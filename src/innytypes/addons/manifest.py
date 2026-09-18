"""The addon manifest — the contract every other slice of the host reads first.

Discovery reads manifests, the resolver builds its graph from ``requires``, the bus decides
what an addon may publish from ``emits`` and what it receives from ``subscribes``. So the
manifest has to exist before any of them, and it has to be **judged** rather than merely
loaded.

Two choices here are load-bearing:

**Validation refuses; it never warns.** Anything accepted-with-complaints leaves every later
slice guessing what it actually got — a resolver cannot half-resolve a dependency, and a bus
cannot half-own a namespace. Every rule below raises :class:`ManifestError` naming the
offending value, and an unknown field is a typo refused rather than a setting silently
ignored.

**The version lives inside the event kind**, ``<addon-id>.<name>.v<N>``. A payload is a
public API between addons, so changing it means a NEW kind and the old one keeps working
(plan 0001). The grammar is enforced here because ``emits`` and ``subscribes`` are lists of
kinds, and a manifest that cannot tell a well-formed kind from a typo validates nothing.

**The settings vocabulary is closed** (plan 0004, D1). A plugin declares what it wants asked
of the user; it cannot ship a widget, a template or a stylesheet, because a plugin that can
draw in the host's window can lie in the host's window. So a `settings` section is a list of
fields whose types come from a fixed list of nine, and an unrecognised type is refused rather
than passed through for the application to puzzle over.

This module parses and judges a manifest. It discovers nothing, resolves nothing and starts
nothing, and — like every host module — it imports no addon.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

from innytypes import HOST_API_VERSION

__all__ = [
    "SETTINGS_FIELD_TYPES",
    "SETTINGS_WRITERS",
    "SUPPORTED_HOST_API_VERSIONS",
    "AddonManifest",
    "EventKind",
    "KindPrefix",
    "ManifestError",
    "Requirement",
    "SettingsField",
    "ShownWhen",
    "StabilityProfile",
    "UpdateSource",
    "is_addon_id",
    "parse_kind",
    "parse_manifest",
    "parse_requirement",
    "parse_settings",
    "parse_subscription",
]

# The host API versions this host implements. A manifest targeting anything else is refused
# rather than started and hoped for: the addon compiled against contracts we do not serve.
SUPPORTED_HOST_API_VERSIONS: tuple[int, ...] = (HOST_API_VERSION,)

# An addon id, and each name segment of an event kind: lowercase letters and digits, joined
# by single hyphens. One spelling per identity, on purpose — if `Whodunnit` and `whodunnit`
# were both legal, two addons could claim one namespace and neither would be wrong.
_SEGMENT = r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*"

_SEGMENT_RE = re.compile(rf"^{_SEGMENT}$")

# `<addon-id>.<name>.v<N>`. N has no leading zero and starts at 1, so one kind has exactly
# one spelling: `v01` and `v1` naming the same public API would defeat the whole point.
_KIND_RE = re.compile(
    rf"^(?P<addon_id>{_SEGMENT})\.(?P<name>{_SEGMENT})\.v(?P<version>[1-9][0-9]*)$"
)

# A subscription prefix: one or more segments then `.*`, so both `monty.*` (everything an
# addon publishes) and `monty.recorded.*` (every version of one kind) are expressible.
_PREFIX_RE = re.compile(rf"^(?P<prefix>{_SEGMENT}(?:\.{_SEGMENT})*)\.\*$")

# An exact version: digits first, then whatever the addon's own scheme uses. The point is
# what it excludes — `*`, `>`, `<`, `~`, `!` and whitespace, the spellings of a range.
_VERSION_RE = re.compile(r"^[0-9][A-Za-z0-9.+-]*$")

# A requirement is `<addon-id>==<version>` and nothing else. Ranges are refused by having no
# syntax to express them (plan 0001: addons are required at exact versions).
_REQUIREMENT_RE = re.compile(rf"^(?P<addon_id>{_SEGMENT})==(?P<version>.+)$")

_REQUIRED_FIELDS = ("id", "version", "host_api", "requires", "emits", "subscribes")
_OPTIONAL_FIELDS = ("stability", "update", "settings")

_STABILITY_FIELDS = (
    "heartbeat_interval",
    "stale_after",
    "max_rss_mb",
    "max_cpu_percent",
    "cpu_window",
    "max_open_files",
    "max_children",
    "breach_grace",
    "restartable",
)

_UPDATE_FIELDS = ("source", "channel")

# --- the settings vocabulary (plan 0004, D1) ----------------------------------------------
#
# Eight scalar types, plus `list of <type>` over any one of them — nine in all. The list is
# closed: a ninth scalar type is a host release, because every type here is a widget the
# application must draw on macOS, Windows and Linux.
SETTINGS_FIELD_TYPES: tuple[str, ...] = (
    "text",
    "paragraph",
    "number",
    "switch",
    "choice",
    "multiple-choice",
    "path",
    "secret",
)

# The spelling of a repeatable field, exactly as plan 0004's table writes it: `list of path`.
# One spelling, with the element type in the `type` string rather than a second attribute, so
# a reader of the manifest sees the whole type in one place.
_LIST_PREFIX = "list of "

# Who may write a value (plan 0004, F2). The default is `user`: a plugin gets to write its own
# settings only where its author said so, so an authorisation token can be kept without a
# plugin also being able to rewrite the folder the user chose.
SETTINGS_WRITERS: tuple[str, ...] = ("user", "plugin", "both")

_PATH_KINDS = ("file", "folder")

_SETTINGS_OPTIONAL_FIELDS = ("help", "default", "required", "group", "shown_when", "written_by")

# Each type's own constraints. A constraint declared on a type that has no use for it is a
# typo its author believes is in force, so it is refused like any other unknown field. For a
# `list of <type>` these are the ELEMENT's constraints — `min` on a `list of number` bounds
# each number in the list.
_SETTINGS_CONSTRAINTS: Mapping[str, tuple[str, ...]] = {
    # `step` is what the application's picker increments by — a drawing hint, not a rule a
    # value has to satisfy, so no value is ever refused for falling between two steps.
    "number": ("min", "max", "step"),
    "choice": ("options",),
    "multiple-choice": ("options",),
    "path": ("kind",),
}

# The constraints without which the application could not draw the widget at all.
_SETTINGS_REQUIRED_CONSTRAINTS: Mapping[str, tuple[str, ...]] = {
    "choice": ("options",),
    "multiple-choice": ("options",),
    "path": ("kind",),
}

_SHOWN_WHEN_FIELDS = ("field", "equals")


class ManifestError(ValueError):
    """Raised when a manifest is refused.

    There is no second, softer outcome. A caller either gets a manifest every host slice can
    rely on, or an error naming what was wrong with the one it was handed.
    """


@dataclass(frozen=True)
class EventKind:
    """One event kind, `<addon-id>.<name>.v<N>`, parsed into its three parts.

    ``addon_id`` is the namespace that owns the kind, and ``version`` is the payload's public
    version — a new payload is a new kind, never an edit to this one.
    """

    addon_id: str
    name: str
    version: int

    def __str__(self) -> str:
        return f"{self.addon_id}.{self.name}.v{self.version}"


@dataclass(frozen=True)
class KindPrefix:
    """A subscription prefix, `monty.*` or `monty.recorded.*`.

    Legal in ``subscribes`` only: a subscriber may ask for a family of kinds, but a publisher
    declares exactly what it publishes.
    """

    prefix: str

    def __str__(self) -> str:
        return f"{self.prefix}.*"


@dataclass(frozen=True)
class Requirement:
    """Another addon, at one exact version."""

    addon_id: str
    version: str

    def __str__(self) -> str:
        return f"{self.addon_id}=={self.version}"


@dataclass(frozen=True)
class StabilityProfile:
    """What an addon publishes about how the helper should watch it (plan 0003).

    Every default here is the helper's, restated so a reader of a parsed profile sees the
    values in force rather than a pile of ``None``. The one field with no default is
    ``heartbeat_interval``: an addon that never promised heartbeats is watched for liveness,
    phantoms and resources, and is **never judged stale**.
    """

    heartbeat_interval: float | None = None
    stale_after: float | None = None
    max_rss_mb: float = 1024
    max_cpu_percent: float = 90
    cpu_window: float = 120
    max_open_files: int = 1024
    max_children: int | None = None
    breach_grace: float = 60
    restartable: bool = True


@dataclass(frozen=True)
class UpdateSource:
    """Where an addon's new versions are published (plan 0003, D15).

    The *source* is the addon's claim; the update **mode** is the user's setting in the
    helper's config and is deliberately not expressible here. An addon with no ``update``
    section is never checked — the helper reports it as not updatable rather than guessing.
    This slice does not resolve the source; it only insists the addon named one.
    """

    source: str
    channel: str = "stable"


@dataclass(frozen=True)
class ShownWhen:
    """A field is shown only while another field equals one value (plan 0004, D2).

    One level, ``equals`` only: ``field`` names exactly one **other** field in the same
    settings section, and ``equals`` is the single value it must hold. It may name a field
    declared later — order is how the application draws the form, and visibility is decided
    over the whole form at once — but never the field it belongs to.
    """

    field: str
    equals: object


@dataclass(frozen=True)
class SettingsField:
    """One declared setting: what the application draws, and what the host will store.

    ``type`` keeps the author's spelling, so a repeatable field reads back as
    ``list of path``; ``element_type`` is that list's element type, and ``None`` for every
    other type. The constraint attributes are the ones that type may declare and ``None``
    everywhere else — a `text` field carrying ``options`` was refused, not parsed.

    ``default`` is judged here against this field's own type and constraints, because a
    default is a value like any other: an author who defaults a `choice` to a value that is
    not one of its options has written a form nobody can save. A list-valued default is kept
    as a tuple, so a parsed declaration is immutable all the way down.
    """

    id: str
    type: str
    label: str
    help: str | None = None
    default: object | None = None
    required: bool = False
    group: str | None = None
    shown_when: ShownWhen | None = None
    written_by: str = "user"
    element_type: str | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: tuple[str, ...] | None = None
    kind: str | None = None


@dataclass(frozen=True)
class AddonManifest:
    """A validated manifest: every field readable by attribute, none of it re-checked later.

    Reaching this object means the id can namespace a kind, the host implements ``host_api``,
    every requirement is an exact pin, every emitted kind is well-formed and owned by this
    addon, and every subscription is a kind or a prefix.
    """

    id: str
    version: str
    host_api: int
    requires: tuple[Requirement, ...]
    emits: tuple[EventKind, ...]
    subscribes: tuple[EventKind | KindPrefix, ...]
    stability: StabilityProfile | None = None
    update: UpdateSource | None = None
    # Empty rather than None: a plugin that declares nothing has no settings, which is a form
    # with no fields — not an absent one the application has to special-case.
    settings: tuple[SettingsField, ...] = ()


def is_addon_id(text: str) -> bool:
    """Whether ``text`` is a well-formed addon id.

    Exposed because the id grammar has more than one reader: the helper's config file names
    plugins in ``[plugins.<addon-id>]`` sections (plan 0003), and a second copy of this
    pattern is a second answer to "what is a legal id".
    """
    return _SEGMENT_RE.match(text) is not None


def parse_kind(text: str) -> EventKind:
    """Parse one exact event kind, or refuse it by name."""
    match = _KIND_RE.match(text)
    if match is None:
        raise ManifestError(
            f"{text!r} is not a well-formed event kind: expected <addon-id>.<name>.v<N>, "
            "lowercase, with N a version number starting at 1 (for example "
            "'whodunnit.transcribed.v1')"
        )
    return EventKind(
        addon_id=match["addon_id"],
        name=match["name"],
        version=int(match["version"]),
    )


def parse_subscription(text: str) -> EventKind | KindPrefix:
    """Parse a subscription: an exact kind, or a prefix pattern ending in ``.*``."""
    if text.endswith(".*"):
        match = _PREFIX_RE.match(text)
        if match is None:
            raise ManifestError(
                f"{text!r} is not a well-formed subscription prefix: expected lowercase "
                "dotted segments followed by '.*' (for example 'whodunnit.*')"
            )
        return KindPrefix(prefix=match["prefix"])
    return parse_kind(text)


def parse_requirement(text: str) -> Requirement:
    """Parse ``<addon-id>==<version>``, refusing every other shape.

    A range would make the resolver guess which version an addon was written against, and
    the whole dependency story (plan 0001) rests on it never having to.
    """
    match = _REQUIREMENT_RE.match(text)
    if match is None:
        raise ManifestError(
            f"requires entry {text!r} is not an exact pin: write '<addon-id>==<version>' "
            "(for example 'monty==1.4.0'). Ranges are refused — addons are required at "
            "exact versions."
        )

    version = match["version"]
    if _VERSION_RE.match(version) is None:
        raise ManifestError(
            f"requires entry {text!r} pins no exact version: {version!r} is not a version"
        )

    return Requirement(addon_id=match["addon_id"], version=version)


def parse_settings(value: object) -> tuple[SettingsField, ...]:
    """Parse the optional ``settings`` section: an ordered list of declared fields.

    Order is the manifest's order and nothing else. Grouping (``group: "Sources"``) tells the
    application which section to draw a field under; it never reorders the form, so an author
    reading their own manifest top to bottom reads the form the user will see.

    Exposed on its own because a recorded declaration is re-read without the rest of the
    manifest around it — when values are validated against it, and when a plugin update
    changes it (plan 0004, D5).
    """
    entries = _as_sequence(value, where="settings")

    fields: list[SettingsField] = []
    declared_ids: set[str] = set()
    for index, entry in enumerate(entries):
        field = _parse_settings_field(entry, index=index)
        if field.id in declared_ids:
            raise ManifestError(
                f"settings[{index}] repeats the field id {field.id!r}: one id names one value, "
                "so two fields sharing it would each claim the same recorded setting"
            )
        declared_ids.add(field.id)
        fields.append(field)

    # Second pass, because `shown_when` may name a field declared later: visibility is decided
    # over the whole form at once, so only the drawing depends on order.
    for field in fields:
        condition = field.shown_when
        if condition is None:
            continue
        if condition.field == field.id:
            raise ManifestError(
                f"settings field {field.id!r} is shown when itself equals a value: "
                "`shown_when` names one OTHER field, never the field it belongs to"
            )
        if condition.field not in declared_ids:
            raise ManifestError(
                f"settings field {field.id!r} is shown when {condition.field!r} has a value, "
                f"but no field {condition.field!r} is declared in this settings section"
            )

    return tuple(fields)


def parse_manifest(data: Mapping[str, object]) -> AddonManifest:
    """Validate a manifest document and return it as a typed object.

    Raises :class:`ManifestError` — naming the offending value — on the first rule broken.
    """
    document = _as_mapping(data, where="manifest")
    _check_fields(document, required=_REQUIRED_FIELDS, optional=_OPTIONAL_FIELDS, where="manifest")

    addon_id = _as_str(document["id"], field="id", where="manifest")
    if not is_addon_id(addon_id):
        raise ManifestError(
            f"manifest id {addon_id!r} cannot namespace an event kind: expected lowercase "
            "letters and digits joined by single hyphens (for example 'anytype-mcp')"
        )

    version = _as_str(document["version"], field="version", where="manifest")
    if _VERSION_RE.match(version) is None:
        raise ManifestError(f"manifest version {version!r} is not an exact version")

    host_api = _as_int(document["host_api"], field="host_api", where="manifest")
    if host_api not in SUPPORTED_HOST_API_VERSIONS:
        supported = ", ".join(str(number) for number in SUPPORTED_HOST_API_VERSIONS)
        raise ManifestError(
            f"addon {addon_id!r} targets host_api {host_api}, which this host does not "
            f"implement; supported: {supported}"
        )

    requires = tuple(
        parse_requirement(entry)
        for entry in _as_str_sequence(document["requires"], field="requires", where="manifest")
    )
    emits = tuple(
        _parse_emitted_kind(entry, addon_id=addon_id)
        for entry in _as_str_sequence(document["emits"], field="emits", where="manifest")
    )
    subscribes = tuple(
        parse_subscription(entry)
        for entry in _as_str_sequence(document["subscribes"], field="subscribes", where="manifest")
    )

    stability = None if "stability" not in document else _parse_stability(document["stability"])
    update = None if "update" not in document else _parse_update(document["update"])
    settings = () if "settings" not in document else parse_settings(document["settings"])

    return AddonManifest(
        id=addon_id,
        version=version,
        host_api=host_api,
        requires=requires,
        emits=emits,
        subscribes=subscribes,
        stability=stability,
        update=update,
        settings=settings,
    )


def _parse_emitted_kind(text: str, *, addon_id: str) -> EventKind:
    """One ``emits`` entry: an exact kind, in the manifest's own namespace."""
    if text.endswith(".*"):
        raise ManifestError(
            f"emits entry {text!r} is a prefix pattern: `emits` lists exact kinds only, "
            "because an addon declares what it publishes. A prefix belongs in `subscribes`."
        )

    kind = parse_kind(text)
    if kind.addon_id != addon_id:
        raise ManifestError(
            f"addon {addon_id!r} may not emit {text!r}: a kind belongs to the addon whose id "
            f"namespaces it ({kind.addon_id!r}), so declaring it here would forge another "
            "addon's events"
        )
    return kind


def _parse_stability(value: object) -> StabilityProfile:
    """The optional ``stability`` section, filled out with the helper's defaults."""
    section = _as_mapping(value, where="stability")
    _check_fields(section, required=(), optional=_STABILITY_FIELDS, where="stability")

    heartbeat_interval = _optional_number(section, "heartbeat_interval", where="stability")
    stale_after = _optional_number(section, "stale_after", where="stability")

    if stale_after is None:
        # The plan's default: three missed heartbeats. Absent a heartbeat interval there is
        # nothing to miss, so the addon is simply never judged stale.
        stale_after = None if heartbeat_interval is None else 3 * heartbeat_interval
    elif heartbeat_interval is None:
        raise ManifestError(
            "stability.stale_after needs a heartbeat_interval: an addon that never promised "
            "heartbeats is watched for liveness and resources, and is never judged stale"
        )

    return StabilityProfile(
        heartbeat_interval=heartbeat_interval,
        stale_after=stale_after,
        max_rss_mb=_number(section, "max_rss_mb", default=1024, where="stability"),
        max_cpu_percent=_number(section, "max_cpu_percent", default=90, where="stability"),
        cpu_window=_number(section, "cpu_window", default=120, where="stability"),
        max_open_files=_count(section, "max_open_files", default=1024, where="stability"),
        # No default: absent means the helper's own limit applies, which is not ours to state.
        max_children=_optional_count(section, "max_children", where="stability"),
        breach_grace=_number(section, "breach_grace", default=60, where="stability"),
        restartable=_flag(section, "restartable", default=True, where="stability"),
    )


def _parse_update(value: object) -> UpdateSource:
    """The optional ``update`` section: where new versions come from."""
    section = _as_mapping(value, where="update")
    _check_fields(section, required=("source",), optional=_UPDATE_FIELDS, where="update")

    source = _as_str(section["source"], field="source", where="update")
    if not source:
        raise ManifestError("update.source is empty: name a source or leave the section out")

    channel = "stable"
    if "channel" in section:
        channel = _as_str(section["channel"], field="channel", where="update")
        if not channel:
            raise ManifestError("update.channel is empty: name a channel or leave it out")

    return UpdateSource(source=source, channel=channel)


# --- the settings declaration (plan 0004, slice 01) ---------------------------------------


def _parse_settings_field(value: object, *, index: int) -> SettingsField:
    """One declared field, judged whole: its attributes, its type's constraints, its default.

    Every refusal names where it happened — the field's position while the id is still
    unknown, and the id as soon as it is readable — because the person reading the message is
    a plugin author looking for their own typo.
    """
    where = f"settings[{index}]"
    section = _as_mapping(value, where=where)

    # The three every field carries, checked before anything else: without an id there is
    # nothing to name the rest of the refusals after.
    missing = [name for name in ("id", "type", "label") if name not in section]
    if missing:
        raise ManifestError(f"{where} is missing required field(s): {', '.join(missing)}")

    field_id = _as_str(section["id"], field="id", where=where)
    if not field_id:
        raise ManifestError(
            f"{where} has an empty id: a field is named so a value can be recorded against it"
        )
    where = f"{where} (id {field_id!r})"

    field_type, element_type = _split_settings_type(
        _as_str(section["type"], field="type", where=where), where=where
    )
    # A `list of <type>` constrains its elements, so the constraints are the element's.
    constrained = element_type or field_type
    _check_fields(
        section,
        required=("id", "type", "label"),
        optional=_SETTINGS_OPTIONAL_FIELDS + _SETTINGS_CONSTRAINTS.get(constrained, ()),
        where=where,
    )

    label = _as_str(section["label"], field="label", where=where)
    if not label:
        raise ManifestError(f"{where} has an empty label: the label is what the window shows")

    for constraint in _SETTINGS_REQUIRED_CONSTRAINTS.get(constrained, ()):
        if constraint not in section:
            raise ManifestError(
                f"{where} is of type {field_type!r} and must declare {constraint!r}: the "
                "application cannot draw the field without it"
            )

    field = SettingsField(
        id=field_id,
        type=field_type,
        label=label,
        help=_optional_text(section, "help", where=where),
        required=_flag(section, "required", default=False, where=where),
        group=_optional_text(section, "group", where=where),
        shown_when=_parse_shown_when(section, where=where),
        written_by=_parse_written_by(section, where=where),
        element_type=element_type,
        min=_optional_bound(section, "min", where=where),
        max=_optional_bound(section, "max", where=where),
        step=_optional_number(section, "step", where=where),
        options=_parse_options(section, where=where),
        kind=_parse_path_kind(section, where=where),
    )

    if field.min is not None and field.max is not None and field.min > field.max:
        raise ManifestError(
            f"{where} declares min {field.min} above max {field.max}: no value could satisfy both"
        )

    if "default" not in section:
        return field

    # A default is a value, so it is judged exactly as a typed one will be: an author who
    # defaults a choice to something that is not an option has written a form nobody can save.
    return replace(
        field,
        default=_checked_value(field, section["default"], where=f"{where}.default"),
    )


def _split_settings_type(declared: str, *, where: str) -> tuple[str, str | None]:
    """Split a declared type into its own spelling and, for a list, its element type."""
    if declared.startswith(_LIST_PREFIX):
        element_type = declared[len(_LIST_PREFIX) :]
        if element_type not in SETTINGS_FIELD_TYPES:
            raise ManifestError(
                f"{where} declares type {declared!r}, whose element type {element_type!r} is "
                f"not one the host draws; a list holds one of: {', '.join(SETTINGS_FIELD_TYPES)}"
            )
        return declared, element_type

    if declared not in SETTINGS_FIELD_TYPES:
        raise ManifestError(
            f"{where} declares unknown type {declared!r}: the host's vocabulary is closed at "
            f"{', '.join(SETTINGS_FIELD_TYPES)} and 'list of <type>'. A plugin cannot ship a "
            "type of its own, because a plugin that can draw in the host's window can lie in it."
        )
    return declared, None


def _parse_written_by(section: Mapping[str, object], *, where: str) -> str:
    """Who may write this field (plan 0004, F2), defaulting to the user."""
    if "written_by" not in section:
        return "user"

    writer = section["written_by"]
    if writer not in SETTINGS_WRITERS:
        raise ManifestError(
            f"{where}.written_by is {writer!r}, which is not one of: {', '.join(SETTINGS_WRITERS)}"
        )
    # `in` on a tuple of strings tells mypy nothing, so say what was just established.
    return str(writer)


def _parse_shown_when(section: Mapping[str, object], *, where: str) -> ShownWhen | None:
    """The optional one-level condition: one other field, one value it must equal."""
    if "shown_when" not in section:
        return None

    condition = _as_mapping(section["shown_when"], where=f"{where}.shown_when")
    _check_fields(condition, required=_SHOWN_WHEN_FIELDS, optional=(), where=f"{where}.shown_when")

    equals = condition["equals"]
    # One value, so the application compares rather than interprets. A list or a mapping here
    # would be a second grammar nobody agreed on (D2: one level, `equals` only).
    if not isinstance(equals, str | int | float | bool):
        raise ManifestError(
            f"{where}.shown_when.equals must be one value — a string, number or true/false — "
            f"got {type(equals).__name__}"
        )

    return ShownWhen(
        field=_as_str(condition["field"], field="shown_when.field", where=where),
        equals=equals,
    )


def _parse_options(section: Mapping[str, object], *, where: str) -> tuple[str, ...] | None:
    """A `choice`'s options: at least one, each named once."""
    if "options" not in section:
        return None

    options = _as_str_sequence(section["options"], field="options", where=where)
    if not options:
        raise ManifestError(f"{where}.options is empty: a choice needs something to choose from")

    for option in options:
        if not option:
            raise ManifestError(f"{where}.options holds an empty option, which names nothing")

    repeated = sorted({option for option in options if options.count(option) > 1})
    if repeated:
        raise ManifestError(
            f"{where}.options repeats {', '.join(repr(option) for option in repeated)}: "
            "one option is one value, and the user could not tell the copies apart"
        )
    return options


def _parse_path_kind(section: Mapping[str, object], *, where: str) -> str | None:
    """A `path`'s kind: the application draws a file picker or a folder picker, not both."""
    if "kind" not in section:
        return None

    kind = section["kind"]
    if kind not in _PATH_KINDS:
        raise ManifestError(
            f"{where}.kind is {kind!r}, which is not one of: {', '.join(_PATH_KINDS)}"
        )
    return str(kind)


def _checked_value(field: SettingsField, value: object, *, where: str) -> object:
    """Judge one value against a field's declaration, returning it as it will be held.

    A list-valued setting comes back as a tuple, so a parsed declaration — and later a
    recorded value read against it — is immutable all the way down.
    """
    if field.element_type is not None:
        items = _as_sequence(value, where=where)
        return tuple(
            _checked_scalar(field, item, type_name=field.element_type, where=f"{where}[{index}]")
            for index, item in enumerate(items)
        )
    return _checked_scalar(field, value, type_name=field.type, where=where)


def _checked_scalar(field: SettingsField, value: object, *, type_name: str, where: str) -> object:
    """One value of one of the eight non-list types."""
    if type_name in ("text", "paragraph", "path", "secret"):
        if not isinstance(value, str):
            raise ManifestError(f"{where} must be a string, got {type(value).__name__}")
        return value

    if type_name == "number":
        # `bool` is an `int` in Python, and true is never a number anybody meant to type.
        if not isinstance(value, int | float) or isinstance(value, bool):
            raise ManifestError(f"{where} must be a number, got {type(value).__name__}")
        if field.min is not None and value < field.min:
            raise ManifestError(f"{where} is {value}, below the declared min {field.min}")
        if field.max is not None and value > field.max:
            raise ManifestError(f"{where} is {value}, above the declared max {field.max}")
        return value

    if type_name == "switch":
        if not isinstance(value, bool):
            raise ManifestError(f"{where} must be true or false, got {type(value).__name__}")
        return value

    options = field.options or ()
    if type_name == "choice":
        if value not in options:
            raise ManifestError(
                f"{where} is {value!r}, which is not one of the declared options: "
                f"{', '.join(options)}"
            )
        return value

    chosen = _as_sequence(value, where=where)
    for index, option in enumerate(chosen):
        if option not in options:
            raise ManifestError(
                f"{where}[{index}] is {option!r}, which is not one of the declared options: "
                f"{', '.join(options)}"
            )
    repeated = sorted({str(option) for option in chosen if chosen.count(option) > 1})
    if repeated:
        raise ManifestError(
            f"{where} chooses {', '.join(repr(option) for option in repeated)} more than once, "
            "and a box can only be ticked once"
        )
    return tuple(chosen)


# --- typed reads, each of which refuses rather than coerces -------------------------------


def _as_mapping(value: object, *, where: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ManifestError(f"{where} must be a mapping of fields, got {type(value).__name__}")
    return value


def _check_fields(
    document: Mapping[str, object],
    *,
    required: Sequence[str],
    optional: Sequence[str],
    where: str,
) -> None:
    """Refuse a missing field, and refuse an unknown one just as firmly.

    An ignored unknown field is a setting its author believes is in force — the exact kind of
    silent disagreement between a manifest and the host that this module exists to prevent.
    """
    missing = [field for field in required if field not in document]
    if missing:
        raise ManifestError(f"{where} is missing required field(s): {', '.join(missing)}")

    unknown = sorted(set(document) - set(required) - set(optional))
    if unknown:
        raise ManifestError(
            f"{where} has unknown field(s): {', '.join(unknown)}. A misspelled field is "
            "refused rather than ignored."
        )


def _as_str(value: object, *, field: str, where: str) -> str:
    if not isinstance(value, str):
        raise ManifestError(f"{where}.{field} must be a string, got {type(value).__name__}")
    return value


def _as_int(value: object, *, field: str, where: str) -> int:
    # `bool` is an `int` in Python, and `host_api: true` is never what anyone meant.
    if not isinstance(value, int) or isinstance(value, bool):
        raise ManifestError(f"{where}.{field} must be an integer, got {type(value).__name__}")
    return value


def _as_sequence(value: object, *, where: str) -> tuple[object, ...]:
    # A bare string is a Sequence, and taking one literally iterates it into characters.
    if not isinstance(value, Sequence) or isinstance(value, str):
        raise ManifestError(f"{where} must be a list, got {type(value).__name__}")
    return tuple(value)


def _optional_text(section: Mapping[str, object], field: str, *, where: str) -> str | None:
    """A string the window shows, or ``None`` when the field is absent."""
    if field not in section:
        return None
    return _as_str(section[field], field=field, where=where)


def _optional_bound(section: Mapping[str, object], field: str, *, where: str) -> float | None:
    """A number's bound: any number, or ``None`` when absent.

    Unlike a stability limit, a bound may be zero or negative — a setting may legitimately
    run from -10 to -1.
    """
    if field not in section:
        return None

    value = section[field]
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise ManifestError(f"{where}.{field} must be a number, got {type(value).__name__}")
    return value


def _as_str_sequence(value: object, *, field: str, where: str) -> tuple[str, ...]:
    # A bare string is a Sequence, and taking one literally iterates it into characters.
    if not isinstance(value, Sequence) or isinstance(value, str):
        raise ManifestError(
            f"{where}.{field} must be a list of strings, got {type(value).__name__}"
        )

    entries: list[str] = []
    for index, entry in enumerate(value):
        if not isinstance(entry, str):
            raise ManifestError(
                f"{where}.{field}[{index}] must be a string, got {type(entry).__name__}"
            )
        entries.append(entry)
    return tuple(entries)


def _optional_number(section: Mapping[str, object], field: str, *, where: str) -> float | None:
    """A positive number, or ``None`` when the field is absent."""
    if field not in section:
        return None

    value = section[field]
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise ManifestError(f"{where}.{field} must be a number, got {type(value).__name__}")
    if value <= 0:
        raise ManifestError(f"{where}.{field} must be greater than zero, got {value}")
    return float(value)


def _number(section: Mapping[str, object], field: str, *, default: float, where: str) -> float:
    value = _optional_number(section, field, where=where)
    return default if value is None else value


def _optional_count(section: Mapping[str, object], field: str, *, where: str) -> int | None:
    """A positive whole number, or ``None`` when the field is absent."""
    if field not in section:
        return None

    value = section[field]
    if not isinstance(value, int) or isinstance(value, bool):
        raise ManifestError(f"{where}.{field} must be a whole number, got {type(value).__name__}")
    if value <= 0:
        raise ManifestError(f"{where}.{field} must be greater than zero, got {value}")
    return value


def _count(section: Mapping[str, object], field: str, *, default: int, where: str) -> int:
    value = _optional_count(section, field, where=where)
    return default if value is None else value


def _flag(section: Mapping[str, object], field: str, *, default: bool, where: str) -> bool:
    if field not in section:
        return default

    value = section[field]
    if not isinstance(value, bool):
        raise ManifestError(f"{where}.{field} must be true or false, got {type(value).__name__}")
    return value
