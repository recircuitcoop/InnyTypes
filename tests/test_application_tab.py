"""Plan 0006 slice 02: the five groups on InnyTypes' own tab."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path

import pytest

from innytypes.addons.manifest import check_settings_value
from innytypes.anytype_mcp.endpoint import DEFAULT_HOST, DEFAULT_PORT
from innytypes.anytype_mcp.gateway import MCP_HOST_VARIABLE, MCP_PORT_VARIABLE
from innytypes.children import MCP_CHILD_ID, Command, CommandName, CommandResult
from innytypes.helper.breaker import ProcessStatus, RunState
from innytypes.helper.config import (
    HELPER_SETTINGS_FIELDS,
    MCP_SETTINGS_FIELDS,
    HelperSettings,
    McpEndpoint,
)
from innytypes.helper.control import CommandRefusedError
from innytypes.helper.launcher import (
    EndpointOutcome,
    EndpointReport,
    LaunchAtLogin,
    move_endpoint,
    observe_endpoint,
)
from innytypes.helper.supervision import Pass, run_supervision
from innytypes.helper.window import (
    APPLICATION_GROUPS,
    CLIENTS_MUST_BE_UPDATED,
    ENDPOINT_FIELD_IDS,
    FIELD_WIDGETS,
    AnytypeGroup,
    ApplicationTab,
    ApplicationWindow,
    Control,
    EndpointEditor,
    HeadlessDesktop,
    InstalledPlugin,
    PluginEntry,
    PluginRunState,
    ProcessRow,
    Tab,
    UpdateKind,
    UpdateRow,
    WidgetKind,
    draw_fields,
    ignored_variable_notice,
)
from test_anytype_mcp_keys import leak_sources
from test_window_wiring import QuitRecorder, RecordingLoginItem

SPEC = 'docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"'
PANEL_SPEC = 'docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"'


def strings_in(value: object, *, seen: set[int] | None = None) -> Iterable[str]:
    """Yield every string nested in a built model value without following cycles."""
    seen = set() if seen is None else seen
    if id(value) in seen:
        return
    seen.add(id(value))
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for key, item in value.items():
            yield from strings_in(key, seen=seen)
            yield from strings_in(item, seen=seen)
    elif isinstance(value, Sequence | set | frozenset):
        for item in value:
            yield from strings_in(item, seen=seen)
    elif is_dataclass(value) and not isinstance(value, type):
        for item in fields(value):
            yield from strings_in(getattr(value, item.name), seen=seen)


# Validates: docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"
def test_application_groups_have_the_fixed_order() -> None:
    tab = ApplicationTab()

    assert (
        tab.groups
        == APPLICATION_GROUPS
        == (
            "Running now",
            "Anytype",
            "The helper",
            "This application",
            "Plugins",
        )
    )

    # The real tab value carries this grouped model; it is not a parallel value that only
    # tests can construct.
    built = Tab.for_application(tab)
    assert built.application is tab
    assert built.application.groups == APPLICATION_GROUPS


# Validates: docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"
def test_running_group_keeps_every_managed_process_and_state() -> None:
    statuses = tuple(
        ProcessStatus(child_id=name, state=state, interventions=0)
        for name, state in (
            ("helper", RunState.RUNNING),
            ("host", RunState.RUNNING),
            ("anytype-mcp", RunState.RESTARTING),
            ("anytype", RunState.RUNNING),
            ("monty", RunState.QUARANTINED),
        )
    )

    tab = ApplicationTab(processes=tuple(ProcessRow.of(status) for status in statuses))

    assert [(row.child_id, row.state) for row in tab.running] == [
        (status.child_id, status.state) for status in statuses
    ]


# Validates: docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"
def test_anytype_group_reports_key_presence_without_carrying_the_key() -> None:
    secret = "never-publish-this-key"
    group = AnytypeGroup.from_state(
        mcp_running=False,
        mcp_reason="Anytype is not running",
        api_key=secret,
    )

    assert group.api_key_set is True
    assert group.mcp_reason == "Anytype is not running"
    assert group.package_version
    assert group.anytype_version
    assert secret not in tuple(strings_in(group))

    unset = AnytypeGroup.from_state(mcp_running=False, mcp_reason="No API key", api_key=None)
    assert unset.api_key_set is False


# Validates: docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"
def test_helper_form_publishes_all_supervision_numbers(tmp_path: Path) -> None:
    tab = ApplicationTab.for_settings(HelperSettings(tmp_path / "config.toml"))

    assert {field.id for field in tab.helper.publish().fields} == {
        "tick",
        "stop_timeout",
        "restart_attempts",
        "restart_backoff",
        "breaker_window",
        "breaker_interventions",
        "max_rss_mb",
        "max_cpu_percent",
        "cpu_window",
        "max_open_files",
        "max_children",
        "breach_grace",
    }


# Validates: docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"
def test_helper_form_refuses_a_bad_number_without_touching_config(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text("[helper]\ntick = 3\n", encoding="utf-8")
    before = path.read_bytes()
    form = ApplicationTab.for_settings(HelperSettings(path)).helper

    outcome = form.save({"tick": 0})

    assert not outcome.accepted
    assert outcome.refused[0].field == "tick"
    assert form.publish().field("tick").error == outcome.refused[0].reason
    assert path.read_bytes() == before


@pytest.mark.parametrize(
    ("field_id", "value"),
    [
        ("stop_timeout", 0),
        ("breaker_window", 0),
        ("restart_attempts", 1.5),
        ("max_children", 2.5),
    ],
)
def test_helper_form_refuses_values_the_concrete_config_cannot_read(
    tmp_path: Path, field_id: str, value: object
) -> None:
    path = tmp_path / "config.toml"
    path.write_text("[helper]\ntick = 3\n", encoding="utf-8")
    before = path.read_bytes()
    form = ApplicationTab.for_settings(HelperSettings(path)).helper

    outcome = form.save({field_id: value})

    assert not outcome.accepted
    assert outcome.refused[0].field == field_id
    assert form.publish().field(field_id).error == outcome.refused[0].reason
    assert path.read_bytes() == before


# Validates: docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"
def test_helper_form_saves_through_live_helper_settings(tmp_path: Path) -> None:
    settings = HelperSettings(tmp_path / "config.toml")
    form = ApplicationTab.for_settings(settings).helper

    outcome = form.save({"tick": 0.25})

    assert outcome.accepted
    assert "tick = 0.25" in (tmp_path / "config.toml").read_text(encoding="utf-8")
    assert settings.current.helper.tick == 0.25
    assert form.publish().field("tick").value == 0.25

    # The supervision loop asks the live settings object for its interval after the save. No
    # process is restarted and no cached value is invalidated.
    sleeps: list[float] = []

    class OnePass:
        def pass_once(self) -> Pass:
            return Pass()

    assert (
        run_supervision(
            OnePass(),
            interval=lambda: settings.current.helper.tick,
            sleep=sleeps.append,
            stop=lambda: bool(sleeps),
        )
        == 1
    )
    assert sleeps == [0.25]


# Validates: docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"
def test_helper_declaration_uses_the_plugin_validator() -> None:
    tick = next(field for field in HELPER_SETTINGS_FIELDS if field.id == "tick")

    assert check_settings_value(tick, 0.5, where=tick.id) == 0.5


# Validates: docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"
def test_application_group_has_existing_controls_but_not_quit() -> None:
    update = UpdateRow(UpdateKind.CORE, "InnyTypes", "0.2.0", apply=Control("Apply 0.2.0"))
    tab = ApplicationTab(core_version="0.1.0", updates=(update,))

    assert tab.application.telemetry is not None
    assert tab.application.launch_at_login is not None
    assert tab.application.version == "0.1.0"
    assert tab.application.updates == (update,)
    assert not hasattr(tab.application, "quit")


# Validates: docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"
def test_installed_plugins_carry_remove_refusals_and_waiting_updates() -> None:
    waiting = UpdateRow(UpdateKind.PLUGIN, "fresh", "2.0", apply=Control("Apply 2.0"))
    tab = ApplicationTab(
        installed=(
            InstalledPlugin("plain", PluginRunState.STOPPED, remove=Control("Remove")),
            InstalledPlugin(
                "needed",
                PluginRunState.RUNNING,
                remove=Control("Remove", enabled=False),
                removal_refusal="required by plain",
            ),
            InstalledPlugin(
                "fresh",
                PluginRunState.RUNNING,
                remove=Control("Remove"),
                update=waiting,
            ),
        )
    )

    assert tab.installed[0].remove.enabled
    assert not tab.installed[1].remove.enabled
    assert tab.installed[1].removal_refusal == "required by plain"
    assert tab.installed[2].update is waiting


# --- the endpoint a person can change (plan 0008, slice 04) --------------------------------

# Credentials that exist only in this file. The word "fake" is on the line for
# tests/test_no_secrets.py, which scans every tracked file.
FAKE_ANYTYPE_KEY = "fake-anytype-key-for-the-panel-0001"  # fake
FAKE_PROXY_TOKEN = "fake-mcp-proxy-bearer-token-0002"  # fake

# A port nothing on the gate's machine is told to use, so nothing here can collide with a
# real InnyTypes. The wiring tests use the same one for the same reason.
SILENT_PORT = 1
SILENT_URL = f"http://127.0.0.1:{SILENT_PORT}/mcp"


@dataclass
class AnsweringHost:
    """The control channel with a host on the other end of it, answering as a test says.

    Not a stand-in for :func:`~innytypes.helper.launcher.move_endpoint`: that function is the
    real one in every test here, so what the panel is exercised against is the real ask, the
    real three-state answer and the real write to `config.toml`.
    """

    endpoint: str = ""
    moved: bool = True
    refusal: str | None = None
    asked: list[Command] = field(default_factory=list)

    def send(self, command: Command) -> CommandResult:
        self.asked.append(command)
        if self.refusal is not None:
            raise CommandRefusedError(self.refusal)
        return CommandResult(name=command.name, endpoint=self.endpoint, endpoint_moved=self.moved)

    @property
    def endpoints_asked_for(self) -> list[tuple[str, int] | None]:
        """The address in every set-endpoint command, in order."""
        return [
            command.endpoint for command in self.asked if command.name is CommandName.SET_ENDPOINT
        ]


def an_editor(settings: HelperSettings, host: AnsweringHost) -> EndpointEditor:
    """The panel's endpoint editor, wired the way :func:`build_window` wires it."""
    return EndpointEditor(
        settings, lambda address, port: move_endpoint(host, address, port, settings=settings)
    )


def a_window(
    tmp_path: Path,
    *,
    settings: HelperSettings | None = None,
    host: AnsweringHost | None = None,
    endpoint: EndpointReport | None = None,
    api_key: str | None = None,
    mcp_running: bool = False,
) -> tuple[ApplicationWindow, HeadlessDesktop, HelperSettings]:
    """An ApplicationWindow with the endpoint seams filled and nothing else touched."""
    live = HelperSettings(tmp_path / "config.toml") if settings is None else settings
    speaking_to = AnsweringHost() if host is None else host
    desktop = HeadlessDesktop()
    report = EndpointReport(url=SILENT_URL, available=False) if endpoint is None else endpoint
    statuses = (
        (lambda: (ProcessStatus(child_id=MCP_CHILD_ID, state=RunState.RUNNING, interventions=0),))
        if mcp_running
        else (lambda: ())
    )
    window = ApplicationWindow(
        desktop=desktop,
        settings=live,
        launch_at_login=LaunchAtLogin(settings=live, login_item=RecordingLoginItem()),
        quit=QuitRecorder(),
        statuses=statuses,
        endpoint=lambda: report,
        move=lambda address, port: move_endpoint(speaking_to, address, port, settings=live),
        application=ApplicationTab(
            anytype=AnytypeGroup.from_state(
                mcp_running=mcp_running, mcp_reason=None, api_key=api_key
            ),
            helper=ApplicationTab.for_settings(live).helper,
        ),
    )
    return window, desktop, live


# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_the_endpoint_is_offered_as_the_panels_own_text_and_number_fields(
    tmp_path: Path,
) -> None:
    """Acceptance 1: two editable fields, drawn by the machinery that draws every setting.

    The declaration is the one in `config.py`, the drawing is :func:`draw_fields`, and the
    two widgets are the vocabulary's own `text` and `number`. Nothing here is a widget kind
    of its own, which is what the bullet forbids.
    """
    settings = HelperSettings(tmp_path / "config.toml")
    editor = an_editor(settings, AnsweringHost())

    published = editor.publish()
    drawn = draw_fields(PluginEntry(plugin_id=editor.addon_id, form=published))

    assert [field.id for field in published.fields] == list(ENDPOINT_FIELD_IDS)
    assert [one.widget for one in drawn] == [WidgetKind.TEXT, WidgetKind.NUMBER]
    # Both drawn from the declaration rather than from anything this panel invented, and
    # both in the shared vocabulary rather than beside it.
    assert {one.widget for one in drawn} <= set(FIELD_WIDGETS.values())
    assert [one.type for one in drawn] == [field.type for field in MCP_SETTINGS_FIELDS]
    assert all(one.editable for one in drawn)
    # Filled with the address this installation would serve, so the starting point is never
    # one the listener would refuse.
    assert [one.value for one in drawn] == [DEFAULT_HOST, DEFAULT_PORT]


@pytest.mark.parametrize(
    ("field_id", "value", "phrase"),
    [
        ("mcp_host", "localhost", "numeric loopback"),
        ("mcp_host", "0.0.0.0", "wildcard and network binds are refused"),  # noqa: S104
        ("mcp_host", "::", "wildcard and network binds are refused"),
        ("mcp_host", "192.168.1.10", "wildcard and network binds are refused"),
        ("mcp_host", "8.8.8.8", "wildcard and network binds are refused"),
        ("mcp_port", 0, "below the declared min 1"),
        ("mcp_port", 70000, "above the declared max 65535"),
        ("mcp_port", 31010.5, "whole number"),
    ],
)
# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_an_unserveable_address_is_refused_in_the_panel_and_reaches_nothing(
    tmp_path: Path, field_id: str, value: object, phrase: str
) -> None:
    """Acceptance 2: refused here, with the reason, and nothing sent and nothing stored.

    Three things at once, because the bullet is three things: the reason is shown, beside
    the field it is about; the stored setting is exactly as it was; and the host was never
    asked, so no listener anywhere was disturbed by a value the panel already knew was bad.
    """
    path = tmp_path / "config.toml"
    settings = HelperSettings(path)
    host = AnsweringHost(endpoint="http://127.0.0.1:31011/mcp")
    editor = an_editor(settings, host)
    submitted = {"mcp_host": DEFAULT_HOST, "mcp_port": DEFAULT_PORT, field_id: value}

    change = editor.save(submitted)

    published = editor.publish()
    assert change is None, "the panel asked the host about an address it should have refused"
    assert phrase in (published.field(field_id).error or "")
    # The reason is beside the field it is about and nowhere else: a bad address must not
    # put its sentence under a perfectly good port.
    other = next(one for one in ENDPOINT_FIELD_IDS if one != field_id)
    assert published.field(other).error is None
    assert host.asked == [], "a refused address was sent to the host"
    assert settings.mcp == McpEndpoint()
    assert not path.exists(), "a refused address created a settings file"
    # And nothing about the save is claimed on the panel either.
    assert (editor.served_url, editor.saved_url, editor.clients_warning) == ("", "", None)


# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_a_saved_address_is_reported_as_the_host_answered_it(tmp_path: Path) -> None:
    """Acceptance 3: the address now being served is the host's answer, not the typed value.

    The host here answers with an address that is *not* the one asked for, which no real
    host does — and that is the point. A panel that rebuilt the URL from the two fields
    would pass this test's sibling and this one only by accident.
    """
    settings = HelperSettings(tmp_path / "config.toml")
    answered = "http://127.0.0.1:31099/mcp"
    host = AnsweringHost(endpoint=answered, moved=True)
    editor = an_editor(settings, host)

    change = editor.save({"mcp_host": "127.0.0.1", "mcp_port": 31011})

    assert change is not None and change.outcome is EndpointOutcome.MOVED
    assert host.endpoints_asked_for == [("127.0.0.1", 31011)]
    assert editor.served_url == answered
    assert "31011" not in editor.served_url
    # The address asked for is what was stored, because that is the address the host
    # confirmed it is serving.
    assert settings.mcp == McpEndpoint(host="127.0.0.1", port=31011)


# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_the_saved_address_is_shown_beside_the_served_one_when_they_differ(
    tmp_path: Path,
) -> None:
    """Acceptance 4: the host is serving it and the setting could not be recorded.

    The one way the two really come apart, and the case slice 03 wrote a reason for. The
    settings file cannot be written — its directory is a file — so the move succeeds, the
    record of it does not, and the panel has to name both addresses rather than pick one.
    """
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("this is a file, so nothing can be written inside it", encoding="utf-8")
    settings = HelperSettings(blocked / "config.toml")
    serving = "http://127.0.0.1:31011/mcp"
    editor = an_editor(settings, AnsweringHost(endpoint=serving, moved=True))

    change = editor.save({"mcp_host": "127.0.0.1", "mcp_port": 31011})

    assert change is not None and change.served
    assert editor.served_url == serving
    # The saved address is still the unconfigured default, and is shown because it is no
    # longer the address being served.
    assert editor.saved_url == f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/mcp"
    assert editor.saved_url != editor.served_url
    assert "could not be stored" in (editor.message or "")


# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_the_saved_address_is_not_repeated_when_it_is_the_served_one(tmp_path: Path) -> None:
    """The other arm of acceptance 4: one address, said once.

    Without this the test above passes against a panel that shows the saved address
    unconditionally, which would tell a person their endpoint had come apart every time
    they pressed Save.
    """
    settings = HelperSettings(tmp_path / "config.toml")
    serving = "http://127.0.0.1:31011/mcp"
    editor = an_editor(settings, AnsweringHost(endpoint=serving, moved=True))

    editor.save({"mcp_host": "127.0.0.1", "mcp_port": 31011})

    assert editor.served_url == serving
    assert editor.saved_url == ""
    assert editor.message is None


@pytest.mark.parametrize(
    ("moved", "expected"),
    [(True, CLIENTS_MUST_BE_UPDATED), (False, None)],
)
# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_only_an_address_that_moved_says_clients_must_be_updated(
    tmp_path: Path, moved: bool, expected: str | None
) -> None:
    """Acceptance 7: the warning is present when the address changed, and absent otherwise.

    Both arms, because the warning is only worth anything if it is not on every save. A
    person who presses Save without editing anything is told they already have that
    endpoint, not that every client they own has just stopped working.
    """
    settings = HelperSettings(tmp_path / "config.toml")
    editor = an_editor(settings, AnsweringHost(endpoint="http://127.0.0.1:31011/mcp", moved=moved))

    change = editor.save({"mcp_host": "127.0.0.1", "mcp_port": 31011})

    assert change is not None
    assert change.outcome is (EndpointOutcome.MOVED if moved else EndpointOutcome.UNCHANGED)
    assert editor.clients_warning == expected
    if expected is not None:
        assert "old address" in expected


# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_a_host_that_refuses_the_move_leaves_the_reason_on_the_fields(tmp_path: Path) -> None:
    """Acceptance 2, for the refusal the panel cannot make itself: the host's own words.

    A bind that fails is the case a person actually hits — the port they chose is taken too
    — and the reason has to reach them without the stored setting moving to an address the
    host would not serve.
    """
    settings = HelperSettings(tmp_path / "config.toml")
    settings.set_mcp_endpoint("127.0.0.1", 31010)
    host = AnsweringHost(refusal="the MCP port 31011 is already in use by another program")
    editor = an_editor(settings, host)

    change = editor.save({"mcp_host": "127.0.0.1", "mcp_port": 31011})

    assert change is not None and change.outcome is EndpointOutcome.REFUSED
    published = editor.publish()
    for field_id in ENDPOINT_FIELD_IDS:
        assert "already in use" in (published.field(field_id).error or "")
    assert settings.mcp == McpEndpoint(host="127.0.0.1", port=31010)
    assert editor.served_url == ""
    assert editor.clients_warning is None


# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_the_panel_names_the_variable_a_stored_value_is_beating(tmp_path: Path) -> None:
    """Acceptance 5: the whole chain, from the stored setting to the sentence.

    Not a fact injected at the group: the setting is stored, the variable is set, the real
    :func:`~innytypes.helper.launcher.observe_endpoint` reads both, and the window carries
    what it answered. The address it probes is port 1, which nothing is ever told to use.
    """
    settings = HelperSettings(tmp_path / "config.toml")
    settings.set_mcp_endpoint(DEFAULT_HOST, SILENT_PORT)
    env = {MCP_PORT_VARIABLE: "31555"}

    report = observe_endpoint(env, settings=settings, timeout=0.2)
    window, desktop, _ = a_window(tmp_path, settings=settings, endpoint=report)
    window.open()

    group = desktop.tabbed.application.anytype
    assert report.ignored_variables == (MCP_PORT_VARIABLE,)
    assert group.mcp_ignored_variables == (MCP_PORT_VARIABLE,)
    notice = ignored_variable_notice(group.mcp_ignored_variables)
    assert notice is not None
    assert MCP_PORT_VARIABLE in notice and "ignored" in notice
    # And the address on the panel is the stored one, not the variable's.
    assert group.mcp_url == SILENT_URL
    assert "31555" not in group.mcp_url


# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_nothing_is_said_about_a_variable_that_is_not_being_ignored(tmp_path: Path) -> None:
    """The other arm of acceptance 5: a machine with no stored value says nothing.

    Without this, the notice could be drawn unconditionally and the test above would still
    pass — and every unconfigured installation would be told a variable it never set is
    being ignored.
    """
    settings = HelperSettings(tmp_path / "config.toml")
    env = {MCP_PORT_VARIABLE: str(SILENT_PORT)}

    report = observe_endpoint(env, settings=settings, timeout=0.2)

    assert report.ignored_variables == ()
    assert ignored_variable_notice(report.ignored_variables) is None
    assert ignored_variable_notice((MCP_HOST_VARIABLE, MCP_PORT_VARIABLE)) is not None


@pytest.mark.parametrize(
    ("mcp_running", "api_key", "reason", "expected"),
    [
        (
            True,
            FAKE_ANYTYPE_KEY,
            f"Another program is answering at {SILENT_URL}, "
            "so InnyTypes could not open its MCP endpoint there.",
            f"Another program is answering at {SILENT_URL}, "
            "so InnyTypes could not open its MCP endpoint there.",
        ),
        (
            False,
            None,
            None,
            "Not started because no Anytype API key is configured.",
        ),
    ],
)
# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_the_panel_still_says_why_the_service_is_unavailable(
    tmp_path: Path,
    mcp_running: bool,
    api_key: str | None,
    reason: str | None,
    expected: str,
) -> None:
    """Acceptance 6: the port taken and the child never validated, with the fields beside it.

    The editable fields are an addition to this section, not a replacement for it: the
    reason a person needs in order to know they *should* change the port has to still be
    there while they change it.
    """
    window, desktop, _ = a_window(
        tmp_path,
        endpoint=EndpointReport(url=SILENT_URL, available=False, reason=reason),
        api_key=api_key,
        mcp_running=mcp_running,
    )

    window.open()

    group = desktop.tabbed.application.anytype
    assert group.mcp_endpoint_reason == expected
    assert group.mcp_available is False
    assert group.endpoint is not None, "the endpoint cannot be changed while it is degraded"


# Validates: docs/loop/inbox/WI-0008-04-the-panel.yaml § "acceptance"
def test_no_credential_reaches_any_state_the_panel_can_show(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Acceptance 6: neither the Anytype API key nor the proxy bearer token, anywhere.

    Both credentials are on disk beside the settings the panel reads, the panel is opened
    and an endpoint is saved through it, and then the whole drawn state is searched — every
    string nested anywhere in it — with the streams and the logs checked by the same
    :func:`leaks` idiom the key tests use.
    """
    caplog.set_level(0)
    settings = HelperSettings(tmp_path / "config.toml")
    # Where a careless reader would find them: the panel reads this directory for its
    # settings and must pick up neither file.
    (tmp_path / "anytype_api_key").write_text(FAKE_ANYTYPE_KEY, encoding="utf-8")
    (tmp_path / "mcp_proxy_token").write_text(FAKE_PROXY_TOKEN, encoding="utf-8")

    window, desktop, _ = a_window(
        tmp_path,
        settings=settings,
        host=AnsweringHost(endpoint="http://127.0.0.1:31011/mcp", moved=True),
        api_key=FAKE_ANYTYPE_KEY,
        mcp_running=True,
    )
    window.open()
    tab = desktop.tabbed.application
    assert tab.anytype.api_key_set is True
    assert tab.anytype.endpoint is not None
    tab.anytype.endpoint.save({"mcp_host": "127.0.0.1", "mcp_port": 31011})
    window.open()

    shown = tuple(strings_in(desktop.tabbed.application))
    drawn = tuple(
        strings_in(
            draw_fields(
                PluginEntry(
                    plugin_id=tab.anytype.endpoint.addon_id,
                    form=tab.anytype.endpoint.publish(),
                )
            )
        )
    )
    # Read once, not once per credential: `capsys.readouterr()` drains what it returns, so
    # a second call would answer "nothing was printed" whatever the first one found.
    captured = capsys.readouterr()
    # The search reaches the panel's own state rather than an empty tuple: the address the
    # host answered with is in there, and a credential would have been found the same way.
    assert "http://127.0.0.1:31011/mcp" in shown
    assert DEFAULT_HOST in drawn
    for secret in (FAKE_ANYTYPE_KEY, FAKE_PROXY_TOKEN):
        assert not [text for text in shown if secret in text]
        assert not [text for text in drawn if secret in text]
        assert leak_sources(secret, captured.out, captured.err, caplog.records) == []
