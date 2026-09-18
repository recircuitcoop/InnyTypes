"""The cross-process event bus: what an addon may publish, and what a subscriber receives.

An event kind is a public API between addons (plan 0001), so this package is where the host
enforces the two rules that make one trustworthy: an addon may emit only kinds its own id
namespaces, and only kinds its manifest declared. The kind grammar itself belongs to
:mod:`innytypes.addons.manifest`, which parses it for the manifest; nothing here re-implements
it.

The publish side lives in :mod:`innytypes.events.emitter`. Delivery — bounded queues, prefix
matching and dropping a subscriber that falls behind — arrives behind the same ``sink`` the
emitter already takes.
"""

from innytypes.events.emitter import (
    Emitter,
    Event,
    EventError,
    EventSink,
    KindRegistry,
    PayloadError,
    UnownedKindError,
    UnregisteredKindError,
)

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
