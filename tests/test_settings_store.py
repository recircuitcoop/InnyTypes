"""The per-plugin settings store: what is recorded, how, and what holds a plugin disabled.

Plan 0004's D4 puts one file per plugin at `plugins/<addon-id>.toml` beside `config.toml`,
D5 says a recorded value that no longer fits its declaration holds the plugin **disabled with
the reason** rather than falling back to a default, F1 says the same of a required field that
has no value at all, and F2 says every write records who made it and when.

Every test here injects its own path under `tmp_path`. Nothing in this file may read or write
the real per-user config directory, and the one test that looks at the real path only asks
what it is named — it never touches it.

Each refusal owns a test that turns red when its check is deleted, because the cheapest way to
"satisfy" a requirement to refuse something is to not implement it.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from innytypes.addons.manifest import SettingsField, parse_settings
from innytypes.addons.settings import (
    USER,
    Attribution,
    PluginAvailability,
    SettingsError,
    SettingsStore,
    default_settings_path,
)


def declare(*fields: object) -> tuple[SettingsField, ...]:
    """Parse a settings declaration exactly as a recorded manifest carries it."""
    return parse_settings(list(fields))


FOLDER = {"id": "root", "type": "path", "label": "Folder to watch", "kind": "folder"}
INTERVAL = {"id": "interval", "type": "number", "label": "Interval", "min": 1, "max": 60}
QUALITY = {"id": "quality", "type": "choice", "label": "Quality", "options": ["low", "high"]}


def store(tmp_path: Path, *fields: object, **kwargs: Any) -> SettingsStore:
    """A store for `monty`, writing under the test's own directory and nowhere else."""
    return SettingsStore(
        "monty",
        declare(*fields),
        path=tmp_path / "plugins" / "monty.toml",
        **kwargs,
    )


# --- defaults, and a required field with none of its own -----------------------------------


def test_a_file_that_does_not_exist_yields_every_declared_default(tmp_path: Path) -> None:
    settings = store(
        tmp_path,
        dict(INTERVAL, default=15),
        dict(QUALITY, default="high"),
    ).read()

    assert settings.values == {"interval": 15, "quality": "high"}
    assert settings.hold is None
    # Reading creates nothing: a plugin nobody has configured has no file.
    assert not (tmp_path / "plugins" / "monty.toml").exists()


def test_a_required_field_with_no_default_yields_no_value(tmp_path: Path) -> None:
    settings = store(tmp_path, dict(FOLDER, required=True), dict(INTERVAL, default=15)).read()

    assert "root" not in settings.values
    assert settings.values == {"interval": 15}


def test_an_optional_field_with_no_default_yields_no_value_and_no_complaint(
    tmp_path: Path,
) -> None:
    settings = store(tmp_path, FOLDER).read()

    assert settings.values == {}
    assert settings.hold is None


# --- the write is atomic -------------------------------------------------------------------


def explode(*args: object, **kwargs: object) -> None:
    raise OSError("the rename failed")


def test_a_write_that_fails_before_the_rename_leaves_the_prior_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = store(tmp_path, dict(INTERVAL, default=15))
    settings.write({"interval": 20}, by=USER)
    before = settings.path.read_text(encoding="utf-8")

    monkeypatch.setattr(os, "replace", explode)
    with pytest.raises(OSError, match="the rename failed"):
        settings.write({"interval": 30}, by=USER)
    monkeypatch.undo()

    assert settings.path.read_text(encoding="utf-8") == before
    assert settings.read().values == {"interval": 20}
    # And nothing half-written is left lying beside it.
    assert sorted(item.name for item in settings.path.parent.iterdir()) == ["monty.toml"]


def test_a_write_that_fails_before_the_rename_leaves_the_file_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = store(tmp_path, dict(INTERVAL, default=15))

    monkeypatch.setattr(os, "replace", explode)
    with pytest.raises(OSError, match="the rename failed"):
        settings.write({"interval": 30}, by=USER)
    monkeypatch.undo()

    assert not settings.path.exists()
    assert list(settings.path.parent.iterdir()) == []


# --- every read is a re-read -----------------------------------------------------------------


def test_a_value_changed_on_disk_is_seen_on_the_very_next_read(tmp_path: Path) -> None:
    settings = store(tmp_path, dict(INTERVAL, default=15))
    settings.write({"interval": 20}, by=USER)
    assert settings.read().values["interval"] == 20

    settings.path.write_text("[values]\ninterval = 42\n", encoding="utf-8")

    assert settings.read().values["interval"] == 42


# --- a write is judged field by field ---------------------------------------------------------


def test_a_write_records_the_valid_field_and_refuses_only_the_invalid_one(
    tmp_path: Path,
) -> None:
    settings = store(tmp_path, INTERVAL, QUALITY)
    settings.write({"quality": "low"}, by=USER)

    outcome = settings.write({"interval": 30, "quality": "medium"}, by=USER)

    assert outcome.recorded == ("interval",)
    assert [problem.field for problem in outcome.refused] == ["quality"]
    assert "medium" in outcome.refused[0].reason
    assert not outcome.accepted

    on_disk = settings.read()
    assert on_disk.values["interval"] == 30
    # The invalid field's prior value is exactly as it was — not replaced, not dropped.
    assert on_disk.values["quality"] == "low"


def test_a_write_of_only_invalid_fields_touches_nothing(tmp_path: Path) -> None:
    settings = store(tmp_path, QUALITY)

    outcome = settings.write({"quality": "medium"}, by=USER)

    assert outcome.recorded == ()
    assert not settings.path.exists()


def test_a_write_to_a_field_that_is_not_declared_is_refused_by_name(tmp_path: Path) -> None:
    settings = store(tmp_path, INTERVAL)

    outcome = settings.write({"colour": "red"}, by=USER)

    assert [problem.field for problem in outcome.refused] == ["colour"]
    assert "colour" in outcome.refused[0].reason


# --- a value that no longer fits: held disabled, and left exactly as recorded (D5) -----------


def test_a_value_that_no_longer_fits_the_declaration_holds_the_plugin_disabled(
    tmp_path: Path,
) -> None:
    path = tmp_path / "plugins" / "monty.toml"
    before = SettingsStore("monty", declare(dict(INTERVAL, max=60)), path=path)
    before.write({"interval": 45}, by=USER)

    # The plugin updates, and its declaration tightens.
    after = SettingsStore("monty", declare(dict(INTERVAL, max=30, default=10)), path=path)
    settings = after.read()

    assert settings.hold is not None
    assert [problem.field for problem in settings.hold.problems] == ["interval"]
    assert "interval" in settings.hold.reason
    assert settings.availability is PluginAvailability.HELD

    # Neither defaulted nor dropped: the value the user chose is still on disk, unjudged.
    assert settings.recorded["interval"] == 45
    assert "interval" not in settings.values
    assert "interval = 45" in path.read_text(encoding="utf-8")


def test_a_value_that_no_longer_fits_does_not_stop_a_later_write(tmp_path: Path) -> None:
    path = tmp_path / "plugins" / "monty.toml"
    SettingsStore("monty", declare(dict(INTERVAL, max=60)), path=path).write(
        {"interval": 45}, by=USER
    )

    after = SettingsStore("monty", declare(dict(INTERVAL, max=30)), path=path)
    assert after.write({"interval": 20}, by=USER).accepted
    assert after.read().hold is None


# --- a required field with no value: held disabled, and it clears itself (F1) ----------------


def test_a_required_field_with_no_value_holds_the_plugin_disabled(tmp_path: Path) -> None:
    settings = store(tmp_path, dict(FOLDER, required=True)).read()

    assert settings.hold is not None
    assert [problem.field for problem in settings.hold.problems] == ["root"]
    assert "root" in settings.hold.reason
    assert settings.availability is PluginAvailability.HELD


def test_held_disabled_is_neither_quarantined_nor_a_users_own_disable(tmp_path: Path) -> None:
    held = store(tmp_path, dict(FOLDER, required=True)).read().availability

    assert held is PluginAvailability.HELD
    assert held != PluginAvailability.DISABLED
    assert held != PluginAvailability.QUARANTINED
    assert PluginAvailability.DISABLED != PluginAvailability.QUARANTINED


def test_held_disabled_clears_itself_once_the_missing_value_is_written(tmp_path: Path) -> None:
    settings = store(tmp_path, dict(FOLDER, required=True))
    assert settings.read().hold is not None

    settings.write({"root": "/Users/someone/Recordings"}, by=USER)

    assert settings.read().hold is None
    assert settings.read().availability is PluginAvailability.ENABLED


# --- who wrote it, and when (F2) --------------------------------------------------------------


def test_a_write_records_who_made_it_and_when(tmp_path: Path) -> None:
    settings = store(tmp_path, INTERVAL)
    settings.write({"interval": 20}, by=USER)

    attribution = settings.read().attribution["interval"]

    assert attribution.by == USER
    assert attribution.by_user
    assert isinstance(attribution.at, datetime)
    assert abs((datetime.now(UTC) - attribution.at).total_seconds()) < 300


def test_a_plugin_writing_its_own_value_is_recorded_as_the_writer(tmp_path: Path) -> None:
    settings = store(tmp_path, dict(INTERVAL, written_by="plugin"))

    settings.write({"interval": 20}, by="monty")

    attribution = settings.read().attribution["interval"]
    assert attribution.by == "monty"
    assert not attribution.by_user
    assert "monty" in settings.path.read_text(encoding="utf-8")


def test_a_plugin_may_not_write_a_field_its_author_left_to_the_user(tmp_path: Path) -> None:
    settings = store(tmp_path, INTERVAL)

    outcome = settings.write({"interval": 20}, by="monty")

    assert [problem.field for problem in outcome.refused] == ["interval"]
    assert not settings.path.exists()


def test_the_user_may_not_write_a_field_its_author_left_to_the_plugin(tmp_path: Path) -> None:
    settings = store(tmp_path, dict(INTERVAL, written_by="plugin"))

    outcome = settings.write({"interval": 20}, by=USER)

    assert [problem.field for problem in outcome.refused] == ["interval"]
    assert not settings.path.exists()


def test_a_field_written_by_both_takes_either_writer(tmp_path: Path) -> None:
    settings = store(tmp_path, dict(INTERVAL, written_by="both"))

    assert settings.write({"interval": 20}, by=USER).accepted
    assert settings.write({"interval": 30}, by="monty").accepted
    assert settings.read().attribution["interval"].by == "monty"


def test_no_write_may_be_made_in_another_plugins_name(tmp_path: Path) -> None:
    settings = store(tmp_path, dict(INTERVAL, written_by="both"))

    with pytest.raises(SettingsError, match="whodunnit"):
        settings.write({"interval": 20}, by="whodunnit")

    assert not settings.path.exists()


# --- the seam slice 03 fills: a secret's value is not in this file -----------------------------


def test_a_secret_is_refused_by_this_store_and_never_written_here(tmp_path: Path) -> None:
    settings = store(tmp_path, {"id": "token", "type": "secret", "label": "Token"})

    outcome = settings.write({"token": "hunter2"}, by=USER)

    assert [problem.field for problem in outcome.refused] == ["token"]
    assert not settings.path.exists()


def test_a_required_secret_holds_the_plugin_disabled_until_one_is_recorded(
    tmp_path: Path,
) -> None:
    field = {"id": "token", "type": "secret", "label": "Token", "required": True}

    without = store(tmp_path, field).read()
    assert without.hold is not None
    assert [problem.field for problem in without.hold.problems] == ["token"]

    withit = store(tmp_path, field, secret_is_set=lambda field_id: field_id == "token").read()
    assert withit.hold is None


def test_a_secret_never_appears_among_the_values_this_store_hands_out(tmp_path: Path) -> None:
    settings = store(tmp_path, {"id": "token", "type": "secret", "label": "Token"})
    settings.path.parent.mkdir(parents=True)
    # Nothing this store writes can put one here, so this is a file somebody mangled by hand.
    settings.path.write_text('[values]\ntoken = "hunter2"\n', encoding="utf-8")

    recorded = settings.read()

    assert "token" not in recorded.values
    assert "token" not in recorded.recorded
    assert recorded.hold is None
    # And it is left alone rather than deleted: this store never touches what it did not write.
    assert "hunter2" in settings.path.read_text(encoding="utf-8")


# --- the file a person reads, and the file a person may have mangled ---------------------------


def test_the_file_reads_as_values_and_an_attribution_table(tmp_path: Path) -> None:
    settings = store(tmp_path, INTERVAL, QUALITY)
    settings.write({"interval": 20, "quality": "low"}, by=USER)

    text = settings.path.read_text(encoding="utf-8")

    assert "[values]" in text
    assert "interval = 20" in text
    assert 'quality = "low"' in text
    assert "[written.interval]" in text
    assert 'by = "user"' in text


def test_a_value_recorded_for_a_field_nobody_declares_any_more_is_kept(tmp_path: Path) -> None:
    path = tmp_path / "plugins" / "monty.toml"
    SettingsStore("monty", declare(INTERVAL, QUALITY), path=path).write(
        {"interval": 20, "quality": "low"}, by=USER
    )

    # The plugin updates and drops `quality` from its declaration.
    after = SettingsStore("monty", declare(INTERVAL), path=path)
    settings = after.read()
    assert settings.hold is None
    assert "quality" not in settings.values

    after.write({"interval": 30}, by=USER)
    assert 'quality = "low"' in path.read_text(encoding="utf-8")


def test_a_file_that_is_not_valid_toml_is_refused_by_name(tmp_path: Path) -> None:
    settings = store(tmp_path, INTERVAL)
    settings.path.parent.mkdir(parents=True)
    settings.path.write_text("[values\ninterval = 20\n", encoding="utf-8")

    with pytest.raises(SettingsError, match="monty.toml"):
        settings.read()


def test_a_table_this_store_does_not_know_is_refused_by_name(tmp_path: Path) -> None:
    settings = store(tmp_path, INTERVAL)
    settings.path.parent.mkdir(parents=True)
    settings.path.write_text(
        "[values]\ninterval = 20\n\n[secrets]\ntoken = 'x'\n", encoding="utf-8"
    )

    with pytest.raises(SettingsError, match="secrets"):
        settings.read()


def test_an_attribution_that_is_not_a_timestamp_is_refused(tmp_path: Path) -> None:
    settings = store(tmp_path, INTERVAL)
    settings.path.parent.mkdir(parents=True)
    settings.path.write_text(
        "[values]\ninterval = 20\n\n[written.interval]\nby = 'user'\nat = 'yesterday'\n",
        encoding="utf-8",
    )

    with pytest.raises(SettingsError, match="at"):
        settings.read()


def test_a_field_id_that_needs_quoting_survives_a_round_trip(tmp_path: Path) -> None:
    settings = store(tmp_path, {"id": "watch folder", "type": "text", "label": "Folder"})

    settings.write({"watch folder": "/tmp/x"}, by=USER)

    assert settings.read().values == {"watch folder": "/tmp/x"}
    assert settings.read().attribution["watch folder"].by == USER


def test_a_switch_and_a_list_survive_a_round_trip(tmp_path: Path) -> None:
    settings = store(
        tmp_path,
        {"id": "watching", "type": "switch", "label": "Watch on start"},
        {"id": "formats", "type": "multiple-choice", "label": "Formats", "options": ["wav", "mp3"]},
        {"id": "sizes", "type": "list of number", "label": "Sizes", "min": 1},
    )

    outcome = settings.write(
        {"watching": True, "formats": ["wav", "mp3"], "sizes": [2, 4.5]}, by=USER
    )

    assert outcome.accepted
    assert settings.read().values == {
        "watching": True,
        "formats": ("wav", "mp3"),
        "sizes": (2, 4.5),
    }
    assert "watching = true" in settings.path.read_text(encoding="utf-8")


def test_a_list_whose_elements_break_their_constraint_is_refused(tmp_path: Path) -> None:
    settings = store(tmp_path, {"id": "sizes", "type": "list of number", "label": "S", "min": 1})

    outcome = settings.write({"sizes": [2, 0]}, by=USER)

    assert [problem.field for problem in outcome.refused] == ["sizes"]
    assert not settings.path.exists()


def test_a_hold_says_which_plugin_it_is_holding(tmp_path: Path) -> None:
    hold = store(tmp_path, dict(FOLDER, required=True)).read().hold

    assert hold is not None
    assert str(hold).startswith("monty is held disabled")


def test_a_file_that_is_not_utf8_is_refused_by_name(tmp_path: Path) -> None:
    settings = store(tmp_path, INTERVAL)
    settings.path.parent.mkdir(parents=True)
    settings.path.write_bytes(b"[values]\ninterval = \xff\n")

    with pytest.raises(SettingsError, match="UTF-8"):
        settings.read()


@pytest.mark.parametrize(
    ("body", "complaint"),
    [
        ("values = 3\n", r"\[values\] must be a table"),
        ("written = 3\n", r"\[written\] must be a table"),
        ("[written]\ninterval = 3\n", "must be a table with"),
        ("[written.interval]\nby = 'user'\n", "missing at"),
        ("[written.interval]\nby = 3\nat = 2026-09-19T10:00:00Z\n", "not a writer's name"),
        ("[written.interval]\nby = 'user'\nat = 3\n", "not a timestamp"),
    ],
)
def test_an_attribution_this_store_could_not_have_written_is_refused(
    tmp_path: Path, body: str, complaint: str
) -> None:
    settings = store(tmp_path, INTERVAL)
    settings.path.parent.mkdir(parents=True)
    settings.path.write_text(body, encoding="utf-8")

    with pytest.raises(SettingsError, match=complaint):
        settings.read()


def test_an_attribution_written_as_a_bare_toml_datetime_is_read(tmp_path: Path) -> None:
    # Not what this store writes, but a person editing the file by hand may well write it,
    # and TOML hands it back as a datetime rather than a string.
    settings = store(tmp_path, INTERVAL)
    settings.path.parent.mkdir(parents=True)
    settings.path.write_text(
        "[values]\ninterval = 20\n\n[written.interval]\nby = 'user'\nat = 2026-09-19T10:00:00Z\n",
        encoding="utf-8",
    )

    assert settings.read().attribution["interval"].at.year == 2026


# --- where the file lives ----------------------------------------------------------------------


def test_the_default_path_is_one_file_per_plugin_beside_the_helpers_config() -> None:
    path = default_settings_path("monty")

    assert path.name == "monty.toml"
    assert path.parent.name == "plugins"
    assert path.parent.parent.name == "innytypes"


def test_an_id_that_could_not_name_a_file_is_refused() -> None:
    with pytest.raises(SettingsError, match="well-formed"):
        SettingsStore("../escape", ())


def test_attribution_is_readable_without_a_store(tmp_path: Path) -> None:
    # The form (slice 04) holds these beside a value, so they are a value of their own.
    attribution = Attribution(by=USER, at=datetime.now(UTC))

    assert attribution.by_user
