"""Plan 0006 slice 02c: installed, official and registered catalogue lists."""

from __future__ import annotations

import ast
import base64
import secrets
from datetime import UTC, datetime
from pathlib import Path

from nacl.signing import SigningKey

from innytypes.helper.catalogue import (
    CatalogueDocumentError,
    CatalogueEntry,
    CatalogueRejected,
    PluginCatalogue,
)
from innytypes.helper.config import HelperSettings, UpdateMode
from innytypes.helper.plugin_lists import PluginLists
from innytypes.helper.window import ApplicationTab, Control, InstalledPlugin, PluginRunState


def catalogue(name: str, *entries: tuple[str, str, str], verified: bool = True) -> PluginCatalogue:
    return PluginCatalogue(
        name,
        f"https://{name}.example.invalid/catalogue.json",
        verified,
        datetime(2026, 9, 20, tzinfo=UTC),
        tuple(
            CatalogueEntry(plugin, summary, requirement, name, verified)
            for plugin, summary, requirement in entries
        ),
    )


class Reader:
    def __init__(self, official: object, registered: dict[str, object]) -> None:
        self._official = official
        self._registered = registered

    def official(self) -> PluginCatalogue:
        if isinstance(self._official, Exception):
            raise self._official
        return self._official  # type: ignore[return-value]

    def registered(self, source: object) -> PluginCatalogue:
        value = self._registered[source.name]  # type: ignore[attr-defined]
        if isinstance(value, Exception):
            raise value
        return value  # type: ignore[return-value]


def configured(tmp_path: Path) -> HelperSettings:
    settings = HelperSettings(tmp_path / "config.toml")
    settings.add_source("acme", "https://acme.example.invalid/catalogue.json", auto_update=True)
    settings.add_source("friends", "https://friends.example.invalid/catalogue.json")
    return settings


def lists(
    tmp_path: Path, *, installed: tuple[InstalledPlugin, ...] = (), calls: list[str] | None = None
) -> PluginLists:
    calls = [] if calls is None else calls
    settings = configured(tmp_path)
    return PluginLists(
        settings=settings,
        reader=Reader(
            catalogue("official", ("monty", "Files things.", "pypi:monty")),
            {
                "acme": catalogue(
                    "acme", ("whodunnit", "Finds authors.", "pypi:not-whodunnit"), verified=False
                ),
                "friends": catalogue(
                    "friends", ("summarize", "Makes text short.", "pypi:summarize")
                ),
            },
        ),  # type: ignore[arg-type]
        installed=installed,
        installer=calls.append,
    )


def test_application_tab_carries_the_three_lists_in_config_order(tmp_path: Path) -> None:
    model = lists(tmp_path)
    tab = ApplicationTab(plugin_lists=model)

    assert tab.plugin_lists is model
    assert [
        group.source_name if hasattr(group, "source_name") else "installed"
        for group in model.groups
    ] == ["installed", "official", "acme", "friends"]


def test_entries_show_summary_install_and_installed_state(tmp_path: Path) -> None:
    installed = (InstalledPlugin("monty", PluginRunState.RUNNING, Control("Remove")),)
    groups = lists(tmp_path, installed=installed).groups
    official = groups[1]
    other = groups[2]

    assert official.entries[0].summary == "Files things."
    assert official.entries[0].installed
    assert official.entries[0].install == Control("Install", enabled=False)
    assert official.entries[0].detail == "already installed"
    assert other.entries[0].install.enabled


def test_registered_entries_name_source_and_only_keyless_is_unverified(tmp_path: Path) -> None:
    settings = HelperSettings(tmp_path / "config.toml")
    key = SigningKey.generate()
    key_line = base64.b64encode(b"Ed" + secrets.token_bytes(8) + bytes(key.verify_key)).decode()
    settings.add_source("signed", "https://signed.example.invalid/list.json", public_key=key_line)
    settings.add_source("open", "https://open.example.invalid/list.json")
    model = PluginLists(
        settings=settings,
        reader=Reader(
            catalogue("official"),
            {
                "signed": catalogue("signed", ("one", "One", "pypi:one")),
                "open": catalogue("open", ("two", "Two", "pypi:two"), verified=False),
            },
        ),  # type: ignore[arg-type]
        installer=lambda _requirement: None,
    )

    signed, open_list = model.groups[2:]
    assert (signed.entries[0].source_name, signed.entries[0].verified) == ("signed", True)
    assert (open_list.entries[0].source_name, open_list.entries[0].verified) == ("open", False)
    assert "unverified" not in signed.entries[0].confirmation
    assert "unverified" in open_list.entries[0].confirmation
    assert "pypi:two" in open_list.entries[0].confirmation


def test_source_switch_round_trips_immediately(tmp_path: Path) -> None:
    model = lists(tmp_path)
    assert model.groups[2].auto_update.on

    outcome = model.set_auto_update("acme", False)

    assert outcome.accepted
    assert not model.groups[2].auto_update.on
    assert "auto_update = false" in model.settings.path.read_text()


def test_registration_removal_and_refusals_are_messages(tmp_path: Path) -> None:
    model = lists(tmp_path)
    assert model.register("new", "https://new.example.invalid/list.json").accepted
    assert model.remove_source("new").accepted
    duplicate = model.register("acme", "https://elsewhere.invalid/list.json")
    insecure = model.register("bad", "http://bad.example.invalid/list.json")

    assert not duplicate.accepted and "already registered" in duplicate.message
    assert not insecure.accepted and "https" in insecure.message.lower()


def test_mistyped_public_key_is_refused_without_writing(tmp_path: Path) -> None:
    model = lists(tmp_path)
    before = model.settings.path.read_bytes()
    outcome = model.register("broken-key", "https://safe.invalid/list.json", public_key="not-a-key")

    assert not outcome.accepted
    assert "public key" in outcome.message
    assert model.settings.path.read_bytes() == before


def test_install_uses_injected_path_and_records_source_update_policy(tmp_path: Path) -> None:
    calls: list[str] = []
    model = lists(tmp_path, calls=calls)
    entry = model.groups[2].entries[0]

    outcome = model.install_entry(entry)
    assert model.settings.update_mode("whodunnit") is UpdateMode.AUTO
    model.set_auto_update("acme", False)

    assert outcome.accepted
    assert calls == ["pypi:not-whodunnit"]
    assert model.settings.current.plugins.override_for("whodunnit").source == "acme"
    assert model.settings.update_mode("whodunnit") is UpdateMode.MANUAL
    tree = ast.parse(Path("src/innytypes/helper/plugin_lists.py").read_text())
    assert not any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name.startswith("install_addon")
        for node in ast.walk(tree)
    )


def test_official_entry_wins_without_hiding_shadow(tmp_path: Path) -> None:
    settings = HelperSettings(tmp_path / "config.toml")
    settings.add_source("acme", "https://acme.invalid/list.json")
    model = PluginLists(
        settings=settings,
        reader=Reader(
            catalogue("official", ("monty", "Official", "pypi:monty")),
            {"acme": catalogue("acme", ("monty", "Impostor", "pypi:not-monty"), verified=False)},
        ),  # type: ignore[arg-type]
        installer=lambda _requirement: None,
    )

    official, shadow = model.groups[1], model.groups[2]
    assert official.entries[0].install.enabled
    assert not shadow.entries[0].install.enabled
    assert shadow.entries[0].source_name == "acme"
    assert "official" in shadow.entries[0].detail


def test_one_failed_catalogue_leaves_other_groups_intact(tmp_path: Path) -> None:
    settings = HelperSettings(tmp_path / "config.toml")
    settings.add_source("bad", "https://bad.invalid/list.json")
    settings.add_source("good", "https://good.invalid/list.json")
    rejected = CatalogueRejected(source="bad", reason="signature", detail="wrong signer")
    model = PluginLists(
        settings=settings,
        reader=Reader(
            catalogue("official"),
            {"bad": rejected, "good": catalogue("good", ("one", "One", "pypi:one"))},
        ),  # type: ignore[arg-type]
        installed=(InstalledPlugin("kept", PluginRunState.RUNNING, Control("Remove")),),
        installer=lambda _requirement: None,
    )

    groups = model.groups
    assert groups[0][0].plugin_id == "kept"
    assert "signature" in groups[2].message
    assert groups[3].entries[0].plugin_id == "one"


def test_an_unreachable_catalogue_leaves_installed_and_official_intact(tmp_path: Path) -> None:
    settings = HelperSettings(tmp_path / "config.toml")
    settings.add_source("offline", "https://offline.invalid/list.json")
    unreachable = CatalogueDocumentError("https://offline.invalid/list.json could not be read")
    model = PluginLists(
        settings=settings,
        reader=Reader(
            catalogue("official", ("one", "One", "pypi:one")),
            {"offline": unreachable},
        ),  # type: ignore[arg-type]
        installed=(InstalledPlugin("kept", PluginRunState.RUNNING, Control("Remove")),),
        installer=lambda _requirement: None,
    )

    groups = model.groups
    assert groups[0][0].plugin_id == "kept"
    assert groups[1].entries[0].plugin_id == "one"
    assert "could not be read" in groups[2].message


def test_plugin_view_docstring_does_not_repeat_superseded_rule() -> None:
    from innytypes.helper.window import PluginView

    assert "lists **installed plugins only**" not in (PluginView.__doc__ or "")
