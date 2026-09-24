"""The kind registry and the per-addon bound emitter — the publish side of the bus.

Addons define their own event kinds and subscribe to each other's, which only works if a
subscriber can trust who sent what. So the host never hands out a general-purpose publish
function: it builds an emitter **bound** to one addon's id, and that binding is the only
source of a published event's identity. There is no `source` argument anywhere below,
deliberately — an argument an addon fills in is an argument an addon can lie about.

Three choices here are load-bearing:

**A kind belongs to the addon whose id namespaces it.** ``monty`` emitting
``whodunnit.transcribed.v1`` is refused even though the kind is perfectly well-formed and
even when ``whodunnit`` really did register it. Registration is a declaration, never a
permission slip.

**An unregistered kind is refused, not registered on the way out.** Auto-registering the
first emit would turn a typo into a public API nobody declared — and because a kind is a
public API (plan 0001), that API would then have to keep working forever. The registry after
a refused emit looks exactly as it did before it.

**A payload is JSON, and that is checked at emit time.** Every event crosses a process
boundary, so a payload that cannot make the trip is a failure that would otherwise surface
far away and much later, in a subscriber, with the call site that built it long gone. "JSON"
here means what arrives is what was published: a `set` and an open file are refused for being
unserializable, and a tuple, a non-string key and a `NaN` are refused for changing shape or
meaning in transit. The walk names the field it stopped at, because a payload with forty
fields tells you nothing otherwise.

This module is the publish side only. Delivery — the bounded per-subscriber queue, prefix
matching, drop-on-overflow and ``innytypes.listener-failed`` — is slice 05, and it arrives
through the ``sink`` this module already requires. That seam is also why an emitter here can
never block: it hands the event on and returns.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from innytypes.addons.manifest import AddonManifest, EventKind, parse_kind
from innytypes.logs import get_logger

__all__ = [
    "Emitter",
    "Event",
    "EventError",
    "EventSink",
    "KindRegistry",
    "PayloadError",
    "UnownedKindError",
    "UnregisteredKindError",
]

log = get_logger(__name__)


class EventError(ValueError):
    """Raised when an emit is refused.

    One base for all three refusals, so a caller that wants to report "this addon tried to
    publish something it may not" can catch once. A kind that is not a kind at all is not
    here: it is refused by the grammar in :mod:`innytypes.addons.manifest`, which is where
    the grammar lives and where it stays.
    """


class UnownedKindError(EventError):
    """Raised when an addon tries to emit a kind another addon's id namespaces."""


class UnregisteredKindError(EventError):
    """Raised when an addon emits a kind of its own that its manifest never declared."""


class PayloadError(EventError):
    """Raised when a payload would not survive the process boundary intact."""


@dataclass(frozen=True)
class Event:
    """One published event: the kind, and the payload that was checked against JSON.

    There is no separate sender field. ``kind.addon_id`` is the sender, because an emitter
    is refused any kind it does not own — one fact, recorded once, unable to disagree with
    itself.
    """

    kind: EventKind
    payload: Mapping[str, object]


# Where a checked event goes. Slice 05 puts the bus here; until then a caller supplies its
# own. It is injected rather than imported so that this slice can be finished, and tested,
# without a delivery mechanism existing at all.
EventSink = Callable[[Event], None]


class Emitter:
    """An addon's only way to publish, bound to that addon's id for its whole life.

    Built by :meth:`KindRegistry.emitter_for`. Every :meth:`emit` is checked against the
    binding first, the registry second and JSON third, and a refusal at any of those means
    nothing reached the sink.
    """

    def __init__(self, *, addon_id: str, registry: KindRegistry, sink: EventSink) -> None:
        self._addon_id = addon_id
        self._registry = registry
        self._sink = sink

    @property
    def addon_id(self) -> str:
        """The addon this emitter publishes as. Set once, at construction."""
        return self._addon_id

    def emit(self, kind: EventKind | str, payload: Mapping[str, object]) -> None:
        """Publish one event, or refuse it by name.

        Raises :class:`UnownedKindError` for another addon's kind,
        :class:`UnregisteredKindError` for a kind absent from this addon's manifest
        ``emits``, and :class:`PayloadError` for a payload that is not JSON. A malformed
        kind string is refused by the grammar itself, as
        :class:`~innytypes.addons.manifest.ManifestError`.
        """
        # The grammar is the manifest module's, so a kind an addon writes in code and a
        # kind it writes in its manifest cannot be judged by two different rules.
        parsed = parse_kind(kind) if isinstance(kind, str) else kind

        # Ownership first: a payload fix would not make a forgery legal, so the forgery is
        # what gets reported.
        if parsed.addon_id != self._addon_id:
            raise UnownedKindError(
                f"addon {self._addon_id!r} may not emit {parsed}: that kind belongs to "
                f"{parsed.addon_id!r}, the addon whose id namespaces it. An emitter is bound "
                "to one addon so a subscriber can trust who sent what."
            )

        if not self._registry.is_registered(parsed):
            raise UnregisteredKindError(
                f"addon {self._addon_id!r} may not emit {parsed}: it is not in the addon's "
                "manifest `emits`. Declare it there — an unregistered kind is refused rather "
                "than registered on the fly, because that would turn a typo into a public API "
                "nobody declared."
            )

        _check_payload(payload, kind=parsed)

        # **The first of the three records an event leaves** (plan 0012, slice 04): emitted
        # here, accepted or refused at the host end of the channel
        # (:mod:`innytypes.events.channel`). DEBUG, and deliberately: an ordinary emit is the
        # most routine thing this application does and is certainly not a warning, so it is at
        # the one level a person turns *on* when the question is whether events fire at all.
        #
        # The field **names**, never the values. A payload is the user's content — a document
        # title, the label of a volume somebody plugged in — and the question a log answers is
        # whether the event fired and what kind it was, not what was inside it.
        log.debug(
            "event emitted: %s by %s, fields %s",
            parsed,
            self._addon_id,
            ", ".join(sorted(payload)) or "(none)",
        )

        # Fire and forget. Whatever the sink does with this — queue it, drop it, put it on a
        # pipe — it does on its own time; an emitter never blocks on a subscriber.
        self._sink(Event(kind=parsed, payload=payload))


class KindRegistry:
    """Every event kind the installed addons declared, and the emitters bound to them.

    Kinds are keyed by their full spelling, ``<addon-id>.<name>.v<N>``, and that is the
    whole of the collision story: ``a.done.v1`` and ``b.done.v1`` are two kinds because two
    addons own them, and ``x.done.v2`` is a third kind rather than an edit to ``x.done.v1``
    — which is exactly what makes a payload change safe for whoever already subscribed.
    """

    def __init__(self) -> None:
        self._kinds: dict[str, EventKind] = {}

    def register(self, *kinds: EventKind) -> None:
        """Record kinds as declared, without building an emitter for them.

        The host needs this for two sets of kinds that belong to no addon manifest: its own
        (``innytypes.listener-failed.v1``, ``innytypes.addon-failed.v1``) and, in the host
        process, the declarations of addons whose emitters live in their own processes
        (:mod:`innytypes.addons.run`). Registering is idempotent: the same kind twice leaves
        the registry exactly as it was.
        """
        for kind in kinds:
            self._kinds[str(kind)] = kind

    def emitter_for(self, manifest: AddonManifest, *, sink: EventSink) -> Emitter:
        """Register a manifest's ``emits`` and return that addon's bound emitter.

        Registering is idempotent: the same manifest twice, or a later manifest that adds a
        kind, leaves everything already registered exactly where it was.
        """
        # `emits` was validated as this addon's own on the way into the manifest, so there is
        # no ownership to re-check here — only one place decides that.
        self.register(*manifest.emits)
        return Emitter(addon_id=manifest.id, registry=self, sink=sink)

    def is_registered(self, kind: EventKind | str) -> bool:
        """Whether this exact kind — namespace, name and version — was declared."""
        return str(kind) in self._kinds

    def kinds(self) -> tuple[EventKind, ...]:
        """Every registered kind, in one stable order so two reads cannot disagree."""
        return tuple(self._kinds[spelling] for spelling in sorted(self._kinds))


# --- the payload walk: JSON, or a refusal naming the field ---------------------------------


def _check_payload(payload: object, *, kind: EventKind) -> None:
    """Refuse anything in ``payload`` that would not cross a process boundary unchanged."""
    if not isinstance(payload, Mapping):
        raise PayloadError(
            f"payload for {kind} must be a mapping of field names to JSON values, got "
            f"{type(payload).__name__}. Every event crosses a process boundary, so a payload "
            "is a JSON object or it is nothing."
        )

    _check_mapping(payload, kind=kind, path="", enclosing=(id(payload),))


def _check_mapping(
    mapping: Mapping[object, object],
    *,
    kind: EventKind,
    path: str,
    enclosing: tuple[int, ...],
) -> None:
    for key, value in mapping.items():
        if not isinstance(key, str):
            raise PayloadError(
                f"payload for {kind} is not JSON: {_where(path)} has the non-string key "
                f"{key!r} ({type(key).__name__}). JSON object keys are strings, and a key "
                "silently stringified in transit is not the key the subscriber was promised."
            )
        _check_value(value, kind=kind, path=_field(path, key), enclosing=enclosing)


def _check_value(
    value: object,
    *,
    kind: EventKind,
    path: str,
    enclosing: tuple[int, ...],
) -> None:
    """One value, and everything under it. Recurses no further than the payload nests."""
    # `bool` is checked with the scalars on purpose: it is a subclass of `int` and both are
    # JSON, so the order only matters to a reader.
    if value is None or isinstance(value, str | bool | int):
        return

    if isinstance(value, float):
        if not math.isfinite(value):
            raise PayloadError(
                f"payload for {kind} is not JSON: {_where(path)} is {value!r}, which "
                "`json.dumps` writes as a bare NaN or Infinity. That is not JSON, and the "
                "far side of the boundary is under no obligation to read it."
            )
        return

    if isinstance(value, Mapping):
        _guard_cycle(value, kind=kind, path=path, enclosing=enclosing)
        _check_mapping(value, kind=kind, path=path, enclosing=(*enclosing, id(value)))
        return

    # `list` exactly, not `Sequence`: a tuple is a sequence that arrives as a list, and a
    # payload that changes shape in transit is not the payload that was published.
    if isinstance(value, list):
        _guard_cycle(value, kind=kind, path=path, enclosing=enclosing)
        inside = (*enclosing, id(value))
        for index, item in enumerate(value):
            _check_value(item, kind=kind, path=f"{path}[{index}]", enclosing=inside)
        return

    raise PayloadError(
        f"payload for {kind} is not JSON: {_where(path)} is a {type(value).__name__}, and "
        "a JSON value is an object, a list, a string, a finite number, a boolean or null. "
        "Every event crosses a process boundary, so this is refused here, where the call "
        "site that built it is still in front of you."
    )


def _guard_cycle(
    container: object,
    *,
    kind: EventKind,
    path: str,
    enclosing: tuple[int, ...],
) -> None:
    """Refuse a payload that contains itself, rather than recursing into it forever."""
    if id(container) in enclosing:
        raise PayloadError(
            f"payload for {kind} is not JSON: {_where(path)} contains the payload it is "
            "part of. JSON has no way to write that, and following it has no end."
        )


def _field(path: str, key: str) -> str:
    return key if not path else f"{path}.{key}"


def _where(path: str) -> str:
    """How to name the spot the walk stopped at — a field, or the payload itself."""
    return "the payload" if not path else f"field {path!r}"
