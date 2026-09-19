"""The table store: rows recorded and refused one at a time, at every depth.

Plan 0005's slice 02. A table's recorded value is a list of rows, read out of a TOML array of
tables and validated cell by cell against the row declaration slice 01 parses — the same
`check_settings_value` every scalar already goes through, so a table adds no new way for a
value to be right or wrong.

The one new policy is **D2**: a save records the rows that pass and refuses the rows that do
not, each named the way a person would name it (`recorder 2`, never `row 2`), rather than
losing nine correct rows to a typo in a tenth. A refused row keeps whatever was on disk at its
position; a refused row the user had just *added* has nothing to keep, so it is simply absent.

Every file here lives under `tmp_path`. Nothing in this file may read or write the real
per-user config directory.

Each refusal owns a test that turns red when its check is deleted, because the cheapest way to
"satisfy" a requirement to refuse something is to not implement it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from innytypes.addons.manifest import SettingsField, parse_settings
from innytypes.addons.settings import (
    USER,
    PluginAvailability,
    SettingsStore,
)


def declare(*fields: object) -> tuple[SettingsField, ...]:
    """Parse a settings declaration exactly as a recorded manifest carries it."""
    return parse_settings(list(fields))


def store(directory: Path, *fields: object, **kwargs: Any) -> SettingsStore:
    """A store for `monty`, writing under the test's own directory and nowhere else."""
    return SettingsStore(
        "monty",
        declare(*fields),
        path=directory / "plugins" / "monty.toml",
        **kwargs,
    )


def rows(value: object) -> list[Mapping[str, object]]:
    """A recorded table value, read the way the form and the runtime will read it."""
    assert isinstance(value, Sequence) and not isinstance(value, str)
    mappings = [row for row in value if isinstance(row, Mapping)]
    assert len(mappings) == len(value), f"not every row is a mapping: {value!r}"
    return mappings


def reasons(problems: Sequence[Any]) -> list[str]:
    """The sentences a person would read, whether they came from a write or from a hold."""
    return [problem.reason for problem in problems]


# --- the declarations these tests record against --------------------------------------------

LABEL: dict[str, object] = {"id": "label", "type": "text", "label": "Name", "required": True}
UUID: dict[str, object] = {"id": "volume_uuid", "type": "text", "label": "Volume UUID"}
GLOBS: dict[str, object] = {
    "id": "globs",
    "type": "list of text",
    "label": "Patterns",
    "default": ["WAV/**/*.WAV"],
}
DESTINATION: dict[str, object] = {
    "id": "destination",
    "type": "path",
    "label": "Copy to",
    "kind": "folder",
}
GAIN: dict[str, object] = {"id": "gain", "type": "number", "label": "Gain", "min": 1}

# A table nested three deep: a recorder holds takes, and a take holds markers.
MARKERS: dict[str, object] = {
    "id": "markers",
    "type": "table",
    "label": "Markers",
    "row_label": "marker",
    "row": [{"id": "at", "type": "number", "label": "At", "min": 0}],
}
TAKES: dict[str, object] = {
    "id": "takes",
    "type": "table",
    "label": "Takes",
    "row_label": "take",
    "row": [{"id": "file", "type": "path", "label": "File", "kind": "file"}, MARKERS],
}


def volumes(*, row: Sequence[object] | None = None, **overrides: object) -> dict[str, object]:
    """monty's recorders: one table that parses, so each test can break exactly one thing."""
    field: dict[str, object] = {
        "id": "volumes",
        "type": "table",
        "label": "Recorders",
        "row_label": "recorder",
        "row": list(row) if row is not None else [LABEL, UUID, DESTINATION],
    }
    field.update(overrides)
    return field


# --- a table's value is a list of rows, at every depth --------------------------------------


def test_a_table_round_trips_as_a_list_of_rows(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())

    outcome = settings.write(
        {
            "volumes": [
                {"label": "Zoom H6", "volume_uuid": "8A1F-22C3", "destination": "/tmp/zoom"},
                {"label": "Field recorder"},
            ]
        },
        by=USER,
    )

    assert outcome.accepted
    assert outcome.recorded == ("volumes",)
    recorded = rows(settings.read().values["volumes"])
    assert [row["label"] for row in recorded] == ["Zoom H6", "Field recorder"]
    assert recorded[0]["volume_uuid"] == "8A1F-22C3"
    # A cell nobody filled in is absent rather than guessed at.
    assert "destination" not in recorded[1]


def test_a_table_nested_two_levels_deep_round_trips_through_a_read(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(row=[LABEL, TAKES]))

    outcome = settings.write(
        {
            "volumes": [
                {
                    "label": "Zoom H6",
                    "takes": [
                        {"file": "/tmp/one.wav"},
                        {"file": "/tmp/two.wav", "markers": [{"at": 1.5}, {"at": 9}]},
                    ],
                }
            ]
        },
        by=USER,
    )

    assert outcome.accepted
    recorded = rows(settings.read().values["volumes"])
    takes = rows(recorded[0]["takes"])
    assert [take["file"] for take in takes] == ["/tmp/one.wav", "/tmp/two.wav"]
    assert [marker["at"] for marker in rows(takes[1]["markers"])] == [1.5, 9]


def test_the_file_holds_a_table_as_an_array_of_tables(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(row=[LABEL, TAKES]))

    settings.write(
        {"volumes": [{"label": "Zoom H6", "takes": [{"file": "/tmp/one.wav"}]}]},
        by=USER,
    )

    text = settings.path.read_text(encoding="utf-8")
    assert "[[values.volumes]]" in text
    assert "[[values.volumes.takes]]" in text
    assert 'label = "Zoom H6"' in text
    assert 'file = "/tmp/one.wav"' in text


# --- one bad cell refuses one row, and nothing else (D2) -------------------------------------


def test_a_required_cell_missing_from_one_row_refuses_only_that_row(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())

    outcome = settings.write(
        {
            "volumes": [
                {"label": "Zoom H6"},
                {"volume_uuid": "8A1F-22C3"},
                {"label": "Field recorder"},
            ]
        },
        by=USER,
    )

    assert [problem.field for problem in outcome.refused] == ["volumes"]
    assert outcome.refused[0].reason == (
        "volumes: recorder 2 is missing 'label', which every recorder must have and which "
        "declares no default of its own"
    )
    # The other two rows are judged on their own and are recorded whole.
    settings_read = settings.read()
    assert [row["label"] for row in rows(settings_read.values["volumes"])] == [
        "Zoom H6",
        "Field recorder",
    ]
    # The field itself is still there: one refused row does not refuse the table.
    assert "volumes" in settings_read.values
    assert settings_read.hold is None


def test_a_row_recorded_with_a_bad_cell_is_named_in_the_hold_and_the_others_are_not(
    tmp_path: Path,
) -> None:
    path = tmp_path / "plugins" / "monty.toml"
    loose = SettingsStore("monty", declare(volumes(row=[LABEL, GAIN])), path=path)
    loose.write(
        {
            "volumes": [
                {"label": "one", "gain": 5},
                {"label": "two", "gain": 1},
                {"label": "three", "gain": 5},
            ]
        },
        by=USER,
    )

    # The plugin updates and its gain column tightens; the middle row no longer fits.
    tight = SettingsStore(
        "monty",
        declare(volumes(row=[LABEL, dict(GAIN, min=2)])),
        path=path,
    )
    settings = tight.read()

    assert settings.hold is not None
    assert [problem.field for problem in settings.hold.problems] == ["volumes"]
    assert "recorder 2" in settings.hold.reason
    assert [row["label"] for row in rows(settings.values["volumes"])] == ["one", "three"]


def test_a_row_carrying_a_key_the_declaration_does_not_name_is_refused(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())

    outcome = settings.write(
        {"volumes": [{"label": "Zoom H6"}, {"label": "Field recorder", "colour": "red"}]},
        by=USER,
    )

    assert "recorder 2" in outcome.refused[0].reason
    assert "'colour'" in outcome.refused[0].reason
    assert [row["label"] for row in rows(settings.read().values["volumes"])] == ["Zoom H6"]


def test_a_row_that_is_not_a_mapping_of_cells_is_refused_by_name(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())

    outcome = settings.write({"volumes": ["Zoom H6"]}, by=USER)

    assert outcome.refused[0].reason == ("volumes: recorder 1 must be a mapping of cells, got str")
    assert not settings.path.exists()


def test_a_table_value_that_is_not_a_list_of_rows_is_refused(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())

    outcome = settings.write({"volumes": "Zoom H6"}, by=USER)

    assert outcome.refused[0].reason == "volumes must be a list of recorders, got str"
    assert not settings.path.exists()


def test_a_cell_refusal_reads_exactly_as_the_same_refusal_on_a_top_level_field(
    tmp_path: Path,
) -> None:
    on_field = store(tmp_path / "plain", GAIN).write({"gain": 0}, by=USER)
    in_cell = store(tmp_path / "table", volumes(row=[LABEL, GAIN])).write(
        {"volumes": [{"label": "Zoom H6", "gain": 0}]}, by=USER
    )

    assert on_field.refused[0].reason == "gain is 0, below the declared min 1"
    # The same sentence, with the row it happened in in front of it.
    assert in_cell.refused[0].reason == f"volumes: recorder 1's {on_field.refused[0].reason}"


# --- a unique column may not repeat (D3) -----------------------------------------------------


def test_a_repeated_unique_value_refuses_both_rows_each_naming_the_other(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(row=[dict(LABEL, unique=True), UUID]))

    outcome = settings.write(
        {
            "volumes": [
                {"label": "Zoom H6", "volume_uuid": "8A1F-22C3"},
                {"label": "Field recorder"},
                {"label": "Zoom H6", "volume_uuid": "9B2E-11D4"},
            ]
        },
        by=USER,
    )

    assert len(outcome.refused) == 2
    first, third = reasons(outcome.refused)
    assert first.startswith("volumes: recorder 1's label is 'Zoom H6'")
    assert "recorder 3" in first
    assert third.startswith("volumes: recorder 3's label is 'Zoom H6'")
    assert "recorder 1" in third
    # The row that repeats nothing is recorded as usual.
    assert [row["label"] for row in rows(settings.read().values["volumes"])] == ["Field recorder"]


def test_a_row_that_leaves_its_unique_column_empty_is_compared_with_nobody(
    tmp_path: Path,
) -> None:
    settings = store(
        tmp_path,
        volumes(row=[{"id": "label", "type": "text", "label": "Name", "unique": True}, UUID]),
    )

    outcome = settings.write(
        {"volumes": [{"volume_uuid": "8A1F-22C3"}, {"volume_uuid": "9B2E-11D4"}]},
        by=USER,
    )

    # A value nobody typed is not an identity two rows could be said to share.
    assert outcome.accepted
    assert len(rows(settings.read().values["volumes"])) == 2


def test_two_rows_may_share_a_column_that_is_not_marked_unique(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(row=[LABEL, UUID]))

    outcome = settings.write(
        {"volumes": [{"label": "Zoom H6"}, {"label": "Zoom H6"}]},
        by=USER,
    )

    assert outcome.accepted
    assert len(rows(settings.read().values["volumes"])) == 2


# --- a partial save: what an added row does, and what an edited one does ----------------------


def test_a_write_of_three_new_rows_records_the_two_that_pass(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())

    outcome = settings.write(
        {
            "volumes": [
                {"label": "Zoom H6"},
                {"label": "Field recorder"},
                {"volume_uuid": "8A1F-22C3"},
            ]
        },
        by=USER,
    )

    assert outcome.recorded == ("volumes",)
    assert "recorder 3" in outcome.refused[0].reason
    recorded = rows(settings.read().values["volumes"])
    assert len(recorded) == 2
    assert [row["label"] for row in recorded] == ["Zoom H6", "Field recorder"]


def test_an_added_row_that_fails_is_absent_rather_than_partly_recorded(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())

    settings.write(
        {"volumes": [{"label": "Zoom H6"}, {"volume_uuid": "8A1F-22C3", "destination": "/tmp/x"}]},
        by=USER,
    )

    text = settings.path.read_text(encoding="utf-8")
    assert "8A1F-22C3" not in text
    assert "/tmp/x" not in text
    assert len(rows(settings.read().values["volumes"])) == 1


def test_an_edited_row_that_fails_keeps_the_row_previously_on_disk(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())
    settings.write(
        {
            "volumes": [
                {"label": "one"},
                {"label": "two", "volume_uuid": "8A1F-22C3"},
                {"label": "three"},
            ]
        },
        by=USER,
    )

    outcome = settings.write(
        {
            "volumes": [
                {"label": "ONE"},
                {"volume_uuid": "9B2E-11D4"},
                {"label": "THREE"},
            ]
        },
        by=USER,
    )

    assert "recorder 2" in outcome.refused[0].reason
    recorded = rows(settings.read().values["volumes"])
    assert [row["label"] for row in recorded] == ["ONE", "two", "THREE"]
    # Kept whole, at its own position: the cell the user did not touch is still there.
    assert recorded[1]["volume_uuid"] == "8A1F-22C3"


def test_a_write_with_fewer_rows_drops_the_rows_the_user_removed(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())
    settings.write({"volumes": [{"label": "one"}, {"label": "two"}, {"label": "three"}]}, by=USER)

    settings.write({"volumes": [{"label": "one"}]}, by=USER)

    assert [row["label"] for row in rows(settings.read().values["volumes"])] == ["one"]


def test_a_refused_row_deep_in_a_nested_table_refuses_only_itself(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(row=[LABEL, TAKES]))

    outcome = settings.write(
        {
            "volumes": [
                {
                    "label": "Zoom H6",
                    "takes": [
                        {"file": "/tmp/one.wav"},
                        {"file": "/tmp/two.wav", "markers": [{"at": -1}, {"at": 9}]},
                    ],
                }
            ]
        },
        by=USER,
    )

    assert outcome.refused[0].reason.startswith(
        "volumes: ((recorder 1).takes (take 2)).markers (marker 1)'s at is -1, below"
    )
    # The take, the recorder and the marker that was fine are all recorded.
    takes = rows(rows(settings.read().values["volumes"])[0]["takes"])
    assert [take["file"] for take in takes] == ["/tmp/one.wav", "/tmp/two.wav"]
    assert [marker["at"] for marker in rows(takes[1]["markers"])] == [9]


def test_a_refused_nested_row_keeps_the_nested_row_previously_on_disk(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(row=[LABEL, TAKES]))
    settings.write(
        {
            "volumes": [
                {
                    "label": "Zoom H6",
                    "takes": [{"file": "/tmp/one.wav"}, {"file": "/tmp/two.wav"}],
                }
            ]
        },
        by=USER,
    )

    outcome = settings.write(
        {"volumes": [{"label": "Zoom H6", "takes": [{"file": "/tmp/ONE.wav"}, {"file": 5}]}]},
        by=USER,
    )

    assert "(recorder 1).takes (take 2)" in outcome.refused[0].reason
    # Position by position, all the way down: the take nobody could save is the one on disk.
    takes = rows(rows(settings.read().values["volumes"])[0]["takes"])
    assert [take["file"] for take in takes] == ["/tmp/ONE.wav", "/tmp/two.wav"]


def test_a_nested_row_added_to_a_row_that_had_none_has_nothing_to_fall_back_on(
    tmp_path: Path,
) -> None:
    settings = store(tmp_path, volumes(row=[LABEL, TAKES]))
    settings.write({"volumes": [{"label": "Zoom H6"}]}, by=USER)

    outcome = settings.write({"volumes": [{"label": "Zoom H6", "takes": [{"file": 5}]}]}, by=USER)

    assert "(recorder 1).takes (take 1)" in outcome.refused[0].reason
    # The recorder is still recorded; the take the user was adding simply is not there.
    assert rows(settings.read().values["volumes"])[0]["takes"] == ()


def test_a_nested_table_cell_that_is_not_a_list_refuses_its_row(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(row=[LABEL, TAKES]))

    outcome = settings.write(
        {"volumes": [{"label": "Zoom H6", "takes": "one"}, {"label": "Field recorder"}]},
        by=USER,
    )

    assert outcome.refused[0].reason == (
        "volumes: recorder 1's takes must be a list of takes, got str"
    )
    assert [row["label"] for row in rows(settings.read().values["volumes"])] == ["Field recorder"]


def test_a_required_nested_table_with_no_rows_refuses_its_row(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(row=[LABEL, dict(TAKES, required=True)]))

    outcome = settings.write(
        {"volumes": [{"label": "Zoom H6", "takes": []}, {"label": "F8n", "takes": [{}]}]},
        by=USER,
    )

    assert outcome.refused[0].reason == (
        "volumes: recorder 1 holds no take, and every recorder must have at least one"
    )
    assert [row["label"] for row in rows(settings.read().values["volumes"])] == ["F8n"]


# --- a required table with no rows holds the plugin disabled (plan 0004, F1) ------------------


def test_a_required_table_with_no_rows_holds_the_plugin_disabled(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(required=True)).read()

    assert settings.hold is not None
    assert [problem.field for problem in settings.hold.problems] == ["volumes"]
    assert settings.hold.reason == "held disabled: volumes is required and holds no recorder"
    assert settings.availability is PluginAvailability.HELD
    assert "volumes" not in settings.values


def test_a_required_table_clears_its_hold_the_moment_one_valid_row_is_written(
    tmp_path: Path,
) -> None:
    settings = store(tmp_path, volumes(required=True))
    assert settings.read().hold is not None

    settings.write({"volumes": [{"label": "Zoom H6"}]}, by=USER)

    assert settings.read().hold is None
    assert settings.read().availability is PluginAvailability.ENABLED


def test_a_write_that_empties_a_required_table_holds_the_plugin_disabled(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(required=True))
    settings.write({"volumes": [{"label": "Zoom H6"}]}, by=USER)

    assert settings.write({"volumes": []}, by=USER).accepted

    assert "volumes = []" in settings.path.read_text(encoding="utf-8")
    assert settings.read().hold is not None


def test_a_required_table_whose_every_row_is_refused_is_held_rather_than_half_recorded(
    tmp_path: Path,
) -> None:
    settings = store(tmp_path, volumes(required=True))

    outcome = settings.write({"volumes": [{"volume_uuid": "8A1F-22C3"}]}, by=USER)

    assert outcome.recorded == ()
    assert not settings.path.exists()
    assert settings.read().hold is not None


def test_an_optional_table_nobody_has_written_holds_nothing_and_hands_over_nothing(
    tmp_path: Path,
) -> None:
    settings = store(tmp_path, volumes()).read()

    assert settings.hold is None
    assert "volumes" not in settings.values


def test_a_table_recorded_as_something_other_than_a_list_holds_the_plugin_disabled(
    tmp_path: Path,
) -> None:
    settings = store(tmp_path, volumes())
    settings.path.parent.mkdir(parents=True)
    settings.path.write_text('[values]\nvolumes = "Zoom H6"\n', encoding="utf-8")

    read = settings.read()

    assert read.hold is not None
    assert read.hold.why == "volumes must be a list of recorders, got str"
    # No rows to salvage, so the whole field is refused rather than half of it recorded.
    assert "volumes" not in read.values


def test_an_optional_table_with_no_rows_holds_nothing(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes())

    assert settings.write({"volumes": []}, by=USER).accepted

    read = settings.read()
    assert read.hold is None
    assert rows(read.values["volumes"]) == []


# --- what a column's own default fills in, and what a table's default starts from -------------


def test_a_column_default_fills_a_cell_the_row_leaves_out(tmp_path: Path) -> None:
    settings = store(tmp_path, volumes(row=[LABEL, GLOBS]))

    settings.write({"volumes": [{"label": "Zoom H6"}]}, by=USER)

    assert rows(settings.read().values["volumes"])[0]["globs"] == ("WAV/**/*.WAV",)


def test_a_nested_table_column_default_fills_the_cell_its_row_leaves_out(
    tmp_path: Path,
) -> None:
    settings = store(
        tmp_path,
        volumes(row=[LABEL, dict(TAKES, default=[{"file": "/tmp/default.wav"}])]),
    )

    settings.write({"volumes": [{"label": "Zoom H6"}]}, by=USER)

    takes = rows(rows(settings.read().values["volumes"])[0]["takes"])
    assert [take["file"] for take in takes] == ["/tmp/default.wav"]


def test_a_declared_default_table_is_handed_over_when_nothing_is_recorded(
    tmp_path: Path,
) -> None:
    settings = store(
        tmp_path,
        volumes(row=[LABEL, GLOBS], default=[{"label": "Zoom H6"}]),
    ).read()

    assert settings.hold is None
    assert dict(rows(settings.values["volumes"])[0]) == {
        "label": "Zoom H6",
        "globs": ("WAV/**/*.WAV",),
    }


# --- attribution is per field, never per row (D4) ---------------------------------------------


def test_a_table_write_records_one_writer_and_one_timestamp_however_many_rows_it_touched(
    tmp_path: Path,
) -> None:
    settings = store(tmp_path, volumes())

    settings.write(
        {"volumes": [{"label": f"recorder {number}"} for number in range(1, 6)]},
        by=USER,
    )

    attribution = settings.read().attribution
    assert list(attribution) == ["volumes"]
    assert attribution["volumes"].by == USER
    headers = [
        line
        for line in settings.path.read_text(encoding="utf-8").splitlines()
        if line.startswith("[written.")
    ]
    assert headers == ["[written.volumes]"]


# --- a secret is never recorded here, at any depth (plan 0004, D6) -----------------------------


def test_a_table_with_a_secret_column_is_refused_rather_than_written_to_this_file(
    tmp_path: Path,
) -> None:
    settings = store(
        tmp_path,
        volumes(row=[LABEL, {"id": "token", "type": "secret", "label": "Token"}]),
    )

    outcome = settings.write({"volumes": [{"label": "Zoom H6", "token": "hunter2"}]}, by=USER)

    assert [problem.field for problem in outcome.refused] == ["volumes"]
    assert "token" in outcome.refused[0].reason
    assert not settings.path.exists()
    # And it holds the plugin disabled rather than handing the rows over regardless.
    assert settings.read().hold is not None


def test_a_secret_column_in_a_nested_row_is_named_by_its_path_through_the_declaration(
    tmp_path: Path,
) -> None:
    takes = dict(TAKES, row=[{"id": "token", "type": "secret", "label": "Token"}])
    settings = store(tmp_path, volumes(row=[LABEL, takes]))

    outcome = settings.write(
        {"volumes": [{"label": "Zoom H6", "takes": [{"token": "hunter2"}]}]}, by=USER
    )

    assert "'takes.token'" in outcome.refused[0].reason
    assert not settings.path.exists()


# --- nothing here goes near the real config directory ------------------------------------------


@pytest.mark.parametrize("written_by", [USER, "monty"])
def test_every_file_these_tests_touch_lives_under_the_test_directory(
    tmp_path: Path, written_by: str
) -> None:
    settings = store(tmp_path, volumes(written_by="both"))

    settings.write({"volumes": [{"label": "Zoom H6"}]}, by=written_by)

    assert settings.path.is_relative_to(tmp_path)
    assert settings.read().attribution["volumes"].by == written_by
