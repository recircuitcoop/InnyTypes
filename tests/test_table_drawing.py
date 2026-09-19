"""The table's drawing: an outline of rows, at every depth, on all three platforms.

Plan 0005's slice 04. A table is the first field whose widget is not one control, and D1's
nesting makes a declaration a tree, so what this slice draws is an outline of rows that
expand rather than a grid. Each row is drawn cell by cell with the widget its own column's
type already has, a column that is itself a table becomes a collapsible group under its row,
only the first columns are shown and the rest sit behind a per-row **more** (D7), **Add**
appends a row of the columns' own defaults, **Remove** asks first when the row is not empty
(D5), and rows drag to reorder (D6).

Four things here would pass by accident if nobody wrote the test that could fail, so each is
written to turn red when its code is deleted:

* **The tenth drawing.** The type-to-widget table and the toolkit's own builder table are
  each stripped of the table's entry, and both removals have to stop the page by name. A
  field type with no drawing must never be a setting quietly missing from the form.
* **Remove asks.** A row holding values is pressed for removal and has to **still be there**
  afterwards, with the question on it, until the confirmation is given. The cheapest way to
  "pass" a requirement to ask first is to not ask.
* **A reorder reaches the store.** Two rows are dragged past each other through the real
  widgets and the real page, and the assertion is on what the **store** holds afterwards —
  not on what the drawing thinks it did.
* **A cell behind the more survives a save.** Five of monty's eight columns are off the
  screen when Save is pressed, and they have to come back recorded rather than emptied.

Nothing real is behind any of it. The stand-in toolkit and the machine under ``tmp_path`` are
the ones `tests/test_plugin_page.py` already drives every other field type through — imported
rather than copied, because two stand-ins are two drawings that drift — and no GUI toolkit is
imported, no process is spawned, nothing sleeps and nothing reaches a network.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from innytypes.addons.manifest import SETTINGS_FIELD_TYPES, SETTINGS_TABLE_TYPE
from innytypes.helper.plugins import PluginPage
from innytypes.helper.toolkit import SAVE_LABEL, TogaDesktop, Toolkit
from innytypes.helper.window import (
    FIELD_WIDGETS,
    GROUP_COLLAPSE_LABEL,
    GROUP_EXPAND_LABEL,
    ROW_DROP_LABEL,
    ROW_FEWER_LABEL,
    ROW_KEEP_LABEL,
    ROW_MORE_LABEL,
    ROW_MOVE_LABEL,
    ROW_REMOVE_LABEL,
    ROW_REMOVE_NOW_LABEL,
    SHOWN_COLUMNS,
    HeadlessDesktop,
    TableDrawing,
    WidgetKind,
    WindowError,
)

# The machine, the stand-in toolkit and the whole-source scan every other field type is
# already held to. Imported so that "the table is drawn through the same stand-in" is the
# same object rather than a second one that looks like it.
from test_application_window import TRAY_APIS
from test_plugin_page import (
    TEN_TYPES,
    FakeToga,
    Machine,
    Widget,
    a_host,
    a_page,
    shape,
)

# --- the declarations these tests draw ---------------------------------------------------------

NAME: dict[str, object] = {"id": "name", "type": "text", "label": "Name", "required": True}
DESTINATION: dict[str, object] = {
    "id": "destination",
    "type": "path",
    "label": "Copy to",
    "kind": "folder",
}
GAIN: dict[str, object] = {"id": "gain", "type": "number", "label": "Gain", "min": 1}

# A table nested two levels deep: a recorder holds takes, and a take holds markers.
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

# monty's own record, which is what D7 is about: eight columns is more than fits on one line.
WIDE: list[dict[str, object]] = [
    {"id": "label", "type": "text", "label": "Name"},
    {"id": "volume_uuid", "type": "text", "label": "Volume UUID"},
    {"id": "volume_name", "type": "text", "label": "Volume name"},
    {"id": "globs", "type": "list of text", "label": "Patterns"},
    {"id": "destination", "type": "path", "label": "Copy to", "kind": "folder"},
    {"id": "speakers", "type": "list of text", "label": "Speakers"},
    {"id": "language", "type": "choice", "label": "Language", "options": ["nl", "fr", "en"]},
    {"id": "gain", "type": "number", "label": "Gain", "min": 0},
]

# Every column of this one declares a default, which is what **Add** fills a new row with.
DEFAULTED: list[dict[str, object]] = [
    {"id": "name", "type": "text", "label": "Name", "default": "New recorder"},
    {
        "id": "language",
        "type": "choice",
        "label": "Language",
        "options": ["nl", "fr"],
        "default": "nl",
    },
    {"id": "gain", "type": "number", "label": "Gain", "min": 1, "default": 3},
]

ADD_RECORDER = "Add recorder"
ADD_TAKE = "Add take"
ADD_MARKER = "Add marker"


def volumes(
    *, row: list[dict[str, object]] | None = None, **overrides: object
) -> dict[str, object]:
    """monty's recorders: one table that parses, so each test can change exactly one thing."""
    declared: dict[str, object] = {
        "id": "volumes",
        "type": "table",
        "label": "Recorders",
        "row_label": "recorder",
        "row": list(row) if row is not None else [NAME, DESTINATION],
    }
    declared.update(overrides)
    return declared


# --- the machine, the desktops and the page -----------------------------------------------------


@pytest.fixture
def machine(tmp_path: Path) -> Machine:
    """One machine's plugin state, every path of it under ``tmp_path``."""
    return Machine(
        addons_root=tmp_path / "addons",
        config_path=tmp_path / "config" / "config.toml",
        secrets_root=tmp_path / "config" / "secrets",
    )


@pytest.fixture
def toga() -> FakeToga:
    return FakeToga()


@pytest.fixture
def drawing(toga: FakeToga) -> TogaDesktop:
    """A toolkit-backed desktop with its window already open, as :meth:`run` leaves it."""
    desktop = TogaDesktop(toolkit=Toolkit(toga=toga, pack=dict, column="column"))
    desktop.run(lambda: None)
    return desktop


def drawn_page(
    machine: Machine,
    *declared: dict[str, object],
    rows: list[dict[str, object]] | None = None,
) -> tuple[PluginPage, HeadlessDesktop]:
    """A plugin with these settings, its rows planted, drawn through the headless desktop."""
    machine.install("monty", settings=declared)
    if rows is not None:
        machine.store("monty").write({"volumes": rows}, by="user")
    page, desktop = a_page(a_host(machine))
    page.open()
    return page, desktop


def table_of(desktop: HeadlessDesktop, field_id: str = "volumes") -> TableDrawing:
    """The one table on the page, asserted to be there rather than assumed to be."""
    table = desktop.table("monty", field_id)
    assert table is not None, f"the page is not showing {field_id}"
    return table


# --- reading the widget tree the toolkit builds --------------------------------------------------


def walk(widget: Widget) -> list[Widget]:
    """One widget and everything under it, so an absence can be asserted over all of it."""
    found = [widget]
    for child in widget.children:
        found.extend(walk(child))
    return found


def table_box(page: Widget, add_label: str) -> Widget:
    """One table's box: the one whose own children hold that table's **Add** control."""
    for widget in walk(page):
        if widget.kind != "box":
            continue
        if any(child.kind == "button" and child.text == add_label for child in widget.children):
            return widget
    raise AssertionError(f"nothing on the page is a table with an {add_label!r} control")


def row_boxes(table: Widget) -> list[Widget]:
    """The row boxes of one table's box, in the order they are drawn."""
    return [child for child in table.children if child.kind == "box"]


def pressable(widget: Widget, text: str) -> Widget:
    """The one control anywhere under ``widget`` that says this, or a failure naming it."""
    found = [one for one in walk(widget) if one.kind == "button" and one.text == text]
    assert len(found) == 1, f"{text!r}: {len(found)} controls, expected one"
    return found[0]


def said(widget: Widget) -> list[str]:
    """Every string anywhere in one widget tree, however deep it is."""
    return [
        str(value)
        for one in walk(widget)
        for value in one.options.values()
        if isinstance(value, str)
    ]


def indent_of(box: Widget) -> int:
    """How far in one box is drawn — the whole of how depth is shown (D1)."""
    style: dict[str, Any] = box.options["style"]
    return int(style["margin_left"])


def open_page(machine: Machine, desktop: TogaDesktop) -> tuple[PluginPage, Widget]:
    """Draw the installed plugin's page with the real page and the stand-in toolkit."""
    page, _ = a_page(a_host(machine), desktop)
    page.open()
    assert desktop.window is not None
    content = desktop.window.content
    assert content is not None
    return page, content


def shown(desktop: TogaDesktop) -> Widget:
    """Whatever is on the window right now, after a control redrew it."""
    assert desktop.window is not None
    content = desktop.window.content
    assert content is not None
    return content


# --- a row is its columns' own widgets -----------------------------------------------------------


def test_a_rows_cells_are_the_widgets_their_own_columns_already_have(machine: Machine) -> None:
    """A `path` column gets the picker a top-level `path` field gets, and nothing else.

    The point of the closed vocabulary, one level down: a table brings no widget of its own,
    it only repeats the ones there are.
    """
    _, desktop = drawn_page(
        machine,
        volumes(),
        rows=[
            {"name": "Zoom H6", "destination": "/recordings/zoom"},
            {"name": "Field recorder", "destination": "/recordings/field"},
        ],
    )

    table = table_of(desktop)
    assert [row.name for row in table.drawn] == ["recorder 1", "recorder 2"]
    for row in table.drawn:
        assert [cell.widget for cell in row.cells] == [WidgetKind.TEXT, WidgetKind.PATH]
        assert [cell.field_id for cell in row.cells] == ["name", "destination"]
        # The `kind` a picker needs is the column's own, exactly as a top-level path's is.
        assert row.cells[1].path_kind == "folder"
    assert [row.cells[0].value for row in table.drawn] == ["Zoom H6", "Field recorder"]
    # The whole table is one widget kind on the page, and it is the tenth one.
    volumes_field = desktop.drawn("monty", "volumes")
    assert volumes_field is not None and volumes_field.widget is WidgetKind.TABLE


def test_the_toolkit_builds_one_row_of_widgets_for_every_recorded_row(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """Two rows, a text column and a path column: the widget shape of each cell, asserted."""
    machine.install("monty", settings=[volumes()])
    machine.store("monty").write(
        {
            "volumes": [
                {"name": "Zoom H6", "destination": "/recordings/zoom"},
                {"name": "Field recorder", "destination": "/recordings/field"},
            ]
        },
        by="user",
    )

    _, content = open_page(machine, drawing)

    rows = row_boxes(table_box(content, ADD_RECORDER))
    # The handle, the text column's own input, the path column's own picker, and Remove.
    assert [shape(row) for row in rows] == [
        "box(button,text-input,box(label,button),button)",
        "box(button,text-input,box(label,button),button)",
    ]


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_a_tables_widget_tree_is_the_same_on_every_platform(
    machine: Machine, toga: FakeToga, monkeypatch: pytest.MonkeyPatch, platform: str
) -> None:
    """One drawing, no platform branch — which is what "on all three platforms" has to mean."""
    monkeypatch.setattr(sys, "platform", platform)
    desktop = TogaDesktop(toolkit=Toolkit(toga=toga, pack=dict, column="column"))
    desktop.run(lambda: None)
    machine.install("monty", settings=[volumes(row=[NAME, TAKES])])
    machine.store("monty").write(
        {"volumes": [{"name": "Zoom H6", "takes": [{"file": "/one.wav", "markers": []}]}]},
        by="user",
    )

    _, content = open_page(machine, desktop)

    assert shape(table_box(content, ADD_RECORDER)) == (
        # One recorder: its handle, its name, Remove — and the takes group under it, which is
        # a label, its Collapse, one take (handle, file picker, Remove, the take's own empty
        # markers group) and its Add. Each table's own Add closes it.
        "box(box(button,text-input,button,box(label,button,box(button,box(label,button),"
        "button,box(label,button,button)),button)),button)"
    )


# --- nesting: a group under its row, indented by its depth (D1) ---------------------------------


def test_a_table_column_draws_as_a_collapsible_group_under_the_row_that_holds_it(
    machine: Machine,
) -> None:
    """Two levels of nesting, both present, each one deeper than the row it hangs under."""
    _, desktop = drawn_page(
        machine,
        volumes(row=[NAME, TAKES]),
        rows=[
            {
                "name": "Zoom H6",
                "takes": [{"file": "/one.wav", "markers": [{"at": 1.5}, {"at": 9.0}]}],
            }
        ],
    )

    recorders = table_of(desktop)
    assert recorders.depth == 0
    (recorder,) = recorders.drawn

    (takes,) = recorder.tables
    assert (takes.column_id, takes.row_label, takes.depth) == ("takes", "take", 1)
    (take,) = takes.drawn
    # Named and addressed the way the store names and addresses it, never a second spelling.
    assert take.name == "(recorder 1).takes (take 1)"
    assert [step.column for step in take.address.path] == ["volumes", "takes"]

    (markers,) = take.tables
    assert (markers.column_id, markers.row_label, markers.depth) == ("markers", "marker", 2)
    assert [row.cells[0].value for row in markers.drawn] == [1.5, 9.0]
    # A table column is drawn as a table and never also as a cell of its row.
    assert [cell.field_id for cell in recorder.cells] == ["name"]


def test_the_deeper_level_is_drawn_indented_under_the_row_it_belongs_to(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """Depth is shown as indentation, and one number per level is the whole of it."""
    machine.install("monty", settings=[volumes(row=[NAME, TAKES])])
    machine.store("monty").write(
        {"volumes": [{"name": "Zoom H6", "takes": [{"file": "/one.wav", "markers": [{"at": 1}]}]}]},
        by="user",
    )

    _, content = open_page(machine, drawing)

    recorders = table_box(content, ADD_RECORDER)
    takes = table_box(content, ADD_TAKE)
    markers = table_box(content, ADD_MARKER)
    assert indent_of(recorders) < indent_of(takes) < indent_of(markers)
    # Both levels really are inside the row above them rather than beside it.
    assert takes in walk(recorders)
    assert markers in walk(takes)


def test_a_collapsed_group_is_its_rows_first_column_alone(machine: Machine) -> None:
    """A deep declaration stays readable because a group folds away (plan 0005)."""
    _, desktop = drawn_page(
        machine,
        volumes(row=[NAME, TAKES]),
        rows=[{"name": "Zoom H6", "takes": [{"file": "/one.wav", "markers": [{"at": 1.5}]}]}],
    )
    (recorder,) = table_of(desktop).drawn
    (takes,) = recorder.tables
    assert takes.group is not None and takes.group.label == GROUP_COLLAPSE_LABEL

    takes.toggle_group()

    (take,) = takes.drawn
    assert [cell.field_id for cell in take.cells] == ["file"]
    # And what is under it is out of the way until somebody expands it again.
    assert take.tables == ()
    assert takes.group is not None and takes.group.label == GROUP_EXPAND_LABEL


# --- D7: the first columns, and the rest behind a per-row more ------------------------------------


def test_only_a_rows_first_columns_are_drawn_until_its_more_is_used(machine: Machine) -> None:
    """monty's record is eight columns wide, and eight widgets on one line is D7's case."""
    _, desktop = drawn_page(
        machine,
        volumes(row=WIDE),
        rows=[{"label": "Zoom H6", "language": "nl"}],
    )
    table = table_of(desktop)

    (row,) = table.drawn
    assert len(row.cells) == SHOWN_COLUMNS < len(WIDE)
    assert row.hidden == ("globs", "destination", "speakers", "language", "gain")
    assert row.more is not None and row.more.label.startswith(ROW_MORE_LABEL)

    table.toggle_more(1)

    (expanded,) = table.drawn
    assert [cell.field_id for cell in expanded.cells] == [str(column["id"]) for column in WIDE]
    assert expanded.hidden == ()
    assert expanded.more is not None and expanded.more.label == ROW_FEWER_LABEL


def test_the_more_control_puts_every_column_of_that_row_on_the_screen(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """The same thing through the real control: press **more**, and the rest are drawn."""
    machine.install("monty", settings=[volumes(row=WIDE)])
    machine.store("monty").write({"volumes": [{"label": "Zoom H6"}]}, by="user")
    _, content = open_page(machine, drawing)

    def cells(page: Widget) -> list[str]:
        (row,) = row_boxes(table_box(page, ADD_RECORDER))
        return [one.kind for one in row.children if one.kind not in {"button", "label"}]

    before = cells(content)
    assert len(before) < len(WIDE)

    (row,) = row_boxes(table_box(content, ADD_RECORDER))
    pressable(row, [one.text for one in walk(row) if one.text.startswith(ROW_MORE_LABEL)][0])
    for control in walk(row):
        if control.kind == "button" and control.text.startswith(ROW_MORE_LABEL):
            control.press()
            break

    assert len(cells(shown(drawing))) == len(WIDE)


def test_a_cell_behind_the_more_is_not_emptied_by_a_save(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """Five of the eight columns are off the screen when Save is pressed, and they survive it.

    The mutation this catches is a drawing that submits only what it drew: a person who never
    opened a row's **more** would silently wipe the columns behind it.
    """
    machine.install("monty", settings=[volumes(row=WIDE)])
    machine.store("monty").write(
        {"volumes": [{"label": "Zoom H6", "language": "fr", "gain": 4}]}, by="user"
    )
    page, content = open_page(machine, drawing)
    drawing.on_configure = page.configure

    pressable(content, SAVE_LABEL).press()

    (recorded,) = machine.store("monty").read().values["volumes"]
    assert recorded["label"] == "Zoom H6"
    assert (recorded["language"], recorded["gain"]) == ("fr", 4)


# --- Add: a row of the columns' own defaults -------------------------------------------------


def test_add_appends_a_row_holding_each_columns_own_declared_default(machine: Machine) -> None:
    """The defaulting rule slice 01 already judges, applied where a new row comes from."""
    _, desktop = drawn_page(machine, volumes(row=DEFAULTED), rows=[{"name": "Zoom H6"}])
    table = table_of(desktop)

    position = table.add_row()

    assert position == 2
    added = table.drawn[1]
    assert added.name == "recorder 2"
    assert {cell.field_id: cell.value for cell in added.cells} == {
        "name": "New recorder",
        "language": "nl",
        "gain": 3,
    }
    # And it is what a Save would carry, in the place it was added to.
    assert table.values()[1] == {"name": "New recorder", "language": "nl", "gain": 3}


def test_the_add_control_says_what_the_plugin_calls_a_row(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """`row_label` has no default precisely so no control anywhere says "row" (slice 01)."""
    machine.install("monty", settings=[volumes(row=DEFAULTED)])
    machine.store("monty").write({"volumes": [{"name": "Zoom H6"}]}, by="user")
    _, content = open_page(machine, drawing)
    assert len(row_boxes(table_box(content, ADD_RECORDER))) == 1

    pressable(content, ADD_RECORDER).press()

    rows = row_boxes(table_box(shown(drawing), ADD_RECORDER))
    assert len(rows) == 2
    assert [one.value for one in rows[1].children if one.kind == "text-input"] == ["New recorder"]


def test_what_was_typed_into_a_row_survives_an_add(machine: Machine, drawing: TogaDesktop) -> None:
    """Pressing **Add** redraws the page, and what is on it goes back into the rows first."""
    machine.install("monty", settings=[volumes(row=[NAME])])
    machine.store("monty").write({"volumes": [{"name": "Zoom H6"}]}, by="user")
    _, content = open_page(machine, drawing)
    typed = next(one for one in walk(content) if one.kind == "text-input")
    typed.options["value"] = "Renamed by hand"

    pressable(content, ADD_RECORDER).press()

    rows = row_boxes(table_box(shown(drawing), ADD_RECORDER))
    assert [one.value for one in rows[0].children if one.kind == "text-input"] == [
        "Renamed by hand"
    ]


# --- Remove: immediately when the row is empty, and asking first when it is not (D5) -------------


def test_an_empty_row_is_removed_without_asking(machine: Machine) -> None:
    _, desktop = drawn_page(machine, volumes(row=[NAME]), rows=[{"name": "Zoom H6"}])
    table = table_of(desktop)
    table.add_row()
    assert len(table.rows) == 2

    removed = table.remove_row(2)

    assert removed is True
    assert [row.name for row in table.drawn] == ["recorder 1"]
    assert table.drawn[0].question is None


def test_a_row_that_holds_something_is_not_removed_until_it_is_confirmed(
    machine: Machine,
) -> None:
    """D5, and the mutation: a Remove that skipped the question would delete this row here."""
    _, desktop = drawn_page(
        machine, volumes(row=[NAME]), rows=[{"name": "Zoom H6"}, {"name": "Field recorder"}]
    )
    table = table_of(desktop)

    removed = table.remove_row(1)

    assert removed is False
    assert [row.name for row in table.drawn] == ["recorder 1", "recorder 2"]
    asked = table.drawn[0]
    assert asked.question == "recorder 1 holds values. Remove it?"
    assert asked.confirm is not None and asked.keep is not None

    assert table.confirm_removal(1) is True
    assert [row.cells[0].value for row in table.drawn] == ["Field recorder"]


def test_a_row_with_a_nested_row_in_it_is_never_empty(machine: Machine) -> None:
    """What would be lost is the nested row, and D5 exists so nothing is lost unasked."""
    _, desktop = drawn_page(
        machine,
        volumes(row=[NAME, TAKES]),
        rows=[{"name": "", "takes": [{"file": "/one.wav"}]}],
    )
    table = table_of(desktop)

    assert table.remove_row(1) is False
    assert len(table.rows) == 1


def test_keeping_a_row_puts_the_question_away_and_changes_nothing_else(machine: Machine) -> None:
    _, desktop = drawn_page(machine, volumes(row=[NAME]), rows=[{"name": "Zoom H6"}])
    table = table_of(desktop)
    table.remove_row(1)

    table.keep_row(1)

    assert table.drawn[0].question is None
    assert [row.cells[0].value for row in table.drawn] == ["Zoom H6"]


def test_a_removal_nobody_asked_about_is_refused(machine: Machine) -> None:
    """The other half of D5: the confirmation confirms one question, not any removal."""
    _, desktop = drawn_page(machine, volumes(row=[NAME]), rows=[{"name": "Zoom H6"}])
    table = table_of(desktop)

    with pytest.raises(WindowError, match="recorder 1"):
        table.confirm_removal(1)


def test_the_remove_control_asks_on_the_row_and_takes_it_out_when_answered(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """The same rule through the real controls, which is where a person meets it."""
    machine.install("monty", settings=[volumes(row=[NAME])])
    machine.store("monty").write(
        {"volumes": [{"name": "Zoom H6"}, {"name": "Field recorder"}]}, by="user"
    )
    _, content = open_page(machine, drawing)

    rows = row_boxes(table_box(content, ADD_RECORDER))
    pressable(rows[0], ROW_REMOVE_LABEL).press()

    asking = shown(drawing)
    assert len(row_boxes(table_box(asking, ADD_RECORDER))) == 2
    assert "recorder 1 holds values. Remove it?" in said(asking)
    assert ROW_KEEP_LABEL in said(asking)

    pressable(asking, ROW_REMOVE_NOW_LABEL).press()

    after = shown(drawing)
    assert len(row_boxes(table_box(after, ADD_RECORDER))) == 1
    assert "recorder 1 holds values. Remove it?" not in said(after)


# --- D6: rows drag to reorder, and a Save afterwards writes the new order ------------------------


def test_moving_a_row_changes_the_order_a_save_would_carry(machine: Machine) -> None:
    _, desktop = drawn_page(
        machine, volumes(row=[NAME]), rows=[{"name": "Zoom H6"}, {"name": "Field recorder"}]
    )
    table = table_of(desktop)

    table.move_row(1, 2)

    assert [row["name"] for row in table.values()] == ["Field recorder", "Zoom H6"]
    # The rows are renamed by where they are now, because that is what a person sees.
    assert [row.name for row in table.drawn] == ["recorder 1", "recorder 2"]


def test_a_save_after_a_drag_records_the_rows_in_their_new_order(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """D6, end to end and against the store: the reorder has to reach the file.

    The assertion is on what the store holds afterwards, so a drag that only rearranged
    widgets — or one the Save read past — fails here rather than looking like it worked.
    """
    machine.install("monty", settings=[volumes(row=[NAME])])
    machine.store("monty").write(
        {"volumes": [{"name": "Zoom H6"}, {"name": "Field recorder"}]}, by="user"
    )
    page, content = open_page(machine, drawing)
    drawing.on_configure = page.configure

    rows = row_boxes(table_box(content, ADD_RECORDER))
    # The handle is the first control on a row: pressed on the row to move, then on the place
    # to move it to, which is the same `move_row` a pointer drag would call.
    assert rows[0].children[0].text == ROW_MOVE_LABEL
    rows[0].children[0].press()

    held = row_boxes(table_box(shown(drawing), ADD_RECORDER))
    assert held[1].children[0].text == ROW_DROP_LABEL
    held[1].children[0].press()

    pressable(shown(drawing), SAVE_LABEL).press()

    recorded = machine.store("monty").read().values["volumes"]
    assert [row["name"] for row in recorded] == ["Field recorder", "Zoom H6"]


def test_a_row_can_be_put_back_down_where_it_was_picked_up(machine: Machine) -> None:
    """Pressing the handle twice is not a reorder, which is how a drag is called off."""
    _, desktop = drawn_page(
        machine, volumes(row=[NAME]), rows=[{"name": "Zoom H6"}, {"name": "Field recorder"}]
    )
    table = table_of(desktop)

    table.grab(1)
    table.grab(1)

    assert table.grabbed is None
    assert [row["name"] for row in table.values()] == ["Zoom H6", "Field recorder"]


# --- where a reason is drawn ---------------------------------------------------------------------


def test_a_cells_reason_is_drawn_beside_that_cell_and_nowhere_else(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """A refused cell is shown as it was submitted, with the reason next to it."""
    machine.install("monty", settings=[volumes(row=[NAME, GAIN])])
    page, _ = open_page(machine, drawing)

    page.configure("monty", {"volumes": [{"name": "Zoom H6", "gain": 0}]})

    content = shown(drawing)
    reason = "volumes: recorder 1's gain is 0, below the declared min 1"
    (row,) = row_boxes(table_box(content, ADD_RECORDER))
    children = row.children
    gain = next(i for i, one in enumerate(children) if one.kind == "number")
    # Immediately beside the cell it is about — the next widget along, and nothing between.
    assert children[gain + 1].kind == "label"
    assert children[gain + 1].text == reason
    # Said once on the whole page, and never above the table as if the table were wrong.
    assert said(content).count(reason) == 1
    assert table_box(content, ADD_RECORDER).children[0].kind != "label"


def test_the_tables_own_reason_is_drawn_once_above_the_whole_table(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """The reason names the table: it is required and holds no recorder, and no row is wrong."""
    machine.install("monty", settings=[volumes(row=[NAME], required=True)])
    machine.store("monty").write({"volumes": [{"name": "Zoom H6"}]}, by="user")
    page, _ = open_page(machine, drawing)

    page.configure("monty", {"volumes": []})

    content = shown(drawing)
    reason = "volumes is required and holds no recorder"
    box = table_box(content, ADD_RECORDER)
    assert box.children[0].kind == "label" and box.children[0].text == reason
    assert said(content).count(reason) == 1
    assert row_boxes(box) == []


def test_the_two_reasons_are_placed_independently(machine: Machine) -> None:
    """A cell's reason hangs on the cell, and the field's own error is never a cell's."""
    machine.install("monty", settings=[volumes(row=[NAME, GAIN])])
    page, desktop = a_page(a_host(machine))
    page.configure("monty", {"volumes": [{"name": "Zoom H6", "gain": 0}]})
    page.open()

    table = table_of(desktop)
    assert table.error is None
    (row,) = table.drawn
    assert row.error is None
    assert row.cells[1].error == "volumes: recorder 1's gain is 0, below the declared min 1"
    assert row.cells[1].cell is not None and row.cells[1].cell.column == "gain"
    assert row.cells[0].error is None


# --- the vocabulary this slice grew ---------------------------------------------------------------


def test_the_vocabulary_the_parametrised_drawing_tests_cover_has_grown_by_one() -> None:
    """The every-declared-type-has-a-drawing tests draw their cases from these lists.

    Both of them are parametrised over what is asserted here, so a tenth type that nobody
    drew fails them — which is why this type could not be half-added.
    """
    assert set(FIELD_WIDGETS) == set(SETTINGS_FIELD_TYPES) | {SETTINGS_TABLE_TYPE}
    assert len(FIELD_WIDGETS) == len(SETTINGS_FIELD_TYPES) + 1
    # The named types plus `list of <type>`, which is composed rather than named.
    assert len(WidgetKind) == len(FIELD_WIDGETS) + 1 == 10
    assert set(TogaDesktop._WIDGETS) == set(WidgetKind)
    assert len(set(TogaDesktop._WIDGETS.values())) == len(WidgetKind)
    # And the declaration the page's own drawing tests sweep is ten types, one per widget.
    assert len(TEN_TYPES) == 10
    assert SETTINGS_TABLE_TYPE in [declared["type"] for declared in TEN_TYPES]


def test_the_page_draws_all_ten_widgets_when_a_table_is_declared(machine: Machine) -> None:
    """The tenth drawing really is on the page, rather than merely declared in an enum."""
    machine.install("monty", settings=TEN_TYPES)
    machine.store("monty").write({"extras": ["/one"]}, by="user")
    page, desktop = a_page(a_host(machine))

    page.open()

    assert desktop.drawn_widgets == frozenset(WidgetKind)
    assert WidgetKind.TABLE in desktop.drawn_widgets


def test_a_table_with_no_widget_for_it_stops_the_page_by_name(
    machine: Machine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The mutation: take the table out of the type-to-widget table and the page must refuse."""
    from innytypes.helper import window

    short = {name: kind for name, kind in FIELD_WIDGETS.items() if name != SETTINGS_TABLE_TYPE}
    monkeypatch.setattr(window, "FIELD_WIDGETS", short)
    machine.install("monty", settings=[volumes()])
    page, _ = a_page(a_host(machine))

    with pytest.raises(WindowError, match=SETTINGS_TABLE_TYPE):
        page.open()


def test_a_toolkit_that_cannot_build_the_outline_stops_the_page_by_name(
    machine: Machine, drawing: TogaDesktop, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same mutation against the toolkit's own builder table."""
    short = {
        one: builder for one, builder in TogaDesktop._WIDGETS.items() if one is not WidgetKind.TABLE
    }
    monkeypatch.setattr(TogaDesktop, "_WIDGETS", short)
    machine.install("monty", settings=[volumes()])
    page, _ = a_page(a_host(machine), drawing)

    with pytest.raises(WindowError, match=str(WidgetKind.TABLE)):
        page.open()


def test_a_columns_type_with_no_widget_stops_the_page_too(
    machine: Machine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A table is only drawable while every one of its columns is."""
    from innytypes.helper import window

    short = {name: kind for name, kind in FIELD_WIDGETS.items() if name != "path"}
    monkeypatch.setattr(window, "FIELD_WIDGETS", short)
    machine.install("monty", settings=[volumes()])
    page, _ = a_page(a_host(machine))

    with pytest.raises(WindowError, match="path"):
        page.open()


# --- the icon this drawing still does not add ---------------------------------------------------


def test_the_table_drawing_adds_no_path_to_the_system_tray(machine: Machine) -> None:
    """F4, re-run over the tree with this slice's drawing code in it.

    The same whole-source scan `tests/test_application_window.py` runs, repeated here because
    this slice is the one that added a pile of controls to the drawing — and a control is
    exactly the kind of thing somebody puts in a tray menu.
    """
    source = Path(__file__).resolve().parents[1] / "src" / "innytypes"
    offenders: list[str] = []

    for path in sorted(source.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for api in TRAY_APIS:
            if api in text:
                offenders.append(f"{path.name}: {api}")
        if ".add_status_item(" in text:
            offenders.append(f"{path.name}: calls add_status_item")

    assert offenders == []


def test_drawing_a_table_through_the_toolkit_registers_no_status_item(
    machine: Machine, drawing: TogaDesktop
) -> None:
    """And the implementation that could add one still refuses to, with a table on the page."""
    machine.install("monty", settings=[volumes(row=WIDE)])
    machine.store("monty").write({"volumes": [{"label": "Zoom H6"}]}, by="user")
    _, content = open_page(machine, drawing)
    pressable(content, ADD_RECORDER).press()

    with pytest.raises(WindowError, match="system tray"):
        drawing.add_status_item("InnyTypes")
