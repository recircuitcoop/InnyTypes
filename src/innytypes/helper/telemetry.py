"""The only code in innytypes that sends anything off the user's machine.

Everything here exists to make one sentence true: **nothing leaves this machine that the user
did not agree to, and nothing at all leaves it before they were asked** (plan 0003, F2). The
pieces are small on purpose, because each of them is a place a leak could start.

**The switch decides, and it decides in one place.** Every public method of
:class:`TelemetryPipeline` begins at :meth:`TelemetryPipeline._switch_allows`, which re-reads
`config.toml` through :class:`~innytypes.helper.config.HelperSettings` — no cached copy, no
flag remembered at startup. `ON` is the only state that queues or sends. `OFF` and `UNSET`
both stop everything **and empty the queue on the spot**, because a report already written is
a report that would otherwise drain later, and "off" that still sends for another minute is
not off. `UNSET` additionally means the identifier source is never even read: the machine id
is computed lazily, inside the gate, so a machine whose owner has not answered the question
has not had its identifier looked at.

That is the structural half of F2. There is no path from a caller to the queue or to an HTTP
transport that does not pass the gate, because the queue and the transports are private to
the pipeline and every entry point starts the same way. A caller cannot forget to check the
switch, because a caller never checks the switch.

**The machine id is a hash, and the thing it hashes never leaves.** D20: HMAC-SHA256 of the
operating system's own machine identifier with :data:`MACHINE_ID_KEY`, a fixed label specific
to innytypes. The raw identifier is registered with the credential redactor the moment it is
read, so it cannot render in a log or a report even by accident. One legal fact the plan
insists on keeping in view: a stable identifier like this is still **pseudonymous personal
data** under the GDPR, which is why the retention periods and the privacy notice in
:data:`PRIVACY_NOTICE` apply to it.

**One redaction function, and it fails closed.** :func:`redact` is what every payload passes
through before it is written to the queue. It drops the *value* of any key whose name is
about content, names, credentials, files, audio, the environment, the user, the host or the
hardware; it removes every registered credential from every string by exact match; it reduces
every absolute path to package-relative form, or to `[redacted]` when it cannot recognise the
package; and it replaces anything it cannot serialize. A key it has never seen keeps its
value only if the key's *name* is harmless, and a value it cannot understand is removed
rather than guessed at.

**The queue is bounded and drops the oldest.** Telemetry must never fill a disk, so
:class:`ReportQueue` holds at most :data:`DEFAULT_MAX_REPORTS` reports and
:data:`DEFAULT_MAX_QUEUE_BYTES` bytes, and enqueuing past either limit deletes the oldest
report rather than growing or failing. Reports are files with a sequence in the name, so
insertion order is the order they sort in, and a crash halfway through leaves either the old
file or the new one and never half of either.

**Sending is somebody else's thread.** :meth:`TelemetryPipeline.report` writes one small file
and sets an event; it never opens a socket. The worker thread does that, with a timeout on
every request and a backoff between failures, and the backoff is an injected `sleep` so the
gate never waits out a real one. A GlitchTip that is down, slow or gone therefore costs a
stabilization action nothing at all — which is the property the acceptance criteria hold this
module to, measured with a transport that hangs while a restart runs.

**Endpoints are build-time settings of a release, not user config** (plan 0003). The defaults
in this repository are empty, and a build with no endpoint queues nothing: there would be
nowhere to send it, and a queue that only rotates is disk churn with no purpose. A release
fills :class:`Endpoints` in.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import platform
import re
import threading
import time
import traceback
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from types import TracebackType
from typing import Protocol

import httpx
from platformdirs import user_data_path

from innytypes import __version__
from innytypes.addons.install import Runner, run_command

# The one place a credential is removed from rendered text already exists, and it is
# deliberately dependency-free so anything holding a secret can use it (plan 0002). The raw
# machine identifier is registered there too: it is exactly the kind of value that must never
# render, and a second registry would be a second place to forget.
from innytypes.anytype_mcp.logs import REDACTED, get_logger, protect
from innytypes.anytype_mcp.logs import redact as redact_credentials
from innytypes.helper.config import APPLICATION_NAME, HelperSettings

__all__ = [
    "DEFAULT_BACKOFF",
    "DEFAULT_MAX_QUEUE_BYTES",
    "DEFAULT_MAX_REPORTS",
    "ERROR_RETENTION_DAYS",
    "FIRST_LAUNCH_QUESTION",
    "MACHINE_ID_KEY",
    "PRIVACY_NOTICE",
    "QUEUE_DIRNAME",
    "SEND_TIMEOUT",
    "USAGE_RETENTION_MONTHS",
    "Endpoints",
    "GlitchTipTransport",
    "InstalledPlugin",
    "MachineIdentifierSource",
    "QueuedReport",
    "ReportKind",
    "ReportQueue",
    "ReportTransport",
    "TelemetryError",
    "TelemetryPipeline",
    "UmamiTransport",
    "UsageSnapshot",
    "answer_first_launch_question",
    "default_queue_path",
    "error_payload",
    "machine_id",
    "os_machine_identifier",
    "question_is_unanswered",
    "redact",
    "stack_frames",
]

logger = get_logger(__name__)


class TelemetryError(RuntimeError):
    """Raised when telemetry cannot be set up, naming what is missing.

    Narrow on purpose. Nothing that goes wrong *while sending* is one of these: a server that
    is down is a retry, not an error the user is shown, because telemetry failing must never
    look like the application failing.
    """


# --- the machine id ---------------------------------------------------------------------------

# The HMAC key. **This is not a secret** — it ships in every copy of innytypes, and treating
# it as one would be security theatre. Its job is domain separation: with it, our hash of a
# machine's identifier cannot be matched against any other software's hash of the same
# identifier, so the id is useless to anyone who does not already have this constant. It is
# spelled as a label rather than as random bytes so that is obvious on sight.
MACHINE_ID_KEY = b"innytypes.machine-id.v1"

# An identifier shorter than this is not the OS's machine identifier — it is a stub, a fake,
# or a truncated read. Registering such a string with the credential redactor would blank
# fragments of unrelated text, so it is refused instead.
MINIMUM_IDENTIFIER_LENGTH = 8

# How the machine identifier is obtained. A callable and nothing else, so no test ever has a
# way to reach the real one by forgetting an argument: there is no default.
MachineIdentifierSource = Callable[[], str]

# What `ioreg` prints for the one value we want out of it.
_IOPLATFORM_UUID = re.compile(r'"IOPlatformUUID"\s*=\s*"([0-9A-Za-z-]+)"')

# Absolute, not `ioreg`: a bare name is resolved through `PATH`, and `PATH` is attacker
# territory in a process that a user's shell profile has touched.
_IOREG = "/usr/sbin/ioreg"


def machine_id(source: MachineIdentifierSource) -> str:
    """The machine id: HMAC-SHA256 of ``source()`` with :data:`MACHINE_ID_KEY`, as hex.

    Deterministic, so the same machine is the same id on every launch, across reinstalls and
    across the switch being toggled — that is the whole of D20's "counted once".

    **Registers the raw identifier with the credential redactor** before returning. Computing
    the id is the only moment the raw value is in play, so it is the moment to make it
    unrenderable; a caller that had to remember to do this separately would one day not.
    """
    raw = source().strip()
    if not raw:
        raise TelemetryError(
            "the machine identifier source returned nothing; telemetry needs the operating "
            "system's own machine identifier to derive a machine id"
        )
    if len(raw) < MINIMUM_IDENTIFIER_LENGTH:
        raise TelemetryError(
            f"the machine identifier source returned {len(raw)} characters, which is not an "
            f"operating system machine identifier (at least {MINIMUM_IDENTIFIER_LENGTH} are "
            "expected)"
        )

    protect(raw)
    return hmac.new(MACHINE_ID_KEY, raw.encode("utf-8"), hashlib.sha256).hexdigest()


def os_machine_identifier(*, system: str | None = None, run: Runner = run_command) -> str:
    """The operating system's own machine identifier, and nothing else about the machine.

    Never the user name, the host name, a network hardware address, a serial number or
    anything from the user's account (plan 0003, D20). ``system`` and ``run`` are injected so
    the parsing is covered by the gate on a machine whose own identifier is never read.

    macOS only so far. Linux's `/etc/machine-id` lands with plan 0003 slice 15 and Windows's
    `MachineGuid` with slice 16; until then this refuses by name rather than inventing a
    fallback, because a fallback here would be some *other* identifier — a host name, a MAC
    address — which is precisely what D20 forbids.
    """
    name = platform.system() if system is None else system

    if name == "Darwin":
        return _macos_platform_uuid(run)

    raise TelemetryError(
        f"no machine identifier source for {name!r} yet: Linux (/etc/machine-id) lands with "
        "plan 0003 slice 15 and Windows (MachineGuid) with slice 16. Telemetry stays off on "
        "this platform rather than identifying the machine some other way"
    )


def _macos_platform_uuid(run: Runner) -> str:
    """`IOPlatformUUID` out of the IORegistry — the identifier macOS gives the machine."""
    try:
        output = run([_IOREG, "-rd1", "-c", "IOPlatformExpertDevice"])
    except Exception as error:  # noqa: BLE001 - every failure is one refusal
        raise TelemetryError(
            f"{_IOREG} could not be read for the machine identifier: {error}"
        ) from error

    found = _IOPLATFORM_UUID.search(output)
    if found is None:
        raise TelemetryError(
            f"{_IOREG} printed no IOPlatformUUID, so this machine has no identifier to derive "
            "a machine id from"
        )
    return found.group(1)


# --- the one redaction function ----------------------------------------------------------------

# A key whose *name* contains any of these never carries its value off the machine. The list
# is the plan's "what is never sent", turned into the vocabulary those things are spelled
# with. It is matched as a substring of the lowercased key, so `object_title`, `spaceName`
# and `ANYTYPE_API_KEY` are all covered by the entries they contain.
#
# Matching by name is a deny-list and deny-lists fail open, so it is never the only defence:
# every string value is *also* scrubbed for registered credentials and for absolute paths,
# and the reports this module builds are assembled from named fields rather than from
# whatever a caller happened to hand over.
FORBIDDEN_KEY_FRAGMENTS = (
    # Anytype content, and the names of the objects and spaces it lives in.
    "content",
    "text",
    "body",
    "markdown",
    "snippet",
    "excerpt",
    "title",
    "name",
    "label",
    "space",
    "object",
    "property",
    "relation",
    "block",
    "note",
    "tag",
    "query",
    "search",
    # The Anytype API key, and any other credential.
    "key",
    "token",
    "secret",
    "password",
    "passphrase",
    "credential",
    "auth",
    "cookie",
    "session",
    "bearer",
    "signature",
    # File contents, and the paths that say where a user keeps their files.
    "file",
    "path",
    "dir",
    "folder",
    "document",
    "attachment",
    "payload",
    "data",
    "blob",
    "bytes",
    # Audio, and everything derived from it.
    "audio",
    "sound",
    "voice",
    "speech",
    "record",
    "transcript",
    "caption",
    "subtitle",
    # Environment variable values — where an API key most often hides.
    "env",
    # Who the user is.
    "user",
    "account",
    "owner",
    "login",
    "email",
    "profile",
    "home",
    # What the machine is called, and where it is on a network.
    "host",
    "domain",
    "address",
    "network",
    "wifi",
    "ssid",
    # The raw OS machine identifier, and every other hardware identity.
    "identifier",
    "uuid",
    "guid",
    "serial",
    "hardware",
    "device",
)

# An absolute path is only ever reported as the part of it *inside a package*. Everything
# before these markers is where the user keeps their files, which is never sent.
_PACKAGE_MARKERS = ("/site-packages/", "/dist-packages/")

# A source checkout, for the one package we can recognise as ours. `/src/` on its own is not
# enough: `/Users/someone/src/private-notes/draft.py` also matches it, and the tail would be
# the user's own directory names.
_OWN_SOURCE_MARKER = "/src/innytypes/"

# The standard library, wherever the interpreter lives.
_PYTHON_LIB = re.compile(r"/(?:lib/)?python3(?:\.\d+)?/")

# An absolute POSIX path of at least two segments. The lookbehind refuses a `/` that follows
# a word character, a dot, a colon or another slash, which is what keeps `https://host/path`
# from being read as a path.
_POSIX_PATH = re.compile(r"(?<![\w.:/])(?:/[\w.+@%-]+){2,}/?")

# `C:\Users\someone\Documents\notes.md`, and the forward-slash spelling of the same thing.
_WINDOWS_PATH = re.compile(r"(?<![\w:])[A-Za-z]:[\\/](?:[\w.+@%-]+[\\/]?){2,}")

# Bounds on one redacted value, so a single report cannot become the thing that fills the
# disk the queue's own bound exists to protect.
MAX_TEXT_LENGTH = 2000
MAX_SEQUENCE_ITEMS = 100
MAX_MAPPING_ITEMS = 100
MAX_DEPTH = 8


def redact(payload: Mapping[str, object], *, secrets: Sequence[str] = ()) -> dict[str, object]:
    """The one function every payload passes through before it is queued or shown.

    ``secrets`` are exact strings that must not survive anywhere in the result, on top of
    whatever :func:`innytypes.anytype_mcp.logs.protect` has already registered. The result is
    always JSON-serializable: a value this function cannot understand is replaced, never
    passed through in the hope that `json` will manage.
    """
    scrubbed = _redact_value(payload, secrets=tuple(secrets), depth=0)
    # `_redact_value` returns a dict for a Mapping at depth 0; the cast is spelled as a check
    # so a future change to that function cannot quietly start returning something else.
    if not isinstance(scrubbed, dict):  # pragma: no cover - unreachable by construction
        raise TelemetryError(f"a report must redact to an object, got {type(scrubbed).__name__}")
    return scrubbed


def _redact_value(value: object, *, secrets: tuple[str, ...], depth: int) -> object:
    """One value, redacted. Anything unrecognised becomes :data:`REDACTED`, never passed on."""
    if depth > MAX_DEPTH:
        # Deeper than any report this module builds. Something is wrapping something, and
        # what it is wrapping has not been looked at.
        return REDACTED

    if value is None or isinstance(value, bool):
        return value

    if isinstance(value, int | float):
        return value

    if isinstance(value, str):
        return _redact_text(value, secrets=secrets)

    if isinstance(value, Mapping):
        redacted: dict[str, object] = {}
        for key, item in list(value.items())[:MAX_MAPPING_ITEMS]:
            name = str(key)
            if _key_is_forbidden(name):
                # The key stays and the value goes: a report that says a field was removed
                # is far easier to read — and to audit — than one with a hole in it.
                redacted[name] = REDACTED
                continue
            redacted[name] = _redact_value(item, secrets=secrets, depth=depth + 1)
        return redacted

    if isinstance(value, Sequence):
        return [
            _redact_value(item, secrets=secrets, depth=depth + 1)
            for item in list(value)[:MAX_SEQUENCE_ITEMS]
        ]

    # A set, a Path, a dataclass, an exception, a file handle: every one of them can render
    # something from the list above through its `str()`. None of them are sent.
    return REDACTED


def _key_is_forbidden(key: str) -> bool:
    """Whether a key's *name* says its value is one of the things that is never sent."""
    lowered = key.lower()
    return any(fragment in lowered for fragment in FORBIDDEN_KEY_FRAGMENTS)


def _redact_text(text: str, *, secrets: tuple[str, ...]) -> str:
    """One string: registered credentials out, then paths reduced, then bounded."""
    # Credentials first. A credential that happens to look like a path must be removed as a
    # credential, whichever of the two rules would have caught it.
    scrubbed = redact_credentials(text)
    for secret in sorted(secrets, key=len, reverse=True):
        if len(secret) >= MINIMUM_IDENTIFIER_LENGTH:
            scrubbed = scrubbed.replace(secret, REDACTED)

    scrubbed = _POSIX_PATH.sub(lambda match: _package_relative(match.group(0)), scrubbed)
    scrubbed = _WINDOWS_PATH.sub(lambda match: _package_relative(match.group(0)), scrubbed)

    if len(scrubbed) > MAX_TEXT_LENGTH:
        scrubbed = scrubbed[:MAX_TEXT_LENGTH] + "…"
    return scrubbed


def _package_relative(path: str) -> str:
    """An absolute path reduced to the part inside a package, or removed entirely.

    This is what "stack trace with file paths redacted to package-relative form" means in
    practice, and it is fail-closed: a path this cannot attribute to a package is a path
    somewhere in the user's own files, and it is replaced rather than shortened.
    """
    normalized = path.replace("\\", "/")

    for marker in _PACKAGE_MARKERS:
        _, separator, tail = normalized.rpartition(marker)
        if separator and tail:
            return tail

    head, separator, tail = normalized.rpartition(_OWN_SOURCE_MARKER)
    if separator and tail and head:
        return f"innytypes/{tail}"

    library = _PYTHON_LIB.search(normalized)
    if library is not None:
        tail = normalized[library.end() :]
        if tail:
            return tail

    return REDACTED


# --- what is sent ------------------------------------------------------------------------------


class ReportKind(StrEnum):
    """The two kinds of report, which go to two different servers (D21, D22)."""

    USAGE = "usage"
    ERROR = "error"


@dataclass(frozen=True)
class InstalledPlugin:
    """One plugin as usage reports it: what it is, which version, and how it updates."""

    id: str
    version: str
    update_mode: str


@dataclass(frozen=True)
class UsageSnapshot:
    """One usage report's contents, exactly as plan 0003's *what is sent* table lists them.

    A dataclass rather than a free-form mapping because the fields are the contract: a caller
    cannot add "just this one extra thing" to a usage report without changing this class, and
    changing this class is the moment somebody asks whether the new thing may be sent.
    """

    innytypes_version: str
    os: str
    os_version: str
    plugins: tuple[InstalledPlugin, ...] = ()
    starts: int = 0
    stops: int = 0
    interventions: Mapping[str, int] = field(default_factory=dict)
    updates: Mapping[str, str] = field(default_factory=dict)

    def as_payload(self) -> dict[str, object]:
        """The report body, before redaction."""
        return {
            "innytypes_version": self.innytypes_version,
            "os": self.os,
            "os_version": self.os_version,
            "plugins": [
                {"id": plugin.id, "version": plugin.version, "update_mode": plugin.update_mode}
                for plugin in self.plugins
            ],
            "starts": self.starts,
            "stops": self.stops,
            "interventions": dict(self.interventions),
            "updates": dict(self.updates),
        }


def error_payload(
    error: BaseException,
    *,
    intervention: str = "",
    versions: Mapping[str, str] | None = None,
) -> dict[str, object]:
    """One error report's contents: the type, the redacted frames, and what followed.

    **The exception's message is deliberately absent.** Plan 0003 lists an error report as the
    exception *type*, the stack trace with paths redacted, the version set and the
    intervention — and not the message, which is the one part of an exception that routinely
    carries a file name, an object title or a credential a caller formatted into it.
    """
    return {
        "exception_type": type(error).__qualname__,
        "stack": stack_frames(error.__traceback__),
        "intervention": intervention,
        "versions": dict(versions or {}),
    }


def stack_frames(traceback_object: TracebackType | None) -> list[str]:
    """The stack as lines of `package/module.py:LINE in function`, and nothing else.

    A frame whose file cannot be attributed to a package is **dropped whole** rather than
    reported with a redacted path: the line number and function name of a file in the user's
    own directory are no more ours to send than its path is. The source line itself is never
    included, because a source line is file contents.
    """
    frames: list[str] = []
    for frame in traceback.extract_tb(traceback_object):
        where = _package_relative(frame.filename)
        if where == REDACTED:
            continue
        frames.append(f"{where}:{frame.lineno} in {frame.name}")
    return frames


# --- the bounded on-disk queue -------------------------------------------------------------------

QUEUE_DIRNAME = "telemetry-queue"

# The bound. Both halves drop the **oldest** report, because the newest one is the one that
# describes what is happening now. 128 reports of at most a few kilobytes each is a queue
# that survives a long offline spell and still cannot be noticed on any disk.
DEFAULT_MAX_REPORTS = 128
DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024

_QUEUE_FILENAME = re.compile(r"^(\d{12})-(usage|error)\.json$")


def default_queue_path() -> Path:
    """Where queued reports wait for this user, creating nothing."""
    return user_data_path(APPLICATION_NAME, appauthor=False) / QUEUE_DIRNAME


@dataclass(frozen=True)
class QueuedReport:
    """One report waiting to be sent, and the file it is waiting in."""

    sequence: int
    kind: ReportKind
    payload: Mapping[str, object]
    path: Path


class ReportQueue:
    """Reports on disk, in order, bounded, dropping the oldest when full.

    On disk rather than in memory because the helper restarts and a laptop goes offline, and
    a report that only existed in memory would be the report about the crash that is gone
    because of the crash. Bounded because telemetry must never fill a disk (plan 0003).

    One file per report, named with a zero-padded sequence, so insertion order is the order
    the names sort in and no index file can disagree with the directory. Writes are atomic,
    so a crash mid-enqueue leaves the old set or the new one, never a half-written report.
    """

    def __init__(
        self,
        root: Path,
        *,
        max_reports: int = DEFAULT_MAX_REPORTS,
        max_bytes: int = DEFAULT_MAX_QUEUE_BYTES,
    ) -> None:
        if max_reports < 1:
            raise TelemetryError(
                f"the telemetry queue must hold at least one report, got {max_reports}"
            )
        self.root = root
        self.max_reports = max_reports
        self.max_bytes = max_bytes
        # Two threads in one process must not pick the same sequence; two *processes* are
        # handled below, by not overwriting a name that has appeared since it was chosen.
        self._lock = threading.Lock()

    def enqueue(self, kind: ReportKind, payload: Mapping[str, object]) -> QueuedReport:
        """Write one report, then bring the queue back inside its bounds."""
        self._ensure_root()
        text = json.dumps(payload, sort_keys=True, ensure_ascii=False)

        with self._lock:
            # Per process, as `config.py` and `children.py` already do: the helper and the
            # application's window are two writers, and one scratch name would corrupt the
            # other. The loop is the cross-process half: `os.link` refuses a name that
            # already exists, so the other process's report is never overwritten by ours.
            temporary = self.root / f".report.{os.getpid()}.{threading.get_ident()}.new"
            temporary.write_text(text, encoding="utf-8")
            try:
                sequence, path = self._claim_name(temporary, kind)
            finally:
                temporary.unlink(missing_ok=True)

            self._enforce_bounds()

        return QueuedReport(sequence=sequence, kind=kind, payload=dict(payload), path=path)

    def _claim_name(self, temporary: Path, kind: ReportKind) -> tuple[int, Path]:
        """Link the written file into the first free sequence, oldest-first order intact."""
        sequence = self._next_sequence()
        while True:
            path = self.root / f"{sequence:012d}-{kind.value}.json"
            try:
                os.link(temporary, path)
            except FileExistsError:
                # Another process claimed this sequence between the scan and now.
                sequence += 1
                continue
            return sequence, path

    def pending(self) -> tuple[QueuedReport, ...]:
        """Every queued report, oldest first.

        A file that cannot be parsed is **deleted**, not skipped: it can never be sent, and
        leaving it would put an unreadable report at the head of the queue for good.
        """
        reports: list[QueuedReport] = []
        for sequence, kind, path in self._files():
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                logger.warning("dropping an unreadable telemetry report: %s", path.name)
                path.unlink(missing_ok=True)
                continue

            if not isinstance(document, dict):
                logger.warning("dropping a telemetry report that is not an object: %s", path.name)
                path.unlink(missing_ok=True)
                continue

            reports.append(QueuedReport(sequence=sequence, kind=kind, payload=document, path=path))
        return tuple(reports)

    def remove(self, report: QueuedReport) -> None:
        """Forget one report, because it has been sent."""
        report.path.unlink(missing_ok=True)

    def purge(self) -> int:
        """Delete every queued report and say how many there were.

        What `telemetry off` does, and it does it immediately: a queue that drained after the
        switch flipped would be the switch not working.
        """
        dropped = 0
        for _sequence, _kind, path in self._files():
            path.unlink(missing_ok=True)
            dropped += 1
        return dropped

    def __len__(self) -> int:
        return len(self._files())

    # --- the files themselves ---------------------------------------------------------------

    def _ensure_root(self) -> None:
        """The queue directory, readable by this user only.

        Queued reports carry the machine id, which is pseudonymous personal data. A
        world-readable directory would hand it to every other account on the machine.
        """
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)

    def _files(self) -> tuple[tuple[int, ReportKind, Path], ...]:
        """Every queue file, oldest first, with the sequence and kind its name carries."""
        try:
            entries = sorted(self.root.iterdir())
        except (FileNotFoundError, NotADirectoryError):
            return ()

        found: list[tuple[int, ReportKind, Path]] = []
        for entry in entries:
            matched = _QUEUE_FILENAME.match(entry.name)
            if matched is None:
                continue
            found.append((int(matched.group(1)), ReportKind(matched.group(2)), entry))
        return tuple(sorted(found, key=lambda item: item[0]))

    def _next_sequence(self) -> int:
        """One past the highest sequence on disk, so order survives a restart."""
        files = self._files()
        return files[-1][0] + 1 if files else 1

    def _enforce_bounds(self) -> None:
        """Drop the oldest until the queue is inside both bounds."""
        files = list(self._files())

        while len(files) > self.max_reports:
            _sequence, _kind, path = files.pop(0)
            path.unlink(missing_ok=True)

        # The newest report is never dropped for the byte bound: a queue that answered "too
        # big" by deleting what was just written would be a queue that never holds anything.
        while len(files) > 1 and self._total_bytes(files) > self.max_bytes:
            _sequence, _kind, path = files.pop(0)
            path.unlink(missing_ok=True)

    @staticmethod
    def _total_bytes(files: Sequence[tuple[int, ReportKind, Path]]) -> int:
        total = 0
        for _sequence, _kind, path in files:
            try:
                total += path.stat().st_size
            except OSError:  # pragma: no cover - the file was removed under us
                continue
        return total


# --- the two transports ---------------------------------------------------------------------------

# Nothing the helper does may wait on a slow server, here least of all: this is the one
# subsystem whose failure the user must never be able to feel.
SEND_TIMEOUT = 10.0

# How long the sender waits after each consecutive failure, in order, the last repeating.
DEFAULT_BACKOFF = (5.0, 30.0, 120.0, 600.0, 1800.0)

# How long the worker sleeps between looks at the queue when nothing woke it.
WAKE_INTERVAL = 0.5

# The host name Umami is told. Umami's event API wants one, and the machine's own is on the
# *never sent* list — so every install reports the same reserved, unresolvable name (RFC
# 2606) and the field carries no information at all.
UMAMI_HOSTNAME = "helper.innytypes.invalid"

# Umami's event API needs a path; this is the only one innytypes ever reports from.
UMAMI_URL_PATH = "/helper"


@dataclass(frozen=True)
class Endpoints:
    """Where a *release* sends its reports. Build-time settings, never user config.

    Empty here, and empty means this build reports nowhere — see the module docstring. A user
    cannot point innytypes at a different server by editing a file (plan 0003).
    """

    glitchtip_dsn: str = ""
    umami_url: str = ""
    umami_website_id: str = ""


DEFAULT_ENDPOINTS = Endpoints()


class ReportTransport(Protocol):
    """How one kind of report reaches its server.

    :meth:`render` is separate from :meth:`send` because D24 requires `innytypes telemetry
    show` to print reports **exactly as they would be sent**, and the only way to be sure of
    that is for the two to share one function that produces the body.
    """

    @property
    def kind(self) -> ReportKind:
        """Which kind of report this transport carries."""
        ...

    @property
    def destination(self) -> str:
        """The URL a report would be posted to."""
        ...

    def render(self, report: QueuedReport) -> str:
        """The exact request body this report would be sent as."""
        ...

    def send(self, report: QueuedReport, *, client: httpx.Client) -> None:
        """Post one report, raising :class:`httpx.HTTPError` if it did not arrive."""
        ...


# The Sentry event fields GlitchTip reads from the top level; everything else in a report
# goes under `extra` rather than being dropped.
_SENTRY_TOP_LEVEL = frozenset(
    {"report_id", "at", "kind", "machine_id", "os", "os_version", "innytypes_version"}
)


@dataclass(frozen=True)
class GlitchTipTransport:
    """Errors, to a self-hosted GlitchTip over the Sentry store protocol (D21).

    The DSN is parsed rather than trusted: its public key goes in the auth header and its
    path carries the project id, and a DSN that is not `https` is refused — telemetry is the
    one thing in this application that must not be readable off a café network.
    """

    dsn: str
    release: str = __version__

    @property
    def kind(self) -> ReportKind:
        return ReportKind.ERROR

    @property
    def destination(self) -> str:
        url, project, _public_key = self._parts()
        return f"{url.scheme}://{url.netloc.decode()}/api/{project}/store/"

    def render(self, report: QueuedReport) -> str:
        """One Sentry event. The exception's *message* is empty on purpose — see
        :func:`error_payload`."""
        payload = dict(report.payload)
        event: dict[str, object] = {
            "event_id": payload.get("report_id", ""),
            "timestamp": payload.get("at", ""),
            "platform": "python",
            "level": "error",
            "logger": "innytypes.helper",
            "release": self.release,
            "exception": {
                "values": [{"type": payload.get("exception_type", "Error"), "value": ""}]
            },
            "tags": {
                name: payload[name]
                for name in ("machine_id", "os", "os_version", "innytypes_version")
                if name in payload
            },
            "extra": {
                name: value for name, value in payload.items() if name not in _SENTRY_TOP_LEVEL
            },
        }
        return json.dumps(event, sort_keys=True, ensure_ascii=False)

    def send(self, report: QueuedReport, *, client: httpx.Client) -> None:
        _url, _project, public_key = self._parts()
        response = client.post(
            self.destination,
            content=self.render(report).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Sentry-Auth": (
                    "Sentry sentry_version=7, "
                    f"sentry_client=innytypes/{self.release}, "
                    f"sentry_key={public_key}"
                ),
            },
        )
        response.raise_for_status()

    def _parts(self) -> tuple[httpx.URL, str, str]:
        """The DSN split into the server, the project id and the public key."""
        if not self.dsn:
            raise TelemetryError("this build has no GlitchTip DSN, so no error report is sent")

        url = httpx.URL(self.dsn)
        if url.scheme != "https":
            raise TelemetryError(
                f"the GlitchTip DSN must be https, got {url.scheme!r}: telemetry is never sent "
                "in the clear"
            )

        project = url.path.strip("/")
        if not project or not url.username:
            raise TelemetryError(
                "the GlitchTip DSN must be https://<public key>@<host>/<project id>"
            )
        return url, project, url.username


@dataclass(frozen=True)
class UmamiTransport:
    """Usage, to a self-hosted Umami as a custom event with JSON event data (D22, F3).

    Umami's event data is a flat map of scalars, so nested report fields are flattened into
    dotted names here rather than sent as objects it would silently drop. The machine's own
    host name is never part of it: :data:`UMAMI_HOSTNAME` is sent instead.
    """

    url: str
    website_id: str
    release: str = __version__

    @property
    def kind(self) -> ReportKind:
        return ReportKind.USAGE

    @property
    def destination(self) -> str:
        if not self.url or not self.website_id:
            raise TelemetryError("this build has no Umami endpoint, so no usage report is sent")
        base = httpx.URL(self.url)
        if base.scheme != "https":
            raise TelemetryError(
                f"the Umami URL must be https, got {base.scheme!r}: telemetry is never sent in "
                "the clear"
            )
        return f"{self.url.rstrip('/')}/api/send"

    def render(self, report: QueuedReport) -> str:
        body = {
            "type": "event",
            "payload": {
                "website": self.website_id,
                "hostname": UMAMI_HOSTNAME,
                "url": UMAMI_URL_PATH,
                "name": report.kind.value,
                "data": _flatten(report.payload),
            },
        }
        return json.dumps(body, sort_keys=True, ensure_ascii=False)

    def send(self, report: QueuedReport, *, client: httpx.Client) -> None:
        response = client.post(
            self.destination,
            content=self.render(report).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                # Umami rejects a request with no User-Agent. Ours says the application and
                # its version and nothing about the machine.
                "User-Agent": f"innytypes/{self.release}",
            },
        )
        response.raise_for_status()


def _flatten(payload: Mapping[str, object], *, prefix: str = "") -> dict[str, object]:
    """Nested report fields as the flat scalars Umami's event data can hold."""
    flat: dict[str, object] = {}
    for key, value in payload.items():
        name = f"{prefix}{key}"
        if isinstance(value, Mapping):
            flat.update(_flatten(value, prefix=f"{name}."))
        elif isinstance(value, list):
            flat[name] = json.dumps(value, sort_keys=True, ensure_ascii=False)
        else:
            flat[name] = value
    return flat


# --- the pipeline ------------------------------------------------------------------------------


class TelemetryPipeline:
    """The gate, the queue and the sender — the only route from innytypes to a server.

    Nothing here is reachable around the switch. The queue and the transports are private,
    and every public method starts at :meth:`_switch_allows`, which re-reads the config file
    and — for `OFF` and for `UNSET` alike — empties the queue and answers no.
    """

    def __init__(
        self,
        *,
        settings: HelperSettings,
        queue: ReportQueue,
        machine_identifier: MachineIdentifierSource,
        endpoints: Endpoints = DEFAULT_ENDPOINTS,
        release: str = __version__,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        backoff: Sequence[float] = DEFAULT_BACKOFF,
        wake_interval: float = WAKE_INTERVAL,
    ) -> None:
        self._settings = settings
        self._queue = queue
        # Required, never defaulted: there is no spelling of this constructor that reads the
        # real machine identifier because an argument was forgotten.
        self._machine_identifier = machine_identifier
        self._release = release
        self._transport = transport
        self._clock = clock
        self._sleep = sleep
        self._backoff = tuple(backoff) or DEFAULT_BACKOFF
        self._wake_interval = wake_interval

        self._transports: dict[ReportKind, ReportTransport] = {}
        if endpoints.glitchtip_dsn:
            self._transports[ReportKind.ERROR] = GlitchTipTransport(
                dsn=endpoints.glitchtip_dsn, release=release
            )
        if endpoints.umami_url and endpoints.umami_website_id:
            self._transports[ReportKind.USAGE] = UmamiTransport(
                url=endpoints.umami_url, website_id=endpoints.umami_website_id, release=release
            )

        self._machine_id: str | None = None
        self._secrets: tuple[str, ...] = ()
        self._failures = 0

        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None

    # --- what a caller reports -------------------------------------------------------------

    def record_usage(self, snapshot: UsageSnapshot) -> QueuedReport | None:
        """Queue one usage report, or nothing at all if the switch does not allow it."""
        return self._report(ReportKind.USAGE, snapshot.as_payload())

    def record_error(
        self,
        error: BaseException,
        *,
        intervention: str = "",
        versions: Mapping[str, str] | None = None,
    ) -> QueuedReport | None:
        """Queue one error report, or nothing at all if the switch does not allow it."""
        return self._report(
            ReportKind.ERROR,
            error_payload(error, intervention=intervention, versions=versions),
        )

    # --- what the user and the sender see --------------------------------------------------

    def pending(self) -> tuple[QueuedReport, ...]:
        """The queued reports, for `innytypes telemetry show` (D24).

        Gated like everything else, so `show` immediately after `off` shows an empty queue
        because the queue *is* empty, not because this method declined to look.
        """
        if not self._switch_allows():
            return ()
        return self._queue.pending()

    def describe(self, report: QueuedReport) -> tuple[str, str]:
        """Where a queued report would go, and the exact body it would be sent as."""
        transport = self._transports.get(report.kind)
        if transport is None:
            return (
                "nowhere: this build has no endpoint for this kind of report",
                json.dumps(report.payload, indent=2, sort_keys=True, ensure_ascii=False),
            )
        return transport.destination, transport.render(report)

    def flush(self) -> int:
        """Send everything queued, in order, and say how many went. Never raises.

        Re-reads the switch **before every single report**, so a user who turns telemetry off
        mid-drain stops the drain at that report rather than after it.
        """
        if not self._switch_allows():
            return 0

        sent = 0
        with httpx.Client(transport=self._transport, timeout=SEND_TIMEOUT) as client:
            for report in self._queue.pending():
                if self._stopping.is_set() or not self._switch_allows():
                    return sent
                if not self._send(report, client=client):
                    return sent
                self._queue.remove(report)
                sent += 1

        self._failures = 0
        return sent

    # --- the background thread ---------------------------------------------------------------

    def start(self) -> None:
        """Start sending in the background. Idempotent."""
        if self._thread is not None:
            return
        self._stopping.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="innytypes-telemetry",
            # A daemon: a telemetry send must never be the reason the application is still
            # running when the user asked it to quit.
            daemon=True,
        )
        self._thread.start()

    def stop(self, *, timeout: float = 2.0) -> None:
        """Stop sending and wait briefly for the thread. Touches neither queue nor network."""
        self._stopping.set()
        self._wake.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout)

    def _run(self) -> None:
        while not self._stopping.is_set():
            self._wake.wait(self._wake_interval)
            self._wake.clear()
            try:
                self.flush()
            except Exception:  # noqa: BLE001 - telemetry never takes the helper down with it
                logger.warning("the telemetry sender failed; it will try again", exc_info=True)

    # --- the gate ------------------------------------------------------------------------------

    def _switch_allows(self) -> bool:
        """The one place the telemetry switch is consulted, re-read from disk every time.

        `ON` is the only answer that permits anything. `OFF` and `UNSET` both purge the queue
        here and now — `OFF` because plan 0003 says anything queued is deleted rather than
        sent later, and `UNSET` because F2 says nothing may be queued before the question is
        answered, which includes anything a previous `ON` left behind.
        """
        try:
            state = self._settings.telemetry
        except Exception:  # noqa: BLE001 - an unreadable config is never permission to send
            logger.warning("the telemetry switch could not be read; sending nothing")
            return False

        if state.may_send:
            return True

        dropped = self._queue.purge()
        if dropped:
            logger.info("telemetry is %s: dropped %d queued report(s)", state.value, dropped)
        return False

    # --- the parts a caller never reaches ----------------------------------------------------

    def _report(self, kind: ReportKind, payload: Mapping[str, object]) -> QueuedReport | None:
        """Redact, stamp and queue one report. Returns nothing when nothing was queued."""
        if not self._switch_allows():
            return None

        if kind not in self._transports:
            # Nowhere to send it, so queueing it would only rotate files on the user's disk.
            logger.debug("no telemetry endpoint for a %s report in this build", kind.value)
            return None

        try:
            stamped = {
                **payload,
                "kind": kind.value,
                "machine_id": self._identity(),
                "report_id": uuid.uuid4().hex,
                "at": datetime.fromtimestamp(self._clock(), tz=UTC).isoformat(),
            }
            report = self._queue.enqueue(kind, redact(stamped, secrets=self._secrets))
        except Exception:  # noqa: BLE001 - reporting a problem must never become one
            # A full disk, a read-only directory, an identifier source that refuses on this
            # platform: none of them are the caller's problem. The caller is a restart, a
            # kill or a quit, and it carries on.
            logger.warning("a %s report could not be queued", kind.value, exc_info=True)
            return None

        # Writing a small file and setting an event is the whole cost a caller pays. The
        # socket belongs to the worker thread, which is what keeps a hung server from ever
        # delaying a restart, a kill or a quit.
        self._wake.set()
        return report

    def _identity(self) -> str:
        """The machine id, computed once, on the first report the switch allowed.

        Lazy for a reason that is the point of this module rather than an optimisation: while
        the question is unanswered the identifier source is never called, so an install whose
        owner has not answered has not had its machine identifier read.
        """
        with self._lock:
            if self._machine_id is None:
                raw = self._machine_identifier().strip()
                self._machine_id = machine_id(lambda: raw)
                # Belt and braces with the global credential registry `machine_id` fills:
                # this copy is passed to `redact` explicitly, so the raw identifier is removed
                # from every payload even if that registry is ever swapped out.
                self._secrets = (raw,)
            return self._machine_id

    def _send(self, report: QueuedReport, *, client: httpx.Client) -> bool:
        """One report to its server. False means "not now", with the backoff already waited."""
        transport = self._transports.get(report.kind)
        if transport is None:
            # The build lost the endpoint between queueing and sending. There is nowhere for
            # this report to go and no later moment when there will be.
            self._queue.remove(report)
            return True

        try:
            transport.send(report, client=client)
        except (httpx.HTTPError, TelemetryError) as error:
            self._failures += 1
            delay = self._backoff[min(self._failures, len(self._backoff)) - 1]
            logger.info(
                "a %s report could not be sent (%s); waiting %.0fs", report.kind.value, error, delay
            )
            self._sleep(delay)
            return False

        self._failures = 0
        return True


# --- the first-launch question -------------------------------------------------------------------

# D25's retention periods, named here so the notice and any later server configuration read
# the same numbers.
ERROR_RETENTION_DAYS = 90
USAGE_RETENTION_MONTHS = 13

FIRST_LAUNCH_QUESTION = "Send anonymous usage and error reports to the InnyTypes servers?"

PRIVACY_NOTICE = f"""\
InnyTypes can send usage and error reports to its own servers. It is entirely optional, and
answering "no" changes nothing else: InnyTypes keeps protecting, restarting and updating the
application either way.

If you say yes, a report contains:

  • a machine id — an HMAC-SHA256 hash of your operating system's machine identifier. The
    identifier itself never leaves this machine, and the hash cannot be matched to the same
    machine in any other software.
  • the InnyTypes version, your operating system and its version.
  • which plugins are installed, at which versions and update modes.
  • how often the application started and stopped, how often the helper had to intervene and
    what kind of intervention it was, and how updates and rollbacks turned out.
  • for an error: the exception type and a stack trace with every file path reduced to
    package-relative form. Never the exception's message.

A report never contains: anything from your Anytype content, the names of your objects or
spaces, your Anytype API key or any other credential, the contents of any file, audio or
transcripts, the values of environment variables, full paths inside your home directory, your
user name, your machine's host name, or your machine's raw identifier.

Reports are kept for {ERROR_RETENTION_DAYS} days (errors) and {USAGE_RETENTION_MONTHS} months
(usage). Under the GDPR the machine id is still pseudonymous personal data, even though it
carries no name, which is why those limits exist.

You can change this at any time in the InnyTypes window, or with `innytypes telemetry on` and
`innytypes telemetry off`. Turning it off deletes anything still waiting to be sent.
`innytypes telemetry show` prints queued reports exactly as they would be sent.
"""


def question_is_unanswered(settings: HelperSettings) -> bool:
    """Whether the first launch still has to ask (plan 0003, F2).

    Read from the live config, so an answer given in the application's window is seen by a
    CLI running beside it without either being restarted.
    """
    return not settings.telemetry.answered


def answer_first_launch_question(settings: HelperSettings, *, enabled: bool) -> None:
    """Record the answer. Asked once, with :data:`PRIVACY_NOTICE` in front of it (D25)."""
    settings.set_telemetry(enabled)
