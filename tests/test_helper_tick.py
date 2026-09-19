"""The assembled tick: whole passes, driven against a machine made entirely of plain data.

Every part of plan 0003 already had a test of its own, and the application still watched
nothing — the helper's loop was ``while True: time.sleep(tick)``. That is exactly why nothing
here tests a policy in isolation: each test below drives **whole passes** of
:class:`~innytypes.helper.supervision.SupervisionTick` and asserts what a pass did to the
machine, so a policy that stops being called fails a test rather than passing five.

Four rules are the ones worth breaking on purpose, because each is something a careless
assembly does by omission:

*Commands are what the policy decided, and nothing else.* A stale plugin and a crashed one both
wait out their backoff before anything is sent —
:func:`test_a_stale_plugin_is_restarted_only_when_its_backoff_has_run_out` and
:func:`test_an_exit_is_restarted_on_the_configured_backoff` turn red the moment a pass starts
issuing restarts of its own.

*Failing twice is a process, failing five times is a problem.* The breaker counts what the tick
had to do, and the fifth intervention quarantines the plugin, tells the user once, and stops the
restarts — :func:`test_a_plugin_that_keeps_failing_ends_quarantined_and_the_user_is_told`.

*A bad pass is one pass.* An unreadable run-state file, a process that vanishes between the
identity check and the sample, a host nothing is connected to and a notifier that refuses are
each driven here, and each is followed by a pass that works.

*The window does not stop the watching.* The same pass runs on the toolkit's own loop, and the
loop is free between passes — which is what "drawing does not block it" means in the only place
it can be asserted without a screen.

Nothing here touches the machine: the process table and the resource probe are one dictionary,
the signaller is a list the table reacts to, the clock is a number a test moves, the control
channel and the heartbeat socket are objects a test writes into, and the release server is an
``httpx.MockTransport``. No process is started, no socket is opened and no test sleeps.
"""

from __future__ import annotations

import base64
import json
import secrets
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from nacl.signing import SigningKey

from innytypes import HOST_API_VERSION
from innytypes.addons.discovery import recorded_manifest_path
from innytypes.addons.manifest import StabilityProfile
from innytypes.children import (
    MCP_CHILD_ID,
    ChildExit,
    ChildKind,
    ChildRecord,
    Command,
    CommandName,
    CommandResult,
    RunStateFile,
)
from innytypes.helper.breaker import HOST_ID, Breaker, QuarantineFile
from innytypes.helper.config import BreakerSettings, HelperSettings, RestartSettings
from innytypes.helper.control import HostNotRunningError
from innytypes.helper.detection import HealthWatch
from innytypes.helper.heartbeat import Heartbeat, HeartbeatRegistry, ProcessState
from innytypes.helper.launcher import (
    ANYTYPE_APP_ID,
    HELPER_ID,
    QUIT_FILENAME,
    Application,
    InstanceLock,
    QuitFile,
    QuitReason,
)
from innytypes.helper.minisign import parse_public_key
from innytypes.helper.notification import (
    Announcer,
    Message,
    NoticeFile,
    NoticeKind,
    RecordingNotifier,
)
from innytypes.helper.processes import (
    ManagedProcesses,
    ProcessFacts,
    ResourceSample,
    Signal,
)
from innytypes.helper.restart import RestartPolicy
from innytypes.helper.supervision import (
    HostRestarts,
    Pass,
    PublishedProfiles,
    RegisteredProgress,
    SupervisionTick,
    run_supervision,
)
from innytypes.helper.toolkit import TogaDesktop, Toolkit
from innytypes.helper.update import check_and_stage
from innytypes.helper.window import WindowError

# The machine these tests describe, with numbers recognisable on sight in a failure message.
HELPER_PID = 4100
HOST_PID = 4200
MCP_PID = 4300
PLUGIN_PID = 4500
ANYTYPE_PID = 4700

STARTED_AT = 1_700_000_000.0

HELPER_EXECUTABLE = "/usr/local/bin/innytypes-helper"
HOST_COMMAND = ("/usr/local/bin/python", "-m", "innytypes", "up")
PLUGIN_EXECUTABLE = "/Users/someone/.local/share/innytypes/addons/monty/env/bin/python"
MCP_EXECUTABLE = "/opt/homebrew/bin/node"
ANYTYPE_EXECUTABLE = "/Applications/Anytype.app/Contents/MacOS/Anytype"
STRANGER_EXECUTABLE = "/Applications/Ledger.app/Contents/MacOS/Ledger"

PLUGIN_ID = "monty"

# The plugin's own promise: a beat every ten seconds, so silence means something after thirty.
HEARTBEAT_INTERVAL = 10.0
STALE_AFTER = 3 * HEARTBEAT_INTERVAL

# The helper's numbers, spelled here so a test that changes one says so.
BACKOFF = (1.0, 2.0, 4.0, 8.0, 16.0)
GRACE = StabilityProfile().breach_grace
MEMORY_LIMIT = StabilityProfile().max_rss_mb


# --- the machine, as plain data --------------------------------------------------------------


class FakeClock:
    """A clock that moves only when a test says so, and when a stop is waited out."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class FakeMachine:
    """The OS process table, the resource probe and the signaller, as one object.

    One object because the real :class:`~innytypes.helper.processes.SystemProcessTable` is one,
    and because two fakes that had to agree about which processes exist would eventually stop
    agreeing. Signalling is modelled rather than recorded: a polite stop removes the process
    unless the test said this one is stubborn, and a kill always removes it.
    """

    facts_by_pid: dict[int, ProcessFacts] = field(default_factory=dict)
    samples: dict[int, ResourceSample] = field(default_factory=dict)
    signals: list[tuple[int, Signal]] = field(default_factory=list)
    sampled: list[int] = field(default_factory=list)
    stubborn: set[int] = field(default_factory=set)
    # Process ids whose sample raises instead of answering: a process that went away between
    # the identity check and the reading.
    vanishing: set[int] = field(default_factory=set)

    def facts(self, pid: int) -> ProcessFacts | None:
        return self.facts_by_pid.get(pid)

    def resources(self, pid: int) -> ResourceSample | None:
        self.sampled.append(pid)
        if pid in self.vanishing:
            raise ProcessLookupError(f"process {pid} went away while it was being read")
        return self.samples.get(pid)

    def send(self, pid: int, which: Signal) -> None:
        self.signals.append((pid, which))
        if which is Signal.KILL or pid not in self.stubborn:
            self.facts_by_pid.pop(pid, None)
            self.samples.pop(pid, None)

    def add(self, record: ChildRecord, *, sample: ResourceSample | None = None) -> None:
        self.facts_by_pid[record.pid] = ProcessFacts(
            pid=record.pid,
            started_at=record.started_at,
            executable=record.executable,
        )
        self.samples[record.pid] = calm() if sample is None else sample

    @property
    def signalled_pids(self) -> list[int]:
        return [pid for pid, _ in self.signals]


def calm(**changed: float | int) -> ResourceSample:
    """A process using nothing anyone would object to, with one field nameable per call."""
    reading = {"rss_mb": 64.0, "cpu_seconds": 0.0, "open_files": 12, "children": 0}
    reading.update(changed)
    return ResourceSample(
        rss_mb=float(reading["rss_mb"]),
        cpu_seconds=float(reading["cpu_seconds"]),
        open_files=int(reading["open_files"]),
        children=int(reading["children"]),
    )


@dataclass
class FakeProcess:
    """Enough of a spawned process for a record to be written about it.

    Structural rather than a subclass of :class:`~innytypes.children.ChildProcess`: that
    protocol's ``pid`` is a read-only property, and what a launcher hands back here is a
    number a test chose.
    """

    pid: int

    def poll(self) -> int | None:  # pragma: no cover - nothing here waits on the host
        return None

    def terminate(self) -> None:  # pragma: no cover - the helper signals through the table
        return None

    def kill(self) -> None:  # pragma: no cover - the helper signals through the table
        return None

    def wait(self, timeout: float | None = None) -> int:  # pragma: no cover - never waited on
        return 0


@dataclass
class FakeLauncher:
    """Records what would have been launched, and makes the fake table believe it exists."""

    machine: FakeMachine
    clock: FakeClock
    next_pid: int = 5_000
    argvs: list[tuple[str, ...]] = field(default_factory=list)

    def __call__(self, argv: Sequence[str]) -> FakeProcess:
        self.argvs.append(tuple(argv))
        self.next_pid += 1
        self.machine.facts_by_pid[self.next_pid] = ProcessFacts(
            pid=self.next_pid,
            started_at=self.clock(),
            executable=argv[0],
        )
        self.machine.samples[self.next_pid] = calm()
        return FakeProcess(pid=self.next_pid)


class NoApplications:
    """No application of interest is already running, so nothing is ever adopted."""

    def find(self, executable: str) -> ProcessFacts | None:
        return None


def _ignore(exit_report: ChildExit) -> None:
    """The exit reporter a link has until the application it reports to exists."""


@dataclass
class FakeLink:
    """The control channel, as the helper holds it: commands out, child exits back.

    The same object in both directions, exactly as :class:`ControlListener` is, because that is
    what makes an exit reported while a stop is being carried out arrive in order.
    """

    report_exit: Callable[[ChildExit], None] = _ignore
    commands: list[Command] = field(default_factory=list)
    waiting: list[ChildExit] = field(default_factory=list)
    connected: bool = True

    def poll(self) -> int:
        """Deliver every exit the host has reported since the last pass."""
        delivered, self.waiting = list(self.waiting), []
        for exit_report in delivered:
            self.report_exit(exit_report)
        return len(delivered)

    def send(self, command: Command) -> CommandResult:
        if not self.connected:
            raise HostNotRunningError("no host is connected to this helper")
        self.commands.append(command)
        return CommandResult(name=command.name)

    @property
    def named(self) -> list[tuple[str, str]]:
        """Every command sent, as (name, child) pairs a failure message can be read out of."""
        return [(str(command.name), command.child_id) for command in self.commands]


@dataclass
class FakeBeats:
    """The heartbeat socket: the beats a test says have arrived, recorded when it is polled."""

    registry: HeartbeatRegistry
    waiting: list[Heartbeat] = field(default_factory=list)
    polls: int = 0

    def poll(self) -> int:
        self.polls += 1
        arrived, self.waiting = list(self.waiting), []
        for beat in arrived:
            self.registry.record(beat)
        return len(arrived)


@dataclass
class RefusingNotifier:
    """A notification backend that will not show anything, and says so by raising."""

    refusals: int = 0

    def post(self, message: Message) -> None:
        self.refusals += 1
        raise RuntimeError("the notification centre refused this message")


# --- one assembled helper ----------------------------------------------------------------


def a_record(
    *,
    id: str = PLUGIN_ID,
    kind: ChildKind = ChildKind.ADDON,
    pid: int = PLUGIN_PID,
    started_at: float = STARTED_AT,
    executable: str = PLUGIN_EXECUTABLE,
    parent_pid: int = HOST_PID,
) -> ChildRecord:
    """One record, as whoever spawned the process wrote it."""
    return ChildRecord(
        id=id,
        kind=kind,
        pid=pid,
        started_at=started_at,
        executable=executable,
        parent_pid=parent_pid,
    )


HELPER_RECORD = a_record(
    id=HELPER_ID,
    kind=ChildKind.HELPER,
    pid=HELPER_PID,
    executable=HELPER_EXECUTABLE,
    parent_pid=1,
)
HOST_RECORD = a_record(
    id=HOST_ID,
    kind=ChildKind.HOST,
    pid=HOST_PID,
    executable=HOST_COMMAND[0],
    parent_pid=HELPER_PID,
)
MCP_RECORD = a_record(id=MCP_CHILD_ID, kind=ChildKind.MCP, pid=MCP_PID, executable=MCP_EXECUTABLE)
PLUGIN_RECORD = a_record()
ANYTYPE_RECORD = a_record(
    id=ANYTYPE_APP_ID,
    kind=ChildKind.ANYTYPE_APP,
    pid=ANYTYPE_PID,
    executable=ANYTYPE_EXECUTABLE,
    parent_pid=HELPER_PID,
)


@dataclass
class Harness:
    """One assembled helper, and everything a test needs to assert about it."""

    tick: SupervisionTick
    application: Application
    machine: FakeMachine
    clock: FakeClock
    link: FakeLink
    beats: FakeBeats
    registry: HeartbeatRegistry
    notifier: RecordingNotifier
    breaker: Breaker
    policy: RestartPolicy
    processes: ManagedProcesses
    run_state: RunStateFile
    run_state_path: Path
    quits: QuitFile
    launcher: FakeLauncher
    quarantines: QuarantineFile
    notices: NoticeFile
    profiles: dict[str, StabilityProfile]

    def records(self) -> dict[str, ChildRecord]:
        return {record.id: record for record in self.run_state.records()}

    def beat(self, *, at: float, record: ChildRecord = PLUGIN_RECORD) -> None:
        """One heartbeat from a process, carrying ``at`` as its progress marker."""
        self.beats.waiting.append(
            Heartbeat(
                id=record.id,
                kind=record.kind,
                pid=record.pid,
                started_at=record.started_at,
                version="1.0.0",
                state=ProcessState.READY,
                progress_at=at,
            )
        )

    def crash(self, *, child: ChildRecord = PLUGIN_RECORD, code: int = 1) -> None:
        """The host reporting that one of its children has gone, on the control channel."""
        self.machine.facts_by_pid.pop(child.pid, None)
        self.machine.samples.pop(child.pid, None)
        self.run_state.forget(child.id)
        self.link.waiting.append(
            ChildExit(
                id=child.id,
                kind=child.kind,
                pid=child.pid,
                exit_code=code,
                expected=False,
            )
        )


@pytest.fixture
def make_helper(tmp_path: Path) -> Callable[..., Harness]:
    """Build a helper whose every seam is a fake, under this test's own directory."""

    def _make(
        *,
        records: Sequence[ChildRecord] = (HELPER_RECORD, HOST_RECORD, PLUGIN_RECORD),
        profile: StabilityProfile | None = None,
        update: Callable[[], Any] | None = None,
        settings: HelperSettings | None = None,
        notifier: RecordingNotifier | None = None,
        max_interventions: int = 5,
    ) -> Harness:
        clock = FakeClock()
        machine = FakeMachine()
        run_state = RunStateFile(tmp_path / "run-state.json")

        for record in records:
            run_state.write(record)
            machine.add(record)

        processes = ManagedProcesses(
            run_state=run_state,
            table=machine,
            send_signal=machine.send,
            clock=clock,
            sleep=lambda seconds: clock.advance(seconds),
            stop_timeout=10.0,
        )
        quits = QuitFile(path=tmp_path / QUIT_FILENAME)
        launcher = FakeLauncher(machine=machine, clock=clock)
        link = FakeLink()

        breaker = Breaker(
            settings=BreakerSettings(max_interventions=max_interventions, window=600.0),
            now=clock,
            store=QuarantineFile(path=tmp_path / "quarantine.json"),
        )
        policy = RestartPolicy(
            channel=HostRestarts(
                link=link,
                processes=processes,
                relaunch=lambda: application.relaunch_host(),
            ),
            settings=RestartSettings(max_attempts=5, backoff=BACKOFF),
            now=clock,
        )

        application = Application(
            lock=InstanceLock(path=tmp_path / "helper.lock", processes=processes),
            processes=processes,
            run_state=run_state,
            quits=quits,
            applications=NoApplications(),
            start_process=launcher,
            host_command=HOST_COMMAND,
            anytype_executable=None,
            identity=lambda: HELPER_RECORD,
            policy=policy,
            breaker=breaker,
            clock=clock,
        )
        link.report_exit = application.child_exited

        registry = HeartbeatRegistry(clock=clock)
        beats = FakeBeats(registry=registry)
        profiles = {PLUGIN_ID: profile} if profile is not None else {}
        recording = RecordingNotifier() if notifier is None else notifier

        return Harness(
            tick=SupervisionTick(
                watch=HealthWatch(
                    processes=processes,
                    probe=machine,
                    heartbeats=RegisteredProgress(registry),
                    profiles=lambda record: profiles.get(record.id),
                    clock=clock,
                ),
                policy=policy,
                breaker=breaker,
                link=link,
                beats=beats,
                announcer=Announcer(
                    notifier=recording, store=NoticeFile(path=tmp_path / "notices.json")
                ),
                quarantines=QuarantineFile(path=tmp_path / "quarantine.json"),
                update=update,
                settings=settings,
                quitting=lambda: application.quitting,
                jitter=lambda window: 0.0,
                now=clock,
            ),
            application=application,
            machine=machine,
            clock=clock,
            link=link,
            beats=beats,
            registry=registry,
            notifier=recording,
            breaker=breaker,
            policy=policy,
            processes=processes,
            run_state=run_state,
            run_state_path=tmp_path / "run-state.json",
            quits=quits,
            launcher=launcher,
            quarantines=QuarantineFile(path=tmp_path / "quarantine.json"),
            notices=NoticeFile(path=tmp_path / "notices.json"),
            profiles=profiles,
        )

    return _make


def beating_plugin() -> StabilityProfile:
    """A plugin that promised to report progress every ten seconds, so silence means something."""
    return StabilityProfile(heartbeat_interval=HEARTBEAT_INTERVAL)


# --- one pass, end to end -------------------------------------------------------------------


def test_one_pass_reads_the_heartbeats_and_samples_every_managed_process(
    make_helper: Callable[..., Harness],
) -> None:
    """The whole point of the slice: one pass actually looks at the whole machine.

    Every record in the run-state file is sampled — the host, the plugin, the MCP server and
    the Anytype desktop app, which publishes nothing and is watched all the same — and the
    heartbeat socket is read before any of it is judged.
    """
    helper = make_helper(
        records=(HELPER_RECORD, HOST_RECORD, MCP_RECORD, PLUGIN_RECORD, ANYTYPE_RECORD),
        profile=beating_plugin(),
    )
    helper.beat(at=STARTED_AT + 5)

    report = helper.tick.pass_once()

    assert report.beats == 1
    assert helper.registry.latest(PLUGIN_ID) is not None
    assert sorted(helper.machine.sampled) == sorted(
        [HELPER_PID, HOST_PID, MCP_PID, PLUGIN_PID, ANYTYPE_PID]
    )
    assert {one.record.id for one in report.observations} == {
        HELPER_ID,
        HOST_ID,
        MCP_CHILD_ID,
        PLUGIN_ID,
        ANYTYPE_APP_ID,
    }
    # Nothing was wrong, so nothing was asked of the host and nobody was signalled.
    assert helper.link.commands == []
    assert helper.machine.signals == []
    assert report.survived


def test_a_record_whose_process_id_was_reused_is_forgotten_and_never_signalled(
    make_helper: Callable[..., Harness],
) -> None:
    """The most dangerous thing a supervisor can do, asserted on a whole pass.

    The plugin's process id now belongs to an unrelated program. The pass forgets the record,
    samples nothing about it, signals nobody, and does not ask the host to restart it.
    """
    helper = make_helper(profile=beating_plugin())
    helper.machine.facts_by_pid[PLUGIN_PID] = ProcessFacts(
        pid=PLUGIN_PID,
        started_at=STARTED_AT + 5_000,
        executable=STRANGER_EXECUTABLE,
    )

    report = helper.tick.pass_once()

    assert PLUGIN_ID not in helper.records()
    assert PLUGIN_PID not in helper.machine.sampled
    assert helper.machine.signals == []
    assert helper.link.commands == []
    assert report.stale == ()


def test_a_stale_plugin_is_restarted_only_when_its_backoff_has_run_out(
    make_helper: Callable[..., Harness],
) -> None:
    """Stale is judged by the tick, decided by the policy, and issued when it is due.

    Nothing is signalled for staleness — the plan is explicit that the restart policy is the
    single decision — so the plugin's process is untouched and the only thing that happens is a
    `restart` command, one backoff later.
    """
    helper = make_helper(profile=beating_plugin())
    helper.beat(at=STARTED_AT + 5)
    helper.tick.pass_once()

    helper.clock.advance(STALE_AFTER + 1)
    stale = helper.tick.pass_once()

    assert stale.stale == (PLUGIN_ID,)
    assert [one.child_id for one in stale.scheduled] == [PLUGIN_ID]
    # Decided, not done: the backoff has not run out, so nothing has been asked of the host.
    assert helper.link.commands == []
    assert helper.machine.signalled_pids == []

    helper.clock.advance(BACKOFF[0])
    issued = helper.tick.pass_once()

    assert helper.link.named == [(str(CommandName.RESTART), PLUGIN_ID)]
    assert [str(result.name) for result in issued.issued] == [str(CommandName.RESTART)]


def test_a_plugin_that_promised_no_heartbeats_is_never_judged_stale(
    make_helper: Callable[..., Harness],
) -> None:
    """The absence that a careless assembly gets wrong by doing nothing.

    A plugin with no `stability` section, and the Anytype desktop app which publishes nothing
    at all, may say nothing for as long as they like. Judging them stale would restart both of
    them within a minute of every launch.
    """
    helper = make_helper(records=(HELPER_RECORD, HOST_RECORD, PLUGIN_RECORD, ANYTYPE_RECORD))

    helper.tick.pass_once()
    helper.clock.advance(STALE_AFTER * 10)
    report = helper.tick.pass_once()

    assert report.stale == ()
    assert helper.link.commands == []


def test_a_sustained_memory_breach_is_stopped_politely_and_then_brought_back(
    make_helper: Callable[..., Harness],
) -> None:
    """A breach is acted on by the tick, and the return is the policy's, as everywhere else.

    The polite stop comes first (D5 and the plan's *Resource breaches*), the record is
    forgotten once the process has gone, and the restart is a command the host carries out
    when the backoff has run out.
    """
    helper = make_helper(profile=beating_plugin())
    helper.machine.samples[PLUGIN_PID] = calm(rss_mb=MEMORY_LIMIT + 200)

    helper.tick.pass_once()
    helper.clock.advance(GRACE + 1)
    breached = helper.tick.pass_once()

    assert breached.breached == (PLUGIN_ID,)
    assert helper.machine.signals == [(PLUGIN_PID, Signal.TERMINATE)]
    assert PLUGIN_ID not in helper.records()

    helper.clock.advance(BACKOFF[0])
    helper.tick.pass_once()

    assert helper.link.named == [(str(CommandName.RESTART), PLUGIN_ID)]


def test_a_plugin_that_may_never_be_relaunched_is_stopped_and_left_stopped(
    make_helper: Callable[..., Harness],
) -> None:
    """``restartable: false`` is the plugin's own word, and the tick obeys it.

    It is stopped for the breach like any other, and no restart is ever decided on — which is
    the half an assembly forgets, because forgetting it looks like working.
    """
    helper = make_helper(profile=StabilityProfile(restartable=False))
    helper.machine.samples[PLUGIN_PID] = calm(rss_mb=MEMORY_LIMIT + 200)

    helper.tick.pass_once()
    helper.clock.advance(GRACE + 1)
    report = helper.tick.pass_once()

    assert helper.machine.signals == [(PLUGIN_PID, Signal.TERMINATE)]
    assert report.scheduled == ()

    helper.clock.advance(sum(BACKOFF))
    helper.tick.pass_once()

    assert helper.link.commands == []


# --- exits, backoff, the breaker and the user -----------------------------------------------


def test_an_exit_is_restarted_on_the_configured_backoff(
    make_helper: Callable[..., Harness],
) -> None:
    """A child that exits comes back with increasing delays, and the host restarts nothing.

    The exit arrives on the control channel while the pass is listening, which is the whole
    shape of the wiring: the helper hears about a crash without polling the run-state file.
    """
    helper = make_helper()

    delays: list[float] = []
    for attempt, delay in enumerate(BACKOFF[:3], start=1):
        helper.crash()
        report = helper.tick.pass_once()

        assert report.exits == 1
        assert [one.attempt for one in report.scheduled] == [attempt]
        delays.append(report.scheduled[0].due_at - helper.clock())

        # A pass an instant before the delay has run out issues nothing at all.
        helper.clock.advance(delay - 0.5)
        assert helper.tick.pass_once().issued == ()

        helper.clock.advance(0.5)
        issued = helper.tick.pass_once()
        assert [str(result.name) for result in issued.issued] == [str(CommandName.RESTART)]

        helper.run_state.write(PLUGIN_RECORD)
        helper.machine.add(PLUGIN_RECORD)

    assert delays == list(BACKOFF[:3])
    assert helper.link.named == [(str(CommandName.RESTART), PLUGIN_ID)] * 3


def test_a_plugin_that_keeps_failing_ends_quarantined_and_the_user_is_told(
    make_helper: Callable[..., Harness],
) -> None:
    """Five interventions inside the window, and the helper stops trying — out loud.

    Everything in this test is driven through passes: the exits arrive on the channel, the
    breaker counts them, the quarantine is written where `innytypes helper status` reads it,
    and the notification is posted **once** however many passes follow.
    """
    helper = make_helper()

    for delay in BACKOFF:
        helper.crash()
        helper.tick.pass_once()
        helper.clock.advance(delay)
        helper.tick.pass_once()
        helper.run_state.write(PLUGIN_RECORD)
        helper.machine.add(PLUGIN_RECORD)

    # Four attempts were made and the fifth intervention was the end of them.
    assert helper.link.named == [(str(CommandName.RESTART), PLUGIN_ID)] * 4
    assert helper.breaker.is_quarantined(PLUGIN_ID)
    assert PLUGIN_ID in helper.quarantines.load()

    quarantined = [message for message in helper.notifier.posted if PLUGIN_ID in message.title]
    assert len(quarantined) == 1
    assert "helper release monty" in quarantined[0].body
    assert [notice.kind for notice in helper.notices.read()] == [NoticeKind.PROCESS_QUARANTINED]

    # The fifth failure was the last one acted on: a sixth exit is counted by nobody and
    # restarted by nobody, and the user is not told a second time.
    before = len(helper.link.commands)
    helper.crash()
    helper.clock.advance(sum(BACKOFF))
    report = helper.tick.pass_once()

    assert report.scheduled == ()
    assert len(helper.link.commands) == before
    assert len(helper.notifier.posted) == len(quarantined)


def test_nothing_is_restarted_or_counted_while_a_quit_is_on_record(
    make_helper: Callable[..., Harness],
) -> None:
    """A process going away during a quit is the quit working, not a failure to supervise.

    Both inputs are covered: the exit the host reports, which
    :meth:`~innytypes.helper.launcher.Application.child_exited` already silences, and the stale
    verdict this tick makes, which would otherwise be a second way to fight a quit (F1).
    """
    helper = make_helper(profile=beating_plugin())
    helper.beat(at=STARTED_AT + 5)
    helper.tick.pass_once()

    helper.quits.record(QuitReason.MENU, at=helper.clock())
    helper.crash()
    helper.clock.advance(STALE_AFTER + 1)
    report = helper.tick.pass_once()

    assert report.scheduled == ()
    assert helper.breaker.interventions_for(PLUGIN_ID) == ()

    helper.clock.advance(sum(BACKOFF))
    assert helper.tick.pass_once().issued == ()
    assert helper.link.commands == []


# --- the one process the helper starts itself ------------------------------------------------


def test_a_host_that_exits_is_relaunched_by_the_helper_after_its_orphans_are_cleared(
    make_helper: Callable[..., Harness],
) -> None:
    """The row of plan 0003's table no command could carry out.

    The host is gone, so a `start` command would have nowhere to arrive. The helper stops the
    orphans the dead host left — an MCP server whose recorded parent is no longer alive — and
    only then starts the host itself, writing the record everything else verifies it by.
    """
    helper = make_helper(records=(HELPER_RECORD, HOST_RECORD, MCP_RECORD, PLUGIN_RECORD))
    helper.crash(child=HOST_RECORD)

    helper.tick.pass_once()
    helper.clock.advance(BACKOFF[0])
    helper.tick.pass_once()

    # The orphaned MCP server was stopped, and it was stopped before the host came back.
    assert (MCP_PID, Signal.TERMINATE) in helper.machine.signals
    assert helper.launcher.argvs == [HOST_COMMAND]

    host = helper.records()[HOST_ID]
    assert host.pid == helper.launcher.next_pid
    assert host.executable == HOST_COMMAND[0]
    # Nothing was asked of a host that had gone.
    assert helper.link.commands == []


def test_a_stale_host_is_stopped_before_it_is_started_again(
    make_helper: Callable[..., Harness],
) -> None:
    """A stale host is alive, and a second one beside it would be worse than the hang."""
    helper = make_helper(records=(HELPER_RECORD, HOST_RECORD))
    helper.profiles[HOST_ID] = beating_plugin()

    helper.beat(at=STARTED_AT + 5, record=HOST_RECORD)
    helper.tick.pass_once()
    helper.clock.advance(STALE_AFTER + 1)
    assert helper.tick.pass_once().stale == (HOST_ID,)

    helper.clock.advance(BACKOFF[0])
    helper.tick.pass_once()

    assert helper.machine.signals == [(HOST_PID, Signal.TERMINATE)]
    assert helper.launcher.argvs == [HOST_COMMAND]
    assert helper.records()[HOST_ID].pid != HOST_PID


def test_a_command_for_any_other_child_still_goes_to_the_host(
    make_helper: Callable[..., Harness],
) -> None:
    """The host's own restarts are the only thing kept off the wire, and nothing else is."""
    helper = make_helper()

    helper.policy.restart(PLUGIN_ID)
    helper.policy.stop(HOST_ID)

    assert helper.link.named == [
        (str(CommandName.RESTART), PLUGIN_ID),
        (str(CommandName.STOP), HOST_ID),
    ]
    assert helper.launcher.argvs == []


# --- a failure in one pass is one pass ------------------------------------------------------


def test_a_run_state_file_that_cannot_be_read_is_one_failed_pass(
    make_helper: Callable[..., Harness],
) -> None:
    """The file every pass starts from, broken, and the pass after it working."""
    helper = make_helper()
    helper.run_state_path.write_text("{not json", encoding="utf-8")

    broken = helper.tick.pass_once()

    assert [failure.step for failure in broken.failures] == ["sample"]
    assert broken.observations == ()
    # The rest of the pass still happened: the sockets were read and the user was told.
    assert helper.beats.polls == 1
    assert helper.notices.read() == ()

    # And the moment the file is readable again, the next pass reads it.
    helper.run_state_path.unlink()
    helper.run_state.write(PLUGIN_RECORD)
    assert helper.tick.pass_once().survived


def test_a_process_that_vanishes_mid_sample_is_one_failed_process(
    make_helper: Callable[..., Harness],
) -> None:
    """A process that passed the identity check and was gone a moment later.

    The reading that raised is the plugin's, and the pass goes on to sample the host and the
    helper: one process that went away must not cost a pass its whole view of the machine.
    """
    helper = make_helper()
    helper.machine.vanishing.add(PLUGIN_PID)

    report = helper.tick.pass_once()

    assert [failure.step for failure in report.failures] == ["sample"]
    assert HOST_PID in helper.machine.sampled

    helper.machine.vanishing.clear()
    assert helper.tick.pass_once().survived


def test_a_host_that_is_not_connected_is_one_failed_pass(
    make_helper: Callable[..., Harness],
) -> None:
    """A restart that could not be sent is reported, and the next pass sends it.

    The helper has to survive this to be any use at all: the moment it most wants to talk to
    the host is the moment the host may not be there.
    """
    helper = make_helper()
    helper.link.connected = False
    helper.crash()
    helper.tick.pass_once()

    helper.clock.advance(BACKOFF[0])
    refused = helper.tick.pass_once()

    assert [failure.step for failure in refused.failures] == ["restart"]
    assert helper.link.commands == []

    # The attempt is gone with the pass that could not make it, and the next exit is decided
    # on and sent as usual.
    helper.link.connected = True
    helper.run_state.write(PLUGIN_RECORD)
    helper.machine.add(PLUGIN_RECORD)
    helper.crash()
    helper.tick.pass_once()
    helper.clock.advance(BACKOFF[1])
    assert helper.tick.pass_once().issued != ()


def test_a_notifier_that_refuses_still_leaves_status_telling_the_truth(
    make_helper: Callable[..., Harness],
) -> None:
    """A message that could not be shown is never why a quarantine goes unrecorded."""
    refusing = RefusingNotifier()
    helper = make_helper(notifier=refusing, max_interventions=1)

    helper.crash()
    report = helper.tick.pass_once()

    assert refusing.refusals == 1
    assert [failure.step for failure in report.failures] == ["notify"]
    # Written before anything was posted, which is what `innytypes helper status` reads.
    assert [notice.subject for notice in helper.notices.read()] == [PLUGIN_ID]
    assert [notice.kind for notice in report.notices] == [NoticeKind.PROCESS_QUARANTINED]

    helper.clock.advance(BACKOFF[0])
    assert helper.tick.pass_once().failures != ()


def test_the_loop_survives_a_pass_that_raises_outright() -> None:
    """The guard over the guard: there is always a next pass, whatever a pass did.

    Every step inside a pass already catches its own failure; this is the promise the loop
    makes about the ones nothing could have been written to expect.
    """

    @dataclass
    class ExplodingTick:
        passes: int = 0

        def pass_once(self) -> Pass:
            self.passes += 1
            if self.passes == 1:
                raise RuntimeError("something nothing inside a pass could have caught")
            return Pass()

    tick = ExplodingTick()
    slept: list[float] = []
    ran = run_supervision(
        tick,
        interval=lambda: 5.0,
        sleep=slept.append,
        stop=lambda: tick.passes >= 3,
    )

    assert ran == 3
    assert tick.passes == 3
    assert slept == [5.0, 5.0, 5.0]


def test_the_loop_reads_the_tick_interval_before_every_wait() -> None:
    """`helper.tick` is a setting, and the helper re-reads its settings rather than caching."""
    intervals = iter([5.0, 2.0, 2.0])
    passes: list[int] = []
    slept: list[float] = []

    @dataclass
    class CountingTick:
        def pass_once(self) -> Pass:
            passes.append(1)
            return Pass()

    run_supervision(
        CountingTick(),
        interval=lambda: next(intervals),
        sleep=slept.append,
        stop=lambda: len(passes) >= 3,
    )

    assert slept == [5.0, 2.0, 2.0]


# --- the windowed application ---------------------------------------------------------------


@dataclass
class FakeLoop:
    """The toolkit's own event loop, as far as scheduling is concerned: a queue a test drains."""

    due: list[Callable[[], None]] = field(default_factory=list)
    delays: list[float] = field(default_factory=list)

    def call_soon(self, work: Callable[[], None]) -> None:
        self.due.append(work)

    def call_later(self, seconds: float, work: Callable[[], None]) -> None:
        self.delays.append(seconds)
        self.due.append(work)

    def run_ready(self) -> int:
        """Run everything that is due now, exactly as a loop turn would."""
        ready, self.due = self.due, []
        for work in ready:
            work()
        return len(ready)


def a_desktop() -> tuple[TogaDesktop, FakeLoop]:
    """A drawing desktop with a window open and a loop, and no toolkit call in sight."""
    desktop = TogaDesktop(toolkit=Toolkit(toga=SimpleNamespace(), pack=object, column="column"))  # type: ignore[arg-type]
    loop = FakeLoop()
    desktop.app = SimpleNamespace(loop=loop)
    desktop.window = SimpleNamespace(title="InnyTypes")
    return desktop, loop


def test_a_pass_happens_while_the_window_is_open(
    make_helper: Callable[..., Harness],
) -> None:
    """The windowed application supervises too, and the drawing is never waiting on it.

    The pass is scheduled on the toolkit's loop rather than run inside the call that schedules
    it, so :meth:`every` returns immediately; each pass puts the next one on the loop and
    returns, so anything else the loop has to do — drawing the window — happens between them.
    """
    helper = make_helper(profile=beating_plugin())
    helper.beat(at=STARTED_AT + 5)
    desktop, loop = a_desktop()

    desktop.every(5.0, helper.tick.pass_once)

    # Scheduled, not run: the loop still owns the process and nothing has been sampled.
    assert helper.machine.sampled == []
    assert len(loop.due) == 1

    drawn: list[str] = []
    loop.due.append(lambda: drawn.append("the window"))
    loop.run_ready()

    assert helper.registry.latest(PLUGIN_ID) is not None
    assert sorted(helper.machine.sampled) == sorted([HELPER_PID, HOST_PID, PLUGIN_PID])
    assert drawn == ["the window"]
    assert desktop.window is not None
    # And the next pass is waiting on the loop, one tick away.
    assert loop.delays == [5.0]

    helper.clock.advance(STALE_AFTER + 1)
    loop.run_ready()

    assert helper.policy.pending[0].child_id == PLUGIN_ID
    assert loop.delays == [5.0, 5.0]


def test_a_pass_that_raises_on_the_loop_is_followed_by_the_next_one() -> None:
    """A window whose supervision stopped at the first surprise would watch nothing at all."""
    desktop, loop = a_desktop()
    passes: list[int] = []

    def work() -> None:
        passes.append(len(passes))
        if len(passes) == 1:
            raise RuntimeError("a pass that could not finish")

    desktop.every(5.0, work)
    loop.run_ready()
    loop.run_ready()

    assert passes == [0, 1]
    assert loop.delays == [5.0, 5.0]


def test_there_is_nothing_to_schedule_a_pass_on_before_the_loop_exists() -> None:
    """Refused out loud rather than dropped, which is the mistake this could hide."""
    desktop = TogaDesktop(toolkit=Toolkit(toga=SimpleNamespace(), pack=object, column="c"))  # type: ignore[arg-type]

    with pytest.raises(WindowError, match="no event loop"):
        desktop.every(5.0, lambda: None)


# --- the core update check, on its schedule --------------------------------------------------


def public_key_text() -> str:
    """A throwaway minisign public key, generated here and never written to the tree."""
    key = SigningKey.generate()
    blob = b"Ed" + secrets.token_bytes(8) + bytes(key.verify_key)
    return (
        "untrusted comment: minisign public key (throwaway, generated in the test)\n"
        + base64.b64encode(blob).decode("ascii")
        + "\n"
    )


def a_release_server() -> tuple[httpx.Client, list[httpx.Request]]:
    """The release host, in this process, recording every request it is asked to answer."""
    asked: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        asked.append(request)
        return httpx.Response(200, json={"channel": "stable", "releases": []})

    return httpx.Client(transport=httpx.MockTransport(handle)), asked


def settings_with(
    path: Path, *, auto_check_versions: bool, interval: float = 86_400
) -> HelperSettings:
    """A `config.toml` holding one decision, read live like every other switch."""
    path.write_text(
        f"auto_check_versions = {str(auto_check_versions).lower()}\n"
        "\n"
        "[update]\n"
        f"check_interval = {interval}\n",
        encoding="utf-8",
    )
    return HelperSettings(path)


@pytest.fixture
def release_check(tmp_path: Path) -> Callable[..., tuple[Callable[[], Any], list[httpx.Request]]]:
    """The scheduled check, bound to an in-process release server and a throwaway key."""
    clients: list[httpx.Client] = []

    def _make(settings: HelperSettings) -> tuple[Callable[[], Any], list[httpx.Request]]:
        client, asked = a_release_server()
        clients.append(client)
        return (
            partial(
                check_and_stage,
                settings=settings,
                client=client,
                staging=tmp_path / "staging",
                public_key=parse_public_key(public_key_text()),
            ),
            asked,
        )

    yield _make

    for client in clients:
        client.close()


def test_the_update_check_runs_on_its_schedule_when_the_switch_is_on(
    make_helper: Callable[..., Harness],
    release_check: Callable[..., tuple[Callable[[], Any], list[httpx.Request]]],
    tmp_path: Path,
) -> None:
    """Every 24 hours, and not on every 5-second pass."""
    settings = settings_with(tmp_path / "config.toml", auto_check_versions=True)
    check, asked = release_check(settings)
    helper = make_helper(update=check, settings=settings)

    first = helper.tick.pass_once()
    assert first.checked
    assert [str(request.url) for request in asked] == [
        "https://releases.innytypes.app/stable/index.json"
    ]

    # The passes in between ask nobody anything.
    for _ in range(3):
        helper.clock.advance(5.0)
        assert not helper.tick.pass_once().checked
    assert len(asked) == 1

    helper.clock.advance(86_400)
    assert helper.tick.pass_once().checked
    assert len(asked) == 2


def test_no_version_request_of_any_kind_is_made_when_the_switch_is_off(
    make_helper: Callable[..., Harness],
    release_check: Callable[..., tuple[Callable[[], Any], list[httpx.Request]]],
    tmp_path: Path,
) -> None:
    """`auto_check_versions = false` means the transport is asked for nothing at all."""
    config = tmp_path / "config.toml"
    settings = settings_with(config, auto_check_versions=False)
    check, asked = release_check(settings)
    helper = make_helper(update=check, settings=settings)

    for _ in range(3):
        helper.tick.pass_once()
        helper.clock.advance(86_400)

    assert asked == []

    # And the switch is re-read rather than remembered: turning it on is obeyed by the next
    # check, with no restart.
    settings_with(config, auto_check_versions=True)
    helper.clock.advance(86_400)
    helper.tick.pass_once()

    assert len(asked) == 1


def test_a_check_that_fails_is_one_failed_pass(
    make_helper: Callable[..., Harness], tmp_path: Path
) -> None:
    """A release server that is down delays an update; it does not stop the supervision."""

    def refuse() -> Any:
        raise httpx.ConnectError("the release server could not be reached")

    settings = settings_with(tmp_path / "config.toml", auto_check_versions=True)
    helper = make_helper(update=refuse, settings=settings)

    report = helper.tick.pass_once()

    assert [failure.step for failure in report.failures] == ["update"]
    assert report.staged is None

    helper.clock.advance(5.0)
    assert helper.tick.pass_once().survived


# --- the two adapters the parts were waiting on ---------------------------------------------


def test_the_stale_judgement_reads_the_progress_marker_and_not_the_arrival_time() -> None:
    """A process that keeps beating with a frozen marker is wedged, and this is what says so."""
    clock = FakeClock()
    registry = HeartbeatRegistry(clock=clock)
    progress = RegisteredProgress(registry)

    assert progress.progress_at(PLUGIN_ID) is None

    registry.record(
        Heartbeat(
            id=PLUGIN_ID,
            kind=ChildKind.ADDON,
            pid=PLUGIN_PID,
            started_at=STARTED_AT,
            version="1.0.0",
            state=ProcessState.READY,
            progress_at=STARTED_AT + 12,
        )
    )

    assert progress.progress_at(PLUGIN_ID) == STARTED_AT + 12


def test_a_plugin_is_watched_against_the_profile_its_manifest_published(
    tmp_path: Path,
) -> None:
    """Without this the manifests' promises would be read by nobody, and nothing judged stale.

    The manifest is the one discovery recorded at install time — no addon code is imported to
    read it — and the host, the MCP server and Anytype publish nothing, so they answer ``None``
    and are watched under the helper-wide defaults.
    """
    root = tmp_path / "addons"
    (root / PLUGIN_ID / "env").mkdir(parents=True)
    recorded_manifest_path(root, PLUGIN_ID).write_text(
        json.dumps(
            {
                "id": PLUGIN_ID,
                "version": "1.0.0",
                "host_api": HOST_API_VERSION,
                "requires": [],
                "emits": [f"{PLUGIN_ID}.copied.v1"],
                "subscribes": [],
                "stability": {"heartbeat_interval": HEARTBEAT_INTERVAL, "max_rss_mb": 512},
            }
        ),
        encoding="utf-8",
    )

    profiles = PublishedProfiles(root=root)

    published = profiles(PLUGIN_RECORD)
    assert published is not None
    assert published.heartbeat_interval == HEARTBEAT_INTERVAL
    assert published.max_rss_mb == 512

    assert profiles(HOST_RECORD) is None
    assert profiles(ANYTYPE_RECORD) is None
    assert profiles(a_record(id="whodunnit", pid=4600)) is None


# --- a helper built with less than all of it -------------------------------------------------


def test_a_helper_with_no_sockets_and_no_notifier_still_watches_and_judges(
    make_helper: Callable[..., Harness],
) -> None:
    """Every part that reaches outside this process is optional, and each absence is survivable.

    A helper with no control socket, no heartbeat socket, no announcer and no update check is
    what an installation whose sockets could not be opened has, and it is still a helper: it
    samples the machine, judges what it finds and stops what has to go. What it cannot do is
    talk to a host or tell anybody, and neither of those is a reason to stop looking.
    """
    helper = make_helper(profile=beating_plugin())
    bare = SupervisionTick(
        watch=helper.tick.watch,
        policy=helper.policy,
        breaker=helper.breaker,
        now=helper.clock,
        jitter=lambda window: 0.0,
    )

    helper.machine.samples[PLUGIN_PID] = calm(rss_mb=MEMORY_LIMIT + 200)
    bare.pass_once()
    helper.clock.advance(GRACE + 1)
    report = bare.pass_once()

    assert report.survived
    assert report.beats == 0
    assert report.exits == 0
    assert report.breached == (PLUGIN_ID,)
    assert helper.machine.signals == [(PLUGIN_PID, Signal.TERMINATE)]
    assert report.notices == ()
    assert helper.notifier.posted == []


def test_one_process_that_cannot_be_acted_on_leaves_the_others_acted_on(
    make_helper: Callable[..., Harness],
) -> None:
    """A pass acts on processes one at a time, because a pass has more than one to act on."""

    class HalfBrokenBreaker(Breaker):
        """A breaker that cannot count one particular process."""

        def record(self, child_id: str, *, reason: str) -> bool:
            if child_id == PLUGIN_ID:
                raise RuntimeError("this intervention could not be counted")
            return super().record(child_id, reason=reason)

    helper = make_helper(profile=beating_plugin())
    helper.profiles[HOST_ID] = beating_plugin()
    helper.tick.breaker = HalfBrokenBreaker(now=helper.clock)

    helper.beat(at=STARTED_AT + 5)
    helper.beat(at=STARTED_AT + 5, record=HOST_RECORD)
    helper.tick.pass_once()

    helper.clock.advance(STALE_AFTER + 1)
    report = helper.tick.pass_once()

    assert [(failure.step, failure.subject) for failure in report.failures] == [("act", PLUGIN_ID)]
    # The host was judged stale in the same pass, and it was still acted on.
    assert [one.child_id for one in report.scheduled] == [HOST_ID]


def test_the_first_update_check_is_spread_over_the_jitter_window(
    make_helper: Callable[..., Harness], tmp_path: Path
) -> None:
    """Every installation asking the release server at the same second is what the spread is for.

    Proved at the one point of it that is not random: a window of zero is no spread, so the
    first pass checks — which is also what makes every other test's injected spread honest
    rather than a way around the schedule.
    """
    config = tmp_path / "config.toml"
    config.write_text(
        "auto_check_versions = true\n\n[update]\ncheck_jitter = 0\n", encoding="utf-8"
    )
    settings = HelperSettings(config)
    checks: list[int] = []
    helper = make_helper(update=lambda: checks.append(1), settings=settings)

    spread = SupervisionTick(
        watch=helper.tick.watch,
        policy=helper.policy,
        breaker=helper.breaker,
        update=lambda: checks.append(1),
        settings=settings,
        now=helper.clock,
    )

    assert spread.pass_once().checked
    assert checks == [1]
