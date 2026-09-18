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

**What is a seam rather than a build, and is meant to be read as one.** The BeeWare Briefcase
bundles (F5) are not built here: :func:`default_host_command` and
:func:`default_anytype_executable` are what an unpackaged installation runs, and the bundle's
own paths land with the packaging slice. Registering a login item with the operating system
(F7) is :class:`UnpackagedLoginItem`, which **refuses out loud** rather than pretending to
register anything — a login item needs the installed bundle's identity, and that identity does
not exist until the bundle does. The switch itself is real and is stored in ``config.toml``.
"""

from __future__ import annotations

import json
import os
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
from typing import Protocol

from platformdirs import user_runtime_path

from innytypes.anytype_mcp.logs import get_logger
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
from innytypes.helper.breaker import HOST_ID, Breaker
from innytypes.helper.config import APPLICATION_NAME, HelperSettings, RestartSettings
from innytypes.helper.processes import (
    ManagedProcesses,
    ProcessFacts,
    ProcessTable,
    Stop,
    Stopped,
    SystemProcessTable,
)
from innytypes.helper.restart import RestartPolicy, ScheduledRestart
from innytypes.helper.swap import AppliedRelease, ReleaseConfirmation

__all__ = [
    "ANYTYPE_APP_ID",
    "CRASH_SIGNALS",
    "EXTERNAL_STOP_SIGNALS",
    "HELPER_ID",
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
    "HostResponse",
    "LaunchAtLogin",
    "LaunchAtLoginError",
    "LockOutcome",
    "LoginItem",
    "InstanceLock",
    "QuitFile",
    "QuitReason",
    "QuitRecord",
    "QuitReport",
    "Quitter",
    "RunningApplications",
    "Start",
    "StartProcess",
    "StartReport",
    "SystemApplications",
    "UnpackagedLoginItem",
    "bring_window_forward",
    "build_quitter",
    "default_anytype_executable",
    "default_host_command",
    "default_lock_path",
    "default_quit_path",
    "default_start_process",
    "install_quit_handlers",
    "main",
    "quit_order",
    "quit_reason_for_signal",
    "started_by_this_application",
    "this_helper",
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


def default_host_command() -> tuple[str, ...]:
    """The command that starts the host: this interpreter, running this package.

    ``python -m innytypes up`` rather than the ``innytypes`` console script, because the
    record written for the host has to carry the executable the OS will report — and for a
    console script that is the interpreter, not the script. Recording the script's path would
    produce a record that can never be verified, and an unverifiable record is one nothing will
    ever signal (:mod:`innytypes.helper.processes`).
    """
    return (sys.executable, "-m", "innytypes", "up")


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
    sent to anything.
    """

    def handle(number: int, frame: FrameType | None) -> None:
        application.quit(quit_reason_for_signal(number))
        # The quit stopped everything else; this process is the last thing left to end, and
        # ending it is what the signal asked for in the first place.
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


def main() -> None:  # pragma: no cover - the one function that touches the real machine
    """``innytypes-helper``: what the application icon launches (D27).

    Assembles the real thing — the real process table, the real lock and run-state files, the
    real launcher — starts the application, and then does nothing but wait: every catchable
    stop signal is a quit, and the quit is what ends this process. The supervision loop that
    watches the children between those two moments is the helper's tick, which the slices
    around this one own.
    """
    run_state = RunStateFile()
    table = SystemProcessTable()
    processes = ManagedProcesses(run_state=run_state, table=table)

    application = Application(
        lock=InstanceLock(path=default_lock_path(), processes=processes),
        processes=processes,
        run_state=run_state,
        quits=QuitFile(),
        applications=SystemApplications(),
        anytype_executable=default_anytype_executable(),
    )

    report = application.start()
    if not report.started:
        return

    install_quit_handlers(application)

    try:
        while True:
            time.sleep(application_tick())
    except KeyboardInterrupt:
        application.quit(QuitReason.EXTERNAL_STOP)


def application_tick() -> float:  # pragma: no cover - read once per loop of the real helper
    """How long the helper waits between passes over its children."""
    return HelperSettings().current.helper.tick
