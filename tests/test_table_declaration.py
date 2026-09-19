"""The `table` declaration: a repeating group of declared fields, nested to any depth.

Plan 0005 adds the tenth type to plan 0004's closed vocabulary, because a volume source is
not a value — it is a record, and monty has several of them. A table declares its columns the
way a settings section declares its fields, so **a row is judged by exactly the rules a
top-level field is**: its own type, its own constraints, its own default. The only new things
are the shape (`row`), the noun an Add button says (`row_label`) and the optional `unique`
marking that gives a row an identity the host never assigns.

Every refusal here owns a test that turns red when its check is deleted, and every refusal is
asserted to name **which column, at which depth** broke the rule — the person reading the
message is a plugin author looking for their own typo, and "row 2" is not something they can
find in a manifest.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

import pytest

from innytypes.addons.manifest import (
    SETTINGS_FIELD_TYPES,
    SETTINGS_TABLE_TYPE,
    SETTINGS_UNIQUE_TYPES,
    ManifestError,
    SettingsField,
    parse_settings,
)


def declared(*fields: object) -> tuple[SettingsField, ...]:
    """Parse a settings section and hand back the fields it declares."""
    return parse_settings(list(fields))


def default_rows(field: SettingsField) -> list[Mapping[str, object]]:
    """A table's declared default rows, read the way a later slice will read them."""
    assert isinstance(field.default, Sequence)
    rows = [row for row in field.default if isinstance(row, Mapping)]
    assert len(rows) == len(field.default)
    return rows


def a_table(**overrides: object) -> dict[str, object]:
    """One table that parses, so each test can break exactly one thing."""
    field: dict[str, object] = {
        "id": "volumes",
        "type": "table",
        "label": "Recorders",
        "row_label": "recorder",
        "row": [{"id": "label", "type": "text", "label": "Name"}],
    }
    field.update(overrides)
    return field


def a_row_field(**overrides: object) -> dict[str, object]:
    """One row field that parses."""
    field: dict[str, object] = {"id": "label", "type": "text", "label": "Name"}
    field.update(overrides)
    return field


# The row monty's volume registry needs, and the one the plan writes out in full.
MONTY_ROW: list[dict[str, object]] = [
    {"id": "label", "type": "text", "label": "Name", "required": True, "unique": True},
    {"id": "volume_uuid", "type": "text", "label": "Volume UUID"},
    {
        "id": "globs",
        "type": "list of text",
        "label": "Patterns",
        "default": ["WAV/**/*.WAV"],
    },
    {"id": "destination", "type": "path", "label": "Copy to", "kind": "folder"},
    {"id": "language", "type": "choice", "label": "Language", "options": ["nl", "fr", "en"]},
]


# --- what a table declares ----------------------------------------------------------------


def test_the_table_type_is_named_beside_the_eight_scalar_types() -> None:
    # It is deliberately NOT one of them: a table is not a scalar, and `list of table` is a
    # repetition of a repetition with nothing to draw.
    assert SETTINGS_TABLE_TYPE == "table"
    assert SETTINGS_TABLE_TYPE not in SETTINGS_FIELD_TYPES


def test_a_table_declares_a_row_and_a_row_label() -> None:
    field = declared(a_table(row=MONTY_ROW, help="Each drive monty copies from"))[0]

    assert field.type == "table"
    assert field.row_label == "recorder"
    assert field.row is not None
    assert [column.id for column in field.row] == [
        "label",
        "volume_uuid",
        "globs",
        "destination",
        "language",
    ]
    # A table carries the attributes every field carries, and nothing special about them.
    assert field.label == "Recorders"
    assert field.help == "Each drive monty copies from"
    assert field.required is False


def test_a_field_that_is_not_a_table_carries_no_row_at_all() -> None:
    field = declared(a_row_field())[0]

    assert field.row is None
    assert field.row_label is None


def test_a_parsed_row_field_is_a_settings_field_like_any_other() -> None:
    field = declared(a_table())[0]
    assert field.row is not None
    column = field.row[0]

    assert isinstance(column, SettingsField)
    with pytest.raises(AttributeError):
        column.label = "Something else"  # type: ignore[misc]


# --- a row is judged by exactly the rules a settings section is ---------------------------


ALL_NINE_IN_A_ROW: list[dict[str, object]] = [
    {"id": "title", "type": "text", "label": "Title"},
    {"id": "notes", "type": "paragraph", "label": "Notes"},
    {"id": "interval", "type": "number", "label": "Interval", "min": 1, "max": 60, "step": 5},
    {"id": "watching", "type": "switch", "label": "Watch on start"},
    {"id": "quality", "type": "choice", "label": "Quality", "options": ["low", "high"]},
    {"id": "formats", "type": "multiple-choice", "label": "Formats", "options": ["wav", "mp3"]},
    {"id": "root", "type": "path", "label": "Root", "kind": "folder"},
    {"id": "token", "type": "secret", "label": "API token"},
    {"id": "extra-files", "type": "list of path", "label": "Extra files", "kind": "file"},
]


def test_a_row_holds_one_field_of_each_type_with_its_own_constraints() -> None:
    field = declared(a_table(row=ALL_NINE_IN_A_ROW))[0]

    assert field.row is not None
    by_id = {column.id: column for column in field.row}
    assert [column.type for column in field.row] == [
        "text",
        "paragraph",
        "number",
        "switch",
        "choice",
        "multiple-choice",
        "path",
        "secret",
        "list of path",
    ]
    assert (by_id["interval"].min, by_id["interval"].max, by_id["interval"].step) == (1, 60, 5)
    assert by_id["quality"].options == ("low", "high")
    assert by_id["formats"].options == ("wav", "mp3")
    assert by_id["root"].kind == "folder"
    assert by_id["extra-files"].element_type == "path"
    assert by_id["extra-files"].kind == "file"
    assert by_id["title"].element_type is None


def test_a_row_field_keeps_the_optional_attributes_every_field_carries() -> None:
    field = declared(
        a_table(
            row=[
                a_row_field(
                    help="What to call this recorder",
                    required=True,
                    group="Identity",
                    written_by="both",
                    default="Zoom H6",
                )
            ]
        )
    )[0]

    assert field.row is not None
    column = field.row[0]
    assert column.help == "What to call this recorder"
    assert column.required is True
    assert column.group == "Identity"
    assert column.written_by == "both"
    assert column.default == "Zoom H6"


def test_a_row_field_s_default_is_judged_against_its_own_constraints() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row=[{**a_row_field(), "type": "number", "min": 1, "default": 0}]))

    message = str(refusal.value)
    assert "volumes" in message
    assert "row[0]" in message
    assert "default" in message


def test_a_row_field_s_shown_when_may_name_another_field_of_the_same_row() -> None:
    field = declared(
        a_table(
            row=[
                {"id": "watching", "type": "switch", "label": "Watch"},
                {
                    "id": "destination",
                    "type": "path",
                    "label": "Copy to",
                    "kind": "folder",
                    "shown_when": {"field": "watching", "equals": True},
                },
            ]
        )
    )[0]

    assert field.row is not None
    assert field.row[1].shown_when is not None
    assert field.row[1].shown_when.field == "watching"


# --- nesting, to any depth (D1) -----------------------------------------------------------


THREE_DEEP: dict[str, object] = {
    "id": "libraries",
    "type": "table",
    "label": "Libraries",
    "row_label": "library",
    "row": [
        {"id": "name", "type": "text", "label": "Name"},
        {
            "id": "recorders",
            "type": "table",
            "label": "Recorders",
            "row_label": "recorder",
            "row": [
                {"id": "label", "type": "text", "label": "Name"},
                {
                    "id": "takes",
                    "type": "table",
                    "label": "Takes",
                    "row_label": "take",
                    "row": [{"id": "file", "type": "path", "label": "File", "kind": "file"}],
                },
            ],
        },
    ],
}


def test_a_table_nested_three_levels_deep_keeps_every_level_s_row_and_row_label() -> None:
    libraries = declared(THREE_DEEP)[0]

    assert libraries.row_label == "library"
    assert libraries.row is not None
    assert [column.id for column in libraries.row] == ["name", "recorders"]

    recorders = libraries.row[1]
    assert recorders.type == "table"
    assert recorders.row_label == "recorder"
    assert recorders.row is not None
    assert [column.id for column in recorders.row] == ["label", "takes"]

    takes = recorders.row[1]
    assert takes.type == "table"
    assert takes.row_label == "take"
    assert takes.row is not None
    assert [column.id for column in takes.row] == ["file"]
    assert takes.row[0].kind == "file"


def test_a_refusal_three_levels_down_names_the_whole_path_to_the_column() -> None:
    broken = {
        **THREE_DEEP,
        "row": [
            {"id": "name", "type": "text", "label": "Name"},
            {
                "id": "recorders",
                "type": "table",
                "label": "Recorders",
                "row_label": "recorder",
                "row": [
                    {
                        "id": "takes",
                        "type": "table",
                        "label": "Takes",
                        "row_label": "take",
                        # The typo, three levels down.
                        "row": [{"id": "file", "type": "filepath", "label": "File"}],
                    }
                ],
            },
        ],
    }

    with pytest.raises(ManifestError) as refusal:
        declared(broken)

    message = str(refusal.value)
    # Every level of the address, so an author can walk straight to the typo.
    assert "id 'libraries'" in message
    assert "id 'recorders'" in message
    assert "id 'takes'" in message
    assert "id 'file'" in message
    assert "'filepath'" in message


# --- the two attributes a table must declare ----------------------------------------------


@pytest.mark.parametrize("attribute", ["row", "row_label"])
def test_a_table_missing_row_or_row_label_is_refused_by_name(attribute: str) -> None:
    broken = a_table()
    del broken[attribute]

    with pytest.raises(ManifestError) as refusal:
        declared(broken)

    message = str(refusal.value)
    assert "volumes" in message
    assert attribute in message


@pytest.mark.parametrize("row_label", [1, ["recorder"], None])
def test_a_row_label_that_is_not_a_string_is_refused(row_label: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row_label=row_label))

    assert "row_label" in str(refusal.value)


def test_an_empty_row_label_is_refused() -> None:
    # The Add button and every row error say this noun; an empty one names nothing.
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row_label=""))

    assert "row_label" in str(refusal.value)


@pytest.mark.parametrize("row", ["label", {"id": "label"}, 1])
def test_a_row_that_is_not_a_list_of_fields_is_refused(row: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row=row))

    assert "row" in str(refusal.value)


def test_an_empty_row_is_refused() -> None:
    # A table with no columns holds nothing, so there is no value to record against it.
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row=[]))

    message = str(refusal.value)
    assert "volumes" in message
    assert "row" in message


@pytest.mark.parametrize("attribute", ["row", "row_label"])
def test_row_and_row_label_on_a_field_that_is_not_a_table_are_refused(attribute: str) -> None:
    # The same house rule as any misplaced constraint: a typo the author believes is in force.
    with pytest.raises(ManifestError) as refusal:
        declared(a_row_field(**{attribute: a_table()[attribute]}))

    assert attribute in str(refusal.value)


def test_a_list_of_tables_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_row_field(type="list of table"))

    assert "table" in str(refusal.value)


# --- the three ways a row itself is wrong -------------------------------------------------


def test_a_row_that_repeats_a_field_id_is_refused_naming_the_row_and_the_field() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            a_table(
                row=[
                    a_row_field(id="label"),
                    a_row_field(id="label", label="Again"),
                ]
            )
        )

    message = str(refusal.value)
    assert "volumes" in message
    assert "row[1]" in message
    assert "'label'" in message


def test_a_row_field_shown_when_naming_a_field_outside_its_own_row_is_refused() -> None:
    # Visibility is judged per row: a condition may not reach into the enclosing form.
    with pytest.raises(ManifestError) as refusal:
        declared(
            {"id": "watching", "type": "switch", "label": "Watch"},
            a_table(
                row=[a_row_field(shown_when={"field": "watching", "equals": True})],
            ),
        )

    message = str(refusal.value)
    assert "volumes" in message
    assert "'watching'" in message
    assert "'label'" in message


def test_a_row_field_shown_when_naming_a_sibling_table_s_row_field_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            a_table(id="folders", row=[a_row_field(id="watching", type="switch")]),
            a_table(row=[a_row_field(shown_when={"field": "watching", "equals": True})]),
        )

    message = str(refusal.value)
    assert "volumes" in message
    assert "'watching'" in message


def test_a_row_field_shown_when_naming_an_enclosing_row_s_field_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            a_table(
                row=[
                    a_row_field(id="watching", type="switch"),
                    {
                        "id": "takes",
                        "type": "table",
                        "label": "Takes",
                        "row_label": "take",
                        "row": [a_row_field(shown_when={"field": "watching", "equals": True})],
                    },
                ]
            )
        )

    message = str(refusal.value)
    assert "takes" in message
    assert "'watching'" in message


def test_a_row_field_shown_when_naming_itself_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row=[a_row_field(shown_when={"field": "label", "equals": "x"})]))

    assert "'label'" in str(refusal.value)


@pytest.mark.parametrize("bad_type", ["widget", "Text", "list of widget", ""])
def test_a_row_field_of_a_type_outside_the_closed_vocabulary_is_refused(bad_type: str) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row=[a_row_field(type=bad_type)]))

    message = str(refusal.value)
    assert "volumes" in message
    assert "row[0]" in message
    assert "'label'" in message


def test_a_row_field_missing_its_id_type_or_label_is_refused_by_position() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row=[a_row_field(), {"id": "globs", "label": "Patterns"}]))

    message = str(refusal.value)
    assert "volumes" in message
    assert "row[1]" in message
    assert "type" in message


def test_an_unknown_attribute_on_a_row_field_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row=[a_row_field(placeholder="Type here")]))

    assert "placeholder" in str(refusal.value)


# --- the optional `unique` marking (D3) ---------------------------------------------------


def test_the_four_comparable_types_are_the_ones_unique_is_accepted_on() -> None:
    assert SETTINGS_UNIQUE_TYPES == ("text", "number", "choice", "path")


def test_a_table_declaring_no_unique_column_parses_and_the_marking_is_absent() -> None:
    field = declared(a_table(row=ALL_NINE_IN_A_ROW))[0]

    assert field.row is not None
    assert [column.unique for column in field.row] == [False] * len(ALL_NINE_IN_A_ROW)


@pytest.mark.parametrize("type_name", SETTINGS_UNIQUE_TYPES)
def test_unique_is_accepted_on_each_comparable_type(type_name: str) -> None:
    constraints: dict[str, object] = {}
    if type_name == "choice":
        constraints["options"] = ["one", "two"]
    if type_name == "path":
        constraints["kind"] = "file"

    field = declared(
        a_table(row=[a_row_field(type=type_name, unique=True, **constraints)]),
    )[0]

    assert field.row is not None
    assert field.row[0].unique is True


@pytest.mark.parametrize(
    ("type_name", "constraints"),
    [
        ("paragraph", {}),
        ("switch", {}),
        ("multiple-choice", {"options": ["one", "two"]}),
        ("secret", {}),
        ("list of text", {}),
    ],
)
def test_unique_on_a_type_that_cannot_identify_a_row_is_refused(
    type_name: str, constraints: dict[str, object]
) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row=[a_row_field(type=type_name, unique=True, **constraints)]))

    message = str(refusal.value)
    assert "unique" in message
    assert "'label'" in message
    assert type_name in message


def test_unique_on_a_nested_table_is_refused() -> None:
    # Two tables cannot be meaningfully compared, so a composite value is not an identity.
    with pytest.raises(ManifestError) as refusal:
        declared(
            a_table(
                row=[
                    {
                        "id": "takes",
                        "type": "table",
                        "label": "Takes",
                        "row_label": "take",
                        "row": [a_row_field()],
                        "unique": True,
                    }
                ]
            )
        )

    message = str(refusal.value)
    assert "unique" in message
    assert "'takes'" in message


def test_two_unique_columns_in_one_row_are_refused_naming_both() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            a_table(
                row=[
                    a_row_field(id="label", unique=True),
                    a_row_field(id="volume_uuid", label="Volume UUID", unique=True),
                ]
            )
        )

    message = str(refusal.value)
    assert "volumes" in message
    assert "label" in message
    assert "volume_uuid" in message


def test_a_nested_table_may_mark_its_own_unique_column() -> None:
    # One per row, and a nested row is its own row.
    field = declared(
        a_table(
            row=[
                a_row_field(unique=True),
                {
                    "id": "takes",
                    "type": "table",
                    "label": "Takes",
                    "row_label": "take",
                    "row": [a_row_field(id="file", type="path", kind="file", unique=True)],
                },
            ]
        )
    )[0]

    assert field.row is not None
    assert field.row[0].unique is True
    nested = field.row[1]
    assert nested.row is not None
    assert nested.row[0].unique is True


@pytest.mark.parametrize("marking", ["yes", 1, None])
def test_a_unique_marking_that_is_not_true_or_false_is_refused(marking: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(row=[a_row_field(unique=marking)]))

    assert "unique" in str(refusal.value)


def test_unique_on_a_top_level_field_is_refused() -> None:
    # A top-level field holds one value; there is nothing for it to be unique among.
    with pytest.raises(ManifestError) as refusal:
        declared(a_row_field(unique=True))

    assert "unique" in str(refusal.value)


# --- a table's own default: a whole set of rows -------------------------------------------


def test_a_table_default_of_whole_rows_is_kept() -> None:
    field = declared(
        a_table(
            row=MONTY_ROW,
            default=[
                {
                    "label": "Zoom H6",
                    "volume_uuid": "8A1F-22C3",
                    "globs": ["WAV/**/*.WAV"],
                    "destination": "/Users/someone/Recordings/zoom",
                    "language": "nl",
                },
                {"label": "Field recorder"},
            ],
        )
    )[0]

    rows = default_rows(field)
    assert len(rows) == 2
    assert rows[0]["label"] == "Zoom H6"
    # A list value inside a row is held as a tuple, like every other list-valued setting.
    assert rows[0]["globs"] == ("WAV/**/*.WAV",)
    # A row carries what it declared and nothing invented for it.
    assert dict(rows[1]) == {"label": "Field recorder"}


def test_a_default_row_is_immutable() -> None:
    field = declared(a_table(default=[{"label": "Zoom H6"}]))[0]

    row = default_rows(field)[0]
    with pytest.raises(TypeError):
        row["label"] = "Something else"  # type: ignore[index]


def test_a_table_default_may_hold_a_nested_table_s_rows() -> None:
    field = declared(
        a_table(
            row=[
                a_row_field(),
                {
                    "id": "takes",
                    "type": "table",
                    "label": "Takes",
                    "row_label": "take",
                    "row": [{"id": "file", "type": "path", "label": "File", "kind": "file"}],
                },
            ],
            default=[{"label": "Zoom H6", "takes": [{"file": "/tmp/one.wav"}]}],
        )
    )[0]

    takes = default_rows(field)[0]["takes"]
    assert isinstance(takes, Sequence)
    nested = takes[0]
    assert isinstance(nested, Mapping)
    assert nested["file"] == "/tmp/one.wav"


@pytest.mark.parametrize("default", ["Zoom H6", {"label": "Zoom H6"}, 1])
def test_a_table_default_that_is_not_a_list_of_rows_is_refused(default: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(default=default))

    assert "default" in str(refusal.value)


def test_an_empty_table_default_is_refused() -> None:
    # A table that starts with no rows is what a table with no default already is.
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(default=[]))

    assert "default" in str(refusal.value)


def test_a_default_row_that_is_not_a_mapping_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(a_table(default=[{"label": "Zoom H6"}, "Field recorder"]))

    message = str(refusal.value)
    assert "recorder 2" in message


def test_a_default_row_carrying_an_undeclared_key_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            a_table(
                row=MONTY_ROW,
                default=[{"label": "Zoom H6"}, {"label": "Field recorder", "colour": "red"}],
            )
        )

    message = str(refusal.value)
    # The row_label and the position, because "row 2" is not something a person can find.
    assert "recorder 2" in message
    assert "colour" in message


def test_a_default_row_missing_a_required_column_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            a_table(
                row=MONTY_ROW,
                default=[{"label": "Zoom H6"}, {"volume_uuid": "8A1F-22C3"}],
            )
        )

    message = str(refusal.value)
    assert "recorder 2" in message
    assert "label" in message


def test_a_default_row_may_omit_a_required_column_that_has_its_own_default() -> None:
    field = declared(
        a_table(
            row=[a_row_field(required=True, default="Zoom H6")],
            default=[{}],
        )
    )[0]

    assert dict(default_rows(field)[0]) == {}


def test_a_default_row_whose_value_fails_a_column_s_constraint_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            a_table(
                row=MONTY_ROW,
                default=[{"label": "Zoom H6"}, {"label": "Field recorder", "language": "de"}],
            )
        )

    message = str(refusal.value)
    assert "recorder 2" in message
    assert "language" in message
    assert "'de'" in message


def test_a_default_row_in_a_nested_table_is_named_by_its_own_row_label() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            a_table(
                row=[
                    a_row_field(),
                    {
                        "id": "takes",
                        "type": "table",
                        "label": "Takes",
                        "row_label": "take",
                        "row": [{"id": "file", "type": "path", "label": "File", "kind": "file"}],
                    },
                ],
                default=[{"label": "Zoom H6", "takes": [{"file": "/tmp/one.wav"}, {"file": 1}]}],
            )
        )

    message = str(refusal.value)
    assert "recorder 1" in message
    assert "take 2" in message
    assert "file" in message
