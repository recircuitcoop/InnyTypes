"""Discovery: what the host finds on disk, and what it refuses to be stopped by.

The substance of this slice is the failure behaviour, so most of what follows builds a
broken addon environment next to a working one and asserts the working one still came
back. Each of those tests turns red if the corresponding guard in
`innytypes.addons.discovery` is deleted — a discovery that raises on the first bad
manifest passes no test here.

Every addon environment used below is built by the test itself, in `tmp_path`: no `uv`
runs, no network, no fixture outside the test, and no addon package is ever importable by
the host.
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

import pytest

from innytypes import HOST_API_VERSION
from innytypes.addons.discovery import (
    ENVIRONMENT_DIRNAME,
    MANIFEST_FILENAME,
    BrokenAddon,
    DiscoveryResult,
    InstalledAddon,
    addon_environment,
    addon_root,
    default_addons_root,
    discover_addons,
    recorded_manifest_path,
)
from innytypes.addons.manifest import AddonManifest, EventKind

# --- building fake addon environments -----------------------------------------------------


def manifest_data(addon_id: str, **overrides: object) -> dict[str, object]:
    """A manifest that parses, so each test can break exactly one thing."""
    data: dict[str, object] = {
        "id": addon_id,
        "version": "1.0.0",
        "host_api": HOST_API_VERSION,
        "requires": [],
        "emits": [f"{addon_id}.started.v1"],
        "subscribes": [],
    }
    data.update(overrides)
    return data


def install_addon(
    root: Path,
    addon_id: str,
    *,
    manifest: Mapping[str, object] | None = None,
    raw_manifest: bytes | None = None,
) -> Path:
    """Write what `innytypes addons install` records: an environment and a manifest beside it.

    This is the test's stand-in for slice 08, and it is deliberately the only thing in this
    file that writes into the addons root.
    """
    environment = addon_environment(root, addon_id)
    environment.mkdir(parents=True)

    path = recorded_manifest_path(root, addon_id)
    if raw_manifest is not None:
        path.write_bytes(raw_manifest)
    elif manifest is not None:
        path.write_text(json.dumps(manifest), encoding="utf-8")

    return addon_root(root, addon_id)


def tree_snapshot(root: Path) -> dict[str, bytes | None]:
    """Every path under `root`, with file contents — so a write of any kind shows up."""
    return {
        str(path.relative_to(root)): path.read_bytes() if path.is_file() else None
        for path in sorted(root.rglob("*"))
    }


class RecordingInstaller:
    """The installer seam slice 08 owns. Discovery must never reach it.

    It records instead of installing, and raises if it is ever called, so a discovery that
    tried to create an environment would fail loudly rather than quietly succeed.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []

    def __call__(self, *args: object, **kwargs: object) -> object:
        self.calls.append(args)
        raise AssertionError(f"discovery invoked an installer: {args!r}")


# --- the happy path -----------------------------------------------------------------------


def test_every_installed_environment_returns_one_validated_manifest(tmp_path: Path) -> None:
    install_addon(tmp_path, "monty", manifest=manifest_data("monty"))
    install_addon(tmp_path, "whodunnit", manifest=manifest_data("whodunnit", version="2.1.0"))

    result = discover_addons(tmp_path)

    assert isinstance(result, DiscoveryResult)
    assert result.broken == ()
    # Sorted by id, so two runs of `addons list` cannot disagree about the order.
    assert [addon.id for addon in result.installed] == ["monty", "whodunnit"]

    monty, whodunnit = result.installed
    assert isinstance(monty, InstalledAddon)
    # A parsed manifest, not a dict: every later slice reads it by attribute.
    assert isinstance(monty.manifest, AddonManifest)
    assert monty.manifest.emits == (EventKind(addon_id="monty", name="started", version=1),)
    assert whodunnit.manifest.version == "2.1.0"


def test_each_addon_reports_where_its_environment_and_manifest_live(tmp_path: Path) -> None:
    install_addon(tmp_path, "monty", manifest=manifest_data("monty"))

    (addon,) = discover_addons(tmp_path).installed

    assert addon.root == tmp_path / "monty"
    assert addon.environment == tmp_path / "monty" / ENVIRONMENT_DIRNAME
    assert addon.manifest_path == tmp_path / "monty" / MANIFEST_FILENAME
    assert addon.environment.is_dir()
    assert addon.manifest_path.is_file()


def test_no_addon_code_is_imported(tmp_path: Path) -> None:
    """The invariant the whole design rests on, exercised rather than asserted.

    The fake environment holds an importable `monty` package that blows up on import. If
    discovery ever reached into an addon environment — putting it on `sys.path` and reading
    the entry point itself instead of the recorded manifest — this test would fail.
    """
    install_addon(tmp_path, "monty", manifest=manifest_data("monty"))
    package = addon_environment(tmp_path, "monty") / "lib" / "site-packages" / "monty"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        'raise AssertionError("the host imported addon code")\n', encoding="utf-8"
    )

    path_before = list(sys.path)
    result = discover_addons(tmp_path)

    assert [addon.id for addon in result.installed] == ["monty"]
    assert "monty" not in sys.modules
    assert sys.path == path_before


# --- one broken addon does not hide the other nine ----------------------------------------


def test_a_missing_manifest_is_reported_and_every_other_addon_still_returns(
    tmp_path: Path,
) -> None:
    # An environment with nothing recorded beside it: a half-finished install.
    install_addon(tmp_path, "monty")
    install_addon(tmp_path, "whodunnit", manifest=manifest_data("whodunnit"))

    result = discover_addons(tmp_path)

    assert [addon.id for addon in result.installed] == ["whodunnit"]
    (broken,) = result.broken
    assert isinstance(broken, BrokenAddon)
    assert broken.id == "monty"
    assert broken.root == tmp_path / "monty"
    # The reason names the missing file and what to do about it, rather than an errno.
    assert MANIFEST_FILENAME in broken.reason
    assert "addons install" in broken.reason


def test_an_unreadable_manifest_is_reported_with_its_reason(tmp_path: Path) -> None:
    # A directory where the recorded manifest belongs — unreadable on every platform.
    install_addon(tmp_path, "monty")
    recorded_manifest_path(tmp_path, "monty").mkdir()
    install_addon(tmp_path, "whodunnit", manifest=manifest_data("whodunnit"))

    result = discover_addons(tmp_path)

    assert [addon.id for addon in result.installed] == ["whodunnit"]
    (broken,) = result.broken
    assert broken.id == "monty"
    assert "could not be read" in broken.reason


def test_a_manifest_that_is_not_utf8_text_is_reported(tmp_path: Path) -> None:
    install_addon(tmp_path, "monty", raw_manifest=b"\xff\xfe not text at all")
    install_addon(tmp_path, "whodunnit", manifest=manifest_data("whodunnit"))

    result = discover_addons(tmp_path)

    assert [addon.id for addon in result.installed] == ["whodunnit"]
    (broken,) = result.broken
    assert broken.id == "monty"
    assert "UTF-8" in broken.reason


def test_a_manifest_that_is_not_json_is_reported(tmp_path: Path) -> None:
    install_addon(tmp_path, "monty", raw_manifest=b"{ not json")
    install_addon(tmp_path, "whodunnit", manifest=manifest_data("whodunnit"))

    result = discover_addons(tmp_path)

    assert [addon.id for addon in result.installed] == ["whodunnit"]
    (broken,) = result.broken
    assert broken.id == "monty"
    assert "not valid JSON" in broken.reason


def test_a_manifest_that_fails_validation_is_reported_rather_than_raised(tmp_path: Path) -> None:
    # A host API this host does not implement: the manifest parses as JSON and is refused.
    install_addon(
        tmp_path, "monty", manifest=manifest_data("monty", host_api=HOST_API_VERSION + 99)
    )
    install_addon(tmp_path, "whodunnit", manifest=manifest_data("whodunnit"))

    result = discover_addons(tmp_path)

    assert [addon.id for addon in result.installed] == ["whodunnit"]
    (broken,) = result.broken
    assert broken.id == "monty"
    assert str(HOST_API_VERSION + 99) in broken.reason


def test_a_manifest_claiming_another_id_is_reported(tmp_path: Path) -> None:
    """The directory name is the addon's identity, and the record must agree with it.

    Discovery reports a broken addon by the name of its directory — that is the only id it
    has before the manifest is readable. A manifest claiming a different id would let one
    addon be reported, started and namespaced under two names.
    """
    install_addon(tmp_path, "monty", manifest=manifest_data("whodunnit"))
    install_addon(tmp_path, "whodunnit", manifest=manifest_data("whodunnit"))

    result = discover_addons(tmp_path)

    assert [addon.id for addon in result.installed] == ["whodunnit"]
    (broken,) = result.broken
    assert broken.id == "monty"
    assert "whodunnit" in broken.reason


def test_one_broken_addon_hides_none_of_the_others(tmp_path: Path) -> None:
    for addon_id in ("alpha", "bravo", "delta", "echo"):
        install_addon(tmp_path, addon_id, manifest=manifest_data(addon_id))
    install_addon(tmp_path, "charlie", raw_manifest=b"{ not json")

    result = discover_addons(tmp_path)

    # Both groups, from one call, so a caller can print the installed and the broken together.
    assert [addon.id for addon in result.installed] == ["alpha", "bravo", "delta", "echo"]
    assert [broken.id for broken in result.broken] == ["charlie"]


def test_several_broken_addons_each_come_back_with_their_own_reason(tmp_path: Path) -> None:
    install_addon(tmp_path, "monty")
    install_addon(tmp_path, "whodunnit", raw_manifest=b"{ not json")
    install_addon(tmp_path, "summarize", manifest=manifest_data("summarize"))

    result = discover_addons(tmp_path)

    assert [addon.id for addon in result.installed] == ["summarize"]
    reasons = {broken.id: broken.reason for broken in result.broken}
    assert set(reasons) == {"monty", "whodunnit"}
    assert MANIFEST_FILENAME in reasons["monty"]
    assert "not valid JSON" in reasons["whodunnit"]


# --- discovery is the read side, and only the read side -----------------------------------


def test_discovery_writes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No environment created, no manifest recorded, no installer invoked."""
    install_addon(tmp_path, "monty", manifest=manifest_data("monty"))
    install_addon(tmp_path, "whodunnit")  # the broken one: recovery is not discovery's job

    installer = RecordingInstaller()
    for attribute in ("run", "Popen", "call", "check_call", "check_output"):
        monkeypatch.setattr(subprocess, attribute, installer)

    before = tree_snapshot(tmp_path)
    result = discover_addons(tmp_path)
    after = tree_snapshot(tmp_path)

    assert installer.calls == []
    assert after == before
    assert [addon.id for addon in result.installed] == ["monty"]
    assert [broken.id for broken in result.broken] == ["whodunnit"]


def test_an_absent_root_yields_nothing_and_is_not_created(tmp_path: Path) -> None:
    root = tmp_path / "never-installed"

    result = discover_addons(root)

    assert result.installed == ()
    assert result.broken == ()
    assert not root.exists()


def test_a_stray_file_in_the_root_is_not_an_addon(tmp_path: Path) -> None:
    install_addon(tmp_path, "monty", manifest=manifest_data("monty"))
    (tmp_path / ".DS_Store").write_bytes(b"\x00")

    result = discover_addons(tmp_path)

    assert [addon.id for addon in result.installed] == ["monty"]
    assert result.broken == ()


# --- where the addons live ----------------------------------------------------------------


def test_the_default_root_is_the_users_innytypes_data_directory() -> None:
    root = default_addons_root()

    assert root.name == "addons"
    assert root.parent.name == "innytypes"
    # Resolving it must not create anything in the user's real directory.
    assert default_addons_root() == root


def test_discovery_uses_the_default_root_when_none_is_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_addon(tmp_path, "monty", manifest=manifest_data("monty"))
    monkeypatch.setattr("innytypes.addons.discovery.default_addons_root", lambda: tmp_path)

    result = discover_addons()

    assert [addon.id for addon in result.installed] == ["monty"]


def test_the_layout_helpers_agree_on_one_place_per_addon(tmp_path: Path) -> None:
    # Slice 08 writes exactly what discovery reads, so both sides call these.
    assert addon_root(tmp_path, "monty") == tmp_path / "monty"
    assert addon_environment(tmp_path, "monty") == tmp_path / "monty" / ENVIRONMENT_DIRNAME
    assert recorded_manifest_path(tmp_path, "monty") == tmp_path / "monty" / MANIFEST_FILENAME
