"""Taking a verified release live at quit, and putting it back when it does not come up.

Slice 09 (:mod:`innytypes.helper.update`) ends with a release sitting in staging under a
``ready.json`` marker. This module is steps 4 and 5 of plan 0003's *update flow* — the two
steps that actually change what the machine runs:

4. **Apply at the next restart the user starts** (D11). The swap happens when the user
   **quits**, never during startup: the helper stops everything, renames the installed
   application aside as ``previous``, renames the new one into its place, and exits. The next
   launch runs the new version. On Windows the two renames are performed by a process started
   at quit, after the helper has exited, because a running program's files are locked there;
   that is a :class:`SwapHandoff`, and it is the only thing about this module that differs
   between the platforms.
5. **Confirm or roll back.** If the new host does not reach a healthy heartbeat within
   ``helper.update_health_window`` of that launch, ``previous`` goes back, the application is
   restarted on it, the failed version is **blocked** so nothing proposes it again, and the
   rollback is reported.

**What this module refuses, stated first.** It is the last gate before downloaded code becomes
the code this machine executes, so what matters is what never reaches the live directory:

* A staging directory with **no ready marker** is not applied. Nothing is guessed from the
  bytes that happen to be there.
* A marker that cannot be read, that says ``ready`` anything but ``true``, that names another
  platform, another version than its own directory, or an artifact name that is not a plain
  file name is **refused**, and the staged release is deleted.
* The **checksum and the minisign signature are checked again**, here, against the key shipped
  inside the running release — not because the download was not verified, but because the
  bytes have been sitting on disk since then and this is the moment they become executable.
  Anything that fails is deleted: *it is never run and never kept*, at apply time exactly as at
  download time.
* A version a rollback already took away is **never applied again**, and the deleted staging
  directory means the next check does not fetch it again either (the check consults the same
  record, :func:`~innytypes.helper.update.choose_candidate`).
* A release whose ``automatic`` flag is false — a host API change, D13 — **waits** for an
  explicit ``innytypes update apply`` however many times the user quits.
* A release under which an **installed plugin could not start** waits instead of applying. An
  update that would silently stop a plugin the user installed is not an update they asked for.

**Why the swap is two renames and not a copy.** ``previous``, ``current`` and the directory the
bundle is unpacked into are siblings under one per-user data directory, so ``os.replace`` stays
inside one filesystem, where it is atomic. Either the machine starts the old release or it
starts the new one; there is no state in which it starts half of each. This is the same
arrangement, for the same reason, that :mod:`innytypes.helper.environments` uses for a plugin.

**The order of the rollback is deliberate.** The failed version is **blocked before** anything
is renamed back. A block that came second would be lost by exactly the failure that makes it
matter — a swap-back that dies halfway — and the machine would come up offering the version
that just failed.

**Every seam that touches the machine is injected**: the installer that unpacks a bundle and
moves the host version inside an environment, the three roots, the staging directory, the
public key, the heartbeat feed, the clock, and the restart. The gate unpacks no archive,
installs no package, runs no ``uv`` and sleeps not at all. The renames are real, under
``tmp_path``, because a swap that is faked out is a swap nothing proves.

**What is a seam rather than a build.** :class:`UvCoreInstaller` is the production half and it
is as real as it can be before the Briefcase bundles exist (F5): it unpacks the verified
archive with tar's ``data`` filter, and it moves ``innytypes`` inside an environment from the
wheel **inside the release**, with ``--no-deps``, because an update replaces one pinned set
with another and never re-resolves anything on the user's machine.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import sys
import tarfile
import time
import zipfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from platformdirs import user_data_path

from innytypes.addons.discovery import (
    APPLICATION_NAME,
    addon_environment,
    addon_root,
    recorded_manifest_path,
)
from innytypes.addons.install import Runner, run_command
from innytypes.children import ChildRecord, addon_interpreter
from innytypes.helper.breaker import HOST_ID
from innytypes.helper.heartbeat import ProcessState
from innytypes.helper.minisign import (
    MinisignError,
    MinisignPublicKey,
    parse_signature,
    verify_file,
)
from innytypes.helper.rollout import BlockedVersions, LatestBeats
from innytypes.helper.update import (
    READY_MARKER,
    UpdateError,
    Version,
    current_platform,
    parse_version,
)
from innytypes.logs import get_logger

log = get_logger(__name__)

__all__ = [
    "BLOCKED_CORE_VERSIONS_FILENAME",
    "CURRENT_DIRNAME",
    "INCOMING_DIRNAME",
    "PENDING_FILENAME",
    "PREVIOUS_DIRNAME",
    "RELEASE_DIRNAME",
    "RELEASE_MARKER",
    "STAGING_DIRNAME",
    "AppliedRelease",
    "BlockedReleases",
    "CoreInstaller",
    "PendingRelease",
    "PendingReleaseFile",
    "PluginCompatibility",
    "ReadyRelease",
    "ReleaseApplier",
    "ReleaseApplyError",
    "ReleaseConfirmation",
    "ReleaseRoots",
    "SwapHandoff",
    "UvCoreInstaller",
    "confirm_or_roll_back",
    "default_blocked_core_versions_path",
    "default_core_staging_path",
    "default_helper_environment",
    "default_pending_release_path",
    "default_release_roots",
    "default_core_staging_path",
    "incompatible_plugins",
    "installed_plugin_apis",
    "read_ready_release",
    "roll_back_release",
    "verify_ready_release",
]

# The installed application and the one it replaced, side by side under the per-user data
# directory so every rename below stays on one filesystem.
RELEASE_DIRNAME = "release"
CURRENT_DIRNAME = "current"
PREVIOUS_DIRNAME = "previous"

# Where a verified release waits between the check that staged it and the quit that installs
# it. Beside `current/` and `previous/` rather than beside the plugin environments' own
# `staging/`, because it holds releases of the application itself and because the window, the
# update check and the quit must all mean the same directory by "staging".
STAGING_DIRNAME = "staging"

# Where a bundle is unpacked before it is anything. A dot name, because this directory exists
# only between the unpack and the rename and must never be mistaken for an installation.
INCOMING_DIRNAME = ".incoming"

# Where the release being rolled back is moved while `previous` comes home, so the window in
# which nothing is installed at all is one rename wide.
ROLLED_BACK_DIRNAME = ".rolled-back"

# What an unpacked release must carry to be swapped in: the version and the host API it was
# built for, as the build wrote them. A tree that cannot say what it is does not become the
# application, for the same reason a plugin environment with no recorded manifest does not
# become a plugin (:mod:`innytypes.helper.environments`).
RELEASE_MARKER = "release.json"

# The note the quit leaves for the next launch: an update was applied and has not been
# confirmed yet. Its absence is what makes an ordinary launch ordinary.
PENDING_FILENAME = "pending-release.json"

# The versions a rollback took away. A file rather than memory, for the reason the plugin
# record is one: the helper restarts and the bad release does not stop being bad.
BLOCKED_CORE_VERSIONS_FILENAME = "blocked-core-versions.json"

# Where the wheels a release carries live inside it, and the one this module installs from.
WHEEL_DIRNAME = "wheels"

# How often the wait for the new host's first healthy beat looks again. Injected on the call,
# so no test spends a second of it.
DEFAULT_POLL_INTERVAL = 0.5

# An artifact's file name as the marker may spell it. The name is joined onto the staging
# directory, so it is checked here as well as at download time: this module re-reads a file
# written by another process, and "slice 09 already checked it" is not a property this one can
# observe.
_ARTIFACT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# A SHA-256 checksum as the marker must spell it.
_SHA256 = re.compile(r"^[0-9a-f]{64}$")

# How much of the artifact is held in memory at a time while it is re-hashed.
_HASH_CHUNK_BYTES = 1024 * 1024


class ReleaseApplyError(RuntimeError):
    """Raised when a release cannot be applied or confirmed, naming what stopped it.

    Every refusal below happens **before** the first rename, or is undone by the rename that
    follows it, so a caller that sees this knows the installed application is the one that was
    already there.
    """


# ── where everything lives ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReleaseRoots:
    """The three directories a swap moves things between, and the one they sit under.

    One object rather than three parameters, because the atomicity of the swap is a property
    of them being siblings: a caller that could pass ``previous`` on another filesystem would
    have a swap that silently degrades into a copy.
    """

    root: Path

    @property
    def live(self) -> Path:
        """The installed application: what the next launch runs."""
        return self.root / CURRENT_DIRNAME

    @property
    def previous(self) -> Path:
        """The installation the last swap replaced, kept so it can come back."""
        return self.root / PREVIOUS_DIRNAME

    @property
    def incoming(self) -> Path:
        """Where a verified bundle is unpacked, before it is anything at all."""
        return self.root / INCOMING_DIRNAME

    @property
    def rolled_back(self) -> Path:
        """Where the release being undone waits while ``previous`` is renamed home."""
        return self.root / ROLLED_BACK_DIRNAME

    @property
    def staging(self) -> Path:
        """Where a verified release waits for the quit that installs it."""
        return self.root / STAGING_DIRNAME


def default_release_roots() -> Path:
    """Where the installed application and the one before it live, for this user."""
    return user_data_path(APPLICATION_NAME, appauthor=False) / RELEASE_DIRNAME


def default_core_staging_path() -> Path:
    """Where a verified core release waits for this user, creating nothing.

    One spelling for the three things that have to agree about it: the check that stages a
    release, the window that says one is waiting, and the quit that installs it. Two of those
    are in different processes from the third, so a caller-chosen directory would be three
    chances to name a different one.
    """
    return ReleaseRoots(default_release_roots()).staging


def default_pending_release_path() -> Path:
    """Where an applied-but-unconfirmed release is noted, for this user."""
    return user_data_path(APPLICATION_NAME, appauthor=False) / PENDING_FILENAME


def default_blocked_core_versions_path() -> Path:
    """Where the host versions a rollback took away are recorded, for this user."""
    return user_data_path(APPLICATION_NAME, appauthor=False) / BLOCKED_CORE_VERSIONS_FILENAME


def default_helper_environment() -> Path:
    """The environment the helper itself runs from.

    ``sys.prefix``, which is the honest answer in both installations this application has: the
    project's own virtual environment when it is run unpackaged, and the environment inside the
    bundle when it is packaged (F5). Moving the host version there is what "the helper updates
    itself as part of the same bundle" means on a machine where the helper does **not** live
    inside the swapped tree; where it does, the swap has already done it and the call is a
    re-pin of the version that is there.
    """
    return Path(sys.prefix)


# ── the versions a rollback took away ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class BlockedReleases:
    """Host versions that failed to come up healthy and will not be offered again.

    The same record a plugin rollback writes (:class:`~innytypes.helper.rollout.BlockedVersions`)
    in its own file, under the host's id. Deliberately the same class and not a second one:
    "an unreadable record is refused rather than read as empty" is the load-bearing behaviour
    here too, and two implementations of it would eventually disagree about which is which.
    """

    versions: BlockedVersions

    @classmethod
    def at(cls, path: Path) -> BlockedReleases:
        """The record kept in one file."""
        return cls(versions=BlockedVersions(path=path))

    def is_blocked(self, version: str) -> bool:
        """Whether this exact host version was taken away by a rollback."""
        return self.versions.is_blocked(HOST_ID, version)

    def block(self, version: str) -> None:
        """Record one host version as blocked, leaving every other record alone."""
        self.versions.block(HOST_ID, version)

    def all(self) -> tuple[str, ...]:
        """Every blocked host version, in the order they were blocked."""
        return self.versions.blocked_for(HOST_ID)


# ── the note a quit leaves for the next launch ───────────────────────────────────────────────


@dataclass(frozen=True)
class PendingRelease:
    """A release that was swapped in and has not proved itself yet."""

    version: Version
    previous_version: str | None
    applied_at: str


@dataclass(frozen=True)
class PendingReleaseFile:
    """The "an update was applied and is not confirmed" note, on disk.

    On disk because the two halves are two different runs of the helper: the quit writes it,
    and the process that reads it is the one the user starts afterwards. It is cleared by the
    confirmation, not by the launch, so a launch that dies before the window is over finds it
    again next time.
    """

    path: Path

    def record(
        self,
        version: Version,
        *,
        previous_version: str | None,
        at: datetime,
    ) -> PendingRelease:
        """Write the note. Called **after** the swap, as the last thing the quit does."""
        entry = PendingRelease(
            version=version,
            previous_version=previous_version,
            applied_at=at.isoformat(),
        )

        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.new")
        temporary.write_text(
            json.dumps(
                {
                    "version": str(entry.version),
                    "previous_version": entry.previous_version,
                    "applied_at": entry.applied_at,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)
        return entry

    def current(self) -> PendingRelease | None:
        """The release waiting to be confirmed, or ``None`` when none is.

        A note that exists but cannot be read is **refused**, not read as "nothing is
        pending". Reading it as nothing would skip the confirmation of an update that did
        happen, which is the exact case the whole rollback exists for.
        """
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError as error:
            raise ReleaseApplyError(f"{self.path} could not be read: {error}") from error

        try:
            document = json.loads(text)
        except ValueError as error:
            raise ReleaseApplyError(
                f"{self.path} is not valid JSON: {error}. It records the update this launch "
                "has to confirm or undo; fix or delete the file."
            ) from error

        if not isinstance(document, Mapping):
            raise ReleaseApplyError(f"{self.path} is not a JSON object naming a version")

        previous = document.get("previous_version")
        return PendingRelease(
            version=_version(document, where=str(self.path)),
            previous_version=None if previous is None else str(previous),
            applied_at=str(document.get("applied_at", "")),
        )

    def clear(self) -> None:
        """Forget the pending release. Only a confirmation or a rollback does this."""
        self.path.unlink(missing_ok=True)


# ── reading, and re-verifying, what slice 09 staged ──────────────────────────────────────────


@dataclass(frozen=True)
class ReadyRelease:
    """A staged release whose marker was read and whose every field survived validation."""

    version: Version
    host_api: int
    platform: str
    directory: Path
    artifact_path: Path
    sha256: str
    signature: str
    automatic: bool
    blocked_reason: str


def read_ready_release(staging: Path, *, platform: str | None = None) -> ReadyRelease | None:
    """The one release waiting in staging, or ``None`` when nothing is waiting.

    ``None`` covers every ordinary absence: no staging directory, an empty one, or a directory
    left by a download that never finished and therefore never got a marker. A marker that is
    *present and wrong* is the other thing entirely, and it raises.
    """
    if not staging.is_dir():
        return None

    ready = sorted(child for child in staging.iterdir() if (child / READY_MARKER).is_file())
    if not ready:
        return None

    if len(ready) > 1:
        raise ReleaseApplyError(
            f"{staging} holds {len(ready)} releases marked ready "
            f"({', '.join(child.name for child in ready)}); a staging directory that cannot "
            "say what is waiting is not one to install from"
        )

    return _read_marker(ready[0], platform=current_platform(platform))


def verify_ready_release(ready: ReadyRelease, *, public_key: MinisignPublicKey) -> None:
    """Check the staged artifact's checksum and signature again, now, before it is unpacked.

    Not a repetition of slice 09's work but a different question. Slice 09 asked "did the
    bytes that arrived match the release that was published"; this asks "are the bytes about
    to be unpacked into the application directory still that release". Between the two lie a
    disk, a reboot and however long the user took to quit, and only the second question is the
    one whose answer decides what this machine executes.

    The **signature** is what decides, exactly as at download time: the checksum comes from
    the marker, which is a local file, and anything able to rewrite the artifact could rewrite
    a checksum beside it. Forging the signature needs the release private key.
    """
    digest = _sha256(ready.artifact_path)
    if not hmac.compare_digest(digest, ready.sha256):
        raise ReleaseApplyError(
            f"the release staged at {ready.directory} no longer matches its own checksum "
            f"(expected {ready.sha256}, found {digest}); it is deleted rather than installed"
        )

    try:
        verify_file(ready.artifact_path, parse_signature(ready.signature), public_key)
    except MinisignError as error:
        raise ReleaseApplyError(
            f"the release staged at {ready.directory} does not verify against the signing key "
            f"shipped inside the running release: {error}; it is deleted rather than installed"
        ) from error


# ── what the installed plugins can live with ─────────────────────────────────────────────────


@dataclass(frozen=True)
class PluginCompatibility:
    """One installed plugin and the host API its recorded manifest targets.

    ``host_api`` is ``None`` when the recorded manifest could not be read at all. Read from
    the recorded JSON rather than through
    :func:`~innytypes.addons.discovery.discover_addons`, on purpose: that parser refuses a
    manifest targeting an API **this** host does not support, and a plugin the running host
    cannot load is exactly the one whose number this check has to be able to see.
    """

    id: str
    host_api: int | None
    root: Path


def installed_plugin_apis(addons_root: Path) -> tuple[PluginCompatibility, ...]:
    """Every installed plugin and the host API number it recorded, sorted by id."""
    if not addons_root.is_dir():
        return ()

    found: list[PluginCompatibility] = []
    for directory in sorted(child for child in addons_root.iterdir() if child.is_dir()):
        plugin_id = directory.name
        found.append(
            PluginCompatibility(
                id=plugin_id,
                host_api=_recorded_host_api(addons_root, plugin_id),
                root=addon_root(addons_root, plugin_id),
            )
        )
    return tuple(found)


def incompatible_plugins(
    plugins: Sequence[PluginCompatibility],
    *,
    host_api: int,
) -> tuple[PluginCompatibility, ...]:
    """The installed plugins that could not start under a host with this API version.

    A plugin whose manifest cannot be read is **not** counted. It cannot start today either,
    so the update does not stop it from starting — and treating it as a blocker would let one
    corrupt directory hold every future update on the machine. It is reported by
    :func:`~innytypes.addons.discovery.discover_addons` as broken, which is where a person
    goes to fix it.
    """
    return tuple(
        plugin for plugin in plugins if plugin.host_api is not None and plugin.host_api != host_api
    )


# ── the installer seam ───────────────────────────────────────────────────────────────────────


class CoreInstaller(Protocol):
    """Everything applying a release needs from the outside world, and nothing else.

    Two calls, in the order :meth:`ReleaseApplier.apply_at_quit` makes them. An implementation
    may unpack a real archive and run ``uv`` (:class:`UvCoreInstaller`), or record what it was
    asked for and create two files, which is what the gate does.
    """

    def unpack(self, artifact: Path, *, destination: Path, version: str) -> None:
        """Unpack one verified release artifact into ``destination``, which does not exist."""
        ...

    def set_host_version(self, environment: Path, *, version: str, release: Path) -> None:
        """Move the ``innytypes`` installed in ``environment`` to ``version``, from ``release``."""
        ...


@dataclass(frozen=True)
class UvCoreInstaller:
    """The production installer: unpack the bundle, then re-pin ``innytypes`` where it is pinned.

    ``run`` is injected for the reason :class:`~innytypes.addons.install.UvInstaller` injects
    it: the argv this class builds is asserted on a machine that has no ``uv`` at all, so the
    gate covers the real implementation rather than only a fake of it.
    """

    uv: str = "uv"
    run: Runner = run_command

    def unpack(self, artifact: Path, *, destination: Path, version: str) -> None:
        """Extract the verified archive, refusing any member that would escape ``destination``.

        The archive is signature-verified before this runs, so its contents are not
        attacker-controlled in the threat model of plan 0003. ``filter="data"`` is set anyway,
        because "this input is trusted" is a property of the caller, and a filter that refuses
        absolute paths, ``..``, links pointing outside the tree and device nodes costs nothing
        to keep true regardless of who calls it next.
        """
        destination.mkdir(parents=True, exist_ok=False)

        try:
            if zipfile.is_zipfile(artifact):
                with zipfile.ZipFile(artifact) as archive:
                    archive.extractall(destination)
                return
            with tarfile.open(artifact) as archive:
                archive.extractall(destination, filter="data")
        except (OSError, tarfile.TarError, zipfile.BadZipFile) as error:
            raise ReleaseApplyError(
                f"release {version} could not be unpacked from {artifact}: {error}"
            ) from error

    def set_host_version(self, environment: Path, *, version: str, release: Path) -> None:
        """Install the release's own ``innytypes`` wheel into one environment, and nothing else.

        ``--no-deps`` and a wheel from inside the release, never an index. A release is a
        complete pinned set (plan 0003, *The update flow*); resolving anything here would
        re-resolve a plugin's dependencies on the user's machine, which is the one thing an
        update must never do.
        """
        wheel = _host_wheel(release, version)
        self._run(
            [
                self.uv,
                "pip",
                "install",
                "--python",
                str(addon_interpreter(environment)),
                "--no-deps",
                str(wheel),
            ]
        )

    def _run(self, argv: Sequence[str]) -> str:
        """Run one command, turning every way it can fail into a refusal that names it."""
        try:
            return self.run(argv)
        except Exception as error:  # noqa: BLE001 - every failure is one refusal
            raise ReleaseApplyError(f"`{' '.join(argv)}` failed: {error}") from error


# ── applying, at quit ────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AppliedRelease:
    """What one quit did about the release in staging: applied it, or why it did not.

    Always returned, never raised: a quit is the one thing in this application that is not
    allowed to fail, and "the update did not apply" is a sentence for the user rather than an
    exception for the caller.

    ``waiting`` tells the two refusals apart that are not failures — a host API change (D13)
    and an installed plugin that could not start under the new host. Those keep the staged
    release, and the next quit asks again.

    ``handed_off`` is the Windows shape of a successful apply (slice 16): the release passed
    every check here, and the two renames will be performed by the updater process this quit
    started, once this process has exited. ``live`` and ``previous`` are therefore empty —
    nothing has been renamed **yet** — while ``applied`` is true, because it answers "will the
    next launch run this version", and it will.
    """

    version: str | None = None
    live: Path | None = None
    previous: Path | None = None
    environments: tuple[str, ...] = ()
    helper_environment: Path | None = None
    waiting: bool = False
    handed_off: bool = False
    reason: str | None = None

    @property
    def applied(self) -> bool:
        """Whether the next launch will run this version."""
        return self.version is not None and self.reason is None


@dataclass(frozen=True)
class _Swapped:
    """The result of the two renames: where the release is, and what it displaced."""

    live: Path
    previous: Path | None


@dataclass(frozen=True)
class _Moved:
    """Which environments took the new host version, and what stopped one that did not."""

    environments: tuple[str, ...] = ()
    reason: str | None = None


def _utcnow() -> datetime:
    """The clock the applier reads, named so it can be replaced by one a test drives."""
    return datetime.now(UTC)


class SwapHandoff(Protocol):
    """Somewhere else for the renames to happen, when this process may not perform them.

    There is exactly one platform that needs this, and one reason (plan 0003, *The update
    flow*, step 4). On Windows a running program's files are **locked**, so the helper cannot
    rename the directory it is executing out of; the swap is performed by a small process
    started at quit, after the helper has exited.
    :class:`~innytypes.helper.windows.WindowsSwapHandoff` is that implementation.

    It is a seam on the applier rather than a branch inside it, because "on Windows, do it
    later" is a fact about the machine and not a decision this module should be making, and
    because the alternative — a ``platform.system()`` test in the middle of the apply — is one
    the gate could never run both sides of. Where no handoff is set, which is macOS and Linux,
    the swap happens here, in-process, exactly as it always has.

    Everything the applier checks before the renames — blocked versions, the ``automatic``
    flag, the checksum, the signature, plugin compatibility — has **already happened** when
    this is called, so a release that should not be installed never causes a process to be
    started at all.
    """

    def hand_off(
        self,
        applier: ReleaseApplier,
        ready: ReadyRelease,
        *,
        requested: bool,
    ) -> None:
        """Arrange for ``ready`` to be swapped in after this process ends, or raise."""
        ...


@dataclass(frozen=True)
class ReleaseApplier:
    """Takes the verified release in staging live, at quit, or explains why it did not.

    Everything that reaches outside the process is a field: the installer is the only thing
    that unpacks or installs, the roots are the only paths renamed, and the clock is the only
    time read — so the gate drives the whole of it under ``tmp_path``, in no time at all.

    ``handoff`` is set on Windows and nowhere else; see :class:`SwapHandoff`.
    """

    installer: CoreInstaller
    roots: ReleaseRoots
    staging: Path
    public_key: MinisignPublicKey
    blocked: BlockedReleases
    pending: PendingReleaseFile
    addons_root: Path
    helper_environment: Path
    platform: str | None = None
    now: Callable[[], datetime] = _utcnow
    handoff: SwapHandoff | None = None

    def apply_at_quit(self, *, requested: bool = False) -> AppliedRelease | None:
        """Swap the staged release in, or say what is keeping it in staging.

        Called from the quit path and from nowhere else (D11): by the time it runs the host,
        the MCP server, the plugins and Anytype have all been stopped, which is why replacing
        the files under them is safe at all.

        ``requested`` is the explicit ``innytypes update apply``. It is the only thing that
        lets a release whose ``automatic`` flag is false through, and it lets nothing else
        through: a blocked version, a failed signature and an incompatible plugin all refuse a
        requested apply exactly as they refuse an automatic one.
        """
        ready = read_ready_release(self.staging, platform=self.platform)
        if ready is None:
            return None

        version = str(ready.version)

        if self.blocked.is_blocked(version):
            # Deleted as well as refused: the record stops the check proposing it again, and
            # removing the bytes stops this quit and every later one re-reading them.
            _remove(ready.directory)
            return AppliedRelease(
                version=version,
                reason=(
                    f"release {version} was rolled back before and is blocked; it is deleted "
                    "rather than installed again"
                ),
            )

        if not ready.automatic and not requested:
            return AppliedRelease(
                version=version,
                waiting=True,
                reason=ready.blocked_reason
                or (
                    f"release {version} is not applied automatically; run "
                    "`innytypes update apply` to install it"
                ),
            )

        try:
            verify_ready_release(ready, public_key=self.public_key)
        except ReleaseApplyError as error:
            _remove(ready.directory)
            return AppliedRelease(version=version, reason=str(error))

        plugins = installed_plugin_apis(self.addons_root)
        stopped_by = incompatible_plugins(plugins, host_api=ready.host_api)
        if stopped_by:
            named = ", ".join(f"{plugin.id} (host API {plugin.host_api})" for plugin in stopped_by)
            return AppliedRelease(
                version=version,
                waiting=True,
                reason=(
                    f"release {version} is built for host API {ready.host_api}, which would "
                    f"stop {named} from starting; the update waits in staging until every "
                    "installed plugin supports it"
                ),
            )

        if self.handoff is not None:
            # Windows (slice 16). Every check above has passed, so what is left is the part
            # this process may not do: renaming files it is running out of. Nothing below this
            # line runs here — the updater runs all of it, by calling this same method in a
            # process that has no handoff.
            try:
                self.handoff.hand_off(self, ready, requested=requested)
            except Exception as error:  # noqa: BLE001 - a quit is never failed by an update
                return AppliedRelease(version=version, waiting=True, reason=str(error))
            return AppliedRelease(version=version, handed_off=True)

        try:
            swapped = self._swap(ready)
        except ReleaseApplyError as error:
            return AppliedRelease(version=version, reason=str(error))

        moved = self._move_host_version(version=version, plugins=plugins, live=swapped.live)
        if moved.reason is not None:
            return self._undo(swapped, reason=moved.reason, version=version)

        previous_version = _release_version(self.roots.previous)
        self.pending.record(ready.version, previous_version=previous_version, at=self.now())

        # The release is installed; leaving it in staging would offer it again at the next
        # quit and leave the marker claiming something is waiting when nothing is.
        _remove(ready.directory)

        log.info("release %s is installed and will run at the next launch", version)
        return AppliedRelease(
            version=version,
            live=swapped.live,
            previous=swapped.previous,
            environments=moved.environments,
            helper_environment=self.helper_environment,
        )

    # --- the two renames ------------------------------------------------------------------

    def _swap(self, ready: ReadyRelease) -> _Swapped:
        """Unpack beside the installation, then exchange the two directories."""
        self.roots.root.mkdir(parents=True, exist_ok=True)

        incoming = self.roots.incoming
        _remove(incoming)

        version = str(ready.version)
        try:
            self.installer.unpack(ready.artifact_path, destination=incoming, version=version)
        except ReleaseApplyError:
            _remove(incoming)
            raise
        except Exception as error:  # noqa: BLE001 - every failure is one refusal
            _remove(incoming)
            raise ReleaseApplyError(
                f"release {version} could not be unpacked: {error}. Nothing was swapped."
            ) from error

        try:
            _insist_release(incoming, version=version, host_api=ready.host_api)
        except ReleaseApplyError:
            _remove(incoming)
            raise

        live = self.roots.live
        previous = self.roots.previous

        # One installation is kept, the one this swap replaces. A chain of them would be a
        # disk leak nobody empties.
        _remove(previous)

        replaced = live.exists()
        if replaced:
            _rename(live, previous, version=version)

        try:
            _rename(incoming, live, version=version)
        except ReleaseApplyError:
            # The first rename happened and the second did not. Put the installation back: an
            # application with no files at all is worse than one that was not updated.
            if replaced:
                _rename(previous, live, version=version)
            raise

        return _Swapped(live=live, previous=previous if replaced else None)

    def _undo(self, swapped: _Swapped, *, reason: str, version: str) -> AppliedRelease:
        """Put the installation back after a swap that could not be finished.

        Nothing is blocked here. What failed is an environment on this machine, not the
        release, and blocking a good version over a local failure would take it away from the
        user for ever.
        """
        if swapped.previous is None:
            # There was no installation to go back to — a first install through this path.
            # Removing the new one would leave the machine with none at all.
            return AppliedRelease(
                version=version,
                live=swapped.live,
                reason=f"{reason}. There is no earlier installation to go back to.",
            )

        roll_back_release(self.roots)
        return AppliedRelease(version=version, reason=f"{reason}. The installation was put back.")

    # --- moving the host version into every environment that pins it -----------------------

    def _move_host_version(
        self,
        *,
        version: str,
        plugins: Sequence[PluginCompatibility],
        live: Path,
    ) -> _Moved:
        """Move ``innytypes`` to the new version inside every plugin environment and the helper.

        Plan 0003: *"A host update also moves the `innytypes` version installed inside every
        plugin environment to the new host version. The helper updates itself as part of the
        same bundle."* Both halves are the same call, because both are environments with the
        host pinned inside them — the plugins' by ``addons install``, the helper's by whatever
        installed the helper. A plugin left pinned to the old host would be running against
        API contracts the host it talks to no longer implements.
        """
        moved: list[str] = []

        for plugin in plugins:
            environment = addon_environment(self.addons_root, plugin.id)
            if not environment.is_dir():
                # A directory under the addons root that is not an environment: broken, or
                # something a person put there. There is nothing to move.
                continue
            try:
                self.installer.set_host_version(environment, version=version, release=live)
            except Exception as error:  # noqa: BLE001 - one failure undoes the whole swap
                return _Moved(
                    reason=(
                        f"{plugin.id} could not be moved to innytypes {version}: {error}. A "
                        "plugin left pinned to the old host would not start against the new one"
                    )
                )
            moved.append(plugin.id)

        try:
            self.installer.set_host_version(self.helper_environment, version=version, release=live)
        except Exception as error:  # noqa: BLE001 - one failure undoes the whole swap
            return _Moved(
                reason=(
                    f"the helper's own environment could not be moved to innytypes {version}: "
                    f"{error}. The helper updates itself as part of the same bundle or not at all"
                )
            )

        return _Moved(environments=tuple(moved))


# ── confirming, at the next launch ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReleaseConfirmation:
    """What the launch after an update found: a healthy new host, or a rollback.

    ``reason`` is filled whenever the release did not hold, and is the sentence a person
    reads next to the notification (slice 14).
    """

    version: str
    confirmed: bool
    rolled_back_to: str | None = None
    blocked: str | None = None
    restarted: bool = False
    reason: str | None = None


def confirm_or_roll_back(
    *,
    roots: ReleaseRoots,
    pending: PendingReleaseFile,
    blocked: BlockedReleases,
    beats: LatestBeats,
    host: ChildRecord | None,
    window: float,
    restart: Callable[[], None],
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
) -> ReleaseConfirmation | None:
    """Step 5: wait for the new host's first healthy beat, or put the old release back.

    Returns ``None`` when no update is pending, which is every ordinary launch. **Nothing is
    applied here** — a release waiting in staging is not looked at, let alone swapped. The
    only thing this function can move is the release that is *already* installed, backwards.

    "Healthy" is three facts together, and all three are load-bearing. The beat has to come
    from the process the host was started as, so a beat left over from the run before cannot
    confirm the update that replaced it. It has to carry the **new version**, so an old host
    that somehow survived the swap cannot confirm it either. And it has to say ``ready``: a
    host that starts and then sits there failing to serve is exactly what a heartbeat exists to
    tell the helper about.
    """
    entry = pending.current()
    if entry is None:
        return None

    version = str(entry.version)
    deadline = now() + window

    while True:
        if _is_host_healthy(beats, host=host, version=version):
            pending.clear()
            log.info("release %s reached a healthy heartbeat and is confirmed", version)
            return ReleaseConfirmation(version=version, confirmed=True)

        if now() >= deadline:
            break

        sleep(poll_interval)

    return _roll_back(
        roots=roots,
        pending=pending,
        blocked=blocked,
        entry=entry,
        window=window,
        restart=restart,
    )


def _roll_back(
    *,
    roots: ReleaseRoots,
    pending: PendingReleaseFile,
    blocked: BlockedReleases,
    entry: PendingRelease,
    window: float,
    restart: Callable[[], None],
) -> ReleaseConfirmation:
    """Block the version, put the previous release back, and start the application on it.

    The block is written **first**, on purpose. Every step after it can fail on a machine
    whose disk or permissions are the reason the update failed in the first place, and of all
    of them the block is the one whose loss would bring the failed version straight back at
    the next check.
    """
    version = str(entry.version)
    blocked.block(version)

    log.error(
        "release %s did not reach a healthy heartbeat within %gs; rolling back", version, window
    )

    try:
        roll_back_release(roots)
    except ReleaseApplyError as error:
        pending.clear()
        return ReleaseConfirmation(
            version=version,
            confirmed=False,
            blocked=version,
            reason=(
                f"release {version} did not reach a healthy heartbeat within {window:g}s and is "
                f"blocked, but it could not be rolled back: {error}"
            ),
        )

    pending.clear()

    restarted = True
    try:
        restart()
    except Exception as error:  # noqa: BLE001 - the rollback happened; the restart is reported
        restarted = False
        log.error("the application could not be restarted after the rollback: %s", error)

    rolled_back_to = entry.previous_version or _release_version(roots.live)
    return ReleaseConfirmation(
        version=version,
        confirmed=False,
        rolled_back_to=rolled_back_to,
        blocked=version,
        restarted=restarted,
        reason=(
            f"release {version} did not reach a healthy heartbeat within {window:g}s, so the "
            f"previous installation was put back and {version} is blocked"
        ),
    )


def roll_back_release(roots: ReleaseRoots) -> Path:
    """Put back the installation the last swap replaced, and return where it now lives.

    Refuses when nothing is kept, rather than removing the live installation and leaving the
    machine with none: "roll back to nothing" is not a rollback. The same two renames as
    :func:`~innytypes.helper.environments.roll_back`, on the application instead of a plugin.
    """
    kept = roots.previous
    live = roots.live

    if not kept.is_dir():
        raise ReleaseApplyError(
            f"there is nothing to roll back to at {kept}: a rollback restores the installation "
            "a swap replaced, and no swap has replaced one"
        )

    roots.root.mkdir(parents=True, exist_ok=True)

    discarded = roots.rolled_back
    _remove(discarded)

    moved = live.exists()
    if moved:
        _rename(live, discarded, version="the installed release")

    try:
        _rename(kept, live, version="the previous release")
    except ReleaseApplyError:
        if moved:
            _rename(discarded, live, version="the installed release")
        raise

    _remove(discarded)
    return live


def _is_host_healthy(beats: LatestBeats, *, host: ChildRecord | None, version: str) -> bool:
    """Whether the host this launch started has said it is ready, on the new version."""
    if host is None:
        return False

    received = beats.latest(host.id)
    if received is None or received.beat.pid != host.pid:
        return False
    if received.beat.version != version:
        return False
    return received.beat.state is ProcessState.READY


# ── reading and writing the small files ──────────────────────────────────────────────────────


def _read_marker(directory: Path, *, platform: str) -> ReadyRelease:
    """One ``ready.json``, with every field it must carry checked before it is believed."""
    marker = directory / READY_MARKER
    where = str(marker)

    try:
        document = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ReleaseApplyError(f"{where} could not be read: {error}") from error

    if not isinstance(document, Mapping):
        raise ReleaseApplyError(f"{where} is not a JSON object")

    if document.get("ready") is not True:
        raise ReleaseApplyError(
            f"{where} does not say `ready`: the marker is written last, after both checks "
            "pass, and its presence is the only thing an install may act on"
        )

    version = _version(document, where=where)
    if directory.name != str(version):
        raise ReleaseApplyError(
            f"{where} names version {version}, but it is staged in {directory.name!r}; a "
            "release whose marker and directory disagree is not one to install"
        )

    host_api = document.get("host_api")
    if not isinstance(host_api, int) or isinstance(host_api, bool) or host_api < 1:
        raise ReleaseApplyError(f"{where}: `host_api` must be a positive whole number")

    staged_for = _text(document, "platform", where=where)
    if staged_for != platform:
        raise ReleaseApplyError(
            f"{where} was staged for {staged_for!r} and this machine is {platform!r}; the "
            "wrong operating system's bundle passes every check and fails only once it runs"
        )

    name = _text(document, "artifact", where=where)
    if _ARTIFACT_NAME.match(name) is None:
        raise ReleaseApplyError(
            f"{where}: `artifact` is {name!r}, which is not a usable file name. The name is "
            "joined onto the staging directory, so anything with a separator in it is refused."
        )

    sha256 = _text(document, "sha256", where=where)
    if _SHA256.match(sha256) is None:
        raise ReleaseApplyError(f"{where}: `sha256` is not 64 lowercase hexadecimal characters")

    signature = _text(document, "signature", where=where)

    automatic = document.get("automatic")
    if not isinstance(automatic, bool):
        raise ReleaseApplyError(
            f"{where}: `automatic` must be true or false. It is what stops a host API change "
            "installing itself (D13), so a missing one is refused rather than assumed."
        )

    artifact_path = directory / name
    if not artifact_path.is_file():
        raise ReleaseApplyError(
            f"{where} names an artifact at {artifact_path}, and there is no such file"
        )

    return ReadyRelease(
        version=version,
        host_api=host_api,
        platform=staged_for,
        directory=directory,
        artifact_path=artifact_path,
        sha256=sha256,
        signature=signature,
        automatic=automatic,
        blocked_reason=str(document.get("blocked_reason", "")),
    )


def _insist_release(unpacked: Path, *, version: str, host_api: int) -> None:
    """Refuse to swap in a tree that cannot say it is the release that was verified.

    The check costs one small file and buys the one thing the signature cannot: the signature
    proves the *archive* is the published one, and this proves the archive **unpacked into
    what that release says it is**, rather than into an empty directory a half-finished
    extraction left behind.
    """
    marker = unpacked / RELEASE_MARKER
    try:
        document = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ReleaseApplyError(
            f"the release unpacked for {version} records nothing at {marker}: {error}. A tree "
            "that cannot say what it is does not become the installed application."
        ) from error

    if not isinstance(document, Mapping):
        raise ReleaseApplyError(f"{marker} is not a JSON object naming a version")

    unpacked_version = str(document.get("version", ""))
    if unpacked_version != version:
        raise ReleaseApplyError(
            f"{marker} says version {unpacked_version!r}, but the verified release is "
            f"{version}; the archive does not hold the release it was signed as"
        )

    unpacked_api = document.get("host_api")
    if unpacked_api != host_api:
        raise ReleaseApplyError(
            f"{marker} says host API {unpacked_api!r}, but the release index says {host_api}; "
            "the compatibility check was made against a number the bundle does not agree with"
        )


def _release_version(release: Path) -> str | None:
    """The version an installed release says it is, or ``None`` when it will not say.

    Only ever used to make a report readable, so a tree with no marker is reported as unknown
    rather than raising over a directory nobody was asked to repair.
    """
    try:
        document = json.loads((release / RELEASE_MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    version = document.get("version") if isinstance(document, Mapping) else None
    return version if isinstance(version, str) else None


def _recorded_host_api(addons_root: Path, plugin_id: str) -> int | None:
    """The `host_api` one plugin recorded at install time, or ``None`` when it cannot be read."""
    try:
        document = json.loads(
            recorded_manifest_path(addons_root, plugin_id).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None

    if not isinstance(document, Mapping):
        return None

    host_api = document.get("host_api")
    if not isinstance(host_api, int) or isinstance(host_api, bool):
        return None
    return host_api


def _host_wheel(release: Path, version: str) -> Path:
    """The ``innytypes`` wheel inside a release, refusing a release that carries none."""
    wheels = sorted((release / WHEEL_DIRNAME).glob(f"innytypes-{version}-*.whl"))
    if not wheels:
        raise ReleaseApplyError(
            f"release {version} carries no innytypes wheel in {release / WHEEL_DIRNAME}, so "
            "the host version cannot be moved inside any environment without resolving one "
            "from an index — which an update never does"
        )
    if len(wheels) > 1:
        raise ReleaseApplyError(
            f"release {version} carries {len(wheels)} innytypes wheels in "
            f"{release / WHEEL_DIRNAME}; a release installs one"
        )
    return wheels[0]


def _sha256(path: Path) -> str:
    """The SHA-256 of a file, read in chunks so a whole bundle is never held in memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def _version(document: Mapping[str, object], *, where: str) -> Version:
    """The `version` field, as a version, with the refusal phrased as this module's own.

    :func:`~innytypes.helper.update.parse_version` raises that module's error type, and a
    caller of this one should have exactly one family to catch — the two modules are read
    together but they are not the same gate.
    """
    try:
        return parse_version(_text(document, "version", where=where), where=where)
    except UpdateError as error:
        raise ReleaseApplyError(str(error)) from error


def _text(document: Mapping[str, object], key: str, *, where: str) -> str:
    """One required text field, refusing an absent or empty one by name."""
    value = document.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ReleaseApplyError(f"{where}: `{key}` must be a non-empty string")
    return value


def _rename(source: Path, destination: Path, *, version: str) -> None:
    """One atomic rename, with every way it can fail named after what was being installed."""
    try:
        os.replace(source, destination)
    except OSError as error:
        raise ReleaseApplyError(
            f"{version}: {source} could not be moved to {destination}: {error}. An "
            "installation is swapped by renaming it, which needs both paths on one filesystem."
        ) from error


def _remove(path: Path) -> None:
    """Delete a file or a whole directory, saying nothing when it was not there."""
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)
