"""One icon starts everything, and every way of turning it off again turns it off.

The owner's requirement is what these tests are really about: **"there has to be a clear and
easy way of turning the whole InnyTypes application off!"** So every row of plan 0003's
*Turning InnyTypes off* table has a test of its own below, and each one asserts the same two
things — nothing InnyTypes started is left running, and nothing is brought back afterwards.

Nothing here touches the machine. The process table is a dictionary, the signaller is a list
that a fake table reacts to, the launcher records argv instead of launching anything, and the
lock, the run-state file and the quit record all live under ``tmp_path``. No process is
started, no signal reaches anything outside the test, and no test sleeps: the clock is a
number a test moves by hand.

The two assertions that would be worthless without their opposite are written as pairs on
purpose: a crashed helper is relaunched **and** an externally stopped one is not, from the same
watch; an exit during a quit is ignored **and** the identical exit outside one is restarted.
"""

from __future__ import annotations

import json
import signal
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from click.testing import CliRunner

from innytypes.children import (
    MCP_CHILD_ID,
    ChildExit,
    ChildKind,
    ChildRecord,
    Command,
    CommandResult,
    RunStateFile,
    default_run_state_path,
)
from innytypes.cli import CliContext, cli
from innytypes.helper.breaker import HOST_ID, Breaker
from innytypes.helper.config import HelperConfigError, HelperSettings, RestartSettings
from innytypes.helper.launcher import (
    ANYTYPE_APP_ID,
    HELPER_ID,
    HOST_ARGUMENT,
    QUIT_FILENAME,
    AnytypeStart,
    Application,
    HelperEnding,
    HelperExit,
    HelperWatch,
    HostResponse,
    InstanceLock,
    LaunchAtLogin,
    LaunchAtLoginError,
    QuitFile,
    QuitReason,
    Quitter,
    Start,
    SystemApplications,
    UnpackagedLoginItem,
    build_quitter,
    bundled_launcher,
    default_anytype_executable,
    default_host_command,
    default_lock_path,
    default_quit_path,
    install_quit_handlers,
    quit_order,
    quit_reason_for_signal,
    run_bundled,
    started_by_this_application,
    this_helper,
)
from innytypes.helper.processes import (
    ManagedProcesses,
    ProcessFacts,
    Signal,
    Stop,
)
from innytypes.helper.restart import RestartPolicy

HELPER_EXECUTABLE = "/opt/innytypes/bin/python"
ANYTYPE_EXECUTABLE = "/Applications/Anytype.app/Contents/MacOS/Anytype"
HOST_COMMAND = ("/opt/innytypes/bin/python", "-m", "innytypes", "up")

# --- fakes ----------------------------------------------------------------------------------


class FakeClock:
    """A clock a test moves by hand. Wall-clock and monotonic are both this, in a test."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class FakeTable:
    """The OS process table as plain data, plus the signals a test sends into it.

    Signalling is modelled rather than mocked: a polite stop removes a process unless the test
    said this one ignores polite stops, and a kill always removes it. That is what lets a test
    assert the escalation — terminate, wait out the timeout, kill — without a process.
    """

    facts_by_pid: dict[int, ProcessFacts] = field(default_factory=dict)
    signals: list[tuple[int, Signal]] = field(default_factory=list)
    # Process IDs that ignore a polite stop and have to be killed.
    stubborn: set[int] = field(default_factory=set)

    def facts(self, pid: int) -> ProcessFacts | None:
        return self.facts_by_pid.get(pid)

    def add(self, record: ChildRecord) -> None:
        self.facts_by_pid[record.pid] = ProcessFacts(
            pid=record.pid,
            started_at=record.started_at,
            executable=record.executable,
        )

    def send(self, pid: int, which: Signal) -> None:
        self.signals.append((pid, which))
        if which is Signal.KILL or pid not in self.stubborn:
            self.facts_by_pid.pop(pid, None)

    @property
    def signalled_pids(self) -> list[int]:
        return [pid for pid, _ in self.signals]


@dataclass
class FakeProcess:
    """Enough of a spawned process for a record to be written about it."""

    pid: int


@dataclass
class FakeLauncher:
    """Records what would have been launched, and makes the fake table believe it exists."""

    table: FakeTable
    clock: FakeClock
    next_pid: int = 500
    argvs: list[tuple[str, ...]] = field(default_factory=list)

    def __call__(self, argv: Sequence[str]) -> FakeProcess:
        self.argvs.append(tuple(argv))
        self.next_pid += 1
        self.table.facts_by_pid[self.next_pid] = ProcessFacts(
            pid=self.next_pid,
            started_at=self.clock(),
            executable=argv[0],
        )
        return FakeProcess(pid=self.next_pid)

    @property
    def count(self) -> int:
        return len(self.argvs)


@dataclass
class FakeApplications:
    """The applications already running, as a test describes them."""

    running: dict[str, ProcessFacts] = field(default_factory=dict)

    def find(self, executable: str) -> ProcessFacts | None:
        return self.running.get(executable)


@dataclass
class FakeHost:
    """A host that carries out restart commands and never restarts anything by itself.

    The second half is the point: if a test sees a child come back, the helper is what brought
    it back.
    """

    commands: list[str] = field(default_factory=list)

    def send(self, command: Command) -> CommandResult:
        self.commands.append(str(command.name))
        return CommandResult(name=command.name)


@dataclass
class Harness:
    """One assembled application and everything a test needs to assert about it."""

    application: Application
    table: FakeTable
    launcher: FakeLauncher
    applications: FakeApplications
    run_state: RunStateFile
    quits: QuitFile
    lock: InstanceLock
    clock: FakeClock
    host: FakeHost
    policy: RestartPolicy
    breaker: Breaker
    windows: list[str]
    processes: ManagedProcesses
    helper_record: ChildRecord

    def records(self) -> dict[str, ChildRecord]:
        return {record.id: record for record in self.run_state.records()}


def helper_record(pid: int = 400, started_at: float = 1_000.0) -> ChildRecord:
    return ChildRecord(
        id=HELPER_ID,
        kind=ChildKind.HELPER,
        pid=pid,
        started_at=started_at,
        executable=HELPER_EXECUTABLE,
        parent_pid=1,
    )


@pytest.fixture
def make_application(tmp_path: Path) -> Callable[..., Harness]:
    """Build an application whose every seam is a fake, under this test's own directory."""

    def _make(
        *,
        anytype_running: bool = False,
        anytype_executable: str | None = ANYTYPE_EXECUTABLE,
        helper: ChildRecord | None = None,
    ) -> Harness:
        clock = FakeClock()
        table = FakeTable()
        me = helper_record() if helper is None else helper
        table.add(me)

        applications = FakeApplications()
        if anytype_running:
            applications.running[ANYTYPE_EXECUTABLE] = ProcessFacts(
                pid=321,
                started_at=900.0,
                executable=ANYTYPE_EXECUTABLE,
            )
            table.facts_by_pid[321] = applications.running[ANYTYPE_EXECUTABLE]

        run_state = RunStateFile(tmp_path / "run-state.json")
        processes = ManagedProcesses(
            run_state=run_state,
            table=table,
            send_signal=table.send,
            clock=clock,
            sleep=clock.advance,
            stop_timeout=10.0,
        )
        lock = InstanceLock(path=tmp_path / "helper.lock", processes=processes)
        quits = QuitFile(path=tmp_path / QUIT_FILENAME)
        launcher = FakeLauncher(table=table, clock=clock)
        host = FakeHost()
        policy = RestartPolicy(channel=host, settings=RestartSettings(), now=clock)  # type: ignore[arg-type]
        breaker = Breaker(now=clock)
        windows: list[str] = []

        application = Application(
            lock=lock,
            processes=processes,
            run_state=run_state,
            quits=quits,
            applications=applications,
            start_process=launcher,
            host_command=HOST_COMMAND,
            anytype_executable=anytype_executable,
            identity=lambda: me,
            policy=policy,
            breaker=breaker,
            show_window=lambda: windows.append("brought forward"),
            clock=clock,
        )

        return Harness(
            application=application,
            table=table,
            launcher=launcher,
            applications=applications,
            run_state=run_state,
            quits=quits,
            lock=lock,
            clock=clock,
            host=host,
            policy=policy,
            breaker=breaker,
            windows=windows,
            processes=processes,
            helper_record=me,
        )

    return _make


def started_application(harness: Harness) -> Harness:
    """A started application with a plugin and an MCP child recorded under the host."""
    harness.application.start()
    host = harness.records()[HOST_ID]

    for child_id, kind, pid in (
        (MCP_CHILD_ID, ChildKind.MCP, 601),
        ("monty", ChildKind.ADDON, 602),
    ):
        record = ChildRecord(
            id=child_id,
            kind=kind,
            pid=pid,
            started_at=harness.clock(),
            executable=f"/opt/innytypes/{child_id}",
            parent_pid=host.pid,
        )
        harness.run_state.write(record)
        harness.table.add(record)

    return harness


# --- one icon, one application --------------------------------------------------------------


def test_a_launch_takes_the_lock_starts_anytype_and_starts_the_host(
    make_application: Callable[..., Harness],
) -> None:
    harness = make_application()

    report = harness.application.start()

    assert report.outcome is Start.STARTED
    assert report.anytype is AnytypeStart.STARTED
    # The helper, Anytype and the host, and nothing else: the MCP server and the plugins are
    # the host's to start.
    assert set(harness.records()) == {HELPER_ID, ANYTYPE_APP_ID, HOST_ID}
    assert harness.launcher.argvs == [(ANYTYPE_EXECUTABLE,), HOST_COMMAND]
    assert harness.lock.holder() == harness.helper_record


def test_a_second_launch_brings_the_window_forward_and_starts_nothing(
    make_application: Callable[..., Harness],
) -> None:
    """The single-instance rule: a second launch spawns nothing at all (plan 0003, D2)."""
    first = make_application()
    first.application.start()
    spawns_after_the_first_launch = first.launcher.count
    records_after_the_first_launch = first.records()

    # A second helper process, launched while the first still holds the lock.
    second = Application(
        lock=first.lock,
        processes=first.processes,
        run_state=first.run_state,
        quits=first.quits,
        applications=first.applications,
        start_process=first.launcher,
        host_command=HOST_COMMAND,
        anytype_executable=ANYTYPE_EXECUTABLE,
        identity=lambda: helper_record(pid=999, started_at=1_100.0),
        show_window=lambda: first.windows.append("brought forward"),
        clock=first.clock,
    )

    report = second.start()

    assert report.outcome is Start.ALREADY_RUNNING
    assert report.holder == first.helper_record
    # Zero additional spawns: no second helper, host, MCP server or plugin.
    assert first.launcher.count == spawns_after_the_first_launch
    assert first.records() == records_after_the_first_launch
    assert first.windows == ["brought forward"]


def test_a_lock_left_by_a_dead_helper_never_locks_the_user_out(
    make_application: Callable[..., Harness],
) -> None:
    harness = make_application()
    dead = helper_record(pid=4_242, started_at=1.0)
    harness.lock.path.parent.mkdir(parents=True, exist_ok=True)
    harness.lock.path.write_text(json.dumps(dead.to_document()), encoding="utf-8")

    report = harness.application.start()

    assert report.outcome is Start.STARTED
    assert harness.lock.holder() == harness.helper_record
    # Nothing was signalled on the way: the lock's holder failed the identity check, and the
    # answer to a phantom is to forget it.
    assert harness.table.signals == []


def test_an_unreadable_lock_is_taken_over_rather_than_obeyed(
    make_application: Callable[..., Harness],
) -> None:
    harness = make_application()
    harness.lock.path.parent.mkdir(parents=True, exist_ok=True)
    harness.lock.path.write_text("this is not a lock", encoding="utf-8")

    assert harness.application.start().outcome is Start.STARTED


def test_anytype_is_adopted_when_it_is_already_running(
    make_application: Callable[..., Harness],
) -> None:
    harness = make_application(anytype_running=True)

    report = harness.application.start()

    assert report.anytype is AnytypeStart.ADOPTED
    # Only the host was launched: Anytype was already there.
    assert harness.launcher.argvs == [HOST_COMMAND]

    adopted = harness.records()[ANYTYPE_APP_ID]
    assert adopted.pid == 321
    assert not started_by_this_application(adopted)


def test_anytype_that_is_not_installed_degrades_rather_than_refusing_to_start(
    make_application: Callable[..., Harness],
) -> None:
    harness = make_application(anytype_executable=None)

    report = harness.application.start()

    assert report.anytype is AnytypeStart.MISSING
    assert ANYTYPE_APP_ID not in harness.records()
    # The host still came up, which is the whole point of degrading.
    assert harness.launcher.argvs == [HOST_COMMAND]


def test_the_default_host_command_runs_the_interpreter_so_its_record_can_verify() -> None:
    """The recorded executable has to be what the OS will report (plan 0003, *Phantom*)."""
    import sys

    assert default_host_command()[0] == sys.executable
    assert default_host_command()[1:] == ("-m", "innytypes", "up")


@pytest.mark.parametrize(
    "executable",
    [
        "/opt/innytypes/bin/python",
        "/usr/bin/python3",
        "/usr/local/bin/python3.13",
        # Windows spells its interpreters like this; a path is split by the platform's own
        # rules, so the name is the part this test can assert on from anywhere.
        "python.exe",
        "pythonw.exe",
    ],
)
def test_an_interpreter_is_not_mistaken_for_an_installed_application(executable: str) -> None:
    assert bundled_launcher(executable) is None
    assert default_host_command(executable) == (executable, "-m", "innytypes", "up")


def test_a_bundle_starts_the_host_by_starting_itself_with_an_argument() -> None:
    # An installed bundle ships the interpreter as a framework and exactly one executable, so
    # there is no `python` to hand `-m innytypes up` to (plan 0003, F5). The application names
    # itself instead, and the record still carries the executable the OS will report.
    launcher = "/Applications/InnyTypes.app/Contents/MacOS/InnyTypes"

    assert bundled_launcher(launcher) == launcher
    assert default_host_command(launcher) == (launcher, HOST_ARGUMENT)


def test_the_bundles_launcher_runs_the_helper_unless_it_is_asked_for_the_host() -> None:
    # The two roles of one executable, and nothing else deciding between them: no file, no
    # environment variable, no guess — only the argument this process was started with.
    roles: list[str] = []

    run_bundled([], helper=lambda: roles.append("helper"), host=lambda: roles.append("host"))
    run_bundled(
        [HOST_ARGUMENT], helper=lambda: roles.append("helper"), host=lambda: roles.append("host")
    )
    run_bundled(
        ["--psn_0_12345"],
        helper=lambda: roles.append("helper"),
        host=lambda: roles.append("host"),
    )

    # The last one is the argument macOS itself adds when a bundle is opened from the Finder,
    # and it must never be read as a request for the host.
    assert roles == ["helper", "host", "helper"]


def test_this_helper_reads_its_three_facts_from_the_process_table() -> None:
    import os

    table = FakeTable()
    table.facts_by_pid[os.getpid()] = ProcessFacts(
        pid=os.getpid(), started_at=777.0, executable="/opt/innytypes/bin/python"
    )

    record = this_helper(table=table)

    assert record.kind is ChildKind.HELPER
    assert (record.started_at, record.executable) == (777.0, "/opt/innytypes/bin/python")


# --- Turning InnyTypes off: one test per row of the table -----------------------------------


def assert_everything_is_off(harness: Harness) -> None:
    """Nothing InnyTypes started is running, and nothing of ours is left recorded."""
    remaining = {
        record.id
        for record in harness.run_state.records()
        if record.id != ANYTYPE_APP_ID or started_by_this_application(record)
    }
    assert remaining == set()
    assert harness.table.facts_by_pid.keys() <= {harness.helper_record.pid, 321}


@pytest.mark.parametrize("reason", [QuitReason.MENU, QuitReason.DOCK, QuitReason.LOGOUT])
def test_quit_from_inside_the_application_turns_everything_off(
    make_application: Callable[..., Harness], reason: QuitReason
) -> None:
    """The Quit menu item, Quit from the Dock, and a logout: the same quit, three ways in."""
    harness = started_application(make_application())

    report = harness.application.quit(reason)

    assert report.reason is reason
    assert report.left_running == ()
    assert_everything_is_off(harness)
    # The helper is not signalled: it is the process running this quit, and it ends by
    # returning from its entry point.
    assert harness.helper_record.pid not in harness.table.signalled_pids


def test_a_quit_stops_things_in_reverse_start_order(
    make_application: Callable[..., Harness],
) -> None:
    harness = started_application(make_application())
    records = harness.records()

    harness.application.quit(QuitReason.MENU)

    assert harness.table.signalled_pids == [
        records["monty"].pid,
        records[MCP_CHILD_ID].pid,
        records[HOST_ID].pid,
        records[ANYTYPE_APP_ID].pid,
    ]


def test_quit_from_the_command_line_turns_everything_off(
    make_application: Callable[..., Harness],
) -> None:
    """`innytypes quit`: another process entirely, acting on the same run-state file."""
    harness = started_application(make_application())
    quitter = Quitter(processes=harness.processes, quits=harness.quits, clock=harness.clock)

    report = quitter.quit()

    assert report.left_running == ()
    # The helper is stopped by this one, because this is not the helper: it is asked first, so
    # it gets its chance to run the orderly shutdown itself.
    assert harness.table.signalled_pids[0] == harness.helper_record.pid
    assert harness.run_state.records() == ()


def test_ending_the_helper_from_outside_shuts_the_host_down_and_relaunches_nothing() -> None:
    """Activity Monitor, Task Manager, `kill <pid>`: the host takes it as "InnyTypes off"."""
    relaunches: list[str] = []
    shutdowns: list[str] = []
    clock = FakeClock()
    watch = HelperWatch(
        relaunch=lambda: relaunches.append("relaunched"),
        shut_down=lambda: shutdowns.append("shut down"),
        now=clock,
    )

    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGKILL):
        assert watch.observe(HelperExit(signal=number)) is HostResponse.SHUT_DOWN

    # Even a long time later, nothing is waiting to bring the helper back.
    clock.advance(3_600)
    watch.tick()
    assert relaunches == []
    assert len(shutdowns) == 3


def test_logging_out_runs_a_quit_rather_than_killing_the_helper_mid_flight(
    make_application: Callable[..., Harness],
) -> None:
    """A logout or a shutdown sends a signal the helper catches, and it quits properly."""
    harness = started_application(make_application())
    registered: list[tuple[int, Callable[..., None]]] = []

    installed = install_quit_handlers(
        harness.application,
        register=lambda number, handler: registered.append((number, handler)),
    )

    assert signal.SIGTERM in installed
    assert signal.SIGHUP in installed

    handler = dict(registered)[signal.SIGHUP]
    with pytest.raises(SystemExit):
        handler(signal.SIGHUP, None)

    assert_everything_is_off(harness)
    recorded = harness.quits.current()
    assert recorded is not None and recorded.reason is QuitReason.LOGOUT


def test_a_helper_inside_an_event_loop_ends_through_the_toolkit_rather_than_by_raising(
    make_application: Callable[..., Harness],
) -> None:
    """The same quit, ended the one way an application running a window can be ended.

    Raising :class:`SystemExit` out of a handler the toolkit's loop called would leave the loop
    holding the process — the application would have stopped everything else and then gone on
    running with nothing to show. So the ending is a seam, and a drawing installation fills it
    with "ask the toolkit to exit".
    """
    harness = started_application(make_application())
    registered: list[tuple[int, Callable[..., None]]] = []
    endings: list[str] = []

    install_quit_handlers(
        harness.application,
        register=lambda number, handler: registered.append((number, handler)),
        ending=lambda: endings.append("ended"),
    )

    # No SystemExit: the loop is told to end instead, and it is told only once the quit has
    # already stopped everything.
    dict(registered)[signal.SIGTERM](signal.SIGTERM, None)

    assert endings == ["ended"]
    assert_everything_is_off(harness)
    recorded = harness.quits.current()
    assert recorded is not None and recorded.reason is QuitReason.EXTERNAL_STOP


def test_a_caught_terminate_is_recorded_as_an_external_stop() -> None:
    assert quit_reason_for_signal(signal.SIGTERM) is QuitReason.EXTERNAL_STOP
    assert quit_reason_for_signal(signal.SIGHUP) is QuitReason.LOGOUT


# --- `innytypes quit --force` ----------------------------------------------------------------


def test_force_quit_stops_every_recorded_process_without_asking_anyone(
    make_application: Callable[..., Harness],
) -> None:
    harness = started_application(make_application())
    quitter = Quitter(processes=harness.processes, quits=harness.quits, clock=harness.clock)

    report = quitter.force()

    assert report.reason is QuitReason.FORCED
    assert report.left_running == ()
    # Every InnyTypes process, the helper included, by its own identity.
    assert harness.helper_record.pid in harness.table.signalled_pids
    assert harness.run_state.records() == ()
    # Nobody was asked to cooperate: no command went to the host at all.
    assert harness.host.commands == []


def test_force_quit_kills_a_process_that_ignores_the_polite_stop(
    make_application: Callable[..., Harness],
) -> None:
    harness = started_application(make_application())
    stubborn = harness.records()["monty"]
    harness.table.stubborn.add(stubborn.pid)

    report = quit_and_force(harness)

    assert report.left_running == ()
    # Politely first, then forcibly, and only after its stop timeout ran out.
    assert (stubborn.pid, Signal.TERMINATE) in harness.table.signals
    assert (stubborn.pid, Signal.KILL) in harness.table.signals
    assert [stop.outcome for stop in report.stopped if stop.record.id == "monty"] == [Stop.KILLED]


def test_force_quit_never_signals_a_stale_record(
    make_application: Callable[..., Harness],
) -> None:
    """A recorded process ID that now belongs to something else is forgotten, never signalled."""
    harness = started_application(make_application())
    stale = ChildRecord(
        id="whodunnit",
        kind=ChildKind.ADDON,
        pid=777,
        started_at=harness.clock(),
        executable="/opt/innytypes/whodunnit",
        parent_pid=harness.records()[HOST_ID].pid,
    )
    harness.run_state.write(stale)
    # That process ID now belongs to an unrelated program.
    harness.table.facts_by_pid[777] = ProcessFacts(
        pid=777, started_at=harness.clock(), executable="/usr/bin/somebody-elses-program"
    )

    report = quit_and_force(harness)

    assert 777 not in harness.table.signalled_pids
    assert harness.table.facts_by_pid[777].executable == "/usr/bin/somebody-elses-program"
    assert [stop.outcome for stop in report.stopped if stop.record.id == "whodunnit"] == [
        Stop.FORGOTTEN
    ]


def test_no_quit_stops_an_anytype_the_application_only_adopted(
    make_application: Callable[..., Harness],
) -> None:
    """F6: an Anytype that was running before InnyTypes is never taken down with it."""
    harness = started_application(make_application(anytype_running=True))

    quit_and_force(harness)

    assert 321 not in harness.table.signalled_pids
    assert harness.table.facts_by_pid[321].executable == ANYTYPE_EXECUTABLE


def quit_and_force(harness: Harness) -> object:
    quitter = Quitter(processes=harness.processes, quits=harness.quits, clock=harness.clock)
    return quitter.force()


# --- a quit is recorded before anything is stopped -------------------------------------------


def test_the_quit_is_on_record_before_the_first_signal_leaves(
    make_application: Callable[..., Harness],
) -> None:
    """The ordering the whole "a quit is not a crash" rule rests on."""
    harness = started_application(make_application())
    seen: list[bool] = []
    send = harness.table.send

    def watch_signal(pid: int, which: Signal) -> None:
        seen.append(harness.quits.current() is not None)
        send(pid, which)

    harness.processes = ManagedProcesses(
        run_state=harness.run_state,
        table=harness.table,
        send_signal=watch_signal,
        clock=harness.clock,
        sleep=harness.clock.advance,
    )
    Quitter(processes=harness.processes, quits=harness.quits, clock=harness.clock).force()

    assert seen and all(seen)


def test_an_exit_during_a_quit_is_not_restarted_counted_or_quarantined(
    make_application: Callable[..., Harness],
) -> None:
    harness = started_application(make_application())
    harness.application.quit(QuitReason.MENU)

    scheduled = harness.application.child_exited(
        ChildExit(id="monty", kind=ChildKind.ADDON, pid=602, exit_code=0, expected=False)
    )
    harness.clock.advance(60)
    harness.policy.tick()

    assert scheduled is None
    assert harness.host.commands == []
    assert harness.breaker.interventions_for("monty") == ()
    assert not harness.breaker.is_quarantined("monty")


def test_the_same_exit_outside_a_quit_is_restarted(
    make_application: Callable[..., Harness],
) -> None:
    """The control for the test above: without the quit, this exit brings the plugin back."""
    harness = started_application(make_application())

    scheduled = harness.application.child_exited(
        ChildExit(id="monty", kind=ChildKind.ADDON, pid=602, exit_code=0, expected=False)
    )
    harness.clock.advance(60)
    harness.policy.tick()

    assert scheduled is not None
    assert harness.host.commands == ["restart"]
    assert len(harness.breaker.interventions_for("monty")) == 1


def test_a_deliberate_stop_is_not_counted_as_an_intervention(
    make_application: Callable[..., Harness],
) -> None:
    harness = started_application(make_application())

    assert (
        harness.application.child_exited(
            ChildExit(id="monty", kind=ChildKind.ADDON, pid=602, exit_code=0, expected=True)
        )
        is None
    )
    assert harness.breaker.interventions_for("monty") == ()


def test_a_quarantined_child_is_not_restarted(
    make_application: Callable[..., Harness],
) -> None:
    harness = started_application(make_application())
    breaker = Breaker(settings=harness.breaker.settings, now=harness.clock)
    for _ in range(5):
        breaker.record("monty", reason="exited")
    harness.application._breaker = breaker  # noqa: SLF001 - the quarantine is the point here

    assert (
        harness.application.child_exited(
            ChildExit(id="monty", kind=ChildKind.ADDON, pid=602, exit_code=1, expected=False)
        )
        is None
    )
    assert harness.host.commands == []


def test_a_start_clears_the_quit_left_by_the_last_run(
    make_application: Callable[..., Harness],
) -> None:
    harness = make_application()
    harness.quits.record(QuitReason.MENU, at=1.0)

    harness.application.start()

    assert harness.quits.current() is None
    assert not harness.application.quitting


def test_an_unreadable_quit_record_still_counts_as_a_quit(tmp_path: Path) -> None:
    """The safe direction: something recorded a quit, so nothing is brought back."""
    quits = QuitFile(path=tmp_path / QUIT_FILENAME)
    quits.path.write_text("{not json", encoding="utf-8")

    recorded = quits.current()
    assert recorded is not None and recorded.reason is QuitReason.UNKNOWN


# --- the host's rule about the helper ---------------------------------------------------------


@dataclass
class WatchHarness:
    watch: HelperWatch
    relaunches: list[str]
    shutdowns: list[str]
    clock: FakeClock


@pytest.fixture
def make_watch(tmp_path: Path) -> Callable[..., WatchHarness]:
    def _make(*, quits: QuitFile | None = None, max_attempts: int = 5) -> WatchHarness:
        clock = FakeClock()
        relaunches: list[str] = []
        shutdowns: list[str] = []
        watch = HelperWatch(
            relaunch=lambda: relaunches.append("relaunched"),
            shut_down=lambda: shutdowns.append("shut down"),
            settings=RestartSettings(max_attempts=max_attempts),
            quits=quits,
            now=clock,
        )
        return WatchHarness(watch=watch, relaunches=relaunches, shutdowns=shutdowns, clock=clock)

    return _make


@pytest.mark.parametrize(
    "ending",
    [
        HelperExit(exit_code=1),
        HelperExit(exit_code=134),
        HelperExit(signal=signal.SIGSEGV),
        HelperExit(signal=signal.SIGABRT),
        HelperExit(signal=signal.SIGBUS),
    ],
)
def test_the_host_relaunches_a_crashed_helper(
    make_watch: Callable[..., WatchHarness], ending: HelperExit
) -> None:
    harness = make_watch()

    assert harness.watch.observe(ending) is HostResponse.RELAUNCH_HELPER
    assert harness.shutdowns == []

    # Scheduled, not slept through: the relaunch happens when its backoff runs out.
    assert harness.relaunches == []
    harness.clock.advance(RestartSettings().backoff[0])
    harness.watch.tick()
    assert harness.relaunches == ["relaunched"]


@pytest.mark.parametrize(
    "ending",
    [
        HelperExit(signal=signal.SIGTERM),
        HelperExit(signal=signal.SIGINT),
        HelperExit(signal=signal.SIGKILL),
        HelperExit(exit_code=0),
        HelperExit(),
    ],
)
def test_the_host_never_relaunches_a_helper_it_did_not_see_crash(
    make_watch: Callable[..., WatchHarness], ending: HelperExit
) -> None:
    harness = make_watch()

    assert harness.watch.observe(ending) is HostResponse.SHUT_DOWN
    harness.clock.advance(3_600)
    harness.watch.tick()

    assert harness.relaunches == []
    assert harness.shutdowns == ["shut down"]


def test_a_crash_during_a_recorded_quit_is_still_a_quit(
    make_watch: Callable[..., WatchHarness], tmp_path: Path
) -> None:
    quits = QuitFile(path=tmp_path / QUIT_FILENAME)
    quits.record(QuitReason.COMMAND_LINE, at=1.0)
    harness = make_watch(quits=quits)

    assert harness.watch.observe(HelperExit(exit_code=1)) is HostResponse.SHUT_DOWN
    harness.clock.advance(3_600)
    harness.watch.tick()

    assert harness.relaunches == []
    assert harness.shutdowns == ["shut down"]


def test_a_helper_that_cannot_be_brought_back_takes_the_application_off(
    make_watch: Callable[..., WatchHarness],
) -> None:
    harness = make_watch(max_attempts=2)

    for _ in range(2):
        assert harness.watch.observe(HelperExit(exit_code=1)) is HostResponse.RELAUNCH_HELPER
        harness.clock.advance(60)
        harness.watch.tick()

    assert harness.watch.observe(HelperExit(exit_code=1)) is HostResponse.SHUT_DOWN
    assert harness.shutdowns == ["shut down"]


def test_a_return_code_is_read_the_way_wait_reports_one() -> None:
    assert HelperExit.from_returncode(-signal.SIGSEGV).ending is HelperEnding.CRASHED
    assert HelperExit.from_returncode(-signal.SIGTERM).ending is HelperEnding.STOPPED
    assert HelperExit.from_returncode(0).ending is HelperEnding.QUIT
    assert HelperExit.from_returncode(2).ending is HelperEnding.CRASHED


# --- launch at login (F7) ---------------------------------------------------------------------


@dataclass
class FakeLoginItem:
    """The OS login-item store, as a list of what it was asked to do."""

    calls: list[str] = field(default_factory=list)
    fail: bool = False

    def register(self) -> None:
        if self.fail:
            raise LaunchAtLoginError("the OS refused")
        self.calls.append("register")

    def unregister(self) -> None:
        self.calls.append("unregister")


def test_launch_at_login_is_off_by_default(tmp_path: Path) -> None:
    switch = LaunchAtLogin(
        settings=HelperSettings(path=tmp_path / "config.toml"),
        login_item=FakeLoginItem(),
    )

    assert switch.enabled is False


def test_turning_launch_at_login_on_registers_the_login_item(tmp_path: Path) -> None:
    item = FakeLoginItem()
    switch = LaunchAtLogin(settings=HelperSettings(path=tmp_path / "config.toml"), login_item=item)

    switch.set(True)

    assert item.calls == ["register"]
    assert switch.enabled is True
    assert "launch_at_login = true" in (tmp_path / "config.toml").read_text(encoding="utf-8")


def test_turning_launch_at_login_off_unregisters_the_login_item(tmp_path: Path) -> None:
    item = FakeLoginItem()
    switch = LaunchAtLogin(settings=HelperSettings(path=tmp_path / "config.toml"), login_item=item)
    switch.set(True)

    switch.set(False)

    assert item.calls == ["register", "unregister"]
    assert switch.enabled is False


def test_a_login_item_the_os_refuses_leaves_the_setting_alone(tmp_path: Path) -> None:
    switch = LaunchAtLogin(
        settings=HelperSettings(path=tmp_path / "config.toml"),
        login_item=FakeLoginItem(fail=True),
    )

    with pytest.raises(LaunchAtLoginError):
        switch.set(True)

    assert switch.enabled is False


def test_the_unpackaged_login_item_refuses_out_loud_rather_than_pretending() -> None:
    """The seam says what it cannot do; a silent success would be the worst outcome."""
    item = UnpackagedLoginItem()

    with pytest.raises(LaunchAtLoginError):
        item.register()
    with pytest.raises(LaunchAtLoginError):
        item.unregister()


# --- the command line -------------------------------------------------------------------------


def test_the_quit_command_turns_the_application_off(
    make_application: Callable[..., Harness],
) -> None:
    harness = started_application(make_application())
    quitter = Quitter(processes=harness.processes, quits=harness.quits, clock=harness.clock)

    result = CliRunner().invoke(
        cli, ["quit"], obj=CliContext(make_quitter=lambda run_state: quitter)
    )

    assert result.exit_code == 0
    assert "InnyTypes is off." in result.output
    assert harness.run_state.records() == ()


def test_the_forced_quit_command_stops_everything_itself(
    make_application: Callable[..., Harness],
) -> None:
    harness = started_application(make_application())
    harness.table.stubborn.add(harness.records()["monty"].pid)
    quitter = Quitter(processes=harness.processes, quits=harness.quits, clock=harness.clock)

    result = CliRunner().invoke(
        cli, ["quit", "--force"], obj=CliContext(make_quitter=lambda run_state: quitter)
    )

    assert result.exit_code == 0
    assert "monty killed" in result.output
    assert harness.host.commands == []
    recorded = harness.quits.current()
    assert recorded is not None and recorded.reason is QuitReason.FORCED


def test_the_quit_command_says_so_when_something_survived_a_forced_kill(
    make_application: Callable[..., Harness],
) -> None:
    """The one case where the command did not do what it promised has to be said out loud."""
    harness = started_application(make_application())
    survivor = harness.records()["monty"]

    def ignore_everything(pid: int, which: Signal) -> None:
        harness.table.signals.append((pid, which))
        if pid != survivor.pid:
            harness.table.facts_by_pid.pop(pid, None)

    processes = ManagedProcesses(
        run_state=harness.run_state,
        table=harness.table,
        send_signal=ignore_everything,
        clock=harness.clock,
        sleep=harness.clock.advance,
    )
    quitter = Quitter(processes=processes, quits=harness.quits, clock=harness.clock)

    result = CliRunner().invoke(
        cli, ["quit", "--force"], obj=CliContext(make_quitter=lambda run_state: quitter)
    )

    assert result.exit_code == 0
    assert "STILL RUNNING" in result.output


def test_quit_order_is_the_reverse_of_the_start_order() -> None:
    records = [
        ChildRecord(id=child_id, kind=kind, pid=pid, started_at=1.0, executable="/x", parent_pid=1)
        for child_id, kind, pid in (
            (HELPER_ID, ChildKind.HELPER, 1),
            (HOST_ID, ChildKind.HOST, 2),
            (ANYTYPE_APP_ID, ChildKind.ANYTYPE_APP, 3),
            (MCP_CHILD_ID, ChildKind.MCP, 4),
            ("monty", ChildKind.ADDON, 5),
        )
    ]

    assert [record.id for record in quit_order(records)] == [
        "monty",
        MCP_CHILD_ID,
        HOST_ID,
        ANYTYPE_APP_ID,
        HELPER_ID,
    ]


def test_a_quit_from_inside_the_application_leaves_an_adopted_anytype_alone(
    make_application: Callable[..., Harness],
) -> None:
    """F6, on the path the Quit menu item takes as well as the forced one."""
    harness = started_application(make_application(anytype_running=True))

    report = harness.application.quit(QuitReason.MENU)

    assert 321 not in harness.table.signalled_pids
    assert ANYTYPE_APP_ID not in {record.id for record in report.signalled}
    assert harness.application.anytype is AnytypeStart.ADOPTED


def test_an_application_with_no_restart_policy_brings_nothing_back(
    make_application: Callable[..., Harness],
) -> None:
    """The helper's own tick owns the policy; an application assembled without one restarts none."""
    harness = make_application()
    plain = Application(
        lock=harness.lock,
        processes=harness.processes,
        run_state=harness.run_state,
        quits=harness.quits,
        applications=harness.applications,
        start_process=harness.launcher,
        host_command=HOST_COMMAND,
        anytype_executable=ANYTYPE_EXECUTABLE,
        identity=lambda: harness.helper_record,
        clock=harness.clock,
    )
    assert plain.start().started is True

    exited = plain.child_exited(
        ChildExit(id="monty", kind=ChildKind.ADDON, pid=602, exit_code=1, expected=False)
    )

    assert exited is None
    assert harness.host.commands == []


def test_a_config_that_cannot_be_written_puts_the_login_item_back(tmp_path: Path) -> None:
    """The switch never claims something the machine is not doing."""
    config = tmp_path / "config.toml"
    config.write_text("telemetry = 'yes please'\n", encoding="utf-8")
    item = FakeLoginItem()
    switch = LaunchAtLogin(settings=HelperSettings(path=config), login_item=item)

    with pytest.raises(HelperConfigError):
        switch.set(True)

    # Registered, then put back exactly as it was.
    assert item.calls == ["register", "unregister"]


def test_the_lock_and_the_quit_record_live_beside_the_run_state_file(tmp_path: Path) -> None:
    quitter = build_quitter(tmp_path / "run-state.json")

    assert quitter.quits.path == tmp_path / QUIT_FILENAME
    # And the per-user defaults are the same runtime directory the run-state file uses.
    assert default_lock_path().parent == default_run_state_path().parent
    assert default_quit_path().parent == default_run_state_path().parent


def test_a_lock_naming_a_record_that_cannot_be_read_is_taken_over(
    make_application: Callable[..., Harness],
) -> None:
    harness = make_application()
    harness.lock.path.parent.mkdir(parents=True, exist_ok=True)
    # Valid JSON, but not a run-state record: it names nobody, so it protects nobody.
    harness.lock.path.write_text(json.dumps({"id": "innytypes.helper"}), encoding="utf-8")

    assert harness.lock.holder() is None
    assert harness.application.start().outcome is Start.STARTED


def test_the_real_application_lookup_answers_nothing_for_something_not_running() -> None:
    """Reads the machine's process table; starts nothing, signals nothing."""
    assert SystemApplications().find("/nowhere/there/is/no/such/application") is None


def test_the_anytype_path_is_resolved_or_honestly_absent() -> None:
    """A path the process table will report, or ``None`` — never a bare command name."""
    found = default_anytype_executable()

    assert found is None or Path(found).is_absolute()


def test_a_scheduled_relaunch_is_visible_before_it_happens(
    make_watch: Callable[..., WatchHarness],
) -> None:
    harness = make_watch()

    harness.watch.observe(HelperExit(exit_code=1))

    assert [pending.child_id for pending in harness.watch.pending] == [HELPER_ID]


def test_a_helper_killed_outright_ends_with_nothing_of_ours_running(
    make_application: Callable[..., Harness],
) -> None:
    """`kill -9` on the helper: it gets no chance to quit, so the host has to finish the job."""
    harness = started_application(make_application())
    relaunches: list[str] = []

    def shut_the_host_down() -> None:
        for record in quit_order(harness.run_state.records()):
            if record.kind is not ChildKind.HELPER:
                harness.processes.stop(record)

    watch = HelperWatch(
        relaunch=lambda: relaunches.append("relaunched"),
        shut_down=shut_the_host_down,
        now=harness.clock,
    )

    # The helper is gone, and nothing caught anything: this is what an unstoppable kill looks
    # like from the host's side.
    harness.table.facts_by_pid.pop(harness.helper_record.pid)
    response = watch.observe(HelperExit(signal=signal.SIGKILL, pid=harness.helper_record.pid))
    harness.clock.advance(3_600)
    watch.tick()

    assert response is HostResponse.SHUT_DOWN
    assert relaunches == []
    assert {record.id for record in harness.run_state.records()} == {HELPER_ID}
    assert harness.table.facts_by_pid == {}
