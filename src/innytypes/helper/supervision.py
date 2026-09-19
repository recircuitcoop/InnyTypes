"""The helper's tick, assembled: the one pass that makes every other module in here run.

Plan 0003 is built out of parts that each decide one thing — heartbeats
(:mod:`innytypes.helper.heartbeat`), the process table and the identity check
(:mod:`innytypes.helper.processes`), stale and breach judgement
(:mod:`innytypes.helper.detection`), the restart policy (:mod:`innytypes.helper.restart`), the
breaker and quarantine (:mod:`innytypes.helper.breaker`), what the user is told
(:mod:`innytypes.helper.notification`) and the core update check
(:mod:`innytypes.helper.update`). Every one of them was proved in isolation and **none of them
was called by the running application**: the helper started Anytype and the host, and then sat
in ``while True: time.sleep(tick)`` watching nothing. This module is the wiring that makes the
policy run, and it adds no policy of its own.

**What one pass does, in order.**

1. **Listen.** Poll the heartbeat socket and the control socket. Beats land in the registry;
   child exits the host reports come back on the control connection and reach the restart
   policy through the same :meth:`~innytypes.helper.launcher.Application.child_exited` that a
   quit already silences.
2. **Sample and judge.** :meth:`~innytypes.helper.detection.HealthWatch.tick` checks every
   record's identity, forgets the phantoms, samples what is left, and judges staleness and
   resource breaches. A sustained breach is stopped there, through the identity-checked path,
   because the tick stops and never starts.
3. **Act.** A stale process and a process that was just stopped for a breach are each an
   **intervention**: the breaker counts it, and if the breaker still allows it the restart
   policy decides when the process comes back. A process whose profile says it is not
   ``restartable`` is stopped and left stopped.
4. **Issue what is due.** :meth:`~innytypes.helper.restart.RestartPolicy.tick` sends the
   restarts whose backoff has run out, over the control channel — never by sleeping through a
   delay, because a helper that is asleep is watching nothing.
5. **Check for an update**, on its schedule and only when ``auto_check_versions`` is on. The
   switch is read inside :func:`~innytypes.helper.update.check_for_update`, immediately before
   the request, so this module never has to remember to ask.
6. **Tell the user.** The whole set of conditions that are true right now — every quarantine,
   and a release waiting in staging — is handed to the
   :class:`~innytypes.helper.notification.Announcer`, which writes them all for
   ``innytypes helper status`` and posts only the ones that are new.

**A pass that goes wrong is a pass, not the end of the helper.** Each step above is attempted
on its own and a failure is logged, named in the :class:`Pass` it returns, and stepped over: an
unreadable run-state file, a process that vanishes between the identity check and the sample, a
notification backend that refuses, a host that is not connected. A supervisor that dies of the
first surprise is worse than no supervisor at all, because the user believes they have one.

**Both loops run the same pass.** :func:`run_supervision` is the plain loop an unpackaged
installation runs, and :meth:`~innytypes.helper.toolkit.TogaDesktop.every` schedules the very
same :meth:`SupervisionTick.pass_once` on the toolkit's own event loop when the application has
a window. Drawing is not blocked by it and it is not blocked by drawing: each pass returns to
the loop, which is free to draw until the next one is due.

**The host is the one process the helper restarts itself.** Every other managed process is the
host's to spawn, so a restart is a command on the control channel; the host cannot be sent a
command asking it to start itself, and a host that has gone is exactly when the command could
not arrive. :class:`HostRestarts` is that row of plan 0003's table and nothing more — stop the
host if it is still there, clear its orphans, start it again — so the policy above it stays the
one place that decides *whether* and *when*.

Every seam is injected, as everywhere else in the helper: the sockets, the clock, the process
table, the notifier, the update check and the transport under it. The gate drives whole passes
with no process, no socket and no sleeping.
"""

from __future__ import annotations

import platform
import random
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from typing import Protocol

import httpx

from innytypes.addons.discovery import DiscoveryResult, default_addons_root, discover_addons
from innytypes.addons.manifest import StabilityProfile
from innytypes.anytype_mcp.logs import get_logger
from innytypes.children import (
    ChildExit,
    ChildKind,
    ChildRecord,
    Command,
    CommandName,
    CommandResult,
    RunStateFile,
)
from innytypes.helper.breaker import HOST_ID, Breaker, QuarantineFile
from innytypes.helper.config import HelperSettings, UpdateSettings
from innytypes.helper.control import ControlListener, recorded_host_pid
from innytypes.helper.detection import HealthWatch, Limit, Observation
from innytypes.helper.heartbeat import Heartbeat, HeartbeatListener, HeartbeatRegistry
from innytypes.helper.notification import (
    Announcer,
    Notice,
    NoticeFile,
    Notifier,
    RecordingNotifier,
    UnsupportedPlatform,
    current_notices,
    notifier_for,
)
from innytypes.helper.processes import ManagedProcesses, Stop, SystemProcessTable
from innytypes.helper.restart import ControlChannel, RestartPolicy, ScheduledRestart
from innytypes.helper.swap import ReadyRelease, default_core_staging_path, read_ready_release
from innytypes.helper.update import (
    StagedRelease,
    UpdateError,
    check_and_stage,
    load_installed_public_key,
)

__all__ = [
    "Failure",
    "HelperApplication",
    "HostRestarts",
    "Listener",
    "Pass",
    "PublishedProfiles",
    "RegisteredProgress",
    "SupervisionTick",
    "Tick",
    "UpdateCheck",
    "build_supervision",
    "run_supervision",
]

log = get_logger(__name__)

# The scheduled core update check, as one call with everything else already bound: in
# production :func:`~innytypes.helper.update.check_and_stage` with the settings, the transport,
# the staging directory and the installed public key. It answers with what it staged, or
# ``None`` when the switch is off or nothing newer exists. A seam rather than a call, because
# the switch, the network and the signature are all things the gate must be able to hold still.
UpdateCheck = Callable[[], StagedRelease | None]

# What a step of a pass answers with when it failed. Named, and typed, because a bare `()`
# read as "a tuple of nothing in particular" is not the same type as the tuple the step would
# have produced, and the fallback has to be the one the caller goes on to use.
_NO_OBSERVATIONS: tuple[Observation, ...] = ()
_NO_RESULTS: tuple[CommandResult, ...] = ()
_NO_NOTICES: tuple[Notice, ...] = ()


class Listener(Protocol):
    """A socket the helper owns and reads on its own tick, never on a thread of its own.

    Both of them are this shape already —
    :class:`~innytypes.helper.heartbeat.HeartbeatListener` and
    :class:`~innytypes.helper.control.ControlListener` — and both answer with how much arrived,
    which is the only thing a pass needs to say about them.
    """

    def poll(self) -> int:
        """Take whatever has arrived, without blocking, and say how much there was."""
        ...


class Tick(Protocol):
    """One pass over the application, whatever is driving it."""

    def pass_once(self) -> Pass:
        """Watch, judge, act and tell the user, once."""
        ...


def _nothing_is_quitting() -> bool:
    """The answer when no quit record is wired up: nothing is being turned off."""
    return False


def _spread(window: float) -> float:
    """Somewhere inside ``window``, so installs do not all check at the same moment."""
    return random.uniform(0.0, window)  # noqa: S311 - a schedule's spread, never a secret


# ── the two adapters the parts were waiting for ──────────────────────────────────────────────


@dataclass(frozen=True)
class RegisteredProgress:
    """The progress markers in the heartbeat registry, as the sampling tick reads them.

    :class:`~innytypes.helper.detection.HealthWatch` asks one question about heartbeats — what
    is the latest progress marker for this process — and
    :class:`~innytypes.helper.heartbeat.HeartbeatRegistry` holds the whole beat. This is the
    join between them, and it is deliberately the *marker* rather than the arrival time: a
    process is stale when its marker has stopped **changing**, which is what catches a loop
    that keeps beating while doing no work.
    """

    registry: HeartbeatRegistry

    def progress_at(self, process_id: str) -> float | None:
        """The latest marker from ``process_id``, or ``None`` when it has never beaten."""
        latest = self.registry.latest(process_id)
        return None if latest is None else latest.beat.progress_at


@dataclass(frozen=True)
class PublishedProfiles:
    """Each plugin's ``stability`` section, read from the manifests discovery records.

    Without this the helper would watch every plugin against the helper-wide defaults and never
    judge any of them stale, however loudly their manifests promised heartbeats — the limits
    would be real and the promise would be ignored. The host, the MCP server and the Anytype
    desktop app publish nothing, so they answer ``None`` and are watched under the defaults,
    which is what plan 0003 says of a process with no profile.

    Read on every pass rather than once, because a plugin installed, updated or removed while
    the helper runs changes the answer, and no addon code is imported to find out: discovery
    reads the recorded manifest and nothing else.
    """

    root: Path
    discover: Callable[[Path], DiscoveryResult] = discover_addons

    def __call__(self, record: ChildRecord) -> StabilityProfile | None:
        """The profile this record published, or ``None`` when it published none."""
        if record.kind is not ChildKind.ADDON:
            return None

        for addon in self.discover(self.root).installed:
            if addon.id == record.id:
                return addon.manifest.stability
        return None


# ── the one process the helper starts itself ─────────────────────────────────────────────────


@dataclass
class HostRestarts(ControlChannel):
    """The channel the restart policy speaks, with the host's own restarts kept off the wire.

    Every other managed process is the host's to spawn, so restarting one is a command the host
    carries out. The host is the helper's, and a command telling the host to start itself would
    have to reach a process that has gone — so this routes those two commands to the helper's
    own hands instead, exactly as plan 0003's table says: *the helper kills it if needed, cleans
    up its orphans, and relaunches it*.

    Each of those three is an existing, identity-checked call
    (:class:`~innytypes.helper.processes.ManagedProcesses`), and the order is the whole of what
    this class contributes. A host relaunched before its orphans were cleared would come up
    beside the leftover MCP server and plugins of the host that died, and the second set would
    be the ones nothing has a record of.
    """

    link: ControlChannel
    processes: ManagedProcesses
    # Start the host again. In production
    # :meth:`~innytypes.helper.launcher.Application.relaunch_host`, which writes the new
    # run-state record the identity check and the control socket's `hello` both read.
    relaunch: Callable[[], object]

    def send(self, command: Command) -> CommandResult:
        """Carry out one command: the host's here, everything else's on the control channel."""
        if command.child_id != HOST_ID or command.name not in (
            CommandName.START,
            CommandName.RESTART,
        ):
            return self.link.send(command)

        if command.name is CommandName.RESTART:
            # A stale host is still alive, and starting a second one beside it is worse than
            # the hang. Identity-checked, polite first, forced after — the same stop everything
            # else in this application gets.
            for record in self.processes.records():
                if record.kind is ChildKind.HOST:
                    self.processes.stop(record)

        self._clear_orphans()
        self.relaunch()
        return CommandResult(name=command.name)

    def _clear_orphans(self) -> None:
        """Stop what the dead host left behind, before anything takes its place.

        Everything the host spawned has just lost its parent, and a new host coming up beside
        the previous one's MCP server and plugins would leave two of each with a record of one.

        **The helper is never one of them**, and the exception is not a tidiness: the helper's
        recorded parent is whoever launched it — a shell that has since exited, a Finder that
        never stays — and a recorded parent that is gone is exactly what makes a record look
        like an orphan. This process is the one process in that file that must never be
        signalled from here, because this process is the one doing the signalling.
        """
        for orphan in self.processes.orphans():
            if orphan.kind is ChildKind.HELPER:
                continue
            self.processes.stop(orphan)


# ── what one pass saw and did ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Failure:
    """One step of one pass that raised, named so a log line says which and about what."""

    step: str
    error: str
    # The process the step was about, where it was about one. Empty for the steps that are
    # about the application as a whole.
    subject: str = ""


@dataclass(frozen=True)
class Pass:
    """Everything one pass observed and did, which is also everything a test asserts on.

    A value rather than a log line, because the loop is the only caller in production and the
    gate is the caller that has to be able to see all of it.
    """

    observations: tuple[Observation, ...] = ()
    # How many heartbeats and how many child exits arrived while this pass was listening.
    beats: int = 0
    exits: int = 0
    # The processes this pass judged stale, and the ones it found stopped for a breach.
    stale: tuple[str, ...] = ()
    breached: tuple[str, ...] = ()
    # The restarts this pass decided on — whatever is waiting for a backoff that was not
    # waiting when the pass began — and the commands whose backoff ran out during it.
    scheduled: tuple[ScheduledRestart, ...] = ()
    issued: tuple[CommandResult, ...] = ()
    # Whether the core update check ran this pass, and what it staged if it did.
    checked: bool = False
    staged: StagedRelease | None = None
    # Every condition that is true now, and the ones the user was told about just now.
    notices: tuple[Notice, ...] = ()
    announced: tuple[Notice, ...] = ()
    failures: tuple[Failure, ...] = ()

    @property
    def survived(self) -> bool:
        """Whether every step of this pass ran without raising."""
        return not self.failures


@dataclass(frozen=True)
class _Acted:
    """What acting on one observation came to: the two verdicts that are worth reporting.

    What it *decided* is not here. A restart is the policy's to record, and this pass reads
    back what the policy is now waiting on — one answer for every way a restart can be
    decided on, rather than three that could disagree.
    """

    stale: bool
    breached: bool


def _attempt[T](
    step: str,
    work: Callable[[], T],
    *,
    fallback: T,
    failures: list[Failure],
    subject: str = "",
) -> T:
    """Run one step of a pass, and let a failure be a failure of that step alone.

    The bare ``Exception`` is the point rather than an oversight. What can come out of these
    steps is a file that will not parse, a process that went away mid-sample, a socket that
    dropped and an operating system that refused to show a notification — and the next pass is
    the thing that recovers from all four. An exception allowed out of here would end the
    supervision on the first one.
    """
    try:
        return work()
    except Exception as error:  # noqa: BLE001 - one bad step must never end the supervision
        about = f" for {subject}" if subject else ""
        log.error("the helper's %s step failed%s: %s", step, about, error)
        failures.append(Failure(step=step, error=str(error), subject=subject))
        return fallback


@dataclass
class SupervisionTick:
    """One pass over the whole application, and the state that spans passes.

    Everything it needs is a field, and everything that reaches outside this process is one of
    the injected ones. What it keeps between passes is deliberately small: when the next update
    check is due, and nothing else. The grace windows, the CPU window and the restart attempts
    are the state of the modules that own those rules, which is where a reader looks for them.
    """

    watch: HealthWatch
    policy: RestartPolicy
    breaker: Breaker
    # The control socket, polled for the child exits the host reports. ``None`` is a helper
    # built without one: it still watches, judges and reports.
    link: Listener | None = None
    # The heartbeat socket. ``None`` means nothing has ever reported progress, which is what
    # :class:`~innytypes.helper.detection.NoHeartbeats` already says.
    beats: Listener | None = None
    announcer: Announcer | None = None
    # Where `innytypes helper status` and `innytypes helper release` speak: the same file the
    # breaker writes its quarantines to, read here so a notice says what status says.
    quarantines: QuarantineFile | None = None
    # A core release waiting in staging, if one is
    # (:func:`~innytypes.helper.swap.read_ready_release`). Asked every pass, because a release
    # staged by an earlier run of the helper is still waiting when this one starts.
    staged: Callable[[], ReadyRelease | None] | None = None
    update: UpdateCheck | None = None
    # Read for the check interval and its spread. ``None`` uses the documented defaults; it
    # never reads the real per-user config file behind a caller's back.
    settings: HelperSettings | None = None
    # Whether a quit is on record. Nothing is restarted, counted or quarantined while one is:
    # a process exiting during a quit is the quit working.
    quitting: Callable[[], bool] = _nothing_is_quitting
    jitter: Callable[[float], float] = _spread
    now: Callable[[], float] = time.monotonic

    _due_at: float = field(default=0.0, init=False, repr=False)

    def __post_init__(self) -> None:
        # The first check is spread over the jitter window rather than made at launch, which is
        # what the spread is for: every installation starting after a power cut would otherwise
        # ask the release server the same question at the same second.
        self._due_at = self.now() + self.jitter(self._numbers().check_jitter)

    # ── one pass ──────────────────────────────────────────────────────────────────────────

    def pass_once(self) -> Pass:
        """Listen, judge, act, issue what is due, check for an update, tell the user."""
        failures: list[Failure] = []
        # What was already waiting for its backoff when this pass began. Whatever is waiting
        # at the end and was not here is what *this* pass decided on — from an exit the host
        # reported, from a stale verdict or from a breach, without this having to be told
        # which, and without the exits' answers having to be threaded back through a socket.
        waiting = set(self.policy.pending)

        beats = _attempt("listen", _polling(self.beats), fallback=0, failures=failures)
        exits = _attempt("listen", _polling(self.link), fallback=0, failures=failures)

        observations = _attempt(
            "sample", self.watch.tick, fallback=_NO_OBSERVATIONS, failures=failures
        )
        acted = self._act(observations, failures=failures)

        issued = _attempt("restart", self.policy.tick, fallback=_NO_RESULTS, failures=failures)

        checked, staged = self._check_for_update(failures=failures)
        notices, announced = self._tell(failures=failures)

        return Pass(
            observations=observations,
            beats=beats,
            exits=exits,
            stale=tuple(one.record.id for one, did in acted if did.stale),
            breached=tuple(one.record.id for one, did in acted if did.breached),
            scheduled=tuple(one for one in self.policy.pending if one not in waiting),
            issued=issued,
            checked=checked,
            staged=staged,
            notices=notices,
            announced=announced,
            failures=tuple(failures),
        )

    # ── acting on what was judged ─────────────────────────────────────────────────────────

    def _act(
        self, observations: Sequence[Observation], *, failures: list[Failure]
    ) -> tuple[tuple[Observation, _Acted], ...]:
        """Turn this pass's verdicts into interventions, one process at a time.

        Per process rather than for the lot, so that a host that is not connected — or any
        other failure reaching one child — leaves every other child of this pass acted on.
        """
        if self.quitting():
            log.debug("a quit is on record; this pass judges and reports but restarts nothing")
            return ()

        acted: list[tuple[Observation, _Acted]] = []
        for observation in observations:
            outcome = _attempt(
                "act",
                partial(self._act_on, observation),
                fallback=None,
                failures=failures,
                subject=observation.record.id,
            )
            if outcome is not None:
                acted.append((observation, outcome))

        return tuple(acted)

    def _act_on(self, observation: Observation) -> _Acted:
        """One process: count what the helper had to do, and let the policy decide the rest."""
        child_id = observation.record.id
        breached = _was_stopped(observation)

        if observation.stale and self.breaker.record(child_id, reason="stopped making progress"):
            self.policy.child_stale(child_id)

        if breached:
            if not self._restartable(observation.record):
                log.info(
                    "%s was stopped for a resource breach and its profile says it is never "
                    "relaunched, so it stays stopped",
                    child_id,
                )
            elif self.breaker.record(child_id, reason=_breach_reason(observation)):
                self.policy.child_stopped_for_breach(child_id)

        return _Acted(stale=observation.stale, breached=breached)

    def _restartable(self, record: ChildRecord) -> bool:
        """Whether this process's own profile allows it to be brought back.

        Asked of the same lookup :class:`~innytypes.helper.detection.HealthWatch` judges
        against, so the profile that decided the breach is the profile that decides the
        relaunch. A process that published nothing is restartable, which is the default a
        manifest carries.
        """
        profile = self.watch.profiles(record)
        return True if profile is None else profile.restartable

    # ── the core update check, on its schedule ────────────────────────────────────────────

    def _check_for_update(self, *, failures: list[Failure]) -> tuple[bool, StagedRelease | None]:
        """Run the scheduled check when it is due, and say whether it ran.

        The **switch is not read here**. It is read inside
        :func:`~innytypes.helper.update.check_for_update`, immediately before the request, so
        turning ``auto_check_versions`` off is obeyed on the next pass with no restart — and
        so this module cannot become a second place that decides whether the network is
        touched.
        """
        if self.update is None:
            return False, None

        now = self.now()
        if now < self._due_at:
            return False, None

        numbers = self._numbers()
        self._due_at = now + numbers.check_interval + self.jitter(numbers.check_jitter)
        return True, _attempt("update", self.update, fallback=None, failures=failures)

    def _numbers(self) -> UpdateSettings:
        """The check's schedule, re-read every time, as every other switch in here is."""
        return UpdateSettings() if self.settings is None else self.settings.current.update

    # ── telling the user ──────────────────────────────────────────────────────────────────

    def _tell(self, *, failures: list[Failure]) -> tuple[tuple[Notice, ...], tuple[Notice, ...]]:
        """Hand the whole set of current conditions over, and post what is new.

        The set is rebuilt from the world on every pass rather than accumulated, because that
        shape is what makes "a notification per change of state, never per tick" a property of
        :class:`~innytypes.helper.notification.Announcer` rather than a discipline here.
        """
        if self.announcer is None:
            return (), ()

        notices = _attempt("notify", self._conditions, fallback=_NO_NOTICES, failures=failures)
        announced = _attempt(
            "notify",
            partial(self.announcer.announce, notices),
            fallback=_NO_NOTICES,
            failures=failures,
        )
        return notices, announced

    def _conditions(self) -> tuple[Notice, ...]:
        """Every condition that is true right now, from what this helper currently holds."""
        return current_notices(
            quarantines=None if self.quarantines is None else self.quarantines.load(),
            staged=None if self.staged is None else self.staged(),
        )


def _polling(listener: Listener | None) -> Callable[[], int]:
    """Reading one socket, or reading nothing when the helper was built without it."""
    if listener is None:
        return lambda: 0
    return listener.poll


def _was_stopped(observation: Observation) -> bool:
    """Whether this pass's sampling actually stopped the process for a sustained breach."""
    return observation.stopped is not None and observation.stopped.outcome in (
        Stop.TERMINATED,
        Stop.KILLED,
    )


def _breach_reason(observation: Observation) -> str:
    """Why it was stopped, in the words the quarantine notice will carry to the user."""
    limits = ", ".join(sorted({str(breach.limit) for breach in observation.sustained}))
    return f"stopped for a {limits or str(Limit.MEMORY)} breach"


# ── the loop an installation with no window runs ─────────────────────────────────────────────


def run_supervision(
    tick: Tick,
    *,
    interval: Callable[[], float],
    sleep: Callable[[float], None] = time.sleep,
    stop: Callable[[], bool] | None = None,
) -> int:
    """Pass after pass, for as long as the application runs. Answers with how many ran.

    ``interval`` is a callable rather than a number because ``helper.tick`` lives in
    `config.toml` and the helper re-reads that file on every access: a user who changes the
    tick is obeyed without a restart, like every other switch.

    The guard around the pass is belt and braces over the one inside it. Every step of a pass
    already catches its own failure; this catches whatever a pass could not have been written
    to expect, because the promise this loop makes is that there is always a next pass.
    """
    done = _nothing_is_quitting if stop is None else stop
    passes = 0

    while not done():
        passes += 1
        try:
            tick.pass_once()
        except Exception as error:  # noqa: BLE001 - there is always a next pass
            log.error("a supervision pass ended in an error nothing inside it caught: %s", error)
        sleep(interval())

    return passes


# ── the one assembly that touches the real machine ───────────────────────────────────────────


class HelperApplication(Protocol):
    """The application this tick supervises, as far as the tick needs it.

    Three things and no more, so that :mod:`innytypes.helper.launcher` imports this module
    rather than the other way round: whether a quit is on record, what a child's exit means,
    and how the host is started again. :class:`~innytypes.helper.launcher.Application` answers
    all three already.
    """

    @property
    def quitting(self) -> bool:
        """Whether a quit is on record."""
        ...

    def child_exited(self, exit_report: ChildExit) -> ScheduledRestart | None:
        """What a child's exit means — which, during a quit, is nothing at all."""
        ...

    def relaunch_host(self) -> ChildRecord:
        """Start the host again, and record the process that is now the host."""
        ...


def build_supervision(
    *,
    application: HelperApplication,
    processes: ManagedProcesses,
    run_state: RunStateFile,
    settings: HelperSettings,
    show_window: Callable[[], None] | None = None,
) -> SupervisionTick:  # pragma: no cover - the one function here that opens a real socket
    """The helper's tick, with every seam filled by the real thing on this machine.

    Called once, by :func:`~innytypes.helper.launcher.main`, **before** the host is started:
    the control socket has to exist for the host to connect to it, and the heartbeat socket has
    to exist before anything beats on it.

    Three of the parts are allowed to be missing, and each absence is a documented behaviour
    rather than a failure to start. A socket that cannot be opened leaves a helper that still
    samples, judges and reports. A platform with no notifier leaves one that records what it
    would have shown and keeps `innytypes helper status` truthful. And a build that ships **no
    release signing key checks for no update at all** (plan 0003, *Core auto-update*), which is
    the intended answer rather than a gap: the alternative to refusing every update is accepting
    one nobody signed.
    """
    numbers = settings.current.helper
    staging = default_core_staging_path()

    registry = HeartbeatRegistry()

    def keep(beat: Heartbeat) -> None:
        """Every beat that arrives, kept as the latest for the process that sent it."""
        registry.record(beat)

    def exited(exit_report: ChildExit) -> None:
        """Every child exit the host reports, straight to the one place that judges one.

        The restart it may schedule is answered to nobody here: the exits arrive while the
        pass is listening, and what was scheduled is issued when its backoff runs out.
        """
        application.child_exited(exit_report)

    beats = HeartbeatListener(sink=keep)
    link = ControlListener(report_exit=exited, host_pid=recorded_host_pid(run_state))
    for name, listener in (("heartbeat", beats), ("control", link)):
        try:
            listener.open()
        except Exception as error:  # noqa: BLE001 - a socket is not a reason to watch nothing
            log.error("the helper's %s socket could not be opened: %s", name, error)

    try:
        notifier: Notifier = notifier_for(platform.system(), on_click=show_window)
    except UnsupportedPlatform as error:
        log.warning("%s; conditions are still recorded for `innytypes helper status`", error)
        notifier = RecordingNotifier()

    return SupervisionTick(
        watch=HealthWatch(
            processes=processes,
            probe=SystemProcessTable(),
            numbers=numbers,
            heartbeats=RegisteredProgress(registry),
            profiles=PublishedProfiles(default_addons_root()),
        ),
        policy=RestartPolicy(
            channel=HostRestarts(
                link=link,
                processes=processes,
                relaunch=application.relaunch_host,
            ),
            settings=numbers.restart,
        ),
        breaker=Breaker(settings=numbers.breaker, store=QuarantineFile()),
        link=link,
        beats=beats,
        announcer=Announcer(notifier=notifier, store=NoticeFile()),
        quarantines=QuarantineFile(),
        staged=partial(read_ready_release, staging),
        update=_core_update_check(settings, staging=staging),
        settings=settings,
        quitting=lambda: application.quitting,
    )


def _core_update_check(
    settings: HelperSettings, *, staging: Path
) -> UpdateCheck | None:  # pragma: no cover - reads the key shipped inside the release
    """The scheduled check, bound to this build's key, or ``None`` when it ships none.

    The client is opened per check rather than held for the life of the helper: checks are a
    day apart, and a connection kept open between them would be a socket held open for a day.
    The switch is not consulted here — :func:`~innytypes.helper.update.check_for_update` reads
    it immediately before the request, which is the one place that decides it.
    """
    try:
        public_key = load_installed_public_key()
    except UpdateError as error:
        log.info("%s", error)
        return None

    def check() -> StagedRelease | None:
        with httpx.Client() as client:
            return check_and_stage(
                settings=settings,
                client=client,
                staging=staging,
                public_key=public_key,
            )

    return check
