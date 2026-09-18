"""The heartbeat: what a managed process tells the helper, and the socket it says it on.

A managed process — the host, the MCP server, an addon — sends a **heartbeat** every
`heartbeat_interval` seconds saying who it is, which process it is, what it is doing and when
it last did real work (docs/plans/0003-innytypes-helper.md, *Health watching*). This module is
the whole protocol: the message and its refusals, the socket the helper listens on, the end a
managed process sends from, and the registry that keeps the latest beat per id.

**Why a socket of the helper's own, and not the event bus.** The helper exists to notice that
the host is dead, so a channel that runs *through* the host reports nothing at exactly the
moment it matters. Heartbeats therefore go straight to the helper over a Unix domain socket in
the per-user runtime directory (D3), owned by the helper, and the helper reads the OS process
table independently besides — a process that stops beating is still visible. The runtime
directory is the right place for the same reason the run-state file lives there
(:mod:`innytypes.children`): the system may clear it on a reboot, which is the correct thing
to do to a channel to processes that no longer exist.

**Owner-only, and belt-and-braces about it.** The socket is created with mode ``0o600`` inside
a directory created ``0o700``: on this machine every process of this user is already trusted
with the Anytype API key, but a socket that reports what is running and when it last worked is
not something another account on a shared machine gets to read. `bind` takes its permissions
from the umask, which the helper does not control, so the umask is tightened *around* the bind
and the mode is set explicitly afterwards — the first closes the window where the socket exists
world-readable, the second makes the result independent of whatever the umask was.

**The wire format is the one the event transport already uses**: newline-delimited JSON over a
byte stream (:mod:`innytypes.events.transport`). A beat is ASCII with no literal newline in it,
because `json.dumps` escapes them, so a newline is an unambiguous end of frame and a dump of
the socket is readable. What this module does *not* share with that transport is its meaning:
that one carries events between the host and its addons, this one carries liveness to a
different process with a different lifetime.

**`detail` is small, JSON, and never content.** The plan says so, and the rule is enforced
rather than documented: a detail JSON cannot write is refused, a detail bigger than
:data:`MAX_DETAIL_BYTES` is refused, and both refusals name the process the beat came from. A
heartbeat is a health signal that the helper may one day report through telemetry, so an addon
that put a user's note in it would be leaking a user's note, not debugging its queue depth.

**What this slice deliberately does not do.** It does not judge staleness, sample resources or
restart anything — slices 04 and 05. It records beats and hands them over. The seam is
:class:`HeartbeatRegistry`: the latest beat per id, with the moment it arrived, read under the
same injected clock every later slice uses. The vocabulary is shared too:
:class:`~innytypes.children.ChildKind` is the `kind` of a heartbeat exactly as it is the kind
of a run-state record, so the two files a phantom check compares cannot drift apart. The plan's
prose says "plugin" where the code says `addon`; the wire, like the run-state file, does not get
to choose.
"""

from __future__ import annotations

import json
import math
import os
import socket
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from platformdirs import user_runtime_path

from innytypes.anytype_mcp.logs import get_logger
from innytypes.children import ChildKind
from innytypes.helper.config import APPLICATION_NAME

__all__ = [
    "FRAME_TERMINATOR",
    "HEARTBEAT_SOCKET_NAME",
    "MAX_DETAIL_BYTES",
    "MAX_FRAME_BYTES",
    "RUNTIME_DIR_MODE",
    "SOCKET_MODE",
    "Heartbeat",
    "HeartbeatError",
    "HeartbeatListener",
    "HeartbeatRegistry",
    "HeartbeatSender",
    "HeartbeatSink",
    "HeartbeatSocketError",
    "ProcessState",
    "ReceivedHeartbeat",
    "decode_heartbeat",
    "default_socket_path",
    "encode_heartbeat",
]

log = get_logger(__name__)

# The socket lives beside the run-state file, in the per-user runtime directory.
HEARTBEAT_SOCKET_NAME = "heartbeat.sock"

# Owner only, for both the socket and the directory it sits in (plan 0003, D3).
SOCKET_MODE = 0o600
RUNTIME_DIR_MODE = 0o700

# `detail` is "optional, small, JSON" and never content. One kilobyte holds a handful of queue
# depths and an error class, and holds nothing anybody would call a document.
MAX_DETAIL_BYTES = 1024

# A whole frame, buffered before a newline arrives. Generous next to a real beat (a few hundred
# bytes) and small enough that a peer which never sends a newline cannot grow the helper's
# memory without bound.
MAX_FRAME_BYTES = 8 * 1024

# What separates one frame from the next, exactly as in `innytypes.events.transport`.
FRAME_TERMINATOR = b"\n"

_RECEIVE_CHUNK = 65536
_LISTEN_BACKLOG = 16

_REQUIRED_FIELDS = ("id", "kind", "pid", "started_at", "version", "state", "progress_at")
_OPTIONAL_FIELDS = ("detail",)


class HeartbeatError(ValueError):
    """Raised when something is not a heartbeat this helper will act on.

    One error for both directions — a beat that cannot be built and a frame that cannot be
    read — because the rule broken is the same one either way, and a reader of the message
    should not have to know which side of the socket it came from.
    """


class HeartbeatSocketError(RuntimeError):
    """Raised when the heartbeat socket cannot be opened, claimed, or reached.

    Separate from :class:`HeartbeatError` on purpose: a malformed beat is a bug in the process
    that sent it, and an unreachable socket is a fact about the machine — the helper is not
    running, or something else already holds the path.
    """


class ProcessState(StrEnum):
    """What a managed process says it is doing (plan 0003, *What each managed process publishes*).

    ``DEGRADED`` is the interesting one: a process that is running but not fully serving says
    so itself, rather than leaving the helper to infer it from a silence that means several
    different things.
    """

    STARTING = "starting"
    READY = "ready"
    DEGRADED = "degraded"
    STOPPING = "stopping"


@dataclass(frozen=True)
class Heartbeat:
    """One beat: who, which process, what version, what state, and when it last made progress.

    ``pid`` and ``started_at`` together are the *process identity* the phantom check is built
    on (slice 03): an ID alone is reused by the operating system, and a start time tells the
    two apart. ``started_at`` is wall-clock seconds, the same clock
    :class:`~innytypes.children.ChildRecord` records and the same one a process start time is
    read from the OS in, because the whole point of the field is that the two are compared.

    ``progress_at`` is **not** the time the beat was sent. It is when the process last did real
    work, and a loop spinning without progress must not refresh it — that difference is the
    only thing that lets slice 04 tell a busy process from a wedged one.
    """

    id: str
    kind: ChildKind
    pid: int
    started_at: float
    version: str
    state: ProcessState
    progress_at: float
    detail: Mapping[str, object] | None = None

    def __post_init__(self) -> None:
        """Refuse a beat that could not mean anything, at the moment it is built.

        Validation lives here rather than only in :func:`decode_heartbeat` so that a process
        sending nonsense finds out in its own code, where the bug is, rather than in the
        helper's log an hour later.
        """
        _require_text(self.id, name="id")
        _require_text(self.version, name="version")
        _require_pid(self.pid, name="pid")
        _require_time(self.started_at, name="started_at")
        _require_time(self.progress_at, name="progress_at")

        if self.detail is not None:
            # Encoded, not merely type-checked: "JSON-serializable" is a claim only an
            # encoder can settle, and the size limit needs the encoded bytes anyway.
            encode_detail(self.detail, process_id=self.id)

    def to_document(self) -> dict[str, object]:
        """This beat as the JSON object that goes on the wire.

        ``detail`` is left out entirely when there is none, rather than written as ``null``:
        the wire says what the process published, and "no detail" is an absence.
        """
        document: dict[str, object] = {
            "id": self.id,
            "kind": str(self.kind),
            "pid": self.pid,
            "started_at": self.started_at,
            "version": self.version,
            "state": str(self.state),
            "progress_at": self.progress_at,
        }
        if self.detail is not None:
            document["detail"] = dict(self.detail)
        return document

    @classmethod
    def from_document(cls, document: Mapping[str, object]) -> Heartbeat:
        """One beat read back from the wire, or a refusal naming the field that was wrong."""
        missing = [name for name in _REQUIRED_FIELDS if name not in document]
        if missing:
            raise HeartbeatError(
                f"a heartbeat is missing {', '.join(missing)}: every one of "
                f"{', '.join(_REQUIRED_FIELDS)} is required, because the helper acts on all of "
                "them — the identity, the version, the state and the progress time"
            )

        unknown = sorted(set(document) - set(_REQUIRED_FIELDS) - set(_OPTIONAL_FIELDS))
        if unknown:
            raise HeartbeatError(
                f"unknown field(s) in a heartbeat: {', '.join(unknown)}. Known fields: "
                f"{', '.join((*_REQUIRED_FIELDS, *_OPTIONAL_FIELDS))}"
            )

        return cls(
            id=_text(document, "id"),
            kind=_kind(document),
            pid=_whole_number(document, "pid"),
            started_at=_number(document, "started_at"),
            version=_text(document, "version"),
            state=_state(document),
            progress_at=_number(document, "progress_at"),
            detail=_detail(document),
        )


def encode_heartbeat(beat: Heartbeat) -> str:
    """One beat as the frame that goes on the wire, newline excluded."""
    return json.dumps(beat.to_document())


def decode_heartbeat(frame: str) -> Heartbeat:
    """One frame read back into a beat, or a refusal naming what was wrong with it."""
    try:
        decoded = json.loads(frame)
    except ValueError as error:
        raise HeartbeatError(f"a heartbeat frame is JSON, and this one is not: {error}") from error

    if not isinstance(decoded, dict):
        raise HeartbeatError(
            f"a heartbeat frame is a JSON object, got {type(decoded).__name__}: {frame!r}"
        )

    return Heartbeat.from_document(decoded)


def encode_detail(detail: Mapping[str, object], *, process_id: str) -> str:
    """``detail`` as JSON, refusing what JSON cannot write and what is too big to be a detail.

    Both refusals name the process, because the fix is in that process's code and the helper's
    log is where somebody will read about it.
    """
    if not isinstance(detail, Mapping):
        raise HeartbeatError(
            f"the detail of {process_id!r} must be a JSON object of small values, got "
            f"{type(detail).__name__}"
        )

    for key in detail:
        if not isinstance(key, str):
            raise HeartbeatError(
                f"the detail of {process_id!r} has a non-string key {key!r}: JSON objects are "
                "keyed by strings"
            )

    try:
        encoded = json.dumps(dict(detail))
    except (TypeError, ValueError) as error:
        raise HeartbeatError(
            f"the detail of {process_id!r} cannot be written as JSON: "
            f"{type(error).__name__}: {error}. A heartbeat crosses a process boundary, so a "
            "detail JSON cannot write is refused here rather than discovered by the helper"
        ) from error

    if len(encoded.encode("utf-8")) > MAX_DETAIL_BYTES:
        raise HeartbeatError(
            f"the detail of {process_id!r} is {len(encoded.encode('utf-8'))} bytes, over the "
            f"{MAX_DETAIL_BYTES}-byte limit. `detail` carries queue depths and error classes, "
            "never content"
        )

    return encoded


def default_socket_path() -> Path:
    """Where the heartbeat socket lives for this user, creating nothing.

    The per-user **runtime** directory, beside the run-state file
    (:func:`innytypes.children.default_run_state_path`), because both describe processes that
    exist right now and the system is entitled to clear the lot on a reboot.
    """
    return user_runtime_path(APPLICATION_NAME, appauthor=False) / HEARTBEAT_SOCKET_NAME


# What the listener does with a beat it has read. A callable, so the socket knows nothing about
# what the helper keeps — in the helper that is `HeartbeatRegistry.record`, and in a test it is
# a list's `append`.
HeartbeatSink = Callable[[Heartbeat], None]


@dataclass
class _Peer:
    """One connected process: its socket and the bytes of a frame that is not finished yet."""

    connection: socket.socket
    buffer: bytearray = field(default_factory=bytearray)


class HeartbeatListener:
    """The helper's end: the socket it owns, and the beats that arrive on it.

    Non-blocking by construction, and driven by :meth:`poll` rather than a loop of its own.
    The helper already has a tick (``helper.tick`` in `config.toml`), so a listener with its
    own thread would be a second schedule to reason about; a test drives the same call the
    helper's tick does, which is why this slice needs no thread and no sleep anywhere in it.

    ``open`` refuses rather than guesses about a path that is already there. A socket somebody
    is listening on belongs to another helper and is left alone; a socket nobody answers is a
    leftover from a helper that died and is replaced; anything that is not a socket at all is
    refused untouched, because deleting a file this code did not create is not a repair.
    """

    def __init__(self, path: Path | None = None, *, sink: HeartbeatSink) -> None:
        self.path = default_socket_path() if path is None else path
        self.refusals = 0
        self._sink = sink
        self._socket: socket.socket | None = None
        self._peers: list[_Peer] = []

    def __enter__(self) -> HeartbeatListener:
        self.open()
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @property
    def open_connections(self) -> int:
        """How many processes are connected right now."""
        return len(self._peers)

    def open(self) -> None:
        """Create the directory, claim the path, bind owner-only, and start listening."""
        if self._socket is not None:
            raise HeartbeatSocketError(f"the listener on {self.path} is already open")

        directory = self.path.parent
        directory.mkdir(parents=True, exist_ok=True)
        # `mkdir`'s own mode is masked by the umask, and a directory that already existed keeps
        # whatever mode it had. Setting it explicitly is what makes the result the same either
        # way.
        os.chmod(directory, RUNTIME_DIR_MODE)

        self._claim_path()

        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        previous_umask = os.umask(0o077)
        try:
            server.bind(str(self.path))
        except OSError as error:
            server.close()
            raise HeartbeatSocketError(
                f"the heartbeat socket {self.path} could not be created: {error}"
            ) from error
        finally:
            os.umask(previous_umask)

        # The umask above closed the window; this makes the mode independent of it.
        os.chmod(self.path, SOCKET_MODE)
        server.listen(_LISTEN_BACKLOG)
        server.setblocking(False)
        self._socket = server

    def poll(self) -> int:
        """Accept whoever is waiting, read whatever has arrived, and return how many beats.

        Never blocks: a process that connected and has sent half a frame costs this call
        nothing, and its half frame waits in that peer's buffer for the next tick.
        """
        server = self._require_open()
        self._accept_pending(server)

        recorded = 0
        for peer in list(self._peers):
            recorded += self._drain(peer)
        return recorded

    def close(self) -> None:
        """Drop every peer, close the socket and remove its path.

        Removing the path is what makes the next helper's ``open`` a clean bind rather than a
        probe of a socket nobody answers.
        """
        for peer in self._peers:
            peer.connection.close()
        self._peers.clear()

        if self._socket is not None:
            self._socket.close()
            self._socket = None
            self.path.unlink(missing_ok=True)

    def _require_open(self) -> socket.socket:
        if self._socket is None:
            raise HeartbeatSocketError(f"the listener on {self.path} is not open")
        return self._socket

    def _claim_path(self) -> None:
        """Decide what an existing path means, and act only where the answer is unambiguous."""
        if not self.path.exists():
            return

        if not self.path.is_socket():
            raise HeartbeatSocketError(
                f"{self.path} exists and is not a socket, so the helper will not replace it: "
                "move it aside if it is yours"
            )

        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(str(self.path))
        except OSError:
            # Nobody is listening: the socket outlived the helper that made it.
            self.path.unlink(missing_ok=True)
        else:
            raise HeartbeatSocketError(
                f"another helper is already listening on {self.path}: only one helper owns the "
                "heartbeat socket"
            )
        finally:
            probe.close()

    def _accept_pending(self, server: socket.socket) -> None:
        while True:
            try:
                connection, _ = server.accept()
            except BlockingIOError:
                return
            except OSError as error:  # pragma: no cover - the socket died under us
                raise HeartbeatSocketError(
                    f"the heartbeat socket {self.path} stopped accepting: {error}"
                ) from error

            connection.setblocking(False)
            self._peers.append(_Peer(connection=connection))

    def _drain(self, peer: _Peer) -> int:
        """Everything this peer has sent since the last poll, as beats handed to the sink."""
        recorded = 0
        while True:
            try:
                chunk = peer.connection.recv(_RECEIVE_CHUNK)
            except BlockingIOError:
                return recorded
            except OSError as error:
                log.debug("a heartbeat peer went away: %s", error)
                self._drop(peer)
                return recorded

            if not chunk:
                # The peer closed. Whatever is left in the buffer is half a frame, and half a
                # frame is not a beat.
                self._drop(peer)
                return recorded

            peer.buffer += chunk
            if len(peer.buffer) > MAX_FRAME_BYTES:
                self._refuse(
                    HeartbeatError(
                        f"a peer sent more than {MAX_FRAME_BYTES} bytes with no end of frame; "
                        "the connection is dropped"
                    )
                )
                self._drop(peer)
                return recorded

            recorded += self._take_frames(peer)

    def _take_frames(self, peer: _Peer) -> int:
        """Every complete frame in this peer's buffer, decoded and handed on.

        A frame that is not a heartbeat is **counted and logged**, and the peer keeps its
        connection: one bad beat from a process that is otherwise reporting is a bug to fix in
        that process, not a reason for the helper to stop hearing from it.
        """
        recorded = 0
        while FRAME_TERMINATOR in peer.buffer:
            line, _, rest = peer.buffer.partition(FRAME_TERMINATOR)
            peer.buffer = bytearray(rest)

            try:
                frame = line.decode("utf-8")
            except UnicodeDecodeError as error:
                self._refuse(
                    HeartbeatError(f"a heartbeat frame is UTF-8, and this one is not: {error}")
                )
                continue

            try:
                beat = decode_heartbeat(frame)
            except HeartbeatError as error:
                self._refuse(error)
                continue

            self._sink(beat)
            recorded += 1
        return recorded

    def _refuse(self, error: HeartbeatError) -> None:
        self.refusals += 1
        log.warning("a heartbeat was refused: %s", error)

    def _drop(self, peer: _Peer) -> None:
        peer.connection.close()
        if peer in self._peers:
            self._peers.remove(peer)


class HeartbeatSender:
    """A managed process's end: one connection to the helper, one frame per beat.

    The connection is opened on the first beat and kept, because a process beats every few
    seconds for as long as it runs and a connect per beat would be three syscalls to say one
    sentence. It is dropped the moment a write fails, so the next beat reconnects — which is
    what happens when the helper is restarted under a process that is still running.

    A failed send **raises** rather than returning false. What a process does about a helper
    that is not listening is a policy (carry on working, most likely), and a policy belongs to
    the process, not to the two lines that write a frame.
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = default_socket_path() if path is None else path
        self._connection: socket.socket | None = None

    def __enter__(self) -> HeartbeatSender:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def send(self, beat: Heartbeat) -> None:
        """Put one beat on the wire, or raise :class:`HeartbeatSocketError` naming the path."""
        frame = encode_heartbeat(beat).encode("utf-8") + FRAME_TERMINATOR
        connection = self._connect()
        try:
            connection.sendall(frame)
        except OSError as error:
            self.close()
            raise HeartbeatSocketError(
                f"the heartbeat for {beat.id!r} could not be sent to {self.path}: {error}"
            ) from error

    def close(self) -> None:
        """Release the connection. The next beat opens a new one."""
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    def _connect(self) -> socket.socket:
        if self._connection is not None:
            return self._connection

        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            connection.connect(str(self.path))
        except OSError as error:
            connection.close()
            raise HeartbeatSocketError(f"no helper is listening on {self.path}: {error}") from error

        self._connection = connection
        return connection


@dataclass(frozen=True)
class ReceivedHeartbeat:
    """One beat, plus the moment the helper received it.

    Two times, because they answer two questions. ``beat.progress_at`` is what the process
    claims about its own work, and ``received_at`` is what the helper observed — a process
    that keeps beating with a frozen ``progress_at`` is wedged, and one that stops beating
    altogether is something else. Slice 04 tells those apart; this slice makes sure both facts
    survive.
    """

    beat: Heartbeat
    received_at: float


class HeartbeatRegistry:
    """The latest beat per id, and nothing else.

    Deliberately not a judge. It records what arrived and when, under an injected clock, and
    every question about whether that is *good enough* belongs to slice 04 — which reads this.

    Locked, because the two sides run on different threads in the helper: beats arrive on
    whichever thread polls the socket, and the tick that reads them is the helper's own.
    """

    def __init__(self, *, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._latest: dict[str, ReceivedHeartbeat] = {}

    def now(self) -> float:
        """This registry's clock. Everything that compares times reads it, so there is one."""
        return self._clock()

    def record(self, beat: Heartbeat) -> ReceivedHeartbeat:
        """Keep this beat as the latest for its id, replacing whatever was there."""
        received = ReceivedHeartbeat(beat=beat, received_at=self._clock())
        with self._lock:
            self._latest[beat.id] = received
        return received

    def latest(self, process_id: str) -> ReceivedHeartbeat | None:
        """The last beat from ``process_id``, or ``None`` if it has never sent one."""
        with self._lock:
            return self._latest.get(process_id)

    def records(self) -> tuple[ReceivedHeartbeat, ...]:
        """Every id's latest beat, sorted by id so a report reads the same way twice."""
        with self._lock:
            return tuple(sorted(self._latest.values(), key=lambda received: received.beat.id))

    def ids(self) -> tuple[str, ...]:
        """Every id that has ever beaten, sorted."""
        with self._lock:
            return tuple(sorted(self._latest))


# --- typed reads, each of which refuses rather than coerces --------------------------------


def _require_text(value: str, *, name: str) -> None:
    if not value:
        raise HeartbeatError(f"a heartbeat's {name} is empty: it names the process that sent it")


def _require_pid(value: int, *, name: str) -> None:
    if value < 1:
        raise HeartbeatError(
            f"a heartbeat's {name} must be a process id of 1 or more, got {value!r}"
        )


def _require_time(value: float, *, name: str) -> None:
    if not math.isfinite(value) or value < 0:
        raise HeartbeatError(
            f"a heartbeat's {name} must be wall-clock seconds of zero or more, got {value!r}"
        )


def _text(document: Mapping[str, object], key: str) -> str:
    value = document[key]
    if not isinstance(value, str):
        raise HeartbeatError(f"a heartbeat's {key} must be text, got {value!r}")
    return value


def _whole_number(document: Mapping[str, object], key: str) -> int:
    value = document[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise HeartbeatError(f"a heartbeat's {key} must be a whole number, got {value!r}")
    return value


def _number(document: Mapping[str, object], key: str) -> float:
    value = document[key]
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise HeartbeatError(f"a heartbeat's {key} must be a number of seconds, got {value!r}")
    return float(value)


def _kind(document: Mapping[str, object]) -> ChildKind:
    text = _text(document, "kind")
    try:
        return ChildKind(text)
    except ValueError as error:
        known = ", ".join(kind.value for kind in ChildKind)
        raise HeartbeatError(
            f"a heartbeat's kind is {text!r}, which is not a kind of managed process; expected "
            f"one of: {known}"
        ) from error


def _state(document: Mapping[str, object]) -> ProcessState:
    text = _text(document, "state")
    try:
        return ProcessState(text)
    except ValueError as error:
        known = ", ".join(state.value for state in ProcessState)
        raise HeartbeatError(
            f"a heartbeat's state is {text!r}, which is not a state; expected one of: {known}"
        ) from error


def _detail(document: Mapping[str, object]) -> Mapping[str, object] | None:
    if "detail" not in document:
        return None

    value = document["detail"]
    if not isinstance(value, dict):
        raise HeartbeatError(
            f"a heartbeat's detail must be a JSON object, got {type(value).__name__}. Leave it "
            "out entirely when there is nothing to say"
        )
    return value
