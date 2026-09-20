"""Plan 0006 slice 02: the five groups on InnyTypes' own tab."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import fields, is_dataclass
from pathlib import Path

from innytypes.addons.manifest import check_settings_value
from innytypes.helper.breaker import ProcessStatus, RunState
from innytypes.helper.config import HELPER_SETTINGS_FIELDS, HelperSettings
from innytypes.helper.supervision import Pass, run_supervision
from innytypes.helper.window import (
    APPLICATION_GROUPS,
    AnytypeGroup,
    ApplicationTab,
    Control,
    InstalledPlugin,
    PluginRunState,
    ProcessRow,
    Tab,
    UpdateKind,
    UpdateRow,
)

SPEC = 'docs/loop/inbox/WI-0006-02-the-applications-tab.yaml § "acceptance"'


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
