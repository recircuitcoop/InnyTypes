"""One icon starts everything — and every way of turning the whole application off again.

The owner's hard requirement (plan 0003, F1) is the reason this module exists: **"there has to
be a clear and easy way of turning the whole InnyTypes application off!"** Everything below is
either a way of starting the application or a way of ending it, and the ending half is the half
that is not allowed to fail.

**Starting** (plan 0003, *How the application starts*). The clickable icon launches
``innytypes-helper`` (D27), and :meth:`Application.start` is what that entry point runs:

1. Take the **single-instance lock**. A second launch finds the lock held by a helper whose
   identity still verifies, brings the running application's window forward, and starts
   **nothing** — no second helper, no second host, no second MCP server, no second plugin.
2. Start the **Anytype desktop app**, or **adopt** it when it is already running (F6), and
   remember which of the two happened, because that decides whether quitting stops it.
3. Start the **host**, which starts the MCP server and the plugins itself (plan 0001 slice 07).

**Ending.** Every row of the plan's *Turning InnyTypes off* table ends up in one of three
places here: :meth:`Application.quit` (the Quit menu item, the Dock's Quit, a logout, and any
signal the helper can catch), :meth:`Quitter.quit` (``innytypes quit`` from another process)
and :meth:`Quitter.force` (``innytypes quit --force``, for when something is hung). All three
**record the quit before they stop anything**, which is what stops a quit from looking like a
pile of crashes: :meth:`Application.child_exited` refuses to restart, count or quarantine
anything at all while a quit is on record.

**The one other thing a quit does.** A core update verified and staged by
:mod:`innytypes.helper.update` is swapped in **here**, after the last process has stopped and
before the helper ends (plan 0003, D11): the files being replaced are the ones everything else
was running out of a moment ago, and the helper is the last process left to replace them.
Nothing is applied during startup; what a *launch* does is confirm the release it is running,
or put the previous one back (:mod:`innytypes.helper.swap`). Both are injected seams, so an
application built without them quits and starts exactly as before. ``innytypes quit --force``
applies nothing, and that is correct rather than an omission: a forced quit is what a person
types when something is hung, and installing an update on the way out of a hang is the last
thing they asked for.

**The rule that makes the application turn-off-able at all.** The helper restarts the host, and
the host relaunches the helper — so without a rule, the two would bring each other back for
ever and there would be no way off the machine. :class:`HelperWatch` is that rule, on the host's
side: a helper that **crashed** (a non-zero exit code, or a crash signal — segmentation fault,
abort, bus error) is relaunched, and a helper that was **stopped from outside** (terminate,
interrupt, kill, Activity Monitor, Task Manager) is not. The second case means the user wants
InnyTypes off, so the host shuts itself and its children down instead.

**Where the safe direction points.** Every uncertain case here resolves towards *off*: a helper
that ended in a way nothing can classify is treated as stopped rather than crashed, a quit file
that cannot be parsed still counts as a quit, and an Anytype the application merely adopted is
never stopped by any quit, forced or not. Being wrong towards "off" costs a user one click on
the icon. Being wrong towards "on" costs them an application they cannot turn off, which is the
one thing the owner said must not happen.

**Every seam that touches the machine is injected**, exactly as in
:mod:`innytypes.helper.processes`: the process table, the signaller, the thing that launches a
process, the list of running applications, the clock, the login-item hook, and the paths of the
lock, the quit record and the run-state file. The gate starts no process, sends no signal and
sleeps not at all.

**What an unpackaged run has, and what a bundle adds.** :func:`default_host_command` and
:func:`default_anytype_executable` are what an installation without a bundle runs, and they
are unchanged by the packaging: the application works from a `pip install` exactly as it
always did. What the BeeWare Briefcase bundles (F5) add is the two things that need an
installed identity. Registering a login item (F7) is one of them —
:class:`UnpackagedLoginItem` still **refuses out loud** for a run with no bundle, because a
hook that quietly did nothing would leave the switch reading "on" while nothing starts at
login, and :func:`default_login_item` is the one place that decides which of the two this
installation gets. The other is the drawing: :func:`main` builds a real window when a toolkit
is installed (:mod:`innytypes.helper.toolkit`) and a headless one when it is not, and both are
applications the user can turn off.
"""

from __future__ import annotations

import json
import os
import platform as platform_module
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from types import FrameType
from typing import TYPE_CHECKING, Protocol, cast

import httpx
from platformdirs import user_runtime_path

from innytypes import __version__
from innytypes.addons.discovery import default_addons_root, discover_addons
from innytypes.addons.install import AddonInstaller, UvInstaller
from innytypes.addons.manifest import parse_requirement
from innytypes.addons.secrets import SecretStore, default_secrets_root
from innytypes.addons.settings_form import PluginState as AvailabilityState
from innytypes.anytype_mcp.config import ConfigError as AnytypeConfigError
from innytypes.anytype_mcp.config import load_api_key
from innytypes.anytype_mcp.keys import (
    KeyAcquisitionError,
    PairingSession,
    complete_pairing,
    start_pairing,
)
from innytypes.children import (
    ChildExit,
    ChildKind,
    ChildProcess,
    ChildRecord,
    Command,
    CommandResult,
    RunStateError,
    RunStateFile,
    default_run_state_path,
)
from innytypes.helper.breaker import (
    HOST_ID,
    Breaker,
    ProcessStatus,
    QuarantineFile,
    RunState,
)
from innytypes.helper.config import APPLICATION_NAME, HelperSettings, RestartSettings
from innytypes.helper.control import ControlListener, ControlSocketError, recorded_host_pid
from innytypes.helper.enablement import plugin_states
from innytypes.helper.processes import (
    ManagedProcesses,
    ProcessFacts,
    ProcessTable,
    Stop,
    Stopped,
    SystemProcessTable,
)
from innytypes.helper.restart import ControlChannel, RestartPolicy, ScheduledRestart
from innytypes.helper.settings_watch import SettingsWatch
from innytypes.helper.swap import (
    AppliedRelease,
    BlockedReleases,
    PendingReleaseFile,
    ReleaseApplier,
    ReleaseApplyError,
    ReleaseConfirmation,
    ReleaseRoots,
    UvCoreInstaller,
    default_blocked_core_versions_path,
    default_core_staging_path,
    default_helper_environment,
    default_pending_release_path,
    default_release_roots,
    read_ready_release,
)
from innytypes.helper.telemetry import (
    DEFAULT_ENDPOINTS,
    Endpoints,
    InstalledPlugin,
    MachineIdentifierSource,
    ReportQueue,
    TelemetryPipeline,
    UsageSnapshot,
    default_queue_path,
    os_machine_identifier,
)
from innytypes.helper.update import (
    READY_MARKER,
    StagedRelease,
    UpdateError,
    load_installed_public_key,
)
from innytypes.helper.versions import PluginReport, VersionCheck
from innytypes.logs import get_logger

if TYPE_CHECKING:
    # Both of these import *this* module — the window is built on the launcher's quit and its
    # login item, and the page is built on the window — so they are names here and real
    # imports inside :func:`build_window`, exactly as :func:`default_login_item` does it.
    from innytypes.helper.plugins import PluginPage
    from innytypes.helper.window import ApplicationWindow, Desktop, UpdateRow

__all__ = [
    "ANYTYPE_APP_ID",
    "CRASH_SIGNALS",
    "EXTERNAL_STOP_SIGNALS",
    "HELPER_ID",
    "HOST_ARGUMENT",
    "LOCK_FILENAME",
    "QUIT_FILENAME",
    "QUIT_ORDER",
    "AnytypeStart",
    "Application",
    "ApplyUpdate",
    "ConfirmRelease",
    "HelperEnding",
    "HelperExit",
    "HelperWatch",
    "HelperWindow",
    "HostResponse",
    "LaunchAtLogin",
    "LaunchAtLoginError",
    "LockOutcome",
    "LoginItem",
    "InstanceLock",
    "LatestVersionCheck",
    "QuitFile",
    "QuitReason",
    "QuitRecord",
    "QuitReport",
    "Quitter",
    "RequestedRelease",
    "RunningApplications",
    "Start",
    "StartProcess",
    "StartReport",
    "SystemApplications",
    "UnpackagedLoginItem",
    "bring_window_forward",
    "build_quitter",
    "build_window",
    "bundled_launcher",
    "default_anytype_executable",
    "default_host_command",
    "default_lock_path",
    "default_login_item",
    "default_quit_path",
    "default_start_process",
    "install_quit_handlers",
    "main",
    "quit_order",
    "quit_reason_for_signal",
    "recorded_statuses",
    "release_applier",
    "run_bundled",
    "run_host",
    "staged_core_release",
    "started_by_this_application",
    "this_helper",
    "this_machine_usage",
]

log = get_logger(__name__)

# The helper's own id and kind in the run-state file. The helper records **itself** there, and
# that is a deliberate addition to what plan 0001 slice 07 wrote: `innytypes quit --force` has
# to be able to stop every InnyTypes process by its verified identity from a process that is
# neither the helper nor the host, and a helper absent from the file would be the one process
# a forced quit could not reach.
HELPER_ID = "innytypes.helper"

# The Anytype desktop app's id in the same file. Namespaced under `innytypes` like every other
# id in it: the record is this application's note about a process it watches, not Anytype's.
ANYTYPE_APP_ID = "innytypes.anytype-app"

# How the bundle's one launcher is told to be the **host** rather than the helper (F5). An
# installed bundle has no Python executable to hand `-m innytypes up` to, so the application
# starts a second copy of itself with this argument instead. See `default_host_command`.
HOST_ARGUMENT = "--innytypes-host"

LOCK_FILENAME = "helper.lock"
QUIT_FILENAME = "quit.json"

# The order everything is stopped in: plugins, the MCP server, the host, Anytype, the helper
# last (plan 0003, *How the application starts*). Reverse of the order it all came up in, so
# nothing is ever left talking to a process that has already gone.
QUIT_ORDER = (
    ChildKind.ADDON,
    ChildKind.MCP,
    ChildKind.HOST,
    ChildKind.ANYTYPE_APP,
    ChildKind.HELPER,
)


def _signals(*names: str) -> frozenset[int]:
    """The signals of these names that exist on this platform, as numbers.

    Looked up rather than written as literals because Windows has almost none of them, and a
    module that imported a missing one would fail at import time on the platform plan 0003
    slice 16 is about.
    """
    found = (getattr(signal, name, None) for name in names)
    return frozenset(int(number) for number in found if number is not None)


# A crash, as the plan defines one: the process died of a fault rather than being asked to
# stop. These are the only endings the host ever relaunches a helper for.
CRASH_SIGNALS = _signals("SIGSEGV", "SIGABRT", "SIGBUS", "SIGILL", "SIGFPE")

# Someone outside the application ended it: a terminate from `kill`, an interrupt from Ctrl-C,
# an unstoppable kill from Activity Monitor or Task Manager, or a session ending at logout.
EXTERNAL_STOP_SIGNALS = _signals("SIGTERM", "SIGINT", "SIGKILL", "SIGHUP", "SIGQUIT")


# ── where the two runtime files live ─────────────────────────────────────────────────────────


def default_lock_path() -> Path:
    """Where the single-instance lock lives for this user, creating nothing.

    In the per-user **runtime** directory beside the run-state file and the quarantines, and
    for the same reason: it describes this moment. A lock that survived a reboot would be a
    machine that comes back up refusing to start the application it is holding a lock for.
    """
    return user_runtime_path(APPLICATION_NAME, appauthor=False) / LOCK_FILENAME


def default_quit_path() -> Path:
    """Where a quit is recorded for this user, creating nothing."""
    return user_runtime_path(APPLICATION_NAME, appauthor=False) / QUIT_FILENAME


# ── the quit record ──────────────────────────────────────────────────────────────────────────


class QuitReason(StrEnum):
    """Which of the plan's ways of turning InnyTypes off this quit came from.

    Every one of them ends the same way — the whole application off, nothing relaunched — so
    the reason exists to be *read afterwards*, in a log or in `innytypes helper status`, not to
    be branched on. The one value that is not a row of the table is :data:`UNKNOWN`.
    """

    MENU = "menu"
    DOCK = "dock"
    COMMAND_LINE = "command-line"
    EXTERNAL_STOP = "external-stop"
    LOGOUT = "logout"
    FORCED = "forced"
    # A quit record that could not be read. Something wrote one, and the only safe reading of
    # "a quit was recorded, contents unclear" is that the user wants InnyTypes off.
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class QuitRecord:
    """One quit, as it was written down before anything was stopped."""

    reason: QuitReason
    at: float


@dataclass
class QuitFile:
    """The "a quit is happening" note, on disk, because three processes have to agree about it.

    The helper writes it before it stops anything; the host reads it before it decides whether
    a dead helper crashed; ``innytypes quit`` writes it from a third process entirely. An
    in-memory flag would be invisible to the other two, and the consequence of that invisibility
    is the exact bug the note prevents: a deliberate shutdown read as a pile of crashes, every
    process restarted, and an application that will not turn off.

    It is removed by the next start, not by the quit, so the record outlives the processes that
    were stopped — which is what makes it readable by anything that notices their exits.
    """

    path: Path = field(default_factory=default_quit_path)

    def record(self, reason: QuitReason, *, at: float) -> QuitRecord:
        """Write the quit down. Called **before** the first process is stopped, always."""
        entry = QuitRecord(reason=reason, at=at)
        document = {"reason": str(entry.reason), "at": entry.at}

        self.path.parent.mkdir(parents=True, exist_ok=True)
        # A scratch name of this process's own, because the helper and `innytypes quit` can
        # both be writing this file, exactly as the run-state file is written.
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.new")
        temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)

        log.info("recorded a quit (%s) before stopping anything", entry.reason)
        return entry

    def current(self) -> QuitRecord | None:
        """The quit on record, or ``None`` when there is none.

        Anything unreadable answers :data:`QuitReason.UNKNOWN` rather than ``None``: a file
        that exists at all means something recorded a quit, and reading it as "no quit" would
        turn a deliberate shutdown back into a restart loop over a JSON error.
        """
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError:
            return QuitRecord(reason=QuitReason.UNKNOWN, at=0.0)

        try:
            document = json.loads(text)
            return QuitRecord(reason=QuitReason(document["reason"]), at=float(document["at"]))
        except (ValueError, TypeError, KeyError):
            return QuitRecord(reason=QuitReason.UNKNOWN, at=0.0)

    def clear(self) -> None:
        """Forget the last quit. Only a **start** does this: a new run is not the old one."""
        self.path.unlink(missing_ok=True)


# ── the single-instance lock ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LockOutcome:
    """Whether this process got the lock, and who has it when it did not."""

    held: bool
    # The helper that holds it, when this process did not get it. `None` when we hold it.
    holder: ChildRecord | None = None


@dataclass
class InstanceLock:
    """The one-helper-per-user lock, and the identity check that keeps it from being a trap.

    The file holds **one run-state record** — the helper's own — rather than a bare process ID,
    so the holder is checked by exactly the same three comparisons as everything else this
    application signals (:class:`~innytypes.helper.processes.ManagedProcesses`): process ID,
    start time and executable path. That matters twice over. A lock left behind by a helper
    that was killed names a process ID that now means nothing, or means something else
    entirely, and either way the check says so and the lock is taken over — a stale file must
    never lock a user out of their own application. And the check is not a second
    implementation: it is the same call, on the same record shape, so the two cannot drift.
    """

    path: Path
    processes: ManagedProcesses

    def acquire(self, me: ChildRecord) -> LockOutcome:
        """Take the lock for ``me``, or report the live helper that already holds it."""
        for attempt in (1, 2):
            try:
                self._create(me)
                return LockOutcome(held=True)
            except FileExistsError:
                holder = self.holder()
                if holder is not None and self.processes.check(holder).is_ours:
                    log.info(
                        "another InnyTypesHelper is already running (process %s); "
                        "this launch starts nothing",
                        holder.pid,
                    )
                    return LockOutcome(held=False, holder=holder)

                # Nobody is behind this lock: a helper that was killed, or a file left by a
                # machine that went down. Take it over rather than refusing to start.
                log.info("taking over a lock left behind at %s", self.path)
                self.path.unlink(missing_ok=True)
                if attempt == 2:
                    # Two failures in a row means someone else is racing us for the same
                    # lock, and they won. Theirs is the running application.
                    return LockOutcome(held=False, holder=self.holder())

        raise AssertionError("unreachable")  # pragma: no cover

    def holder(self) -> ChildRecord | None:
        """The helper the lock file names, or ``None`` when there is no readable lock."""
        try:
            document = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            return None
        except OSError:
            return None

        try:
            return ChildRecord.from_document(document)
        except RunStateError:
            # A lock file we cannot read names nobody, so it protects nobody. Treated as
            # absent, which the caller turns into "take it over".
            return None

    def release(self) -> None:
        """Drop the lock. Removing a lock that is already gone is not an error."""
        self.path.unlink(missing_ok=True)

    def _create(self, me: ChildRecord) -> None:
        """Create the lock file, failing if it exists. Atomic: ``O_CREAT | O_EXCL``."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(me.to_document(), handle, indent=2, sort_keys=True)


# ── starting things ──────────────────────────────────────────────────────────────────────────


# How a process is launched by the helper. Narrower than
# :class:`innytypes.children.Spawn` on purpose: the helper is not the host, it holds no pipe to
# the host or to Anytype and it has no event channel to hand either of them, so a seam carrying
# those would be a seam promising something this module never does.
StartProcess = Callable[[Sequence[str]], ChildProcess]


def default_start_process(argv: Sequence[str]) -> ChildProcess:
    """Launch one process with the helper's own stdio, which is where its log goes."""
    return subprocess.Popen(list(argv))


class RunningApplications(Protocol):
    """How the helper asks whether an application is already running (F6).

    One question, by executable path, because that is the only thing the helper knows about
    Anytype that the OS also knows. It is a protocol of its own rather than another method on
    :class:`~innytypes.helper.processes.ProcessTable`: that one answers about a process ID it
    was given, and this one has to go looking.
    """

    def find(self, executable: str) -> ProcessFacts | None:
        """The running process with this executable, or ``None`` when there is none."""
        ...


class SystemApplications:
    """The real list of running applications on this machine, read through ``psutil``.

    The import is inside the method for the same reason as in
    :mod:`innytypes.helper.processes`: nothing in the gate reads the real process table, and a
    module-wide import would make every test pay for a library none of them call.
    """

    def find(self, executable: str) -> ProcessFacts | None:
        """Look for one executable among every process this user may read."""
        import psutil

        for process in psutil.process_iter(["pid", "exe", "create_time"]):
            try:
                if process.info["exe"] != executable:
                    continue
                return ProcessFacts(
                    pid=int(process.info["pid"]),
                    started_at=float(process.info["create_time"]),
                    executable=executable,
                )
            except (psutil.Error, OSError, TypeError, ValueError):
                # A process that went away mid-scan, or one this user may not read. Neither
                # is the one we are looking for as far as this scan can tell.
                continue

        return None


def default_anytype_executable() -> str | None:
    """Where the Anytype desktop app is on this machine, or ``None`` when it is not installed.

    Resolved to a **path**, never a bare command name, because the path is what the process
    table reports and what the run-state record has to match (plan 0003, *Phantom detection*).
    An absent Anytype is a documented degradation rather than a failure to start: the helper,
    the host and every plugin that does not need Anytype still come up.
    """
    if sys.platform == "darwin":
        bundled = Path("/Applications/Anytype.app/Contents/MacOS/Anytype")
        if bundled.exists():
            return str(bundled)

    found = shutil.which("anytype")
    return found if found is None else str(Path(found).resolve())


def bundled_launcher(executable: str | None = None) -> str | None:
    """This process's own launcher when it is an installed application, else ``None``.

    The question being asked is narrow and practical: **can ``sys.executable`` be handed
    ``-m innytypes up``?** A Briefcase bundle ships the interpreter as a framework (macOS) or a
    library (Windows) and exactly one executable — the application's own launcher — so it
    cannot. A virtual environment's `python`, a system `python3.13` and `briefcase dev` all
    can, and all three are the same case.

    It is answered from the executable's **name**, because that is the one fact every platform
    agrees on and the only one available without starting a process. Being wrong either way is
    visible immediately rather than silently: a launcher mistaken for an interpreter produces
    the host failing to start, and an interpreter mistaken for a launcher produces a Python
    complaining about an unknown option. Neither can be mistaken for a working application.
    """
    running = sys.executable if executable is None else executable
    # `python`, `python3`, `python3.13`, `python.exe`, `pythonw.exe`.
    return None if Path(running).stem.lower().startswith("python") else running


def default_host_command(executable: str | None = None) -> tuple[str, ...]:
    """The command that starts the host, in the one form this installation can spell.

    ``python -m innytypes up`` rather than the ``innytypes`` console script, because the
    record written for the host has to carry the executable the OS will report — and for a
    console script that is the interpreter, not the script. Recording the script's path would
    produce a record that can never be verified, and an unverifiable record is one nothing will
    ever signal (:mod:`innytypes.helper.processes`).

    **An installed bundle has no interpreter to name** (F5), so it names itself.
    :data:`HOST_ARGUMENT` is how the application's single launcher is told which of its two
    jobs to do, and :func:`run_bundled` is where that is read. The record is as verifiable as
    before — it carries the launcher's path, which is exactly what the OS reports for the
    process it starts — and the helper and the host remain two processes, told apart by their
    process ids as they always were.
    """
    running = sys.executable if executable is None else executable
    if bundled_launcher(running) is not None:
        return (running, HOST_ARGUMENT)
    return (running, "-m", "innytypes", "up")


def this_helper(
    *,
    table: ProcessTable | None = None,
    clock: Callable[[], float] = time.time,
) -> ChildRecord:
    """This helper process's own run-state record: the three facts, read from the OS.

    The start time comes from the process table when it will answer, because that is the value
    every later identity check is compared against. The clock is the fallback for a platform or
    a permission that will not tell us, and it is close enough for the tolerance the check
    allows (:data:`~innytypes.helper.processes.START_TIME_TOLERANCE`).
    """
    pid = os.getpid()
    facts = (SystemProcessTable() if table is None else table).facts(pid)

    return ChildRecord(
        id=HELPER_ID,
        kind=ChildKind.HELPER,
        pid=pid,
        started_at=clock() if facts is None else facts.started_at,
        executable=sys.executable if facts is None else facts.executable,
        parent_pid=os.getppid(),
    )


def bring_window_forward() -> None:
    """Show the running application's window, for a second launch that starts nothing.

    A documented seam. The application's window is plan 0003's own later slice; until it
    exists there is nothing to raise, and the honest behaviour of a second launch is to say so
    and exit rather than to start a second copy of everything.
    """
    log.info("InnyTypes is already running; bringing its window forward")


class Start(StrEnum):
    """What a launch did: started the application, or found it already running."""

    STARTED = "started"
    ALREADY_RUNNING = "already-running"


class AnytypeStart(StrEnum):
    """Which of the three things happened to the Anytype desktop app at startup (F6).

    :data:`ADOPTED` is the one with consequences: an Anytype the application did not start is
    never stopped when the application quits, however that quit was asked for.
    """

    STARTED = "started"
    ADOPTED = "adopted"
    MISSING = "missing"


@dataclass(frozen=True)
class StartReport:
    """What one launch did, in full: enough to tell a second launch from a first."""

    outcome: Start
    anytype: AnytypeStart | None = None
    # Every record this launch wrote: the helper's own, Anytype's, the host's.
    records: tuple[ChildRecord, ...] = ()
    # The helper that was already running, when this launch found one.
    holder: ChildRecord | None = None
    # What this launch found out about the release it is running, when the application was
    # built with a way to confirm one. ``None`` means no update was waiting to be confirmed.
    confirmation: ReleaseConfirmation | None = None

    @property
    def started(self) -> bool:
        """Whether this launch actually brought the application up."""
        return self.outcome is Start.STARTED


def started_by_this_application(record: ChildRecord) -> bool:
    """Whether the application started this process, or merely adopted it (F6).

    An adopted process is recorded as **its own parent**, which is not a trick: it had no
    parent in this application, it was running before the helper and it must outlive it. The
    convention also makes it impossible for an adopted Anytype to be read as an orphan of ours
    and stopped as one, because its recorded parent is alive exactly as long as it is.
    """
    return record.parent_pid != record.pid


# ── the two moments a core update touches the application (plan 0003, D11) ───────────────────

# What a **quit** does about a release waiting in staging: swap it in, or say why it is still
# waiting (:meth:`innytypes.helper.swap.ReleaseApplier.apply_at_quit`). It is a seam rather
# than a call into :mod:`innytypes.helper.swap` so that the one rule that matters here — the
# swap happens at quit and at no other moment — is visible in this file, where quitting lives.
ApplyUpdate = Callable[[], AppliedRelease | None]

# What a **launch** does about a release that was swapped in by the last quit: wait for the new
# host's first healthy heartbeat, or put the previous installation back
# (:func:`innytypes.helper.swap.confirm_or_roll_back`). It takes the host's record because the
# beat it is waiting for has to come from *that* process. It never applies anything: a release
# in staging is not looked at here, which is what "nothing is applied during startup" means.
ConfirmRelease = Callable[[ChildRecord], ReleaseConfirmation | None]


def quit_order(records: Iterable[ChildRecord]) -> tuple[ChildRecord, ...]:
    """Every record in the order a quit stops them: plugins, MCP, host, Anytype, helper last.

    Reverse of the order they started in. Within one kind the order is by id, so two runs of
    the same quit stop the same processes in the same order and a log of one reads like a log
    of the other.
    """
    return tuple(sorted(records, key=lambda record: (QUIT_ORDER.index(record.kind), record.id)))


@dataclass(frozen=True)
class QuitReport:
    """What a quit stopped, and what it could not."""

    reason: QuitReason
    stopped: tuple[Stopped, ...] = ()
    # What this quit did about a staged core update, when the application was built with a
    # way to apply one. ``None`` means nothing was waiting, or nothing was wired.
    update: AppliedRelease | None = None

    @property
    def signalled(self) -> tuple[ChildRecord, ...]:
        """Every process this quit actually sent a signal to."""
        return tuple(stop.record for stop in self.stopped if stop.signalled)

    @property
    def left_running(self) -> tuple[ChildRecord, ...]:
        """Every process still alive after a forced kill. Empty is what a quit promises."""
        return tuple(stop.record for stop in self.stopped if stop.outcome is Stop.STILL_RUNNING)


class Application:
    """The whole InnyTypes application, from the icon being clicked to the last process going.

    One object owns starting and quitting because the two share the facts that decide the
    second: whether Anytype was started or adopted, what the lock says, and what is in the
    run-state file. Splitting them would mean two places that both believe they know whether
    Anytype is ours to stop.
    """

    def __init__(
        self,
        *,
        lock: InstanceLock,
        processes: ManagedProcesses,
        run_state: RunStateFile,
        quits: QuitFile,
        applications: RunningApplications,
        start_process: StartProcess = default_start_process,
        host_command: Sequence[str] | None = None,
        anytype_executable: str | None = None,
        identity: Callable[[], ChildRecord] = this_helper,
        policy: RestartPolicy | None = None,
        breaker: Breaker | None = None,
        show_window: Callable[[], None] = bring_window_forward,
        clock: Callable[[], float] = time.time,
        apply_update: ApplyUpdate | None = None,
        confirm_release: ConfirmRelease | None = None,
    ) -> None:
        self._lock = lock
        self._processes = processes
        self._run_state = run_state
        self._quits = quits
        self._applications = applications
        self._start_process = start_process
        self._host_command = tuple(default_host_command() if host_command is None else host_command)
        self._anytype_executable = anytype_executable
        self._identity = identity
        self._policy = policy
        self._breaker = breaker
        self._show_window = show_window
        self._clock = clock
        self._apply_update = apply_update
        self._confirm_release = confirm_release

        self._anytype: AnytypeStart | None = None

    # ── starting ──────────────────────────────────────────────────────────────────────────

    @property
    def anytype(self) -> AnytypeStart | None:
        """Whether Anytype was started by this application, adopted, or not there at all."""
        return self._anytype

    @property
    def quitting(self) -> bool:
        """Whether a quit is on record. Nothing is restarted, counted or quarantined while it is."""
        return self._quits.current() is not None

    def start(self) -> StartReport:
        """Take the lock, bring Anytype up or adopt it, and start the host.

        A launch that finds the lock held starts **nothing at all** and returns before any of
        the rest: not a helper, not Anytype, not the host, and therefore not the MCP server or
        any plugin either, because those are the host's to start.
        """
        me = self._identity()
        outcome = self._lock.acquire(me)

        if not outcome.held:
            self._show_window()
            return StartReport(outcome=Start.ALREADY_RUNNING, holder=outcome.holder)

        self._run_state.write(me)
        # The last run's quit belongs to the last run. Leaving it would tell this run's host
        # that a quit is in progress, and nothing would ever be restarted again.
        self._quits.clear()

        records = [me]
        anytype = self._start_anytype()
        if anytype is not None:
            records.append(anytype)
        host = self._start_host()
        records.append(host)

        return StartReport(
            outcome=Start.STARTED,
            anytype=self._anytype,
            records=tuple(records),
            confirmation=self._confirm(host),
        )

    def _confirm(self, host: ChildRecord) -> ReleaseConfirmation | None:
        """Confirm the release this launch is running, or put the previous one back (D11).

        **Nothing is applied here.** A verified release waiting in staging is not read, not
        unpacked and not swapped — that happens at the *next quit* and nowhere else. The only
        thing this can move is the installation that is already live, backwards, when the
        update the last quit applied does not come up healthy.

        A failure to confirm is logged rather than raised. The application has already started
        by this point, and an exception thrown out of the confirmation would turn "the update
        could not be confirmed" into "the application would not start".
        """
        if self._confirm_release is None:
            return None

        try:
            return self._confirm_release(host)
        except Exception as error:  # noqa: BLE001 - a launch is not failed by a confirmation
            log.error("the release this launch is running could not be confirmed: %s", error)
            return None

    def _start_anytype(self) -> ChildRecord | None:
        """Start the Anytype desktop app, or adopt the one already running (F6)."""
        if self._anytype_executable is None:
            self._anytype = AnytypeStart.MISSING
            log.warning(
                "the Anytype desktop app was not found on this machine; InnyTypes starts "
                "without it and everything that does not need it still runs"
            )
            return None

        running = self._applications.find(self._anytype_executable)
        if running is not None:
            self._anytype = AnytypeStart.ADOPTED
            log.info("adopting the Anytype desktop app already running as process %s", running.pid)
            record = ChildRecord(
                id=ANYTYPE_APP_ID,
                kind=ChildKind.ANYTYPE_APP,
                pid=running.pid,
                started_at=running.started_at,
                executable=running.executable,
                # Its own parent: it was here before us, it is not ours to stop, and it must
                # never be read as an orphan of this application.
                parent_pid=running.pid,
            )
            self._run_state.write(record)
            return record

        self._anytype = AnytypeStart.STARTED
        return self._launch(
            child_id=ANYTYPE_APP_ID,
            kind=ChildKind.ANYTYPE_APP,
            argv=(self._anytype_executable,),
        )

    def _start_host(self) -> ChildRecord:
        """Start the host, which starts the MCP server and the plugins itself."""
        return self._launch(child_id=HOST_ID, kind=ChildKind.HOST, argv=self._host_command)

    def relaunch_host(self) -> ChildRecord:
        """Start the host again, for the helper's own restart policy.

        The host is the one managed process the helper both decides about **and** spawns (plan
        0003, *The helper owns every restart*): every other restart is a command the host
        carries out, and a command telling the host to start itself would have to reach the
        process that has gone. Whether and when is still the policy's, and stopping the host
        that hung and the orphans it left is done before this is called
        (:class:`innytypes.helper.supervision.HostRestarts`, which routes a due host restart
        here) — all this does is start it and record the process that is now the host.
        """
        return self._start_host()

    def _launch(self, *, child_id: str, kind: ChildKind, argv: Sequence[str]) -> ChildRecord:
        """Launch one process and write the record that makes it safe to signal later."""
        process = self._start_process(argv)
        record = ChildRecord(
            id=child_id,
            kind=kind,
            pid=process.pid,
            # Read after the spawn returned, which is why the identity check compares start
            # times within a tolerance rather than exactly.
            started_at=self._clock(),
            executable=argv[0],
            parent_pid=os.getpid(),
        )
        self._run_state.write(record)
        log.info("started %s (process %s)", child_id, record.pid)
        return record

    # ── quitting ──────────────────────────────────────────────────────────────────────────

    def quit(self, reason: QuitReason) -> QuitReport:
        """Turn the whole application off: record the quit first, then stop everything.

        The order of those two halves is the whole point. The record goes down **before** the
        first signal, so every exit that follows is already known to be part of a quit —
        nothing is restarted, nothing is counted towards a breaker and nothing is reported as
        an error. A quit that stopped things first would look, from the outside, exactly like
        the application falling over.

        The helper itself is not signalled here, because the helper is this process: it forgets
        its own record, drops the lock, and the caller returns from its entry point.

        **This is where a staged core update is applied** (D11), between the last process
        stopping and this one ending. It could not happen anywhere else: the files being
        replaced are the ones the host, the MCP server and the plugins were running out of a
        moment ago, and the helper is the only process left to do the replacing.
        """
        self._quits.record(reason, at=self._clock())

        stopped: list[Stopped] = []
        for record in quit_order(self._processes.records()):
            if record.kind is ChildKind.HELPER:
                continue
            if record.kind is ChildKind.ANYTYPE_APP and not started_by_this_application(record):
                log.info("leaving the Anytype desktop app running: this application adopted it")
                continue
            stopped.append(self._processes.stop(record))

        applied = self._apply()

        self._run_state.forget(HELPER_ID)
        self._lock.release()
        log.info("InnyTypes is off (%s)", reason)
        return QuitReport(reason=reason, stopped=tuple(stopped), update=applied)

    def _apply(self) -> AppliedRelease | None:
        """Swap in the release waiting in staging, now that nothing is running out of it.

        Every failure is caught and reported rather than raised. Turning the application off is
        the one thing the owner said must always work (F1), and an update that could not be
        installed must never be a reason the user cannot quit — the release simply stays in
        staging and the next quit tries again.
        """
        if self._apply_update is None:
            return None

        try:
            return self._apply_update()
        except Exception as error:  # noqa: BLE001 - a quit is never failed by an update
            log.error("the staged update could not be applied during this quit: %s", error)
            return None

    def child_exited(self, exit_report: ChildExit) -> ScheduledRestart | None:
        """What a child's exit means — which, during a quit, is nothing at all.

        Outside a quit this is the ordinary path: the breaker counts the intervention and the
        restart policy decides when the process comes back. During a quit it is a hard stop.
        Not a restart that is refused later, not an intervention counted "just in case": the
        exit is logged and the method returns, because a process exiting during a quit is the
        quit working.
        """
        if self.quitting:
            log.info(
                "%s (process %s) exited during a quit; nothing is restarted",
                exit_report.id,
                exit_report.pid,
            )
            return None

        if self._policy is None:
            return None

        if exit_report.expected:
            # Deliberate stops are the policy's business to ignore, and they are not
            # interventions: nothing went wrong.
            return self._policy.child_exited(exit_report)

        if self._breaker is not None and not self._breaker.record(
            exit_report.id, reason=f"exited with code {exit_report.exit_code}"
        ):
            return None

        return self._policy.child_exited(exit_report)


# ── turning it off from another process ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Quitter:
    """``innytypes quit``, with and without ``--force``: turning it all off from outside.

    Both ways record the quit first and then stop processes by their **verified identity**, so
    neither can ever signal a process ID that now belongs to somebody else — that check is
    :class:`~innytypes.helper.processes.ManagedProcesses`'s and is not repeated here.

    The difference between them is who is asked to do the work:

    :meth:`quit` **asks the helper**. It stops the helper politely and waits out its stop
    timeout, which is the helper's chance to run its own orderly shutdown — plugins, MCP
    server, host, Anytype — and then stops whatever is still recorded. On a healthy machine
    that second pass finds nothing but records the helper has already cleaned up, and signals
    nobody.

    :meth:`force` **asks nobody**. It goes straight down the run-state file, politely first and
    forcibly after, without waiting on the helper or the host to cooperate — which is the point
    of it, because the reason a person types `--force` is that one of them is hung.
    """

    processes: ManagedProcesses
    quits: QuitFile
    clock: Callable[[], float] = time.time

    def quit(self) -> QuitReport:
        """Ask the running application to quit, and make sure of it."""
        self.quits.record(QuitReason.COMMAND_LINE, at=self.clock())

        stopped: list[Stopped] = []
        for record in self.processes.records():
            if record.kind is ChildKind.HELPER:
                stopped.append(self.processes.stop(record))

        # Re-read: the helper, given its stop timeout, will have stopped and forgotten most of
        # this itself. What is left is what it did not get to.
        stopped.extend(self._stop_the_rest())
        return QuitReport(reason=QuitReason.COMMAND_LINE, stopped=tuple(stopped))

    def force(self) -> QuitReport:
        """Stop every recorded process itself, politely then forcibly, waiting on nobody."""
        self.quits.record(QuitReason.FORCED, at=self.clock())
        return QuitReport(reason=QuitReason.FORCED, stopped=tuple(self._stop_the_rest()))

    def _stop_the_rest(self) -> tuple[Stopped, ...]:
        """Stop everything still in the run-state file, in the order a quit stops things."""
        stopped: list[Stopped] = []

        for record in quit_order(self.processes.records()):
            if record.kind is ChildKind.ANYTYPE_APP and not started_by_this_application(record):
                # Adopted: it was the user's Anytype before InnyTypes ever ran, and no quit of
                # ours — forced or not — is allowed to take it down with us (F6).
                log.info("leaving the Anytype desktop app running: this application adopted it")
                continue
            stopped.append(self.processes.stop(record))

        return tuple(stopped)


def build_quitter(run_state: Path | None = None) -> Quitter:
    """The quitter ``innytypes quit`` builds: the real files, the real process table.

    ``run_state`` names the run-state file; the quit record is written **beside** it, so a test
    or a second installation that redirects one redirects both and the two cannot end up
    describing different machines.
    """
    path = default_run_state_path() if run_state is None else run_state

    return Quitter(
        processes=ManagedProcesses(run_state=RunStateFile(path), table=SystemProcessTable()),
        quits=QuitFile(path=path.with_name(QUIT_FILENAME)),
    )


# ── the signals a helper can catch ───────────────────────────────────────────────────────────


def quit_reason_for_signal(number: int) -> QuitReason:
    """Which row of *Turning InnyTypes off* a caught signal is.

    A hang-up is the session ending — a logout or a shutdown, which the plan says is treated
    exactly as Quit. Everything else the helper can catch is somebody outside ending it. Both
    run the same quit; the reason is what a log says about it afterwards.
    """
    if number == getattr(signal, "SIGHUP", None):
        return QuitReason.LOGOUT
    return QuitReason.EXTERNAL_STOP


def install_quit_handlers(
    application: Application,
    *,
    register: Callable[[int, Callable[[int, FrameType | None], None]], object] = signal.signal,
    ending: Callable[[], None] | None = None,
) -> tuple[int, ...]:
    """Make every catchable stop signal run a **quit** rather than kill the helper mid-flight.

    This is what makes two rows of the plan's table true at once. A logout or a shutdown sends
    the helper a terminate or a hang-up; so does `kill <pid>` and so does Activity Monitor. If
    the helper simply died on those, its children would be left running with nobody watching
    them, and the exits nobody recorded would look like crashes to the host. Instead the helper
    catches them, records the quit, stops everything in order, and exits.

    A kill that cannot be caught (``SIGKILL``) is still covered, on the other side: the host
    sees a helper that ended without crashing and shuts itself and its children down
    (:class:`HelperWatch`).

    ``register`` is injected so the gate proves this wiring without a real signal ever being
    sent to anything — and so an application running a **toolkit's event loop** can register
    on that loop instead (:meth:`innytypes.helper.toolkit.TogaDesktop.on_signal`), where a
    Python-level handler would simply never run.

    ``ending`` is how *this* process ends once the quit has stopped everything else. The
    default raises :class:`SystemExit`, which is what ends a helper that is waiting in Python.
    A helper inside an event loop has to ask the toolkit instead, because raising out of a
    handler the loop called would leave the loop holding the process.
    """

    def handle(number: int, frame: FrameType | None) -> None:
        application.quit(quit_reason_for_signal(number))
        # The quit stopped everything else; this process is the last thing left to end, and
        # ending it is what the signal asked for in the first place.
        if ending is not None:
            ending()
            return
        raise SystemExit(0)

    installed: list[int] = []
    for number in sorted(_signals("SIGTERM", "SIGINT", "SIGHUP")):
        register(number, handle)
        installed.append(number)

    return tuple(installed)


# ── the host's side: the one thing the host ever restarts ────────────────────────────────────


class HelperEnding(StrEnum):
    """How the helper's process ended, in the only three ways that change what happens next."""

    # A non-zero exit code, or a crash signal. The one ending the host relaunches.
    CRASHED = "crashed"
    # Terminate, interrupt, kill, Activity Monitor, Task Manager: the user wants InnyTypes off.
    STOPPED = "stopped-from-outside"
    # It ended cleanly, on purpose. A quit, and nothing to bring back.
    QUIT = "quit"


@dataclass(frozen=True)
class HelperExit:
    """The helper's ending, as whatever observed it can describe it.

    Two fields rather than one, because the two things that can be known about a dead process
    are different facts: an exit code is what it chose, a signal is what was done to it. A
    POSIX return code packs both into one number, and :meth:`from_returncode` unpacks it.
    """

    exit_code: int | None = None
    signal: int | None = None
    pid: int = 0

    @classmethod
    def from_returncode(cls, returncode: int, *, pid: int = 0) -> HelperExit:
        """Read a ``wait``-style return code: negative means the signal that ended it."""
        if returncode < 0:
            return cls(signal=-returncode, pid=pid)
        return cls(exit_code=returncode, pid=pid)

    @property
    def ending(self) -> HelperEnding:
        """Which of the three endings this is.

        An ending nothing could describe — no code, no signal — is **stopped**, not crashed.
        That is the safe direction: being wrong here means the user clicks the icon again,
        where the other way round means an application that relaunches itself after the user
        has tried to end it.
        """
        if self.signal is not None:
            return HelperEnding.CRASHED if self.signal in CRASH_SIGNALS else HelperEnding.STOPPED
        if self.exit_code is None:
            return HelperEnding.STOPPED
        return HelperEnding.QUIT if self.exit_code == 0 else HelperEnding.CRASHED


class HostResponse(StrEnum):
    """What the host does about a helper that is no longer there."""

    RELAUNCH_HELPER = "relaunch-helper"
    SHUT_DOWN = "shut-down"


@dataclass
class _RelaunchChannel:
    """The control channel the helper-watch's restart policy speaks: one command, one relaunch.

    The policy in :mod:`innytypes.helper.restart` sends commands to a host; here the only
    "child" is the helper and the only recipient is the function that launches it again. Using
    that policy rather than a second one is deliberate — plan 0003 says the host relaunches the
    helper "with the same backoff and breaker settings as the helper's policy, read from the
    same config", and the cheapest way to keep two things identical is for there to be one.
    """

    relaunch: Callable[[], None]

    def send(self, command: Command) -> CommandResult:
        self.relaunch()
        return CommandResult(name=command.name)


class HelperWatch:
    """The host's one rule about the helper — and the reason InnyTypes can be turned off.

    The helper restarts the host; the host relaunches the helper. Left there, the pair would
    resurrect each other for ever and nothing the user did could end the application. So the
    host's half is deliberately narrow: it relaunches a helper that **crashed**, and nothing
    else. A helper that was stopped from outside, that exited cleanly, or that ended in a way
    nobody can describe means the user wants InnyTypes off — and the host shuts itself and its
    children down instead.

    A recorded quit overrides all of it. During a quit even a non-zero exit is part of the quit,
    and relaunching then would be the application refusing to close.
    """

    def __init__(
        self,
        *,
        relaunch: Callable[[], None],
        shut_down: Callable[[], None],
        settings: RestartSettings | None = None,
        quits: QuitFile | None = None,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._shut_down = shut_down
        self._quits = quits
        self._policy = RestartPolicy(
            channel=_RelaunchChannel(relaunch),
            settings=RestartSettings() if settings is None else settings,
            now=now,
        )

    def observe(self, ending: HelperExit) -> HostResponse:
        """Decide what a dead helper means, and act on it.

        A relaunch is **scheduled** rather than done here, for the same reason every other
        restart in this application is: the delay is a backoff, and sleeping through it would
        stop the host doing anything else. :meth:`tick` issues it when its time comes.
        """
        if self._quits is not None and self._quits.current() is not None:
            log.info("the helper ended during a quit; shutting the host down with its children")
            self._shut_down()
            return HostResponse.SHUT_DOWN

        if ending.ending is not HelperEnding.CRASHED:
            log.info(
                "the helper was %s rather than crashing; the user wants InnyTypes off, so the "
                "host is shutting down with its children",
                ending.ending,
            )
            self._shut_down()
            return HostResponse.SHUT_DOWN

        scheduled = self._policy.child_exited(
            ChildExit(
                id=HELPER_ID,
                kind=ChildKind.HELPER,
                pid=ending.pid,
                exit_code=self._code(ending),
                expected=False,
            )
        )

        if scheduled is None:
            # The attempts are exhausted. A host that kept running without a helper would be an
            # application nothing watches and nothing can quit, so it goes off instead.
            log.error("the helper cannot be brought back; shutting the host down with it")
            self._shut_down()
            return HostResponse.SHUT_DOWN

        log.warning("the helper crashed; relaunching it in %.0fs", scheduled.due_at - self._now())
        return HostResponse.RELAUNCH_HELPER

    def tick(self) -> None:
        """Launch the helper again if a scheduled relaunch has come due."""
        self._policy.tick()

    @property
    def pending(self) -> tuple[ScheduledRestart, ...]:
        """The relaunches waiting for their backoff, soonest first."""
        return self._policy.pending

    def _now(self) -> float:
        return self._policy.now()

    @staticmethod
    def _code(ending: HelperExit) -> int | None:
        """The exit code to report, with a signal expressed the way ``wait`` expresses one."""
        if ending.exit_code is not None:
            return ending.exit_code
        return None if ending.signal is None else -ending.signal


# ── launch at login (F7) ─────────────────────────────────────────────────────────────────────


class LaunchAtLoginError(RuntimeError):
    """Raised when a login item cannot be registered or unregistered."""


class LoginItem(Protocol):
    """The operating system's login-item store, as this application touches it.

    Two calls and no state: whether the switch is on is `config.toml`'s answer, not the OS's,
    because the config file is what the application's window shows and what the user edits.
    """

    def register(self) -> None:
        """Ask the OS to start this application at login."""
        ...

    def unregister(self) -> None:
        """Ask the OS to stop starting this application at login."""
        ...


class UnpackagedLoginItem:
    """The login-item hook for an installation that is not a bundle yet — and it says so.

    Registering a login item means handing the operating system the identity of an installed
    application: a bundle path and identifier on macOS, a shortcut in the Startup folder on
    Windows, a `.desktop` file on Linux. None of those exist until the BeeWare Briefcase bundles
    are built (F5), so there is nothing truthful to register.

    It **refuses out loud** rather than doing nothing quietly. A hook that silently succeeded
    would leave the switch reading "on" in the window and the application never starting at
    login, which is the worst of the three possible behaviours: the user would have no way to
    tell it had not worked.
    """

    def register(self) -> None:
        raise LaunchAtLoginError(
            "starting InnyTypes at login needs the installed application bundle, which this "
            "installation does not have yet; the login item is registered by the packaged "
            "application (plan 0003, F5 and F7)"
        )

    def unregister(self) -> None:
        raise LaunchAtLoginError(
            "there is no login item to remove: this installation is not a packaged application "
            "bundle (plan 0003, F5 and F7)"
        )


@dataclass
class LaunchAtLogin:
    """The `launch_at_login` switch: off by default, stored in `config.toml`, acted on by the OS.

    The order of the two halves is chosen so that the file never claims something the machine
    is not doing. The OS is asked first; the setting is written only once that has worked; and
    a write that fails puts the OS back the way it was. A switch whose stored value and whose
    real behaviour disagree is worse than one that refuses to move.
    """

    settings: HelperSettings
    login_item: LoginItem = field(default_factory=UnpackagedLoginItem)

    @property
    def enabled(self) -> bool:
        """Whether the application is set to start at login. False until someone says otherwise."""
        return self.settings.launch_at_login

    def set(self, enabled: bool) -> bool:
        """Turn the switch on or off, in the OS and in `config.toml`, in that order."""
        if enabled:
            self.login_item.register()
        else:
            self.login_item.unregister()

        try:
            self.settings.set_launch_at_login(enabled)
        except Exception:
            # Put the machine back: the setting is what the window shows, and a login item the
            # user cannot see in the window is one they cannot turn off either.
            if enabled:
                self.login_item.unregister()
            else:
                self.login_item.register()
            raise

        log.info("launch at login is now %s", "on" if enabled else "off")
        return enabled


# ── the entry point ──────────────────────────────────────────────────────────────────────────


def default_login_item() -> LoginItem:  # pragma: no cover - reads the real installation
    """The OS login-item hook this installation actually has (F7).

    macOS in a built bundle gets a real one (:mod:`innytypes.helper.macos`); Linux gets its
    autostart entry; everything else, and every unpackaged run, gets
    :class:`UnpackagedLoginItem`'s refusal, which is still the honest answer where there is no
    installed identity to register.

    The imports are inside the function because both platform modules import *this* one for
    :class:`LaunchAtLoginError` and :class:`LoginItem`, and a module-level import here would
    close that circle at import time.
    """
    if sys.platform == "darwin":
        from innytypes.helper.macos import default_login_item as mac_login_item

        return mac_login_item()

    if sys.platform.startswith("linux"):
        from innytypes.helper.linux import DesktopEntry, LinuxLoginItem

        icon = str(Path(sys.executable).resolve().parent / "innytypes.png")
        return LinuxLoginItem(entry=DesktopEntry(executable=sys.executable, icon=icon))

    return UnpackagedLoginItem()


# ── what the window is told, from this machine's own roots (plan 0004, slice 11) ─────────────


@dataclass
class LatestVersionCheck:
    """The last plugin version check this helper made, kept where the window can read it.

    A version check reaches the network, so it is made on the helper's own schedule and never
    while a window is being drawn (plan 0003, D14). This is the one place its answer lives
    between the two: the helper records what a check found, and the window asks for the lines
    it should show, as often as it likes, for nothing.

    Nothing recorded yet is **not** "nothing is available" — it is "nobody has asked yet", and
    a check that failed leaves the last good answer standing rather than emptying the window.
    Both draw a window with no plugin update waiting in it, which is the truthful drawing when
    nothing is known to be.
    """

    check: VersionCheck | None = None

    def record(self, check: VersionCheck) -> None:
        """Keep what one check found. The helper calls this; the window never does."""
        self.check = check

    def reports(self) -> tuple[PluginReport, ...]:
        """Every plugin's line from the last check, and nothing at all before the first."""
        return () if self.check is None else self.check.reports


@dataclass
class RequestedRelease:
    """The staged core release somebody pressed **Apply** on, waiting for the quit (D11).

    A core release is swapped in at a quit and at no other moment: the files it replaces are
    the ones the host, the MCP server and every plugin are running out of while the window is
    open. So Apply cannot install anything, and what it does instead is say *yes* — which is
    exactly what a release with ``automatic`` false is waiting for
    (:meth:`~innytypes.helper.swap.ReleaseApplier.apply_at_quit`).

    One object shared between the window that records the yes and the quit that reads it,
    because they are the two halves of one press, in one process, minutes apart.
    """

    version: str | None = None

    def request(self, version: str) -> None:
        """Record that the user asked for this release to be installed."""
        self.version = version
        log.info("release %s was asked for; it is installed when you quit InnyTypes", version)

    @property
    def wanted(self) -> bool:
        """Whether a release was asked for by hand during this run."""
        return self.version is not None


def recorded_statuses(
    *, processes: ManagedProcesses, quarantines: QuarantineFile
) -> tuple[ProcessStatus, ...]:
    """Every managed process the window lists, and what each one is doing.

    Read from the two files the helper keeps — the run-state file, each record checked against
    the process table, and the quarantines — for the same reason `innytypes helper status`
    reads them rather than asking the helper: they are what is true of this machine, and a
    window that had to ask would go blank at the one moment a person most wants it, which is
    when the helper is the thing that is wedged.

    ``interventions`` is 0 for every row, and that is honesty rather than laziness. How many
    times the helper has had to act is counted inside its breaker, over the last few minutes,
    and two files read just now have no claim to know it. What the window shows is the word
    and the reason, and both of those are on disk.
    """
    recorded = quarantines.load()

    try:
        live = processes.live()
    except (RunStateError, OSError) as error:
        # A run-state file that cannot be read is a window with no process list in it, not a
        # window that will not open.
        log.warning("the run-state file does not say what is running: %s", error)
        live = ()

    statuses = [
        ProcessStatus(
            child_id=identified.record.id,
            state=(RunState.QUARANTINED if identified.record.id in recorded else RunState.RUNNING),
            interventions=0,
            last_reason=recorded.get(identified.record.id),
        )
        for identified in live
    ]

    listed = {status.child_id for status in statuses}
    statuses.extend(
        ProcessStatus(
            child_id=child_id,
            state=RunState.QUARANTINED,
            interventions=0,
            last_reason=reason,
        )
        for child_id, reason in sorted(recorded.items())
        if child_id not in listed
    )

    return tuple(statuses)


def staged_core_release(staging: Path) -> StagedRelease | None:
    """The core release waiting in staging right now, or ``None`` when none is.

    Read off the disk rather than remembered from the check that staged it, because the two
    are usually different runs of the helper: the download may have happened days ago, and
    what the window has to say is what is waiting *now*.

    Every refusal answers ``None`` — a staging directory holding two releases marked ready, a
    marker that does not parse, a platform this build publishes nothing for. None of those is
    a reason for a window not to open, and the release stays exactly where it is.
    """
    try:
        ready = read_ready_release(staging)
    except (ReleaseApplyError, UpdateError, OSError) as error:
        log.warning("what is waiting in %s could not be read: %s", staging, error)
        return None

    if ready is None:
        return None

    return StagedRelease(
        version=ready.version,
        directory=ready.directory,
        artifact_path=ready.artifact_path,
        marker_path=ready.directory / READY_MARKER,
        automatic=ready.automatic,
    )


def this_machine_usage(
    *, settings: HelperSettings, addons_root: Path | None = None
) -> UsageSnapshot:
    """What a usage report would say about this machine, read fresh when it is asked for.

    Exactly the fields plan 0003's *what is sent* table lists, and the counters it cannot
    honestly fill are left at zero: starts, stops and interventions are the helper's own
    tallies, kept by the breaker while it runs.

    Whether any of this leaves the machine is not decided here and cannot be. It is built the
    same way whether the telemetry switch is on, off or unanswered, and
    :class:`~innytypes.helper.telemetry.TelemetryPipeline` re-reads that switch before it
    queues a byte (F2).
    """
    found = discover_addons(addons_root)

    return UsageSnapshot(
        innytypes_version=__version__,
        os=platform_module.system(),
        os_version=platform_module.release(),
        plugins=tuple(
            InstalledPlugin(
                id=addon.id,
                version=addon.manifest.version,
                update_mode=str(settings.update_mode(addon.id)),
            )
            for addon in found.installed
        ),
    )


def release_applier(staging: Path | None = None) -> ReleaseApplier | None:
    """What a quit installs a staged core release with, or ``None`` for an installation that
    cannot install one.

    Two installations get ``None``, and both are the honest answer rather than a gap:

    * one that ships **no release signing key** (:func:`
      ~innytypes.helper.update.load_installed_public_key`) — a `pip install` from a checkout
      rather than a built bundle. There is nothing it could verify, so there is nothing it may
      install;
    * **Windows**, where a running program's files are locked and the swap belongs to the
      quit-time updater the bundle installs beside the application
      (:class:`~innytypes.helper.windows.WindowsSwapHandoff`, plan 0003 slice 16). That
      updater is started with an interpreter outside the release tree, which only a built
      bundle has, so there is nothing truthful to point a handoff at from here.

    Refusing once, here, is what keeps the alternative from happening: a quit that raised.
    """
    if sys.platform == "win32":
        log.info(
            "a staged core release is installed by the packaged updater on Windows, so this "
            "quit installs nothing"
        )
        return None

    try:
        public_key = load_installed_public_key()
    except UpdateError as error:
        log.info("this installation cannot install a core release: %s", error)
        return None

    return ReleaseApplier(
        installer=UvCoreInstaller(),
        roots=ReleaseRoots(default_release_roots()),
        staging=default_core_staging_path() if staging is None else staging,
        public_key=public_key,
        blocked=BlockedReleases.at(default_blocked_core_versions_path()),
        pending=PendingReleaseFile(path=default_pending_release_path()),
        addons_root=default_addons_root(),
        helper_environment=default_helper_environment(),
    )


@dataclass(frozen=True)
class HelperWindow:
    """The window a launch draws, with every source behind it already wired up.

    What :func:`build_window` hands back, and the reason it hands back an object rather than
    only the window: the drawing routes the plugin page's five controls, the helper's tick
    drives the restart policy, and the version check records what it found — so the three
    things the window was assembled *from* have to be reachable by name afterwards.
    """

    window: ApplicationWindow
    page: PluginPage
    # The last version check, for the helper to record into and the window to draw from.
    checks: LatestVersionCheck
    # The Apply the user pressed on a core release, for the quit that installs it.
    requested: RequestedRelease
    # The one restart policy in this process: the settings watch asks it for the restart a
    # changed value is owed (D10), and the helper's tick issues what it has scheduled.
    restarts: RestartPolicy


def build_window(
    *,
    desktop: Desktop,
    settings: HelperSettings,
    quit: Callable[[QuitReason], QuitReport],
    channel: ControlChannel,
    processes: ManagedProcesses,
    login_item: LoginItem | None = None,
    quarantines: QuarantineFile | None = None,
    checks: LatestVersionCheck | None = None,
    requested: RequestedRelease | None = None,
    addons_root: Path | None = None,
    secrets_root: Path | None = None,
    staging: Path | None = None,
    queue_root: Path | None = None,
    catalogue_cache: Path | None = None,
    catalogue_reader: object | None = None,
    installer: AddonInstaller | None = None,
    machine_identifier: MachineIdentifierSource = os_machine_identifier,
    endpoints: Endpoints = DEFAULT_ENDPOINTS,
    start_anytype_pairing: Callable[[], tuple[bool, str]] | None = None,
    complete_anytype_pairing: Callable[[str], tuple[bool, str]] | None = None,
) -> HelperWindow:
    """Build the window with **every** one of its sources filled, from this machine's roots.

    This function exists because the application shipped without it. `ApplicationWindow` has
    always taken the process list, the plugin page, the pending updates, the telemetry
    pipeline and the usage snapshot, and the entry point passed none of them — so every one
    defaulted to ``None`` and the window a person opened held two switches and Quit, while
    everything else was built, drawn and covered by tests nobody could see the effect of.
    :attr:`~innytypes.helper.window.ApplicationWindow.unfilled` is how that is said out loud,
    and `tests/test_window_wiring.py` is where it is asserted of what this function returns.

    **Every root is an argument, and every default is this user's own directory.** That is
    what lets the gate build the real thing under ``tmp_path`` — the real window, the real
    page, the real host, the real telemetry pipeline — with an injected control channel and
    nothing else faked, and reach no per-user directory at all.

    Nothing here starts a process, opens a socket or makes a request. The control channel is
    handed in already open (or not yet connected, which is a window that still draws), and the
    version check that fills ``checks`` is the helper's, on its own schedule.
    """
    from innytypes.helper.catalogue import (
        CatalogueCache,
        CatalogueReader,
        default_catalogue_cache_path,
    )
    from innytypes.helper.plugin_lists import PluginLists
    from innytypes.helper.plugins import AddRequest, InstalledPluginHost, PluginPage
    from innytypes.helper.window import AnytypeGroup, ApplicationTab, ApplicationWindow, UpdateKind

    quarantine_file = QuarantineFile() if quarantines is None else quarantines
    version_checks = LatestVersionCheck() if checks is None else checks
    asked_for = RequestedRelease() if requested is None else requested
    secrets = SecretStore(root=default_secrets_root() if secrets_root is None else secrets_root)
    staging_root = default_core_staging_path() if staging is None else staging

    # The one restart policy, and the watch that asks it for the restart a changed value is
    # owed (D10). Both are here rather than inside the page because they are the *helper's*,
    # and the page is only one of the things that can change a value.
    restarts = RestartPolicy(channel=channel, settings=settings.current.helper.restart)
    watch = SettingsWatch(restarts)

    host = InstalledPluginHost(
        settings=settings,
        channel=channel,
        installer=UvInstaller() if installer is None else installer,
        addons_root=addons_root,
        config_path=settings.path,
        secrets_root=secrets_root,
        quarantines=quarantine_file.load,
        reports=version_checks.reports,
        watch=watch,
    )
    page = PluginPage(desktop=desktop, host=host)
    lists = PluginLists(
        settings=settings,
        reader=(
            CatalogueReader(
                settings=settings,
                cache=CatalogueCache(
                    default_catalogue_cache_path() if catalogue_cache is None else catalogue_cache
                ),
            )
            if catalogue_reader is None
            else cast(CatalogueReader, catalogue_reader)
        ),
        installer=lambda requirement: page.add(
            AddRequest(requirement=parse_requirement(requirement))
        ),
    )
    try:
        anytype_key = load_api_key(key_file=settings.path.parent / "anytype_api_key")
    except (AnytypeConfigError, OSError):
        anytype_key = None

    pairing_started = False
    pairing_message = None
    if anytype_key is None and start_anytype_pairing is not None:
        pairing_started, pairing_message = start_anytype_pairing()

    def statuses() -> tuple[ProcessStatus, ...]:
        return recorded_statuses(processes=processes, quarantines=quarantine_file)

    def plugins() -> tuple[tuple[str, AvailabilityState], ...]:
        """Every installed plugin and the one word for it — the command line's own answer."""
        return plugin_states(
            installed=discover_addons(addons_root).installed,
            enabled=settings.is_enabled,
            quarantines=quarantine_file.load(),
            config_path=settings.path,
            secrets=secrets,
        )

    def apply_update(row: UpdateRow) -> None:
        """Press **Apply** on one pending update, in the one way each kind can be applied.

        A plugin is updated now, through the page's own call. A core release is not applied by
        anything while the application is running (D11), so pressing Apply on one records the
        request and the next quit installs it.
        """
        if row.kind is UpdateKind.CORE:
            asked_for.request(row.version)
            return
        page.update(row.subject)

    window = ApplicationWindow(
        desktop=desktop,
        settings=settings,
        launch_at_login=LaunchAtLogin(
            settings=settings,
            login_item=default_login_item() if login_item is None else login_item,
        ),
        quit=quit,
        statuses=statuses,
        plugins=plugins,
        page=page,
        core_update=lambda: staged_core_release(staging_root),
        plugin_updates=version_checks.reports,
        apply_update=apply_update,
        telemetry=TelemetryPipeline(
            settings=settings,
            queue=ReportQueue(default_queue_path() if queue_root is None else queue_root),
            machine_identifier=machine_identifier,
            endpoints=endpoints,
        ),
        usage=lambda: this_machine_usage(settings=settings, addons_root=addons_root),
        application=ApplicationTab(
            anytype=AnytypeGroup.from_state(
                mcp_running=False,
                mcp_reason="The Anytype MCP process is not running.",
                api_key=anytype_key,
            ),
            helper=ApplicationTab.for_settings(settings).helper,
            plugin_lists=lists,
        ),
    )
    window._application.anytype.pairing_started = pairing_started
    window._application.anytype.pairing_message = pairing_message
    window._application.anytype.start_pairing = start_anytype_pairing
    window._application.anytype.complete_pairing = complete_anytype_pairing

    empty = window.unfilled
    if empty:
        # Not raised: a window with a seam missing is still a window with Quit in it, and F1
        # outranks everything here. It is said out loud because the alternative — the state
        # this application shipped in — is a seam nobody notices for weeks.
        log.error("the window was built without %s", ", ".join(sorted(empty)))

    return HelperWindow(
        window=window,
        page=page,
        checks=version_checks,
        requested=asked_for,
        restarts=restarts,
    )


def main() -> None:  # pragma: no cover - the one function that touches the real machine
    """``innytypes-helper``: what the application icon launches (D27).

    Assembles the real thing — the real process table, the real lock and run-state files, the
    real launcher, the real window — starts the application, and then hands the process to
    whichever loop it has: the toolkit's event loop when this installation can draw, and a
    plain wait when it cannot. Either way every catchable stop signal is a quit, and the quit
    is what ends this process.

    **The window is not optional to the user and is optional to the code**, which is the shape
    slice 07b asked for: a bundle carries the toolkit and gets a real window with Quit in it;
    an unpackaged `pip install` has no GUI stack, falls back to
    :class:`~innytypes.helper.window.HeadlessDesktop`, and is still a complete application that
    `innytypes quit` turns off. What is never allowed is a running application with no way to
    stop it (F1), and both paths have one.

    **Everything the window shows is wired here** (plan 0004, slice 11). The process list, the
    plugin page, the pending core and plugin updates, the telemetry pipeline and the usage
    snapshot are :func:`build_window`'s to assemble from this machine's roots; what is left in
    this function is the part that touches the machine — the real files, the real process
    table, the control socket the host connects to, and the loop.

    The window's imports are local for the same reason as
    :func:`default_login_item`'s: :mod:`innytypes.helper.window` imports this module.
    """
    from innytypes.helper.config import HelperSettings
    from innytypes.helper.supervision import build_supervision, run_supervision
    from innytypes.helper.toolkit import TogaDesktop, load_toolkit
    from innytypes.helper.window import HeadlessDesktop

    run_state = RunStateFile()
    table = SystemProcessTable()
    processes = ManagedProcesses(run_state=run_state, table=table)

    requested = RequestedRelease()
    applier = release_applier()

    def apply_staged_release() -> AppliedRelease | None:
        """What this quit does about a release waiting in staging (D11).

        The **only** moment a core release is installed, and the reason the window's Apply is
        a yes rather than an installation: by the time this runs the host, the MCP server,
        every plugin and Anytype have stopped, and the helper is the last process left that
        could replace the files they were running out of.
        """
        if applier is None:
            return None
        return applier.apply_at_quit(requested=requested.wanted)

    application = Application(
        lock=InstanceLock(path=default_lock_path(), processes=processes),
        processes=processes,
        run_state=run_state,
        quits=QuitFile(),
        applications=SystemApplications(),
        anytype_executable=default_anytype_executable(),
        show_window=lambda: show_the_running_window(),
        apply_update=apply_staged_release,
    )

    def report_child_exit(exit_report: ChildExit) -> None:
        """A child the host says is gone, handed to the helper's own rule about it (slice 07)."""
        application.child_exited(exit_report)

    # The helper listens and the host connects (plan 0003, slice 18), so the socket is opened
    # **before** the host is started below. A socket that could not be opened is a window that
    # lists every plugin as stopped rather than an application that will not start.
    channel = ControlListener(report_exit=report_child_exit, host_pid=recorded_host_pid(run_state))
    try:
        channel.open()
    except ControlSocketError as error:
        log.error("the helper is running without a control channel to its host: %s", error)

    settings = HelperSettings()
    toolkit = load_toolkit()
    drawing = None if toolkit is None else TogaDesktop(toolkit=toolkit)
    desktop: Desktop = HeadlessDesktop() if drawing is None else drawing

    pairing: list[PairingSession] = []
    key_file = settings.path.parent / "anytype_api_key"

    def begin_anytype_pairing() -> tuple[bool, str]:
        try:
            with httpx.Client(timeout=5.0) as client:
                session = start_pairing(client)
        except KeyAcquisitionError as error:
            return False, str(error)
        pairing[:] = [session]
        return True, "Anytype is showing a new four-digit pairing code."

    def finish_anytype_pairing(code: str) -> tuple[bool, str]:
        if not pairing:
            return False, "Start pairing again to request a new code from Anytype."
        try:
            with httpx.Client(timeout=5.0) as client:
                complete_pairing(pairing[0], code, client, key_file=key_file)
        except KeyAcquisitionError as error:
            return False, str(error)
        pairing.clear()
        return True, "The Anytype API key was stored securely."

    built = build_window(
        desktop=desktop,
        settings=settings,
        quit=application.quit,
        channel=channel,
        processes=processes,
        requested=requested,
        start_anytype_pairing=begin_anytype_pairing,
        complete_anytype_pairing=finish_anytype_pairing,
    )
    window = built.window
    page = built.page

    def show_the_running_window() -> None:
        """What a second launch does: bring the application that is already up forward.

        Only this process's own window can be reopened, and this process has one to reopen
        only once its toolkit has started. A second launch that reaches here before that has
        no window — the running application is somewhere else, and on macOS the operating
        system has already brought *its* window forward — so it says so and exits, which is
        what an installation without a toolkit has always done.
        """
        if drawing is None or drawing.window is not None:
            window.reopen()
        else:
            bring_window_forward()

    if drawing is not None:
        drawing.on_quit = window.quit
        drawing.on_telemetry = window.set_telemetry
        drawing.on_launch_at_login = window.set_launch_at_login
        drawing.on_apply = window.apply_update
        drawing.on_answer = window.set_telemetry
        # The plugin page's controls, each routed to the one call that owns the work (plan
        # 0004, *What the application is told, in one place*). **Add** is deliberately not
        # among them: adding a plugin needs a dialog to say *which* plugin, the toolkit has
        # no such dialog yet, and a control wired to a request nobody made would install
        # something nobody named. Pressing it refuses by name until that dialog exists.
        drawing.on_remove = page.remove
        drawing.on_update = page.update
        drawing.on_enable = lambda plugin_id, enabled: page.set_enabled(plugin_id, enabled=enabled)
        drawing.on_configure = page.configure

    # Before the host is started, because the host connects to the control socket as it comes
    # up and beats on the heartbeat socket from then on: both have to be there to be found.
    supervision = build_supervision(
        application=application,
        processes=processes,
        run_state=run_state,
        settings=settings,
        show_window=window.open_notice,
    )

    report = application.start()
    if not report.started:
        return

    if drawing is not None:

        def start_drawing() -> None:
            # Inside the toolkit's startup, which is the first moment its loop exists — and
            # the loop is what has to carry the signals and the supervision from here on.
            install_quit_handlers(application, register=drawing.on_signal, ending=drawing.stop)
            drawing.every(application_tick(), supervision.pass_once)
            window.open()

        # Does not return until the application ends: the toolkit owns the process from here,
        # and every way of quitting runs through it.
        drawing.run(start_drawing)
        return

    install_quit_handlers(application)

    try:
        run_supervision(supervision, interval=application_tick)
    except KeyboardInterrupt:
        application.quit(QuitReason.EXTERNAL_STOP)
    finally:
        # The socket is this helper's, and it outlives nothing: a path left behind would be
        # the next launch's "another helper is already listening".
        channel.close()


def run_host() -> None:  # pragma: no cover - this call becomes the host process
    """Be the host, in this process: what ``<launcher> --innytypes-host`` runs."""
    from innytypes.cli import cli

    cli(["up"])


def run_bundled(
    argv: Sequence[str],
    *,
    helper: Callable[[], None] = main,
    host: Callable[[], None] = run_host,
) -> None:
    """The bundle's single launcher, in whichever of its two roles it was asked for.

    One executable does both jobs because an installed bundle contains exactly one, and which
    job this is comes from the argument the caller was given — never from a file, an
    environment variable or a guess. ``helper`` defaults to :func:`main`, the same function
    ``innytypes-helper`` names, so a bundle and an unpackaged installation cannot start
    different things; both seams exist so the gate can watch this choice without starting
    anything.
    """
    if HOST_ARGUMENT in argv:
        host()
        return
    helper()


def application_tick() -> float:  # pragma: no cover - read once per loop of the real helper
    """How long the helper waits between passes over its children."""
    return HelperSettings().current.helper.tick
