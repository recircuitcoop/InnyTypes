"""A plugin tab owns one plugin's controls and one reversible working copy."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from innytypes import HOST_API_VERSION
from innytypes.addons.manifest import parse_manifest
from innytypes.addons.settings import SettingsStore, WriteOutcome
from innytypes.addons.settings_form import SettingsForm
from innytypes.helper.window import (
    APPLY_LABEL,
    Control,
    PluginEntry,
    PluginRunState,
    PluginSource,
    PluginTab,
    PluginView,
    TabbedContents,
    UpdateKind,
    UpdateRow,
)

DECLARATION = (
    {"id": "name", "type": "text", "label": "Name", "default": "recorded"},
    {"id": "other", "type": "text", "label": "Other", "default": "kept"},
    {
        "id": "recorders",
        "type": "table",
        "label": "Recorders",
        "row_label": "recorder",
        "row": (
            {"id": "label", "type": "text", "label": "Label"},
            {"id": "folder", "type": "path", "label": "Folder", "kind": "folder"},
        ),
    },
)


def store(tmp_path: Path, plugin_id: str = "monty") -> SettingsStore:
    manifest = parse_manifest(
        {
            "id": plugin_id,
            "version": "1.2.3",
            "host_api": HOST_API_VERSION,
            "requires": [],
            "emits": [],
            "subscribes": [],
            "settings": DECLARATION,
        }
    )
    result = SettingsStore(plugin_id, manifest.settings, path=tmp_path / f"{plugin_id}.toml")
    result.write(
        {
            "name": "recorded",
            "other": "kept",
            "recorders": [
                {"label": "one", "folder": "/one"},
                {"label": "two", "folder": "/two"},
            ],
        },
        by="user",
    )
    return result


def entry(settings: SettingsStore, plugin_id: str = "monty") -> PluginEntry:
    return PluginEntry(
        plugin_id=plugin_id,
        version="1.2.3",
        source=PluginSource.GIT,
        source_detail="https://example.invalid/monty.git",
        enabled=True,
        run_state=PluginRunState.HELD,
        detail="one setting needs attention",
        pending_update=UpdateRow(
            kind=UpdateKind.PLUGIN,
            subject=plugin_id,
            version="2.0.0",
            apply=Control(label=f"{APPLY_LABEL} 2.0.0"),
        ),
        form=SettingsForm(settings).publish(),
    )


class Actions:
    def __init__(self, settings: SettingsStore) -> None:
        self.settings = settings
        self.calls: list[object] = []

    def reload(self) -> PluginEntry:
        return entry(self.settings, self.settings.addon_id)

    def configure(self, plugin_id: str, values: Mapping[str, object]) -> WriteOutcome:
        self.calls.append(("configure", plugin_id, dict(values)))
        return self.settings.write(values, by="user")

    def enabled(self, plugin_id: str, *, enabled: bool) -> object:
        call = ("enabled", plugin_id, enabled)
        self.calls.append(call)
        return call

    def remove(self, plugin_id: str) -> object:
        call = ("remove", plugin_id)
        self.calls.append(call)
        return call

    def update(self, plugin_id: str) -> object:
        call = ("update", plugin_id)
        self.calls.append(call)
        return call


def plugin_tab(tmp_path: Path) -> tuple[PluginTab, SettingsStore, Actions]:
    settings = store(tmp_path)
    actions = Actions(settings)
    tab = PluginTab(
        entry(settings),
        reload=actions.reload,
        configure=actions.configure,
        set_enabled=actions.enabled,
        remove=actions.remove,
        update=actions.update,
    )
    return tab, settings, actions


def test_a_fully_described_plugin_tab_carries_every_part(tmp_path: Path) -> None:
    tab, _, _ = plugin_tab(tmp_path)

    assert tab.plugin_id == "monty"
    assert tab.version == "1.2.3"
    assert tab.source is PluginSource.GIT
    assert tab.source_detail == "https://example.invalid/monty.git"
    assert tab.run_state is PluginRunState.HELD
    assert tab.detail == "one setting needs attention"
    assert tab.enabled is True
    assert [field.field_id for field in tab.fields] == ["name", "other", "recorders"]
    assert tab.save_control.label == "Save"
    assert tab.cancel_control.label == "Cancel"
    assert tab.remove_control.label == "Remove"
    assert tab.pending_update.version == "2.0.0"


def test_colliding_field_ids_stay_inside_their_own_tabs(tmp_path: Path) -> None:
    entries = []
    for plugin_id, value in (("a", "alpha"), ("b", "bravo"), ("c", "charlie")):
        settings = store(tmp_path, plugin_id)
        settings.write({"name": value}, by="user")
        entries.append(entry(settings, plugin_id))

    tabs = TabbedContents(installed=PluginView(tuple(entries))).tabs[1:]

    assert [tab.plugin.value("name") for tab in tabs] == ["alpha", "bravo", "charlie"]


def test_cancel_discards_scalar_typing_without_writing(tmp_path: Path) -> None:
    tab, settings, actions = plugin_tab(tmp_path)
    before = settings.path.read_bytes()
    tab.set_value("name", "mistake")
    tab.set_value("other", "also a mistake")

    tab.cancel()

    assert tab.value("name") == "recorded"
    assert tab.value("other") == "kept"
    assert settings.path.read_bytes() == before
    assert actions.calls == []


def test_cancel_undoes_an_added_row(tmp_path: Path) -> None:
    tab, _, _ = plugin_tab(tmp_path)
    tab.table("recorders").add_row()
    tab.cancel()
    assert [row.values["label"] for row in tab.table("recorders").rows] == ["one", "two"]


def test_cancel_undoes_a_removed_row(tmp_path: Path) -> None:
    tab, _, _ = plugin_tab(tmp_path)
    table = tab.table("recorders")
    assert table.remove_row(1) is False
    table.confirm_removal(1)
    tab.cancel()
    assert [row.values["label"] for row in tab.table("recorders").rows] == ["one", "two"]


def test_cancel_undoes_reordering(tmp_path: Path) -> None:
    tab, _, _ = plugin_tab(tmp_path)
    tab.table("recorders").move_down(1)
    tab.cancel()
    assert [row.values["label"] for row in tab.table("recorders").rows] == ["one", "two"]


def test_cancel_is_local_to_one_tab(tmp_path: Path) -> None:
    a_store = store(tmp_path, "a")
    b_store = store(tmp_path, "b")
    a = PluginTab(entry(a_store, "a"), reload=lambda: entry(a_store, "a"))
    b = PluginTab(entry(b_store, "b"), reload=lambda: entry(b_store, "b"))
    a.set_value("name", "typing in A")
    b.set_value("name", "typing in B")

    b.cancel()

    assert a.value("name") == "typing in A"
    assert b.value("name") == "recorded"


def test_save_routes_the_whole_working_copy_and_refusal_writes_nothing(tmp_path: Path) -> None:
    tab, settings, actions = plugin_tab(tmp_path)
    tab.set_value("name", "saved")
    outcome = tab.save()
    assert outcome.accepted
    assert settings.read().values["name"] == "saved"
    assert actions.calls[0][0:2] == ("configure", "monty")

    before = settings.path.read_bytes()
    tab.set_value("unknown", "refused")
    refused = tab.save()
    assert any(problem.field == "unknown" for problem in refused.refused)
    assert settings.path.read_bytes() == before


def test_broken_plugin_has_detail_and_remove_but_no_form() -> None:
    removed: list[str] = []
    tab = PluginTab(
        PluginEntry(plugin_id="broken", run_state=PluginRunState.BROKEN, detail="bad record"),
        remove=lambda plugin_id: removed.append(plugin_id),
    )

    assert tab.detail == "bad record"
    assert tab.form is None
    assert tab.fields == ()
    assert tab.table("missing") is None
    assert tab.remove() is None
    assert removed == ["broken"]


def test_switch_remove_and_apply_route_to_the_existing_action_seams(tmp_path: Path) -> None:
    tab, _, actions = plugin_tab(tmp_path)

    tab.set_enabled(False)
    tab.remove()
    tab.apply_update()

    assert actions.calls == [
        ("enabled", "monty", False),
        ("remove", "monty"),
        ("update", "monty"),
    ]
