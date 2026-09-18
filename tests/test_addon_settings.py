"""The settings declaration: what a plugin may ask for, and what it is refused.

Plan 0004 closes the vocabulary at D1's nine types on purpose — a plugin that could ship its
own widget could draw, and therefore lie, in the host's window. So every rule here is a
refusal, and every refusal owns a test that turns red when its check is deleted: the cheapest
way to "satisfy" a requirement to refuse something is to not implement it.

Every refusal is also asserted to **name the offending field**, because the person reading it
is a plugin author looking for their own typo.
"""

from __future__ import annotations

import pytest

from innytypes import HOST_API_VERSION
from innytypes.addons.manifest import (
    SETTINGS_FIELD_TYPES,
    SETTINGS_WRITERS,
    ManifestError,
    SettingsField,
    ShownWhen,
    parse_manifest,
    parse_settings,
)


def settings_manifest(*fields: object) -> dict[str, object]:
    """A manifest that parses, carrying exactly the settings fields given."""
    return {
        "id": "monty",
        "version": "1.4.0",
        "host_api": HOST_API_VERSION,
        "requires": [],
        "emits": [],
        "subscribes": [],
        "settings": list(fields),
    }


def text_field(**overrides: object) -> dict[str, object]:
    """One field that parses, so each test can break exactly one thing."""
    field: dict[str, object] = {"id": "title", "type": "text", "label": "Title"}
    field.update(overrides)
    return field


def declared(*fields: object) -> tuple[SettingsField, ...]:
    """Parse a whole manifest and hand back only its settings."""
    return parse_manifest(settings_manifest(*fields)).settings


# --- the nine types, and their own constraints --------------------------------------------


ALL_NINE = [
    {"id": "title", "type": "text", "label": "Title"},
    {"id": "notes", "type": "paragraph", "label": "Notes"},
    {"id": "interval", "type": "number", "label": "Interval", "min": 1, "max": 60, "step": 5},
    {"id": "watching", "type": "switch", "label": "Watch on start"},
    {"id": "quality", "type": "choice", "label": "Quality", "options": ["low", "high"]},
    {
        "id": "formats",
        "type": "multiple-choice",
        "label": "Formats",
        "options": ["wav", "mp3"],
    },
    {"id": "root", "type": "path", "label": "Root", "kind": "folder"},
    {"id": "token", "type": "secret", "label": "API token"},
    {"id": "extra-files", "type": "list of path", "label": "Extra files", "kind": "file"},
]


def test_a_manifest_that_declares_no_settings_has_none() -> None:
    manifest = parse_manifest(
        {
            "id": "monty",
            "version": "1.4.0",
            "host_api": HOST_API_VERSION,
            "requires": [],
            "emits": [],
            "subscribes": [],
        }
    )

    assert manifest.settings == ()


def test_one_field_of_each_of_the_nine_types_parses_with_its_own_constraints() -> None:
    fields = declared(*ALL_NINE)

    assert [field.type for field in fields] == [
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
    # The eight non-list types are exactly the host's closed vocabulary — a tenth type is a
    # host release, never a manifest an author writes.
    assert tuple(field.type for field in fields[:8]) == SETTINGS_FIELD_TYPES

    by_id = {field.id: field for field in fields}
    assert isinstance(by_id["title"], SettingsField)
    assert (by_id["interval"].min, by_id["interval"].max, by_id["interval"].step) == (1, 60, 5)
    assert by_id["quality"].options == ("low", "high")
    assert by_id["formats"].options == ("wav", "mp3")
    assert by_id["root"].kind == "folder"
    # A `list of <type>` keeps the author's spelling and names its element type separately.
    assert by_id["extra-files"].type == "list of path"
    assert by_id["extra-files"].element_type == "path"
    assert by_id["extra-files"].kind == "file"
    # Every other type carries no element type at all.
    assert by_id["title"].element_type is None


@pytest.mark.parametrize("element_type", SETTINGS_FIELD_TYPES)
def test_a_list_of_each_non_list_type_parses(element_type: str) -> None:
    constraints: dict[str, object] = {}
    if element_type in ("choice", "multiple-choice"):
        constraints["options"] = ["one", "two"]
    if element_type == "path":
        constraints["kind"] = "file"

    field = declared(
        {"id": "many", "type": f"list of {element_type}", "label": "Many", **constraints}
    )[0]

    assert field.type == f"list of {element_type}"
    assert field.element_type == element_type


def test_a_secret_carries_the_same_common_attributes_as_any_other_field() -> None:
    # Where a secret's value is stored is slice 03's question; the declaration is ordinary.
    field = declared(
        {
            "id": "token",
            "type": "secret",
            "label": "API token",
            "help": "Pasted once; never shown again",
            "required": True,
            "group": "Account",
            "written_by": "both",
        }
    )[0]

    assert (field.id, field.type, field.label) == ("token", "secret", "API token")
    assert field.help == "Pasted once; never shown again"
    assert field.required is True
    assert field.group == "Account"
    assert field.written_by == "both"


def test_a_parsed_field_is_frozen() -> None:
    field = declared(text_field())[0]

    with pytest.raises(AttributeError):
        field.label = "Something else"  # type: ignore[misc]


def test_parse_settings_reads_a_bare_section() -> None:
    # Later slices re-read a recorded declaration without a whole manifest around it.
    fields = parse_settings([text_field()])

    assert [field.id for field in fields] == ["title"]


# --- the three attributes every field must carry ------------------------------------------


@pytest.mark.parametrize("attribute", ["id", "type", "label"])
def test_a_field_missing_one_of_the_three_required_attributes_is_refused(attribute: str) -> None:
    broken = text_field()
    del broken[attribute]

    with pytest.raises(ManifestError) as refusal:
        declared(text_field(id="first"), broken)

    message = str(refusal.value)
    # The position, because an author with ten fields needs to know which one.
    assert "settings[1]" in message
    assert attribute in message


@pytest.mark.parametrize("value", [1, None, ["Title"]])
def test_a_label_that_is_not_a_string_is_refused(value: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(label=value))

    assert "label" in str(refusal.value)
    assert "title" in str(refusal.value)


def test_an_empty_id_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(id=""))

    assert "settings[0]" in str(refusal.value)


def test_an_empty_label_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(label=""))

    assert "label" in str(refusal.value)


def test_two_fields_sharing_an_id_are_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(id="folder"), text_field(id="folder", label="Again"))

    assert "folder" in str(refusal.value)


def test_a_settings_section_that_is_not_a_list_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(
            {
                "id": "monty",
                "version": "1.4.0",
                "host_api": HOST_API_VERSION,
                "requires": [],
                "emits": [],
                "subscribes": [],
                "settings": {"title": "Title"},
            }
        )

    assert "settings" in str(refusal.value)


def test_a_field_that_is_not_a_mapping_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared("title")

    assert "settings[0]" in str(refusal.value)


def test_an_unknown_field_attribute_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(placeholder="Type here"))

    assert "placeholder" in str(refusal.value)
    assert "title" in str(refusal.value)


# --- order is the manifest's, and grouping is only for drawing ----------------------------


def test_field_order_is_the_manifest_order_regardless_of_grouping() -> None:
    fields = declared(
        text_field(id="first", group="Sources"),
        text_field(id="second", group="Output"),
        text_field(id="third", group="Sources"),
        text_field(id="fourth"),
    )

    # Not grouped together, not sorted — exactly as written.
    assert [field.id for field in fields] == ["first", "second", "third", "fourth"]
    assert [field.group for field in fields] == ["Sources", "Output", "Sources", None]


def test_two_fields_may_share_a_group() -> None:
    fields = declared(
        text_field(id="first", group="Sources"),
        text_field(id="second", group="Sources"),
    )

    assert {field.group for field in fields} == {"Sources"}


def test_a_group_that_is_not_a_string_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(group=["Sources"]))

    assert "group" in str(refusal.value)


def test_help_is_optional_and_must_be_a_string() -> None:
    assert declared(text_field(help="What to call it"))[0].help == "What to call it"
    assert declared(text_field())[0].help is None

    with pytest.raises(ManifestError) as refusal:
        declared(text_field(help=7))

    assert "help" in str(refusal.value)


def test_required_defaults_to_false_and_must_be_a_boolean() -> None:
    assert declared(text_field())[0].required is False
    assert declared(text_field(required=True))[0].required is True

    with pytest.raises(ManifestError) as refusal:
        declared(text_field(required="yes"))

    assert "required" in str(refusal.value)


# --- who may write a field (plan 0004, F2) ------------------------------------------------


def test_written_by_defaults_to_the_user() -> None:
    assert declared(text_field())[0].written_by == "user"


@pytest.mark.parametrize("writer", ["user", "plugin", "both"])
def test_written_by_accepts_each_of_the_three_writers(writer: str) -> None:
    assert declared(text_field(written_by=writer))[0].written_by == writer


def test_the_writers_are_exactly_user_plugin_and_both() -> None:
    assert SETTINGS_WRITERS == ("user", "plugin", "both")


@pytest.mark.parametrize("writer", ["anyone", "host", "User", "", 1])
def test_a_written_by_outside_the_three_writers_is_refused(writer: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(written_by=writer))

    assert "written_by" in str(refusal.value)
    assert "title" in str(refusal.value)


# --- the closed vocabulary ----------------------------------------------------------------


@pytest.mark.parametrize("bad_type", ["widget", "Text", "string", "list", "list of", ""])
def test_a_type_outside_the_closed_vocabulary_is_refused(bad_type: str) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type=bad_type))

    message = str(refusal.value)
    assert "title" in message
    assert repr(bad_type) in message


@pytest.mark.parametrize("bad_type", ["list of widget", "list of list of text", "list of Text"])
def test_a_list_of_an_unrecognised_element_type_is_refused(bad_type: str) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type=bad_type))

    message = str(refusal.value)
    assert "title" in message
    # The message names the element type that was not recognised, not just the whole spelling.
    assert repr(bad_type.removeprefix("list of ")) in message


def test_a_type_that_is_not_a_string_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type=["text"]))

    assert "type" in str(refusal.value)


# --- each type's own constraints ----------------------------------------------------------


@pytest.mark.parametrize("field_type", ["choice", "multiple-choice", "list of choice"])
def test_a_choice_without_options_is_refused(field_type: str) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type=field_type))

    assert "options" in str(refusal.value)
    assert "title" in str(refusal.value)


@pytest.mark.parametrize("options", [[], "low", ["low", "low"], ["low", 2], [""]])
def test_options_that_are_not_a_list_of_distinct_names_are_refused(options: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type="choice", options=options))

    assert "options" in str(refusal.value)


@pytest.mark.parametrize("field_type", ["path", "list of path"])
def test_a_path_without_a_kind_is_refused(field_type: str) -> None:
    # The application draws a file picker or a folder picker; it cannot draw "either".
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type=field_type))

    assert "kind" in str(refusal.value)


@pytest.mark.parametrize("kind", ["directory", "File", "", 1])
def test_a_path_kind_that_is_not_file_or_folder_is_refused(kind: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type="path", kind=kind))

    assert "kind" in str(refusal.value)


def test_a_number_may_declare_no_bounds_at_all() -> None:
    field = declared(text_field(type="number"))[0]

    assert (field.min, field.max, field.step) == (None, None, None)


def test_a_number_may_be_bounded_below_zero() -> None:
    field = declared(text_field(type="number", min=-10, max=-1))[0]

    assert (field.min, field.max) == (-10, -1)


def test_a_number_whose_minimum_exceeds_its_maximum_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type="number", min=10, max=1))

    assert "title" in str(refusal.value)
    assert "min" in str(refusal.value)


@pytest.mark.parametrize("step", [0, -1])
def test_a_step_that_is_not_positive_is_refused(step: int) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type="number", step=step))

    assert "step" in str(refusal.value)


@pytest.mark.parametrize("bound", ["min", "max", "step"])
def test_a_bound_that_is_not_a_number_is_refused(bound: str) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type="number", **{bound: "10"}))

    assert bound in str(refusal.value)


@pytest.mark.parametrize(
    ("field_type", "constraint"),
    [
        ("text", {"options": ["low", "high"]}),
        ("text", {"kind": "file"}),
        ("text", {"min": 1}),
        ("switch", {"step": 1}),
        ("choice", {"kind": "file"}),
        ("path", {"options": ["low"]}),
    ],
)
def test_a_constraint_that_belongs_to_another_type_is_refused(
    field_type: str, constraint: dict[str, object]
) -> None:
    # A misplaced constraint is a typo the author believes is in force — the same house rule
    # as an unknown manifest field.
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type=field_type, **constraint))

    message = str(refusal.value)
    assert "title" in message
    assert next(iter(constraint)) in message


# --- a default is a value, judged like any other value ------------------------------------


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ({"type": "text"}, "hello"),
        ({"type": "paragraph"}, "a\nb"),
        ({"type": "number", "min": 1, "max": 10}, 5),
        ({"type": "number"}, 2.5),
        ({"type": "switch"}, True),
        ({"type": "choice", "options": ["low", "high"]}, "low"),
        ({"type": "secret"}, "hunter2"),
        ({"type": "path", "kind": "folder"}, "/tmp"),
    ],
)
def test_a_default_of_the_field_s_own_type_is_kept(field: dict[str, object], value: object) -> None:
    assert declared(text_field(default=value, **field))[0].default == value


def test_a_list_default_is_kept_as_a_tuple() -> None:
    field = declared(
        text_field(type="list of text", default=["one", "two"]),
    )[0]

    assert field.default == ("one", "two")


def test_a_multiple_choice_default_is_kept_as_a_tuple() -> None:
    field = declared(
        text_field(type="multiple-choice", options=["wav", "mp3"], default=["mp3"]),
    )[0]

    assert field.default == ("mp3",)


def test_a_field_without_a_default_has_none() -> None:
    assert declared(text_field())[0].default is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ({"type": "text"}, 1),
        ({"type": "paragraph"}, True),
        ({"type": "number"}, "5"),
        ({"type": "number"}, True),
        ({"type": "switch"}, "yes"),
        ({"type": "secret"}, 1),
        ({"type": "path", "kind": "file"}, 1),
        ({"type": "list of text"}, "one"),
        ({"type": "multiple-choice", "options": ["wav"]}, "wav"),
    ],
)
def test_a_default_of_the_wrong_type_is_refused(field: dict[str, object], value: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(default=value, **field))

    assert "default" in str(refusal.value)
    assert "title" in str(refusal.value)


@pytest.mark.parametrize("value", [0, 11])
def test_a_default_outside_a_number_s_bounds_is_refused(value: int) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type="number", min=1, max=10, default=value))

    assert "default" in str(refusal.value)


def test_a_default_that_is_not_one_of_the_options_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type="choice", options=["low", "high"], default="medium"))

    assert "medium" in str(refusal.value)


def test_a_multiple_choice_default_repeating_an_option_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type="multiple-choice", options=["wav"], default=["wav", "wav"]))

    assert "default" in str(refusal.value)


def test_a_list_default_with_a_bad_element_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(type="list of number", min=1, default=[1, 0]))

    message = str(refusal.value)
    # Named down to the offending element, so the author knows which row.
    assert "default[1]" in message


def test_a_null_default_is_refused() -> None:
    # No type in the vocabulary stores "nothing"; an author who meant "no default" omits it.
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(default=None))

    assert "default" in str(refusal.value)


# --- shown_when: one other field, one value (plan 0004, D2) --------------------------------


def test_a_shown_when_naming_another_field_parses() -> None:
    fields = declared(
        text_field(id="watching", type="switch"),
        text_field(id="folder", shown_when={"field": "watching", "equals": True}),
    )

    assert fields[0].shown_when is None
    assert fields[1].shown_when == ShownWhen(field="watching", equals=True)


def test_a_shown_when_may_name_a_field_declared_later() -> None:
    # Order is a drawing concern; visibility is evaluated over the whole form at once.
    fields = declared(
        text_field(id="folder", shown_when={"field": "watching", "equals": True}),
        text_field(id="watching", type="switch"),
    )

    assert fields[0].shown_when == ShownWhen(field="watching", equals=True)


def test_a_shown_when_naming_a_field_that_does_not_exist_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(id="folder", shown_when={"field": "watching", "equals": True}))

    message = str(refusal.value)
    assert "watching" in message
    assert "folder" in message


def test_a_shown_when_naming_its_own_field_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(id="folder", shown_when={"field": "folder", "equals": "x"}))

    assert "folder" in str(refusal.value)


@pytest.mark.parametrize("condition", [{"field": "watching"}, {"equals": True}, {}])
def test_a_shown_when_missing_its_field_or_its_value_is_refused(
    condition: dict[str, object],
) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            text_field(id="watching", type="switch"),
            text_field(id="folder", shown_when=condition),
        )

    assert "shown_when" in str(refusal.value)


def test_a_shown_when_with_an_extra_key_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            text_field(id="watching", type="switch"),
            text_field(
                id="folder",
                shown_when={"field": "watching", "equals": True, "not_equals": False},
            ),
        )

    assert "not_equals" in str(refusal.value)


def test_a_shown_when_that_is_not_a_mapping_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(text_field(shown_when="watching"))

    assert "shown_when" in str(refusal.value)


@pytest.mark.parametrize("equals", [["a"], {"a": 1}, None])
def test_a_shown_when_comparing_against_something_other_than_one_value_is_refused(
    equals: object,
) -> None:
    with pytest.raises(ManifestError) as refusal:
        declared(
            text_field(id="watching", type="switch"),
            text_field(id="folder", shown_when={"field": "watching", "equals": equals}),
        )

    assert "equals" in str(refusal.value)
