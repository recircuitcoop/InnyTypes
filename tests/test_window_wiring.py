"""What the running application actually builds — and that none of it is left ``None``.

Plan 0004, slice 11. Everything the window shows had been built, drawn and covered by tests
for weeks, and none of it was on the screen of the application a person opens:
`ApplicationWindow` takes the process list, the plugin page, the pending core and plugin
updates, the telemetry pipeline and the usage snapshot, and `innytypes.helper.launcher.main`
passed **none** of them, so every one defaulted to ``None`` and the window held two switches
and Quit.

So this file is written against the one thing that could have caught that, and it is not a
drawing test:

* :func:`test_the_entry_point_leaves_no_seam_empty` asserts that what
  :func:`~innytypes.helper.launcher.build_window` returns has **every** optional seam filled.
  :attr:`~innytypes.helper.window.ApplicationWindow.unfilled` reads the window's own
  ``__init__`` signature, so removing any one argument from the builder turns this test red,
  and a seam somebody adds later is covered by it on the day it is added.
* :func:`test_a_window_built_with_nothing_names_every_seam_it_is_missing` is the other half:
  it pins the seams by name against a window built the way the entry point used to build
  one, so the assertion above can never pass because the property went blank.

The rest is what the wiring is *for*: an installed plugin reaches the drawn page, a value
saved through the page reaches the store on disk and restarts that plugin through the control
channel, the process list comes from the run-state file and the quarantines, a release waiting
in staging is offered with an Apply, and a usage report carrying this machine's plugins
reaches telemetry when the switch allows it.

**Every source refusing is a window that still draws and still quits**, which is F1 and is
the last group of tests here: no installed plugins, an unreadable quarantine file, a version
check that never answered, a control channel with no host on it, and a plugin page that
raises outright.

Nothing real is behind any of it. No toolkit is imported, no process is started, no socket is
opened, nothing sleeps, nothing reaches a network, and every path — the addons root, the
config file, the plugins directory, the secrets root, the run-state file, the quarantines, the
release staging directory and the telemetry queue — is under ``tmp_path``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from innytypes import HOST_API_VERSION, __version__
from innytypes.addons.discovery import ENVIRONMENT_DIRNAME, MANIFEST_FILENAME
from innytypes.addons.manifest import parse_manifest
from innytypes.addons.settings import PluginAvailability, SettingsStore
from innytypes.children import (
    MCP_CHILD_ID,
    ChildKind,
    ChildRecord,
    Command,
    CommandName,
    CommandResult,
    RunStateFile,
)
from innytypes.helper.breaker import QuarantineFile, RunState
from innytypes.helper.config import HelperSettings, McpEndpoint
from innytypes.helper.control import HostNotRunningError
from innytypes.helper.launcher import (
    Endpoint,
    EndpointOutcome,
    EndpointReport,
    HelperWindow,
    LatestVersionCheck,
    LaunchAtLogin,
    QuitReason,
    QuitReport,
    build_window,
)
from innytypes.helper.notification import (
    Message,
    Notice,
    NoticeKind,
    RecordingNotifier,
    compose,
)
from innytypes.helper.processes import ManagedProcesses, ProcessFacts
from innytypes.helper.telemetry import Endpoints
from innytypes.helper.update import READY_MARKER, current_platform
from innytypes.helper.versions import PluginReport, PluginState, TargetSet, VersionCheck
from innytypes.helper.window import (
    APPLICATION_TAB,
    APPLY_LABEL,
    CLIENTS_MUST_BE_UPDATED,
    CORE_SUBJECT,
    ApplicationTab,
    ApplicationWindow,
    Degradations,
    Element,
    HeadlessDesktop,
    PluginRunState,
    PluginSource,
    PluginTab,
    UpdateKind,
    WidgetKind,
)

# A machine identifier that exists only in this file, long enough to be one. The word "fake"
# is on the line for tests/test_no_secrets.py, which scans every tracked file.
FAKE_IDENTIFIER = "fake-machine-identifier-0123456789"

# Somewhere for a usage report to be addressed to. Empty in a real build (this one reports
# nowhere), so a test that wants to see a report queued has to say where it would go.
SOMEWHERE = Endpoints(umami_url="https://example.invalid/api/send", umami_website_id="test")

# What a real build of this release reports to, which is nowhere at all.
NOWHERE = Endpoints()

# The MCP endpoint as a machine with nothing serving it reads: an address that is configured
# and is not answering. A port no client is told to use, so nothing here can collide with a
# real InnyTypes on the machine running the gate.
UNSERVED_URL = "http://127.0.0.1:1/mcp"
NO_ENDPOINT = EndpointReport(
    url=UNSERVED_URL, available=False, reason=f"Nothing is serving {UNSERVED_URL}."
)

# One folder field, which is monty's own (plan 0004, slice 09): the value a person types in
# the window, the value that is written to disk, and the value the plugin is restarted onto.
MONTY_SETTINGS: list[Mapping[str, object]] = [
    {"id": "root", "type": "path", "label": "Folder to watch", "kind": "folder"},
]


# --- the machine every test is built on -------------------------------------------------------


@dataclass(frozen=True)
class Machine:
    """One machine's whole state, every path of it under ``tmp_path``.

    Each root is handed to :func:`~innytypes.helper.launcher.build_window` explicitly, which
    is how nothing here can reach a real per-user directory by forgetting an argument.
    """

    root: Path

    @property
    def addons_root(self) -> Path:
        return self.root / "addons"

    @property
    def config_path(self) -> Path:
        return self.root / "config" / "config.toml"

    @property
    def secrets_root(self) -> Path:
        return self.root / "config" / "secrets"

    @property
    def run_state_path(self) -> Path:
        return self.root / "runtime" / "run-state.json"

    @property
    def quarantine_path(self) -> Path:
        return self.root / "runtime" / "quarantine.json"

    @property
    def staging(self) -> Path:
        return self.root / "release" / "staging"

    @property
    def queue_root(self) -> Path:
        return self.root / "queue"

    def settings(self, *, telemetry: bool | None = None) -> HelperSettings:
        """The live view of this machine's `config.toml`, written if it says anything."""
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        if telemetry is not None:
            self.config_path.write_text(
                f"telemetry = {'true' if telemetry else 'false'}\n", encoding="utf-8"
            )
        return HelperSettings(path=self.config_path)

    def install(
        self,
        plugin_id: str,
        *,
        version: str = "1.0.0",
        settings: Sequence[Mapping[str, object]] = (),
    ) -> Path:
        """Put on disk exactly what `addons install` records: a manifest and an environment."""
        root = self.addons_root / plugin_id
        (root / ENVIRONMENT_DIRNAME).mkdir(parents=True)
        (root / MANIFEST_FILENAME).write_text(
            json.dumps(
                {
                    "id": plugin_id,
                    "version": version,
                    "host_api": HOST_API_VERSION,
                    "requires": [],
                    "emits": [],
                    "subscribes": [],
                    "settings": [dict(declared) for declared in settings],
                }
            ),
            encoding="utf-8",
        )
        return root

    def settings_path(self, plugin_id: str) -> Path:
        """One plugin's settings file, beside this machine's `config.toml` (D4)."""
        return self.config_path.parent / "plugins" / f"{plugin_id}.toml"

    def store(self, plugin_id: str) -> SettingsStore:
        """A store over this machine's own files, for reading back what a save wrote."""
        manifest = parse_manifest(
            json.loads((self.addons_root / plugin_id / MANIFEST_FILENAME).read_text("utf-8"))
        )
        return SettingsStore(
            plugin_id,
            manifest.settings,
            path=self.settings_path(plugin_id),
            secret_is_set=lambda field_id: False,
        )

    def record(self, child_id: str, *, kind: ChildKind = ChildKind.ADDON, pid: int) -> ChildRecord:
        """Write one run-state record, as the helper and the host write them."""
        entry = ChildRecord(
            id=child_id,
            kind=kind,
            pid=pid,
            started_at=1_000.0,
            executable="/opt/innytypes/bin/python",
            parent_pid=1,
        )
        RunStateFile(self.run_state_path).write(entry)
        return entry

    def quarantine(self, **reasons: str) -> None:
        """Record quarantines exactly as the breaker records them."""
        QuarantineFile(path=self.quarantine_path).save(dict(reasons))

    def stage_release(self, version: str = "1.4.0", *, automatic: bool = False) -> Path:
        """Write a staged core release as slice 09 leaves one, marker last."""
        directory = self.staging / version
        directory.mkdir(parents=True)
        artifact = directory / f"innytypes-{version}.tar.gz"
        artifact.write_bytes(b"a release, as far as this suite is concerned")
        (directory / READY_MARKER).write_text(
            json.dumps(
                {
                    "version": version,
                    "host_api": HOST_API_VERSION,
                    "platform": current_platform(),
                    "artifact": artifact.name,
                    "sha256": "0" * 64,
                    "signature": "untrusted-until-it-is-verified-at-quit",
                    "automatic": automatic,
                    "blocked_reason": "" if automatic else "this release changes the host API",
                    "staged_at": "2026-09-18T10:30:00+00:00",
                    "ready": True,
                }
            ),
            encoding="utf-8",
        )
        return directory


@pytest.fixture
def machine(tmp_path: Path) -> Machine:
    return Machine(root=tmp_path)


# --- the world outside this process, faked -----------------------------------------------------


@dataclass
class FakeChannel:
    """The control channel: what the host was asked, and what it says is running."""

    running: list[str] = field(default_factory=list)
    commands: list[Command] = field(default_factory=list)
    # What this host answers a set-endpoint with (plan 0008): the address it is now serving,
    # and whether serving it meant moving. Empty is a host that named no address, which
    # `move_endpoint` treats as having answered nothing.
    endpoint: str = ""
    endpoint_moved: bool = True

    def send(self, command: Command) -> CommandResult:
        self.commands.append(command)
        if command.name is CommandName.LIST:
            return CommandResult(name=command.name, children=self._records())
        if command.name is CommandName.SET_ENDPOINT:
            return CommandResult(
                name=command.name, endpoint=self.endpoint, endpoint_moved=self.endpoint_moved
            )
        return CommandResult(name=command.name)

    def _records(self) -> tuple[ChildRecord, ...]:
        return tuple(
            ChildRecord(
                id=child_id,
                kind=ChildKind.ADDON,
                pid=2000 + index,
                started_at=1_000.0,
                executable="/opt/innytypes/bin/python",
                parent_pid=1,
            )
            for index, child_id in enumerate(self.running)
        )

    @property
    def names(self) -> list[CommandName]:
        return [command.name for command in self.commands]


class SilentChannel:
    """A control channel with **no host connected to it** — the first seconds of every launch."""

    def send(self, command: Command) -> CommandResult:
        raise HostNotRunningError(
            f"no host is connected to this helper, so {command.name} reached nothing"
        )


@dataclass
class FakeTable:
    """The process table, answering only about the processes a test says exist."""

    alive: dict[int, ProcessFacts] = field(default_factory=dict)

    def facts(self, pid: int) -> ProcessFacts | None:
        return self.alive.get(pid)


class RecordingLoginItem:
    """The OS login-item store, recorded rather than touched (F7)."""

    def __init__(self) -> None:
        self.registered = False

    def register(self) -> None:
        self.registered = True

    def unregister(self) -> None:
        self.registered = False


@dataclass
class QuitRecorder:
    """The application's quit, recorded. Nothing is stopped and nothing is signalled."""

    reasons: list[QuitReason] = field(default_factory=list)

    def __call__(self, reason: QuitReason) -> QuitReport:
        self.reasons.append(reason)
        return QuitReport(reason=reason)


class RefusingPage:
    """A plugin page that cannot be drawn at all, however it was built."""

    def open(self) -> None:
        raise RuntimeError("this page cannot be drawn")


# --- building what the entry point builds ------------------------------------------------------


@dataclass(frozen=True)
class Wiring:
    """One built window and everything a test needs to assert about it."""

    built: HelperWindow
    desktop: HeadlessDesktop
    quits: QuitRecorder

    @property
    def window(self) -> ApplicationWindow:
        return self.built.window


def wire(
    machine: Machine,
    *,
    channel: FakeChannel | SilentChannel | None = None,
    alive: dict[int, ProcessFacts] | None = None,
    checks: LatestVersionCheck | None = None,
    telemetry: bool | None = None,
    endpoints: Endpoints = NOWHERE,
    endpoint: Endpoint = lambda: NO_ENDPOINT,
    degradations: Degradations = lambda _component: None,
) -> Wiring:
    """Build the window the entry point builds, with every root under ``tmp_path``.

    The one thing a test replaces is the control channel, which is the only seam here that is
    a *process* rather than a file. Everything else — the window, the page, the installed
    plugin host, the settings stores, the secret store, the telemetry pipeline — is the real
    one the application runs.
    """
    desktop = HeadlessDesktop()
    quits = QuitRecorder()
    speaking_to = FakeChannel() if channel is None else channel

    built = build_window(
        desktop=desktop,
        settings=machine.settings(telemetry=telemetry),
        quit=quits,
        channel=speaking_to,
        processes=ManagedProcesses(
            run_state=RunStateFile(machine.run_state_path),
            table=FakeTable(alive or {}),
        ),
        login_item=RecordingLoginItem(),
        quarantines=QuarantineFile(path=machine.quarantine_path),
        checks=checks,
        addons_root=machine.addons_root,
        secrets_root=machine.secrets_root,
        staging=machine.staging,
        queue_root=machine.queue_root,
        machine_identifier=lambda: FAKE_IDENTIFIER,
        endpoints=endpoints,
        # Always passed, never defaulted: the real seam opens a socket to this machine's
        # configured MCP port, and this file reaches no network and no fixed user port.
        endpoint=endpoint,
        # What the host said it came up without. A machine where the host reported nothing
        # is the default here, which is a host that came up whole — never "nobody asked".
        degradations=degradations,
        # Likewise never defaulted. The default is the developer's own key file, so a
        # machine that has paired with Anytype would make these tests read a real
        # credential — and the test for a MISSING key would pass only on a machine that
        # happens not to have one. It did, until this machine acquired a key.
        key_file=machine.root / "canonical" / "anytype_api_key",
    )
    return Wiring(built=built, desktop=desktop, quits=quits)


def a_check(*reports: PluginReport) -> VersionCheck:
    """One version check, as the helper's own would come back from a source that answered."""
    return VersionCheck(checked=True, target=TargetSet(plugins=()), reports=reports)


def an_available_update(plugin_id: str, *, target: str = "2.0.0") -> PluginReport:
    return PluginReport(
        id=plugin_id,
        installed_version="1.0.0",
        state=PluginState.AVAILABLE,
        target_version=target,
        newest_version=target,
    )


# --- the seams ---------------------------------------------------------------------------------


def test_the_entry_point_leaves_no_seam_empty(machine: Machine) -> None:
    """Every optional source the window has is filled by what the application builds.

    The assertion this whole slice exists for. Take any one argument out of
    :func:`~innytypes.helper.launcher.build_window`'s call to `ApplicationWindow` and this
    goes red naming it.
    """
    wiring = wire(machine)

    assert wiring.window.unfilled == frozenset()


def test_a_window_built_with_nothing_names_every_seam_it_is_missing(machine: Machine) -> None:
    """The window built the way the entry point used to build one says so, seam by seam.

    Two things at once: the seams are pinned by name, so the test above cannot pass
    because :attr:`~innytypes.helper.window.ApplicationWindow.unfilled` quietly went blank;
    and this *is* what the application shipped as — a window that draws two switches and
    Quit, because nothing else was ever passed to it.
    """
    settings = machine.settings()
    window = ApplicationWindow(
        desktop=HeadlessDesktop(),
        settings=settings,
        launch_at_login=LaunchAtLogin(settings=settings, login_item=RecordingLoginItem()),
        quit=QuitRecorder(),
    )

    assert window.unfilled == frozenset(
        {
            "statuses",
            "plugins",
            "page",
            "core_update",
            "plugin_updates",
            "apply_update",
            "telemetry",
            "usage",
            "endpoint",
            "move",
            "degradations",
        }
    )
    assert window.open().elements == frozenset(
        {Element.TELEMETRY, Element.LAUNCH_AT_LOGIN, Element.QUIT}
    )


# --- the plugin page ---------------------------------------------------------------------------


def test_an_installed_plugin_reaches_the_drawn_page(machine: Machine) -> None:
    """Opening the window draws the page, and the page lists what is installed (D12).

    One installed plugin, running, with monty's own folder field: the word for what it is
    doing, where it came from, and a widget for its settings form all reach the desktop —
    through the one view :class:`~innytypes.helper.window.PluginView`, which is the only thing
    the page is handed.
    """
    machine.install("monty", settings=MONTY_SETTINGS)
    wiring = wire(machine, channel=FakeChannel(running=["monty"]))

    wiring.window.open()

    view = wiring.desktop.last_plugins
    assert view is not None
    entry = view.plugin("monty")
    assert entry is not None
    assert entry.version == "1.0.0"
    assert entry.source is PluginSource.INDEX
    assert entry.run_state is PluginRunState.RUNNING
    drawn = wiring.desktop.drawn("monty", "root")
    assert drawn is not None
    assert drawn.widget is WidgetKind.PATH


@pytest.mark.parametrize("condition", ["healthy", "held", "quarantined"])
def test_the_assembled_window_always_opens_on_the_application_tab(
    machine: Machine, condition: str
) -> None:
    """D8 through build_window, including both states that most need attention."""
    machine.install("monty")
    if condition == "held":
        machine.settings().set_enabled("monty", False)
    elif condition == "quarantined":
        machine.quarantine(monty="it crashed repeatedly")
    wiring = wire(machine)

    wiring.window.open()

    assert wiring.desktop.tabbed.ids == (APPLICATION_TAB, "monty")
    assert wiring.desktop.tabbed.selected_id == APPLICATION_TAB
    assert wiring.window.unfilled == frozenset()


def test_the_assembled_window_carries_the_shipped_application_groups(machine: Machine) -> None:
    """The composition root, not a unit-only constructor, supplies the five-group model."""
    machine.install("monty")
    wiring = wire(machine)

    wiring.window.open()

    application = wiring.desktop.tabbed.application
    assert isinstance(application, ApplicationTab)
    assert application.helper.publish().addon_id == "innytypes"
    assert [plugin.plugin_id for plugin in application.installed] == ["monty"]
    assert application.plugin_lists is not None


def test_the_assembled_anytype_group_keeps_a_stopped_mcp_reason(machine: Machine) -> None:
    record = machine.record(MCP_CHILD_ID, kind=ChildKind.MCP, pid=42)
    machine.quarantine(**{MCP_CHILD_ID: "the MCP server crashed repeatedly"})
    wiring = wire(
        machine,
        alive={
            42: ProcessFacts(
                pid=42,
                started_at=record.started_at,
                executable=record.executable,
            )
        },
    )

    wiring.window.open()

    application = wiring.desktop.tabbed.application
    assert isinstance(application, ApplicationTab)
    assert not application.anytype.mcp_running
    assert application.anytype.mcp_reason == "the MCP server crashed repeatedly"


def test_the_assembled_anytype_group_explains_a_missing_api_key(machine: Machine) -> None:
    wiring = wire(machine)

    wiring.window.open()

    application = wiring.desktop.tabbed.application
    assert isinstance(application, ApplicationTab)
    assert not application.anytype.api_key_set
    assert application.anytype.mcp_reason == (
        "Not started because no Anytype API key is configured."
    )


def test_the_assembled_anytype_group_says_what_the_host_reported_rather_than_guessing(
    machine: Machine,
) -> None:
    """Acceptance 2, the window half (plan 0009, slice 04).

    Every other reason in this group is the window looking at the machine from outside — no
    record, a run state, an address that will not answer — and on the day this was written
    none of them could say the one thing that mattered. Anytype had shipped chats, widgets,
    queries and schema endpoints, the supervisor terminated the child over a tool surface
    that no longer matched, and the window said "No MCP process was reported by the host".

    The sentence below is the supervisor's own, and `tests/test_mcp_host_integration.py`
    proves that the real validation produces it and that it crosses the control channel
    unedited. What is proved here is the last hop: the window prefers it to its own guess,
    and carries it to the endpoint line too, because a silent address whose child is gone has
    already been explained above it.
    """
    said = (
        "the Anytype MCP child could not initialize: live Anytype MCP tools differ from the "
        "committed surface: added=['search_objects'], removed=[], changed=[]"
    )
    wiring = wire(
        machine, degradations=lambda component: said if component == MCP_CHILD_ID else None
    )

    wiring.window.open()

    application = wiring.desktop.tabbed.application
    assert isinstance(application, ApplicationTab)
    assert not application.anytype.mcp_running
    assert application.anytype.mcp_reason == said
    assert application.anytype.mcp_endpoint_reason == said


def test_a_kind_the_host_refused_is_drawn_on_that_plugins_tab(machine: Machine) -> None:
    """Plan 0012 slice 03: the window half of "a refusal reaches the person".

    Clicking the notification about a refused kind opens that plugin's tab
    (:meth:`~innytypes.helper.window.ApplicationWindow.open_notice`), so that tab is where the
    host's sentence has to be. It comes through the same seam the Anytype section reads, and
    through the page's one view — so a redraw after Save keeps it too.
    """
    said = "monty sent monty.mounted.v1, which its recorded manifest does not declare."
    machine.install("monty")
    wiring = wire(machine, degradations=lambda component: said if component == "monty" else None)

    wiring.window.open_notice(
        Message(title="", body="", notice=Notice(kind=NoticeKind.EVENT_REFUSED, subject="monty"))
    )

    assert wiring.desktop.tabbed.selected_id == "monty"
    view = wiring.desktop.last_plugins
    assert view is not None
    entry = view.plugin("monty")
    assert entry is not None
    assert entry.detail is not None and entry.detail.startswith(said)
    # And the tab the notification opened draws that same sentence.
    tab = wiring.desktop.tabbed.selected
    assert isinstance(tab.contents, PluginTab)
    assert tab.contents.detail == entry.detail


def test_reopening_forgets_the_plugin_that_was_last_open(machine: Machine) -> None:
    machine.install("monty")
    wiring = wire(machine)
    wiring.window.open()
    wiring.desktop.select_tab("monty")

    wiring.window.reopen()

    assert wiring.desktop.tabbed.selected_id == APPLICATION_TAB


def test_notification_click_selects_its_plugin_or_the_application(machine: Machine) -> None:
    machine.install("monty")
    wiring = wire(machine)
    notifier = RecordingNotifier(on_click=wiring.window.open_notice)

    notifier.post(
        compose(
            Notice(
                NoticeKind.PROCESS_QUARANTINED,
                subject="monty",
                detail="it crashed repeatedly",
            )
        )
    )
    notifier.click()
    assert wiring.desktop.tabbed.selected_id == "monty"

    notifier.post(compose(Notice(NoticeKind.UPDATE_STAGED, subject="innytypes", version="2.0")))
    notifier.click()
    assert wiring.desktop.tabbed.selected_id == APPLICATION_TAB


def test_install_adds_a_tab_without_moving_selection(machine: Machine) -> None:
    machine.install("monty")
    wiring = wire(machine)
    wiring.window.open()
    wiring.desktop.select_tab("monty")

    machine.install("whodunnit")
    wiring.built.page.open()

    assert wiring.desktop.tabbed.ids == (APPLICATION_TAB, "monty", "whodunnit")
    assert wiring.desktop.tabbed.selected_id == "monty"
    application = wiring.desktop.tabbed.application
    assert isinstance(application, ApplicationTab)
    assert [plugin.plugin_id for plugin in application.installed] == ["monty", "whodunnit"]


def test_removing_selected_and_unselected_plugins_obeys_the_selection_rule(
    machine: Machine,
) -> None:
    machine.install("monty")
    machine.install("whodunnit")
    wiring = wire(machine)
    wiring.window.open()
    wiring.desktop.select_tab("monty")

    wiring.built.page.remove("whodunnit")
    assert wiring.desktop.tabbed.ids == (APPLICATION_TAB, "monty")
    assert wiring.desktop.tabbed.selected_id == "monty"
    application = wiring.desktop.tabbed.application
    assert isinstance(application, ApplicationTab)
    assert [plugin.plugin_id for plugin in application.installed] == ["monty"]

    wiring.built.page.remove("monty")
    assert wiring.desktop.tabbed.ids == (APPLICATION_TAB,)
    assert wiring.desktop.tabbed.selected_id == APPLICATION_TAB
    application = wiring.desktop.tabbed.application
    assert isinstance(application, ApplicationTab)
    assert application.installed == ()


def test_the_window_lists_every_installed_plugin_with_its_availability_word(
    machine: Machine,
) -> None:
    """The contents carry the same word `helper status` prints, from the same function."""
    machine.install("monty", settings=MONTY_SETTINGS)
    machine.install("whodunnit")
    machine.quarantine(whodunnit="it crashed five times in ten minutes")
    wiring = wire(machine)

    contents = wiring.window.open()

    monty = contents.plugin("monty")
    whodunnit = contents.plugin("whodunnit")
    assert monty is not None and monty.availability is PluginAvailability.ENABLED
    assert whodunnit is not None
    assert whodunnit.availability is PluginAvailability.QUARANTINED
    assert whodunnit.detail == "it crashed five times in ten minutes"


def test_a_saved_setting_reaches_the_store_and_restarts_that_plugin(machine: Machine) -> None:
    """Typing a folder into the form records it and brings the plugin back on it (D10).

    Both halves, with the channel injected: the value is on disk in the plugin's own settings
    file, and one ``restart`` command for that plugin went to the host. The restart is the
    settings watch's decision and the existing restart path — which is why the command is a
    plain ``restart`` rather than a stop and a start.
    """
    machine.install("monty", settings=MONTY_SETTINGS)
    folder = machine.root / "watched"
    folder.mkdir()
    channel = FakeChannel(running=["monty"])
    wiring = wire(machine, channel=channel)

    wiring.window.open()
    outcome = wiring.built.page.configure("monty", {"root": str(folder)})

    assert outcome.accepted
    assert machine.store("monty").read().values["root"] == str(folder)
    restarted = [
        command.child_id for command in channel.commands if command.name is CommandName.RESTART
    ]
    assert restarted == ["monty"]


def test_a_second_save_of_the_same_value_restarts_nothing(machine: Machine) -> None:
    """A restart is a visible interruption, so it takes a value that actually moved.

    The other half of the rule above: the watch remembers what the plugin is running on, so
    the helper's own tick cannot restart it a second time for a change it has already acted
    on, and a save that records the same value again is not a change at all.
    """
    machine.install("monty", settings=MONTY_SETTINGS)
    folder = machine.root / "watched"
    folder.mkdir()
    channel = FakeChannel(running=["monty"])
    wiring = wire(machine, channel=channel)
    wiring.window.open()
    wiring.built.page.configure("monty", {"root": str(folder)})

    wiring.built.page.configure("monty", {"root": str(folder)})

    assert channel.names.count(CommandName.RESTART) == 1


def test_a_plugin_that_is_not_running_is_not_restarted_by_a_save(machine: Machine) -> None:
    """A stopped plugin reads its settings when it starts, so nothing is restarted for it."""
    machine.install("monty", settings=MONTY_SETTINGS)
    folder = machine.root / "watched"
    folder.mkdir()
    channel = FakeChannel(running=[])
    wiring = wire(machine, channel=channel)
    wiring.window.open()

    wiring.built.page.configure("monty", {"root": str(folder)})

    assert CommandName.RESTART not in channel.names
    assert machine.store("monty").read().values["root"] == str(folder)


# --- the process list, the updates and the usage report ----------------------------------------


def test_the_process_list_comes_from_the_run_state_file_and_the_quarantines(
    machine: Machine,
) -> None:
    """What the window lists is what the helper's own two files say, checked against the OS."""
    host = machine.record("innytypes", kind=ChildKind.HOST, pid=4242)
    machine.quarantine(whodunnit="it crashed five times in ten minutes")
    wiring = wire(
        machine,
        alive={
            4242: ProcessFacts(pid=4242, started_at=host.started_at, executable=host.executable)
        },
    )

    contents = wiring.window.open()

    host_row = contents.process("innytypes")
    quarantined = contents.process("whodunnit")
    assert host_row is not None and host_row.state is RunState.RUNNING
    assert quarantined is not None and quarantined.state is RunState.QUARANTINED
    assert Element.PROCESSES in contents.elements


def test_a_release_waiting_in_staging_is_offered_and_applied_at_the_next_quit(
    machine: Machine,
) -> None:
    """A core release that may not install itself gets an Apply, and Apply says yes (D11).

    Pressing it installs nothing — the files it would replace are the ones every other process
    is running out of — so what it records is the request the quit reads.
    """
    machine.stage_release("1.4.0", automatic=False)
    wiring = wire(machine)

    contents = wiring.window.open()
    row = contents.update(CORE_SUBJECT)

    assert row is not None
    assert row.kind is UpdateKind.CORE
    assert row.version == "1.4.0"
    assert row.apply is not None
    assert row.apply.label == f"{APPLY_LABEL} 1.4.0"
    assert not wiring.built.requested.wanted

    wiring.window.apply_update(row)

    assert wiring.built.requested.version == "1.4.0"


def test_a_plugin_update_the_last_check_found_is_shown(machine: Machine) -> None:
    """The window draws the lines of the last version check, and never makes one itself."""
    machine.install("monty", settings=MONTY_SETTINGS)
    checks = LatestVersionCheck()
    wiring = wire(machine, checks=checks)

    assert wiring.window.open().update("monty") is None

    checks.record(a_check(an_available_update("monty", target="2.0.0")))
    row = wiring.window.open().update("monty")

    assert row is not None
    assert row.kind is UpdateKind.PLUGIN
    assert row.version == "2.0.0"


def test_a_usage_report_carries_this_machines_plugins_when_the_switch_is_on(
    machine: Machine,
) -> None:
    """Opening the window reports usage through the pipeline, and the snapshot is real.

    Both seams at once: the telemetry pipeline is the one the application built, and the
    usage snapshot is read off this machine rather than invented — the plugin in the report
    is the one installed under ``tmp_path``.
    """
    machine.install("monty", settings=MONTY_SETTINGS)
    wiring = wire(machine, telemetry=True, endpoints=SOMEWHERE)

    wiring.window.open()

    queued = sorted(machine.queue_root.glob("*.json"))
    assert len(queued) == 1
    report = json.loads(queued[0].read_text(encoding="utf-8"))
    assert report["innytypes_version"] == __version__
    assert [plugin["id"] for plugin in report["plugins"]] == ["monty"]


def test_nothing_is_reported_while_the_telemetry_question_is_unanswered(
    machine: Machine,
) -> None:
    """The gate the wiring must not go around: an unanswered switch queues nothing (F2)."""
    machine.install("monty")
    wiring = wire(machine, endpoints=SOMEWHERE)

    wiring.window.open()

    assert not machine.queue_root.exists() or not list(machine.queue_root.glob("*.json"))


# --- every source refusing, and a window that still opens and still quits -----------------------


def _still_a_window(wiring: Wiring) -> None:
    """The whole of what F1 asks of a degraded window: it draws, and Quit is in it."""
    contents = wiring.window.open()

    assert not hasattr(contents, "quit")
    assert Element.QUIT in contents.elements
    assert wiring.window.quit().reason is QuitReason.MENU
    assert wiring.quits.reasons == [QuitReason.MENU]


def test_a_machine_with_no_plugins_still_draws_and_still_quits(machine: Machine) -> None:
    """Nothing installed is not a failure: it is a page with nothing on it."""
    wiring = wire(machine)

    _still_a_window(wiring)

    assert wiring.desktop.last_plugins is not None
    assert wiring.desktop.last_plugins.ids == ()


def test_an_unreadable_quarantine_file_still_draws_and_still_quits(machine: Machine) -> None:
    """A quarantine file nothing can read means no quarantines are known, not no window."""
    machine.quarantine_path.parent.mkdir(parents=True, exist_ok=True)
    machine.quarantine_path.write_text("{ not json at all", encoding="utf-8")
    machine.install("monty")
    wiring = wire(machine)

    _still_a_window(wiring)

    assert wiring.desktop.last is not None
    assert wiring.desktop.last.plugin("monty") is not None


def test_a_version_check_that_never_answered_still_draws_and_still_quits(
    machine: Machine,
) -> None:
    """No check recorded is "nobody has asked yet", and asks for no update to be drawn."""
    machine.install("monty")
    wiring = wire(machine, checks=LatestVersionCheck())

    _still_a_window(wiring)

    assert wiring.desktop.last is not None
    assert wiring.desktop.last.updates == ()


def test_a_control_channel_with_no_host_still_draws_and_still_quits(machine: Machine) -> None:
    """The first seconds of every launch: the helper listens and no host has connected yet."""
    machine.install("monty", settings=MONTY_SETTINGS)
    wiring = wire(machine, channel=SilentChannel())

    _still_a_window(wiring)

    view = wiring.desktop.last_plugins
    assert view is not None
    entry = view.plugin("monty")
    assert entry is not None
    assert entry.run_state is PluginRunState.STOPPED


def test_a_plugin_page_that_refuses_still_draws_the_window_and_still_quits(
    machine: Machine,
) -> None:
    """Whatever the page cannot do, the window opens and Quit works (F1)."""
    settings = machine.settings()
    desktop = HeadlessDesktop()
    quits = QuitRecorder()
    window = ApplicationWindow(
        desktop=desktop,
        settings=settings,
        launch_at_login=LaunchAtLogin(settings=settings, login_item=RecordingLoginItem()),
        quit=quits,
        page=RefusingPage(),
    )

    contents = window.open()

    assert not hasattr(contents, "quit")
    assert desktop.last is contents
    assert desktop.last_plugins is None
    assert window.quit().reason is QuitReason.MENU


# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_the_assembled_application_moves_the_endpoint_over_its_own_control_channel(
    machine: Machine,
) -> None:
    """The panel's Save reaches the host through the channel the application really built.

    `unfilled` proves the seam is not ``None``; this proves what is behind it. The window
    here is the one :func:`~innytypes.helper.launcher.build_window` assembles, the channel
    is the only thing replaced, and the address travels from the panel to a set-endpoint
    command and back into this machine's own `config.toml`.
    """
    channel = FakeChannel(endpoint="http://127.0.0.1:31011/mcp", endpoint_moved=True)
    wiring = wire(machine, channel=channel)
    wiring.window.open()

    editor = wiring.desktop.tabbed.application.anytype.endpoint
    assert editor is not None, "the assembled application drew no editable endpoint"
    change = editor.save({"mcp_host": "127.0.0.1", "mcp_port": 31011})

    assert change is not None and change.outcome is EndpointOutcome.MOVED
    assert [
        command.endpoint for command in channel.commands if command.name is CommandName.SET_ENDPOINT
    ] == [("127.0.0.1", 31011)]
    assert editor.served_url == "http://127.0.0.1:31011/mcp"
    assert editor.clients_warning == CLIENTS_MUST_BE_UPDATED
    # And the machine's own settings file now holds it, so the next start binds it too.
    assert HelperSettings(machine.config_path).mcp == McpEndpoint(host="127.0.0.1", port=31011)
