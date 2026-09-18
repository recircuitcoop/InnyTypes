"""The cross-process event bus: what an addon may publish, and what a subscriber receives.

An event kind is a public API between addons (plan 0001), so this package is where the host
enforces the two rules that make one trustworthy: an addon may emit only kinds its own id
namespaces, and only kinds its manifest declared. The kind grammar itself belongs to
:mod:`innytypes.addons.manifest`, which parses it for the manifest; nothing here re-implements
it.

The publish side lives in :mod:`innytypes.events.emitter` and hands each checked event to an
``EventSink``. :mod:`innytypes.events.bus` is that sink: it matches the kind against every
subscription, by exact kind or by prefix, and queues the event for each subscriber that asked
for it — bounded, and without ever calling a handler, so an emitter cannot be delayed by one.
:mod:`innytypes.events.delivery` runs those queues, a thread per subscriber, so that one
subscriber's pace is never another's. A subscriber that dies, hangs or falls behind is dropped
and the drop is published as ``innytypes.listener-failed.v1``.
"""

from innytypes.events.bus import (
    DEFAULT_QUEUE_BOUND,
    LISTENER_FAILED,
    DropReason,
    EventBus,
    EventHandler,
    Subscription,
)
from innytypes.events.delivery import ThreadedDelivery
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
    "DEFAULT_QUEUE_BOUND",
    "LISTENER_FAILED",
    "DropReason",
    "Emitter",
    "Event",
    "EventBus",
    "EventError",
    "EventHandler",
    "EventSink",
    "KindRegistry",
    "PayloadError",
    "Subscription",
    "ThreadedDelivery",
    "UnownedKindError",
    "UnregisteredKindError",
]
