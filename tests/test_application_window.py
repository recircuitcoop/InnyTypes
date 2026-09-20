"""The application's own window: everything it shows, every control, and the icon it never adds.

Two of these tests are the ones the slice exists for, and both assert an **absence**, which is
the hardest kind to prove:

* **No system tray.** The owner said the controls live only inside the application (plan 0003,
  F4). :class:`~innytypes.helper.window.Desktop` offers ``add_status_item`` — the macOS menu
  bar extra, the Windows notification-area icon, the Linux tray item — so that never calling
  it is an assertion rather than a promise. One test watches the recording desktop; a second
  reads the source tree, so a tray icon added anywhere in ``innytypes`` fails the gate, not
  only one added to the window.
* **Closing is not quitting.** The window is wired to the *real*
  :class:`~innytypes.helper.launcher.Application` from slice 07, so closing it is checked
  against the same quit record, run-state file and signal list that the quit tests use. The
  pair is written on purpose: closing signals nobody and records no quit, and the identical
  setup quitting does both. Either assertion alone would pass against a window that did
  nothing at all.

Nothing here draws anything, starts anything or reaches the network. The desktop is
:class:`~innytypes.helper.window.HeadlessDesktop`, the process table is a dictionary, the
config file and the telemetry queue live under ``tmp_path``, the clock is a number a test
moves, and the telemetry transport is an :class:`httpx.MockTransport` that records requests
instead of making them.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import pytest

from innytypes.children import ChildKind, ChildRecord, Command, CommandResult, RunStateFile
from innytypes.helper.breaker import HOST_ID, ProcessStatus, RunState
from innytypes.helper.config import HelperSettings, UpdateMode
from innytypes.helper.launcher import (
    HELPER_ID,
    QUIT_FILENAME,
    Application,
    InstanceLock,
    LaunchAtLogin,
    LaunchAtLoginError,
    QuitFile,
    QuitReason,
    Start,
)
from innytypes.helper.processes import ManagedProcesses, ProcessFacts, Signal
from innytypes.helper.restart import RestartPolicy
from innytypes.helper.telemetry import (
    Endpoints,
    InstalledPlugin,
    ReportQueue,
    TelemetryPipeline,
    UsageSnapshot,
)
from innytypes.helper.update import StagedRelease, Version
from innytypes.helper.versions import ConsistencyRule, PluginReport, PluginState
from innytypes.helper.window import (
    APPLY_LABEL,
    CORE_SUBJECT,
    ApplicationWindow,
    Control,
    Element,
    HeadlessDesktop,
    ProcessRow,
    SwitchState,
    UpdateKind,
    UpdateRow,
    WindowError,
)

HELPER_EXECUTABLE = "/opt/innytypes/bin/python"
HOST_COMMAND = ("/opt/innytypes/bin/python", "-m", "innytypes", "up")

# Endpoints that exist only in this file. Both https, because the transports refuse anything
# else, and both ``.invalid`` so a request that escaped the mock could not resolve.
TEST_ENDPOINTS = Endpoints(
    glitchtip_dsn="https://fakepublickey0123456789@errors.innytypes.invalid/7",
    umami_url="https://usage.innytypes.invalid",
    umami_website_id="fake-website-0123",
)

# A machine identifier that exists only here. The word "fake" is on the line for
# tests/test_no_secrets.py.
FAKE_IDENTIFIER = "FAKE-6B4C1E2A-9D3F-4A18-8C7E-2F5B0A9D1C34"

# The tray, notification-area and menu-bar-extra APIs, by the names a real implementation
# would have to use. None of them may appear anywhere under ``src/innytypes``.
TRAY_APIS = (
    "NSStatusBar",
    "NSStatusItem",
    "statusItemWithLength",
    "Shell_NotifyIcon",
    "NOTIFYICONDATA",
    "StatusNotifierItem",
    "QSystemTrayIcon",
    "AppIndicator",
    "pystray",
    "rumps",
)


# --- fakes ----------------------------------------------------------------------------------


class FakeClock:
    """Seconds a test moves rather than waits."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class FakeTable:
    """The OS process table as plain data, and the signals a test sends into it."""

    facts_by_pid: dict[int, ProcessFacts] = field(default_factory=dict)
    signals: list[tuple[int, Signal]] = field(default_factory=list)

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
        self.facts_by_pid.pop(pid, None)


@dataclass
class FakeProcess:
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
class NoApplications:
    """No other application is running, which keeps Anytype out of these tests entirely."""

    def find(self, executable: str) -> ProcessFacts | None:
        return None


@dataclass
class FakeHost:
    """A host that answers the control channel and starts nothing by itself."""

    commands: list[str] = field(default_factory=list)

    def send(self, command: Command) -> CommandResult:
        self.commands.append(str(command.name))
        return CommandResult(name=command.name)


@dataclass
class RecordingLoginItem:
    """A login item the operating system accepts, for the switch's happy path."""

    registered: bool = False

    def register(self) -> None:
        self.registered = True

    def unregister(self) -> None:
        self.registered = False


class RefusingLoginItem:
    """A login item that refuses, exactly as an unpackaged installation's does (F5, F7)."""

    def register(self) -> None:
        raise LaunchAtLoginError("this installation is not a packaged application bundle")

    def unregister(self) -> None:
        raise LaunchAtLoginError("there is no login item to remove")


class RecordingTransport:
    """An `httpx.MockTransport` that records every request instead of making one."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(200, json={"ok": True})


class FakeIdentifierSource:
    """The OS machine identifier, faked, counting every time it is asked for."""

    def __init__(self) -> None:
        self.reads = 0

    def __call__(self) -> str:
        self.reads += 1
        return FAKE_IDENTIFIER


# --- what a test hands the window -----------------------------------------------------------


def a_status(child_id: str, state: RunState, reason: str | None = None) -> ProcessStatus:
    return ProcessStatus(
        child_id=child_id,
        state=state,
        interventions=0 if reason is None else 1,
        last_reason=reason,
    )


def a_staged_release(*, automatic: bool, version: str = "1.4.0") -> StagedRelease:
    major, minor, patch = (int(part) for part in version.split("."))
    directory = Path("/staging") / version
    return StagedRelease(
        version=Version(major, minor, patch),
        directory=directory,
        artifact_path=directory / f"innytypes-{version}.tar.gz",
        marker_path=directory / "ready",
        automatic=automatic,
    )


def an_available_plugin(plugin_id: str, *, target: str = "2.0.0") -> PluginReport:
    return PluginReport(
        id=plugin_id,
        installed_version="1.0.0",
        state=PluginState.AVAILABLE,
        target_version=target,
        newest_version=target,
    )


def a_blocked_plugin(plugin_id: str) -> PluginReport:
    return PluginReport(
        id=plugin_id,
        installed_version="1.0.0",
        state=PluginState.BLOCKED,
        target_version="1.0.0",
        newest_version="3.0.0",
        rule=ConsistencyRule.HOST_API,
        reason="3.0.0 needs a newer host than this one",
    )


def a_usage_snapshot() -> UsageSnapshot:
    return UsageSnapshot(
        innytypes_version="9.9.9",
        os="Darwin",
        os_version="25.3.0",
        plugins=(InstalledPlugin(id="whodunnit", version="1.2.0", update_mode="auto"),),
        starts=1,
    )


@dataclass
class Harness:
    """One window, the application behind it, and everything a test asserts about either."""

    window: ApplicationWindow
    desktop: HeadlessDesktop
    application: Application
    settings: HelperSettings
    config_file: Path
    table: FakeTable
    launcher: FakeLauncher
    run_state: RunStateFile
    quits: QuitFile
    login_item: RecordingLoginItem | RefusingLoginItem
    applied: list[UpdateRow]
    transport: RecordingTransport
    queue: ReportQueue
    identifier: FakeIdentifierSource

    def records(self) -> dict[str, ChildRecord]:
        return {record.id: record for record in self.run_state.records()}


MakeWindow = Callable[..., Harness]


@pytest.fixture
def make_window(tmp_path: Path) -> MakeWindow:
    """Build a window whose every seam is a fake, under this test's own directory."""

    def _make(
        *,
        statuses: Sequence[ProcessStatus] = (),
        core_update: StagedRelease | None = None,
        plugin_updates: Sequence[PluginReport] = (),
        config: str = "",
        answers: Sequence[bool | None] = (),
        login_item: RecordingLoginItem | RefusingLoginItem | None = None,
        with_telemetry: bool = False,
        directory: Path | None = None,
    ) -> Harness:
        root = tmp_path if directory is None else directory
        root.mkdir(parents=True, exist_ok=True)

        config_file = root / "config.toml"
        config_file.write_text(config, encoding="utf-8")
        settings = HelperSettings(path=config_file)

        clock = FakeClock()
        table = FakeTable()
        me = ChildRecord(
            id=HELPER_ID,
            kind=ChildKind.HELPER,
            pid=400,
            started_at=1_000.0,
            executable=HELPER_EXECUTABLE,
            parent_pid=1,
        )
        table.add(me)

        run_state = RunStateFile(root / "run-state.json")
        processes = ManagedProcesses(
            run_state=run_state,
            table=table,
            send_signal=table.send,
            clock=clock,
            sleep=clock.advance,
            stop_timeout=10.0,
        )
        quits = QuitFile(path=root / QUIT_FILENAME)
        launcher = FakeLauncher(table=table, clock=clock)

        application = Application(
            lock=InstanceLock(path=root / "helper.lock", processes=processes),
            processes=processes,
            run_state=run_state,
            quits=quits,
            applications=NoApplications(),
            start_process=launcher,
            host_command=HOST_COMMAND,
            anytype_executable=None,
            identity=lambda: me,
            policy=RestartPolicy(channel=FakeHost(), now=clock),  # type: ignore[arg-type]
            clock=clock,
        )

        desktop = HeadlessDesktop(answers=list(answers))
        item = RecordingLoginItem() if login_item is None else login_item
        applied: list[UpdateRow] = []

        transport = RecordingTransport()
        identifier = FakeIdentifierSource()
        queue = ReportQueue(root / "queue")
        pipeline: TelemetryPipeline | None = None
        if with_telemetry:
            pipeline = TelemetryPipeline(
                settings=settings,
                queue=queue,
                machine_identifier=identifier,
                endpoints=TEST_ENDPOINTS,
                release="9.9.9",
                transport=transport.transport,
                clock=clock,
            )

        window = ApplicationWindow(
            desktop=desktop,
            settings=settings,
            launch_at_login=LaunchAtLogin(settings=settings, login_item=item),
            quit=application.quit,
            statuses=lambda: statuses,
            core_update=lambda: core_update,
            plugin_updates=lambda: plugin_updates,
            apply_update=applied.append,
            telemetry=pipeline,
            usage=a_usage_snapshot if with_telemetry else None,
        )

        return Harness(
            window=window,
            desktop=desktop,
            application=application,
            settings=settings,
            config_file=config_file,
            table=table,
            launcher=launcher,
            run_state=run_state,
            quits=quits,
            login_item=item,
            applied=applied,
            transport=transport,
            queue=queue,
            identifier=identifier,
        )

    return _make


# --- what the window shows ------------------------------------------------------------------


def test_the_window_shows_every_process_update_switch_and_quit(make_window: MakeWindow) -> None:
    """Every element of plan 0003's list, filled from state the test injected."""
    harness = make_window(
        statuses=(
            a_status(HOST_ID, RunState.RUNNING),
            a_status("monty", RunState.RESTARTING, "exited with code 1"),
            a_status("whodunnit", RunState.QUARANTINED, "4 restarts in 10 minutes"),
        ),
        core_update=a_staged_release(automatic=False),
        plugin_updates=(an_available_plugin("summarize"),),
        config='telemetry = true\nlaunch_at_login = true\n[plugins]\nupdate_mode = "manual"\n',
    )

    contents = harness.window.open()

    assert contents.elements == {
        Element.PROCESSES,
        Element.UPDATES,
        Element.TELEMETRY,
        Element.LAUNCH_AT_LOGIN,
        Element.QUIT,
    }

    # Every managed process, in the state the helper says it is in.
    assert contents.process(HOST_ID) == ProcessRow(child_id=HOST_ID, state=RunState.RUNNING)
    assert contents.process("monty") == ProcessRow(
        child_id="monty", state=RunState.RESTARTING, detail="exited with code 1"
    )
    assert contents.process("whodunnit") == ProcessRow(
        child_id="whodunnit",
        state=RunState.QUARANTINED,
        detail="4 restarts in 10 minutes",
    )

    # Both pending updates, core and plugin, each with its Apply.
    core = contents.update(CORE_SUBJECT)
    assert core is not None
    assert core.kind is UpdateKind.CORE
    assert core.version == "1.4.0"
    assert core.apply == Control(label=f"{APPLY_LABEL} 1.4.0")

    plugin = contents.update("summarize")
    assert plugin is not None
    assert plugin.kind is UpdateKind.PLUGIN
    assert plugin.version == "2.0.0"
    assert plugin.apply == Control(label=f"{APPLY_LABEL} 2.0.0")

    # The two switches, reading what `config.toml` says.
    assert contents.telemetry.state is SwitchState.ON
    assert contents.launch_at_login.state is SwitchState.ON

    # And Quit InnyTypes, by the name the plan gives it.
    assert not hasattr(contents, "quit")

    # What was drawn is what was returned.
    assert harness.desktop.last == contents


def test_the_switches_reflect_an_off_and_unanswered_configuration(make_window: MakeWindow) -> None:
    """The same three elements, with the opposite values, so the reading is not a constant."""
    harness = make_window(config="launch_at_login = false\n")

    contents = harness.window.open()

    assert contents.telemetry.state is SwitchState.UNANSWERED
    assert contents.telemetry.on is False
    assert contents.launch_at_login.state is SwitchState.OFF


def test_quit_is_shown_even_when_nothing_else_is(make_window: MakeWindow) -> None:
    """F1: turning InnyTypes off is never hidden, including on an empty window."""
    harness = make_window()

    contents = harness.window.open()

    assert contents.processes == ()
    assert contents.updates == ()
    assert Element.QUIT in contents.elements
    assert not hasattr(contents, "quit")


def test_only_manual_updates_carry_an_apply_control(make_window: MakeWindow) -> None:
    """An `auto` update and a blocked one are shown, and neither is the user's to press."""
    harness = make_window(
        core_update=a_staged_release(automatic=True),
        plugin_updates=(
            an_available_plugin("summarize", target="2.0.0"),
            an_available_plugin("monty", target="3.1.0"),
            a_blocked_plugin("whodunnit"),
        ),
        config=('[plugins]\nupdate_mode = "auto"\n[plugins.summarize]\nupdate_mode = "manual"\n'),
    )

    contents = harness.window.open()

    applicable = {row.subject for row in contents.applicable_updates}
    assert applicable == {"summarize"}

    automatic_core = contents.update(CORE_SUBJECT)
    assert automatic_core is not None
    assert automatic_core.apply is None
    assert automatic_core.detail == "Will be applied the next time you quit InnyTypes."

    auto_plugin = contents.update("monty")
    assert auto_plugin is not None
    assert auto_plugin.apply is None

    blocked = contents.update("whodunnit")
    assert blocked is not None
    assert blocked.apply is None
    assert blocked.detail == "3.0.0 needs a newer host than this one"


def test_a_plugin_with_nothing_pending_is_not_in_the_window(make_window: MakeWindow) -> None:
    """The window lists what is waiting, not everything installed."""
    harness = make_window(
        plugin_updates=(
            PluginReport(
                id="monty",
                installed_version="1.0.0",
                state=PluginState.UP_TO_DATE,
                target_version="1.0.0",
            ),
        )
    )

    contents = harness.window.open()

    assert contents.updates == ()
    assert Element.UPDATES not in contents.elements


def test_pressing_apply_applies_that_update(make_window: MakeWindow) -> None:
    harness = make_window(
        plugin_updates=(an_available_plugin("summarize"),),
        config='[plugins]\nupdate_mode = "manual"\n',
    )
    contents = harness.window.open()
    row = contents.update("summarize")
    assert row is not None

    harness.window.apply_update(row)

    assert harness.applied == [row]


def test_applying_an_update_with_no_apply_control_is_refused(make_window: MakeWindow) -> None:
    """The `auto` mode is the user's setting; the window does not overrule it by accident."""
    harness = make_window(
        plugin_updates=(an_available_plugin("monty"),),
        config='[plugins]\nupdate_mode = "auto"\n',
    )
    contents = harness.window.open()
    row = contents.update("monty")
    assert row is not None

    with pytest.raises(WindowError, match="no Apply control"):
        harness.window.apply_update(row)

    assert harness.applied == []


# --- the Dock entry, and the system tray that is never registered ----------------------------


def test_the_dock_entry_is_registered_once_and_no_status_item_ever_is(
    make_window: MakeWindow,
) -> None:
    """F4, as an assertion: the Dock/taskbar entry exactly once, the tray never.

    Reopening is the case that could get this wrong twice over — a second Dock entry, or a
    tray icon added "so the window can be found again" — so the window is opened three times.
    """
    harness = make_window()

    harness.window.open()
    harness.window.reopen()
    harness.window.reopen()

    assert harness.desktop.application_shown == 1
    assert harness.desktop.status_items == []
    assert len(harness.desktop.presented) == 3


def test_quitting_and_closing_never_register_a_status_item(make_window: MakeWindow) -> None:
    """Every other path through the window, held to the same rule."""
    harness = make_window(
        statuses=(a_status(HOST_ID, RunState.RUNNING),),
        core_update=a_staged_release(automatic=False),
    )

    harness.window.open()
    harness.window.set_telemetry(True)
    harness.window.set_launch_at_login(True)
    harness.window.close()
    harness.window.open()
    harness.window.quit()

    assert harness.desktop.status_items == []


def test_no_system_tray_api_appears_anywhere_in_the_tree() -> None:
    """The rule, checked against the source rather than against one object's behaviour.

    The recording desktop proves the window declines the status item. This proves nobody else
    reaches around it: a tray icon added to the helper, the host or a later slice fails here.
    """
    source = Path(__file__).resolve().parents[1] / "src" / "innytypes"
    offenders: list[str] = []

    for path in sorted(source.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for api in TRAY_APIS:
            if api in text:
                offenders.append(f"{path.name}: {api}")
        # The seam itself is declared in window.py and called nowhere.
        if ".add_status_item(" in text:
            offenders.append(f"{path.name}: calls add_status_item")

    assert offenders == []


# --- closing is not quitting ------------------------------------------------------------------


def test_closing_the_window_stops_nothing(make_window: MakeWindow) -> None:
    """The window is closed and the application keeps running, in full."""
    harness = make_window()
    report = harness.application.start()
    assert report.outcome is Start.STARTED
    before = harness.records()

    harness.window.open()
    harness.window.close()

    assert harness.window.visible is False
    assert harness.desktop.dismissed == 1
    # Nothing was signalled, no quit was recorded, and every record is still there.
    assert harness.table.signals == []
    assert harness.quits.current() is None
    assert harness.records() == before
    assert HOST_ID in harness.records()


def test_quitting_from_the_window_turns_everything_off(make_window: MakeWindow) -> None:
    """The counterpart, from the identical setup: Quit InnyTypes does what closing does not."""
    harness = make_window()
    harness.application.start()
    host = harness.records()[HOST_ID]

    harness.window.open()
    quit_report = harness.window.quit()

    assert quit_report.reason is QuitReason.MENU
    assert host.pid in [pid for pid, _ in harness.table.signals]
    assert harness.quits.current() is not None
    assert harness.window.visible is False


def test_a_second_launch_reopens_the_window_and_starts_nothing(tmp_path: Path) -> None:
    """The single-instance rule, from slice 07's side: the icon reopens this window.

    Two applications share one lock directory. The second one finds the lock held by a helper
    whose identity still verifies, so it starts nothing and calls the window's ``reopen``.
    """
    root = tmp_path / "shared"
    root.mkdir()

    clock = FakeClock()
    table = FakeTable()
    first_helper = ChildRecord(
        id=HELPER_ID,
        kind=ChildKind.HELPER,
        pid=400,
        started_at=1_000.0,
        executable=HELPER_EXECUTABLE,
        parent_pid=1,
    )
    table.add(first_helper)

    run_state = RunStateFile(root / "run-state.json")
    processes = ManagedProcesses(
        run_state=run_state,
        table=table,
        send_signal=table.send,
        clock=clock,
        sleep=clock.advance,
    )
    lock = InstanceLock(path=root / "helper.lock", processes=processes)
    quits = QuitFile(path=root / QUIT_FILENAME)

    config_file = root / "config.toml"
    config_file.write_text("", encoding="utf-8")
    settings = HelperSettings(path=config_file)

    desktop = HeadlessDesktop(answers=[False])
    first_launcher = FakeLauncher(table=table, clock=clock)
    first = Application(
        lock=lock,
        processes=processes,
        run_state=run_state,
        quits=quits,
        applications=NoApplications(),
        start_process=first_launcher,
        host_command=HOST_COMMAND,
        anytype_executable=None,
        identity=lambda: first_helper,
        clock=clock,
    )
    window = ApplicationWindow(
        desktop=desktop,
        settings=settings,
        launch_at_login=LaunchAtLogin(settings=settings, login_item=RecordingLoginItem()),
        quit=first.quit,
    )

    assert first.start().outcome is Start.STARTED
    window.open()
    assert first_launcher.count == 1

    # The user clicks the icon again. A second helper takes the same lock path.
    second_helper = ChildRecord(
        id=HELPER_ID,
        kind=ChildKind.HELPER,
        pid=401,
        started_at=1_000.0,
        executable=HELPER_EXECUTABLE,
        parent_pid=1,
    )
    table.add(second_helper)
    second_launcher = FakeLauncher(table=table, clock=clock, next_pid=800)
    second = Application(
        lock=lock,
        processes=processes,
        run_state=run_state,
        quits=quits,
        applications=NoApplications(),
        start_process=second_launcher,
        host_command=HOST_COMMAND,
        anytype_executable=None,
        identity=lambda: second_helper,
        show_window=window.reopen,
        clock=clock,
    )

    report = second.start()

    assert report.outcome is Start.ALREADY_RUNNING
    # Nothing was started a second time, and the window came back instead.
    assert second_launcher.count == 0
    assert len(desktop.presented) == 2
    assert desktop.application_shown == 1
    assert desktop.status_items == []


# --- the first-launch question ----------------------------------------------------------------


def test_the_question_is_asked_once_across_two_launches(tmp_path: Path) -> None:
    """F2: asked on the first launch, answered, and never asked again."""
    config_file = tmp_path / "config.toml"
    config_file.write_text("", encoding="utf-8")
    settings = HelperSettings(path=config_file)

    def a_window(desktop: HeadlessDesktop) -> ApplicationWindow:
        return ApplicationWindow(
            desktop=desktop,
            settings=settings,
            launch_at_login=LaunchAtLogin(settings=settings, login_item=RecordingLoginItem()),
            quit=lambda reason: pytest.fail("the question must not quit anything"),
        )

    first_desktop = HeadlessDesktop(answers=[True])
    first = a_window(first_desktop)
    contents = first.open()

    assert len(first_desktop.questions) == 1
    assert contents.telemetry.state is SwitchState.ON

    # A whole new launch, reading the same config file.
    second_desktop = HeadlessDesktop(answers=[False])
    second = a_window(second_desktop)
    again = second.open()

    assert second_desktop.questions == []
    assert again.telemetry.state is SwitchState.ON

    # Reopening within the second launch does not ask either.
    second.reopen()
    assert second_desktop.questions == []


def test_the_question_carries_the_privacy_notice(make_window: MakeWindow) -> None:
    """D25: the notice is shown with the choice, not somewhere the user has to go looking."""
    from innytypes.helper.telemetry import FIRST_LAUNCH_QUESTION, PRIVACY_NOTICE

    seen: list[tuple[str, str]] = []

    class NotingDesktop(HeadlessDesktop):
        def ask(self, question: str, notice: str) -> bool | None:
            seen.append((question, notice))
            return True

    harness = make_window()
    window = ApplicationWindow(
        desktop=NotingDesktop(),
        settings=harness.settings,
        launch_at_login=LaunchAtLogin(settings=harness.settings, login_item=RecordingLoginItem()),
        quit=harness.application.quit,
    )

    window.open()

    assert seen == [(FIRST_LAUNCH_QUESTION, PRIVACY_NOTICE)]


def test_a_dismissed_question_is_not_read_as_a_no(make_window: MakeWindow) -> None:
    """Closing the dialog decides nothing, so the switch stays unanswered and it is asked again."""
    harness = make_window(answers=[None, None])

    first = harness.window.open()
    assert first.telemetry.state is SwitchState.UNANSWERED
    assert len(harness.desktop.questions) == 1

    second = harness.window.open()
    assert second.telemetry.state is SwitchState.UNANSWERED
    assert len(harness.desktop.questions) == 2


def test_the_telemetry_switch_answers_the_question_too(make_window: MakeWindow) -> None:
    """A user who dismissed the dialog and then used the switch has answered it properly."""
    harness = make_window(answers=[None])
    harness.window.open()
    assert len(harness.desktop.questions) == 1

    switch = harness.window.set_telemetry(True)

    assert switch.state is SwitchState.ON
    assert harness.settings.telemetry.answered is True

    harness.window.open()
    assert len(harness.desktop.questions) == 1


# --- nothing is sent or queued before the question is answered --------------------------------


def test_nothing_is_queued_or_sent_while_the_question_is_unanswered(
    make_window: MakeWindow,
) -> None:
    """F2, through the real pipeline: no request, no queued file, no machine identifier read."""
    harness = make_window(answers=[None], with_telemetry=True)

    harness.window.open()
    harness.window.reopen()

    assert harness.transport.requests == []
    assert len(harness.queue) == 0
    # The identifier is derived inside the gate, so an unanswered question never reads it.
    assert harness.identifier.reads == 0


def test_a_yes_is_what_lets_the_usage_report_be_queued(make_window: MakeWindow) -> None:
    """The canary for the test above: the same window queues once the answer is yes."""
    harness = make_window(answers=[True], with_telemetry=True)

    harness.window.open()

    assert len(harness.queue) == 1
    assert harness.identifier.reads == 1
    # Queued, not sent: delivery is the sender's business and nothing was flushed here.
    assert harness.transport.requests == []


def test_turning_telemetry_off_in_the_window_empties_the_queue(make_window: MakeWindow) -> None:
    """The switch takes effect immediately: what is queued is deleted, not sent later."""
    harness = make_window(answers=[True], with_telemetry=True)
    harness.window.open()
    assert len(harness.queue) == 1

    switch = harness.window.set_telemetry(False)
    harness.window.reopen()

    assert switch.state is SwitchState.OFF
    assert len(harness.queue) == 0
    assert harness.transport.requests == []


# --- the launch-at-login switch ---------------------------------------------------------------


def test_the_launch_at_login_switch_registers_and_stores(make_window: MakeWindow) -> None:
    harness = make_window(login_item=RecordingLoginItem())

    switch = harness.window.set_launch_at_login(True)

    assert switch.state is SwitchState.ON
    assert switch.detail is None
    assert isinstance(harness.login_item, RecordingLoginItem)
    assert harness.login_item.registered is True
    assert harness.settings.launch_at_login is True
    assert harness.window.contents().launch_at_login.state is SwitchState.ON


def test_a_refused_login_item_leaves_the_switch_off_and_says_why(make_window: MakeWindow) -> None:
    """The unpackaged installation (F5, F7): the switch does not move and the window explains.

    A switch that moved on screen while the machine did nothing is the one outcome that would
    be worse than refusing, because the user would have no way to tell.
    """
    harness = make_window(login_item=RefusingLoginItem())

    switch = harness.window.set_launch_at_login(True)

    assert switch.state is SwitchState.OFF
    assert switch.detail is not None
    assert "packaged application bundle" in switch.detail
    assert harness.settings.launch_at_login is False
    assert harness.window.contents().launch_at_login.detail == switch.detail


def test_the_refusal_clears_once_the_switch_moves(make_window: MakeWindow) -> None:
    """A stale explanation under a switch that now works would be its own small lie."""
    harness = make_window(login_item=RecordingLoginItem())
    harness.window._launch_at_login_refusal = "something went wrong earlier"

    switch = harness.window.set_launch_at_login(True)

    assert switch.detail is None


# --- the mode a plugin update is judged by ----------------------------------------------------


def test_the_update_mode_is_read_from_the_config_at_the_moment_it_is_drawn(
    make_window: MakeWindow,
) -> None:
    """The helper re-reads `config.toml` before it acts, and so does the window."""
    harness = make_window(
        plugin_updates=(an_available_plugin("summarize"),),
        config='[plugins]\nupdate_mode = "auto"\n',
    )

    assert harness.window.contents().applicable_updates == ()

    harness.config_file.write_text('[plugins]\nupdate_mode = "manual"\n', encoding="utf-8")

    applicable = harness.window.contents().applicable_updates
    assert [row.subject for row in applicable] == ["summarize"]
    assert harness.settings.current.update_mode_for("summarize") is UpdateMode.MANUAL
