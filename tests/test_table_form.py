"""The published table: rows, nested rows and per-cell errors, in one publish.

Plan 0005's slice 03, the form half. The application draws a table from the published form
and from nothing else — not the manifest, not the store, not the file — so a published table
field carries its row declaration, its rows in recorded order, whatever was submitted for a
row that was refused, and the reason for each bad cell placed on the cell it belongs to, at
every depth.

The address a refusal carries is the address the form places it at, so the application reads
one vocabulary rather than translating between two: a problem from :meth:`SettingsForm.save`
names a cell, and that same cell is where the next publish shows it.

Every store here writes under ``tmp_path``. Nothing in this file may read or write the real
per-user config directory.

Each refusal owns a test that turns red when its check is deleted, because the cheapest way to
"satisfy" a requirement to refuse something is to not implement it.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from innytypes.addons.manifest import SettingsField, parse_settings
from innytypes.addons.settings import (
    CellAddress,
    PluginAvailability,
    RowAt,
    SettingsStore,
)
from innytypes.addons.settings_form import FormField, FormRow, SettingsForm


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


def form(directory: Path, *fields: object, **kwargs: Any) -> SettingsForm:
    """A form over such a store, which is what the application is handed."""
    state = kwargs.pop("state", None)
    return SettingsForm(store(directory, *fields, **kwargs), state=state)


def published_table(directory: Path, *fields: object, **kwargs: Any) -> FormField:
    """The one published field these tests are about."""
    return form(directory, *fields, **kwargs).publish().field("volumes")


# --- the declarations these tests draw ---------------------------------------------------------

LABEL: dict[str, object] = {"id": "label", "type": "text", "label": "Name", "required": True}
UUID: dict[str, object] = {"id": "volume_uuid", "type": "text", "label": "Volume UUID"}
GLOBS: dict[str, object] = {
    "id": "globs",
    "type": "list of text",
    "label": "Patterns",
    "default": ["WAV/**/*.WAV"],
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
        "row": list(row) if row is not None else [LABEL, UUID, GLOBS],
    }
    field.update(overrides)
    return field


def markers(published: FormField) -> tuple[FormRow, ...]:
    """The marker rows of the first take of the first recorder — the depth-three case."""
    return published.row_at(1).rows["takes"][1].rows["markers"]


# --- a published table carries its declaration and its rows ------------------------------------


def test_a_published_table_carries_its_row_declaration_and_its_recorded_rows(
    tmp_path: Path,
) -> None:
    settings = form(tmp_path, volumes())
    settings.save(
        {
            "volumes": [
                {"label": "Zoom H6", "volume_uuid": "8A1F-22C3"},
                {"label": "Field recorder"},
            ]
        }
    )

    published = settings.publish().field("volumes")

    # The declaration, so the drawing knows what a cell is without reading a manifest.
    assert published.type == "table"
    assert published.row_label == "recorder"
    assert published.row is not None
    assert [column.id for column in published.row] == ["label", "volume_uuid", "globs"]
    # The rows, in the order they were recorded, each named as a person would name it.
    assert [row.position for row in published.rows] == [1, 2]
    assert [row.name for row in published.rows] == ["recorder 1", "recorder 2"]
    assert [row.values["label"] for row in published.rows] == ["Zoom H6", "Field recorder"]
    assert published.rows[0].values["volume_uuid"] == "8A1F-22C3"
    # A cell the row left out carries the column's own default, which is what the store
    # recorded for it — so the drawing shows what the plugin would be handed.
    assert published.rows[1].values["globs"] == ["WAV/**/*.WAV"]
    # A cell with neither a value nor a default is unanswered, and says so the one way the
    # form ever says it.
    assert published.rows[1].values["volume_uuid"] is None
    # Nothing is wrong with any of it, and the page says that by saying nothing.
    assert published.error is None
    assert [row.errors for row in published.rows] == [{}, {}]
    assert [row.error for row in published.rows] == [None, None]


def test_a_table_nobody_has_written_publishes_no_rows_and_no_error(tmp_path: Path) -> None:
    published = published_table(tmp_path, volumes())

    assert published.rows == ()
    assert published.error is None


# --- one bad cell, addressed to one cell -------------------------------------------------------


def test_a_cell_error_is_reachable_by_its_rows_position_and_its_fields_id(
    tmp_path: Path,
) -> None:
    """The whole point of publishing a table: the reason hangs on the cell it is about."""
    loose = form(tmp_path, volumes(row=[LABEL, GAIN]))
    loose.save({"volumes": [{"label": "one", "gain": 5}, {"label": "two", "gain": 1}]})

    # The plugin updates and its gain column tightens, so the second row no longer fits (D5).
    published = published_table(tmp_path, volumes(row=[LABEL, dict(GAIN, min=2)]))

    assert published.row_at(2).errors["gain"] == (
        "volumes: recorder 2's gain is 1, below the declared min 2"
    )
    # Addressed to a cell, so it is not also hanging over the whole table or over the row.
    assert published.error is None
    assert published.row_at(2).error is None
    assert published.row_at(1).errors == {}
    # And the row is still on the page, with the value that is being refused in it.
    assert published.row_at(2).values["gain"] == 1


def test_a_cell_error_does_not_leave_the_plugin_looking_healthy(tmp_path: Path) -> None:
    """A reason beside a cell is still a hold: the page says so at the top as well."""
    loose = form(tmp_path, volumes(row=[LABEL, GAIN]))
    loose.save({"volumes": [{"label": "one", "gain": 1}]})

    page = form(tmp_path, volumes(row=[LABEL, dict(GAIN, min=2)])).publish()

    assert page.availability is PluginAvailability.HELD
    assert page.reason is not None
    assert "recorder 1" in page.reason


def test_the_address_a_refusal_carries_is_the_address_the_form_places_it_at(
    tmp_path: Path,
) -> None:
    """One vocabulary: the application never translates a refusal into a place on the page."""
    settings = form(tmp_path, volumes(row=[LABEL, GAIN]))

    outcome = settings.save({"volumes": [{"label": "one", "gain": 5}, {"label": "two", "gain": 0}]})

    assert [problem.field for problem in outcome.refused] == ["volumes"]
    refused = outcome.refused[0]
    assert refused.cell == CellAddress(path=(RowAt("volumes", 2),), column="gain")

    published = settings.publish().field("volumes")
    assert published.error_for(refused.cell) == refused.reason
    # The row carries its own address, so a drawing that holds a row can ask about it too.
    assert published.row_at(2).address == refused.cell.row


# --- a row that is itself a table, to any depth ------------------------------------------------


def test_a_nested_row_publishes_its_own_rows_and_its_own_cell_errors_at_depth_three(
    tmp_path: Path,
) -> None:
    """D1: the whole tree is in one publish, and no consumer reads anything else to walk it."""
    loose = form(tmp_path, volumes(row=[LABEL, TAKES]))
    loose.save(
        {
            "volumes": [
                {
                    "label": "Zoom H6",
                    "takes": [
                        {"file": "/tmp/one.wav"},
                        {"file": "/tmp/two.wav", "markers": [{"at": 1}, {"at": 9}]},
                    ],
                }
            ]
        }
    )

    # The marker column tightens two levels down, so one marker of one take no longer fits.
    tight = dict(
        TAKES,
        row=[
            {"id": "file", "type": "path", "label": "File", "kind": "file"},
            dict(MARKERS, row=[{"id": "at", "type": "number", "label": "At", "min": 5}]),
        ],
    )
    published = published_table(tmp_path, volumes(row=[LABEL, tight]))

    # The nested rows are present, nested as declared, in recorded order.
    takes = published.row_at(1).rows["takes"]
    assert [take.values["file"] for take in takes] == ["/tmp/one.wav", "/tmp/two.wav"]
    assert [take.name for take in takes] == [
        "(recorder 1).takes (take 1)",
        "(recorder 1).takes (take 2)",
    ]
    assert [marker.values["at"] for marker in markers(published)] == [1, 9]

    # And so is the reason for the one bad cell among them, on that cell.
    assert markers(published)[0].errors["at"] == (
        "volumes: ((recorder 1).takes (take 2)).markers (marker 1)'s at is 1, "
        "below the declared min 5"
    )
    assert markers(published)[1].errors == {}
    # Nothing above it is accused of anything.
    assert published.error is None
    assert published.row_at(1).errors == {}
    assert takes[1].errors == {}


def test_a_nested_cell_error_is_addressed_by_the_path_down_to_it(tmp_path: Path) -> None:
    settings = form(tmp_path, volumes(row=[LABEL, TAKES]))

    outcome = settings.save(
        {
            "volumes": [
                {"label": "Zoom H6", "takes": [{"file": "/tmp/one.wav"}]},
                {
                    "label": "Field recorder",
                    "takes": [{"file": "/tmp/two.wav", "markers": [{"at": -1}]}],
                },
            ]
        }
    )

    refused = outcome.refused[0]
    assert refused.cell == CellAddress(
        path=(RowAt("volumes", 2), RowAt("takes", 1), RowAt("markers", 1)),
        column="at",
    )
    published = settings.publish().field("volumes")
    assert published.error_for(refused.cell) == refused.reason


def test_a_nested_table_column_is_published_as_rows_rather_than_as_a_cell(
    tmp_path: Path,
) -> None:
    """A table column is drawn as a table, so it is never also offered as a cell to draw."""
    settings = form(tmp_path, volumes(row=[LABEL, TAKES]))
    settings.save({"volumes": [{"label": "Zoom H6", "takes": [{"file": "/tmp/one.wav"}]}]})

    published = settings.publish().field("volumes")

    assert "takes" not in published.row_at(1).values
    assert set(published.row_at(1).rows) == {"takes"}
    assert published.row_at(1).rows["takes"][0].rows["markers"] == ()


# --- a refused row stays on the page, as it was submitted --------------------------------------


def test_a_refused_rows_submitted_values_are_published_beside_its_error(tmp_path: Path) -> None:
    """D2 on screen: the store keeps the row it had, and the person sees what they typed."""
    settings = form(tmp_path, volumes(row=[LABEL, GAIN]))
    settings.save({"volumes": [{"label": "one", "gain": 5}, {"label": "two", "gain": 5}]})

    settings.save({"volumes": [{"label": "one", "gain": 5}, {"label": "two-edited", "gain": 0}]})

    published = settings.publish().field("volumes")
    # What is on the page is what was submitted, both cells of it.
    assert published.row_at(2).values == {"label": "two-edited", "gain": 0}
    assert published.row_at(2).errors["gain"] == (
        "volumes: recorder 2's gain is 0, below the declared min 1"
    )
    # What is on disk is the row that was there before, untouched (slice 02's rule).
    on_disk = store(tmp_path, volumes(row=[LABEL, GAIN])).read().values["volumes"]
    assert [row["label"] for row in on_disk] == ["one", "two"]  # type: ignore[index]


def test_a_row_the_next_save_records_is_published_from_what_was_recorded(tmp_path: Path) -> None:
    """The submitted row is shown until it is corrected, and not one publish longer."""
    settings = form(tmp_path, volumes(row=[LABEL, GAIN]))
    settings.save({"volumes": [{"label": "one", "gain": 5}]})
    settings.save({"volumes": [{"label": "one-edited", "gain": 0}]})

    assert settings.publish().field("volumes").row_at(1).values["gain"] == 0

    settings.save({"volumes": [{"label": "one-edited", "gain": 7}]})

    published = settings.publish().field("volumes")
    assert published.row_at(1).values == {"label": "one-edited", "gain": 7}
    assert published.row_at(1).errors == {}
    assert published.error is None


# --- what is wrong with a row rather than with a cell ------------------------------------------


def test_a_row_carrying_a_key_the_declaration_does_not_name_is_the_rows_own_error(
    tmp_path: Path,
) -> None:
    settings = form(tmp_path, volumes(row=[LABEL, GAIN]))

    settings.save({"volumes": [{"label": "one", "gain": 5, "colour": "red"}]})

    published = settings.publish().field("volumes")
    row = published.row_at(1)
    assert row.error is not None
    assert "'colour'" in row.error
    # There is no cell called `colour` to hang it on, so nothing is hung on one.
    assert published.row_at(1).errors == {}
    assert "colour" not in published.row_at(1).values
    # And the declared cells are still on the page, so the row can be corrected.
    assert published.row_at(1).values == {"label": "one", "gain": 5}


def test_a_missing_required_cell_is_addressed_to_the_cell_that_is_missing(
    tmp_path: Path,
) -> None:
    settings = form(tmp_path, volumes(row=[LABEL, GAIN]))

    settings.save({"volumes": [{"gain": 5}]})

    published = settings.publish().field("volumes")
    assert "must have" in published.row_at(1).errors["label"]
    assert published.row_at(1).values["label"] is None


def test_a_row_that_is_not_a_mapping_of_cells_is_published_as_a_row_with_nothing_in_it(
    tmp_path: Path,
) -> None:
    settings = form(tmp_path, volumes(row=[LABEL, GAIN]))

    settings.save({"volumes": ["Zoom H6"]})

    published = settings.publish().field("volumes")
    assert published.row_at(1).error == "volumes: recorder 1 must be a mapping of cells, got str"
    assert published.row_at(1).values == {}
    assert published.row_at(1).rows == {}


# --- what is wrong with the table rather than with a row ---------------------------------------


def test_a_table_that_is_not_a_list_of_rows_is_the_fields_own_error(tmp_path: Path) -> None:
    settings = form(tmp_path, volumes())

    settings.save({"volumes": "Zoom H6"})

    published = settings.publish().field("volumes")
    assert published.error == "volumes must be a list of recorders, got str"
    assert published.rows == ()
    # One vocabulary here too: a refusal about the table itself is addressed to no row, and
    # reading that address back off the page gives the field's own reason.
    refused = settings.save({"volumes": "Zoom H6"}).refused[0]
    assert refused.cell == CellAddress(path=())
    assert published.error_for(refused.cell) == published.error


def test_an_address_the_page_no_longer_holds_answers_with_nothing(tmp_path: Path) -> None:
    """A refusal outlives the row it was about — the user deleted it — and is simply not there."""
    settings = form(tmp_path, volumes(row=[LABEL, TAKES]))
    settings.save({"volumes": [{"label": "Zoom H6"}]})

    published = settings.publish().field("volumes")

    assert published.error_for(CellAddress(path=(RowAt("volumes", 9),), column="label")) is None
    assert (
        published.error_for(
            CellAddress(path=(RowAt("volumes", 9), RowAt("takes", 1)), column="file")
        )
        is None
    )


def test_a_required_table_with_no_rows_says_so_above_the_table(tmp_path: Path) -> None:
    published = published_table(tmp_path, volumes(required=True))

    assert published.error == "volumes is required and holds no recorder"
    assert published.rows == ()


def test_a_nested_table_that_is_not_a_list_is_addressed_to_the_cell_that_holds_it(
    tmp_path: Path,
) -> None:
    settings = form(tmp_path, volumes(row=[LABEL, TAKES]))

    settings.save({"volumes": [{"label": "Zoom H6", "takes": "one"}]})

    published = settings.publish().field("volumes")
    assert published.row_at(1).errors["takes"] == (
        "volumes: recorder 1's takes must be a list of takes, got str"
    )
    assert published.row_at(1).rows["takes"] == ()


def test_a_row_asked_for_by_a_position_nobody_filled_is_refused_by_name(tmp_path: Path) -> None:
    published = published_table(tmp_path, volumes())

    with pytest.raises(KeyError, match="recorder 1"):
        published.row_at(1)


# --- nothing here goes near the real config directory ------------------------------------------


def test_every_file_these_tests_touch_lives_under_the_test_directory(tmp_path: Path) -> None:
    settings = form(tmp_path, volumes())

    settings.save({"volumes": [{"label": "Zoom H6"}]})

    assert settings.publish().field("volumes").row_at(1).values["label"] == "Zoom H6"
    assert store(tmp_path, volumes()).path.is_relative_to(tmp_path)
