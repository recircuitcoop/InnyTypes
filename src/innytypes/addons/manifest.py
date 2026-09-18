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

This module parses and judges a manifest. It discovers nothing, resolves nothing and starts
nothing, and — like every host module — it imports no addon.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from innytypes import HOST_API_VERSION

__all__ = [
    "SUPPORTED_HOST_API_VERSIONS",
    "AddonManifest",
    "EventKind",
    "KindPrefix",
    "ManifestError",
    "Requirement",
    "StabilityProfile",
    "UpdateSource",
    "is_addon_id",
    "parse_kind",
    "parse_manifest",
    "parse_requirement",
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
_OPTIONAL_FIELDS = ("stability", "update")

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

    return AddonManifest(
        id=addon_id,
        version=version,
        host_api=host_api,
        requires=requires,
        emits=emits,
        subscribes=subscribes,
        stability=stability,
        update=update,
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
