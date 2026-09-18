"""Subscription matching and bounded, fire-and-forget delivery — the receive side of the bus.

Slice 04 built the publish side and left exactly one seam: ``EventSink``, the callable an
:class:`~innytypes.events.emitter.Emitter` hands a checked event to. :meth:`EventBus.publish`
is that callable. Wire a bus behind an emitter and the host has a whole bus; wire a recorder
behind it and the publish side is still testable on its own.

Four choices here are load-bearing:

**Nothing a subscriber does happens on the publisher's thread.** :meth:`EventBus.publish`
matches the kind, drops one encoded payload into each matching subscriber's bounded queue and
returns. It never calls a handler, so there is no handler it can be delayed by — not a slow
one, not a hung one, not one that raises. Handlers run when something pumps the queue, which
in the host is that subscriber's own delivery thread (:mod:`innytypes.events.delivery`).

**A full queue drops the subscriber; it never waits for room.** The alternative — blocking, or
growing the queue — is the design plan 0001 forbids, because either one lets the slowest
subscriber in the process decide how fast every publisher runs. The bound is the promise: a
subscriber gets that many events of head start and not one more.

**A hang is detected as falling behind, not by a timer.** There is no watchdog on a handler,
because a watchdog has to guess how long a legitimate handler may take, and a transcription
that honestly needs a minute is indistinguishable from a deadlock to a stopwatch. A handler
that never returns stops draining its queue, the queue fills, and the subscriber is dropped by
the same rule as one that is merely slow. One mechanism, no guessing.

**A subscriber reads a copy, not the publisher's object.** Slice 04 deliberately passes
payloads through without copying — the emitter checks a payload, it does not own it. The bus
does own it: it encodes the payload once, at publish, and each subscriber decodes its own copy
when it reads its queue. So a publisher that keeps editing its dict after ``emit`` cannot
change what was already published, and two subscribers cannot edit each other's copy. This is
not tidiness. Slice 06 carries these events between processes, where a copy is what the pipe
already forces; if in-process delivery aliased instead, a bug would appear or vanish depending
on which side of a process boundary a subscriber happened to be running, which is the worst
kind of bug this bus could have. Encoding on the publisher's thread and decoding on each
subscriber's is also where the work belongs: the publisher pays once, no matter how many
subscribers there are.
"""

from __future__ import annotations

import json
import threading
from collections import deque
from collections.abc import Callable, Iterable, Mapping
from enum import StrEnum
from queue import Empty, Full, Queue

from innytypes.addons.manifest import EventKind, KindPrefix, parse_kind
from innytypes.events.emitter import Event

__all__ = [
    "ADDON_FAILED",
    "DEFAULT_QUEUE_BOUND",
    "LISTENER_FAILED",
    "DropReason",
    "EventBus",
    "EventHandler",
    "Subscription",
    "encode_payload",
    "matches",
]

# How many events a subscriber may fall behind before it is dropped. Big enough that a
# handler doing real work through a burst survives it, small enough that a dead one is
# noticed while the events it missed still matter.
DEFAULT_QUEUE_BOUND = 128

# The host's own event, and it obeys the host's own grammar: `<addon-id>.<name>.v<N>`, with
# `innytypes` as the namespace the host owns. Plan 0001 names it `innytypes.listener-failed`
# for short, but a kind without a version could not be subscribed to by name, and a kind is a
# public API — this one included.
LISTENER_FAILED = parse_kind("innytypes.listener-failed.v1")

# The host's other own event: an addon process that could not start the addon it was launched
# for. It is published by the host end of that child's connection, from the report the runner
# sends before it exits (:mod:`innytypes.addons.run`), and it is in the host's namespace rather
# than the addon's on purpose — the addon never ran, so it cannot be the sender, and a kind in
# the addon's namespace that its manifest never declared would collide with one it may declare
# tomorrow.
ADDON_FAILED = parse_kind("innytypes.addon-failed.v1")

# What a subscriber is handed. It may do anything at all, including nothing and including
# taking forever: that is the bus's problem to contain, not the handler's to promise.
EventHandler = Callable[[Event], None]


class DropReason(StrEnum):
    """Why a subscriber stopped being a subscriber.

    Both reasons are the subscriber's, never the publisher's — there is no reason in here
    for "the host was busy", because the host dropping events it could have delivered would
    be a bug rather than a state to report.
    """

    # It did not read its queue fast enough, which is also what a hung handler looks like.
    OVERFLOW = "overflow"
    # Its handler raised.
    RAISED = "raised"


class Subscription:
    """One subscriber's patterns, its bounded queue, and the handler behind it.

    Built by :meth:`EventBus.subscribe`. The queue is per subscription on purpose: a shared
    one would put every subscriber behind whichever of them is slowest, which is the thing
    the bound exists to prevent.
    """

    def __init__(
        self,
        *,
        subscriber: str,
        patterns: Iterable[EventKind | KindPrefix],
        handler: EventHandler,
        queue_bound: int,
        bus: EventBus,
    ) -> None:
        self._subscriber = subscriber
        self._patterns = tuple(patterns)
        self._handler = handler
        self._queue_bound = queue_bound
        self._bus = bus
        self._alive = True
        # The kind travels beside the payload rather than inside it, because the kind is how
        # the event was routed and re-parsing it per delivery would be work already done.
        self._queue: Queue[tuple[EventKind, str]] = Queue(maxsize=queue_bound)

    @property
    def subscriber(self) -> str:
        """Who is subscribed — the addon id the host registered this subscription for."""
        return self._subscriber

    @property
    def queue_bound(self) -> int:
        """How many undelivered events this subscriber may hold before it is dropped."""
        return self._queue_bound

    @property
    def alive(self) -> bool:
        """Whether this subscription still receives. A dropped one never comes back."""
        return self._alive

    @property
    def pending(self) -> int:
        """How many events are queued and not yet handed to the handler."""
        return self._queue.qsize()

    def matches(self, kind: EventKind) -> bool:
        """Whether any one of this subscription's patterns covers ``kind``."""
        return any(matches(pattern, kind) for pattern in self._patterns)

    def deliver_next(self, *, timeout: float = 0.0) -> bool:
        """Hand the next queued event to the handler. Returns whether there was one.

        This is the only place a handler is ever called, and it is deliberately not called
        by :meth:`EventBus.publish`: whoever calls this is the thread that carries the
        subscriber's slowness, and it is never the publisher's.

        A handler that raises has lost the event it was given and the host cannot tell what
        else it lost with it, so the subscriber is dropped and the drop is announced —
        preferable to a subscriber that quietly misses one event in twenty.
        """
        if not self._alive:
            return False

        try:
            kind, encoded = self._queue.get(timeout=timeout)
        except Empty:
            return False

        try:
            self._handler(Event(kind=kind, payload=json.loads(encoded)))
        except Exception as error:
            announcement = self._bus._drop(
                self,
                reason=DropReason.RAISED,
                kind=kind,
                detail=f"{type(error).__name__}: {error}",
            )
            if announcement is not None:
                # Published from the subscriber's own delivery thread, which is safe for the
                # same reason it is safe anywhere: publishing never blocks.
                self._bus.publish(announcement)

        return True

    def deliver_pending(self) -> int:
        """Hand over everything queued right now, and report how many that was.

        Bounded by construction: it takes what the queue holds and stops, so a publisher
        that keeps publishing cannot keep this call from returning.
        """
        delivered = 0
        while self.deliver_next():
            delivered += 1
        return delivered

    # --- used by the bus, not by a caller ---------------------------------------------------

    def _offer(self, kind: EventKind, encoded: str) -> None:
        """Put one event on the queue, or raise :class:`queue.Full`. Never waits."""
        self._queue.put_nowait((kind, encoded))

    def _discard(self) -> None:
        """Throw away what a dropped subscriber will now never read."""
        while True:
            try:
                self._queue.get_nowait()
            except Empty:
                return


class EventBus:
    """Delivery: who receives what, how far behind they may fall, and what happens when they do.

    The bus is the ``EventSink`` half of the contract slice 04 declared — :meth:`publish` has
    exactly that signature — so a host builds one bus and hands ``bus.publish`` to every
    emitter it creates.
    """

    def __init__(self, *, queue_bound: int = DEFAULT_QUEUE_BOUND) -> None:
        self._queue_bound = queue_bound
        self._subscriptions: list[Subscription] = []
        # Subscriptions are read by publishers and dropped by delivery threads, so the list
        # and the alive flag are guarded. Handlers are never called under this lock: a
        # subscriber's own code must not be able to hold up a publisher's matching.
        self._lock = threading.Lock()

    def subscribe(
        self,
        *,
        subscriber: str,
        patterns: Iterable[EventKind | KindPrefix],
        handler: EventHandler,
        queue_bound: int | None = None,
    ) -> Subscription:
        """Register one subscriber and return its subscription.

        ``patterns`` is what an addon wrote in its manifest ``subscribes``, already parsed —
        an exact kind, or a prefix such as ``whodunnit.*``. The grammar lives in
        :mod:`innytypes.addons.manifest` and is not re-implemented here.
        """
        subscription = Subscription(
            subscriber=subscriber,
            patterns=patterns,
            handler=handler,
            queue_bound=self._queue_bound if queue_bound is None else queue_bound,
            bus=self,
        )
        with self._lock:
            self._subscriptions.append(subscription)
        return subscription

    def subscriptions(self) -> tuple[Subscription, ...]:
        """Every subscription still receiving, in the order they were registered."""
        with self._lock:
            return tuple(self._subscriptions)

    def publish(self, event: Event) -> None:
        """Queue one event for every subscriber that asked for its kind, and return.

        This is the sink an emitter is built with, and it is the one method that must never
        be slow: it encodes the payload once, offers it to each matching queue without
        waiting, and drops any subscriber with no room left.

        A drop is itself announced as an event, which could in principle cascade — the
        subscriber that hears about drops can be the one that overflows. It cannot run away,
        for two reasons: the announcement is queued here rather than delivered recursively,
        and a dropped subscription is removed before its announcement is published, so each
        further announcement has strictly fewer subscribers to reach than the one before.
        """
        pending = deque([event])
        while pending:
            current = pending.popleft()
            # Encoded once, here, so every subscriber of this event reads exactly the same
            # bytes — including the ones reading them off a pipe in another process.
            encoded = encode_payload(current.payload)

            for subscription in self._matching(current.kind):
                try:
                    subscription._offer(current.kind, encoded)
                except Full:
                    announcement = self._drop(
                        subscription,
                        reason=DropReason.OVERFLOW,
                        kind=current.kind,
                        detail=(
                            f"its queue of {subscription.queue_bound} was already full; a "
                            "subscriber that hangs or falls behind is dropped, never waited on"
                        ),
                    )
                    if announcement is not None:
                        pending.append(announcement)

    def _drop(
        self,
        subscription: Subscription,
        *,
        reason: DropReason,
        kind: EventKind,
        detail: str,
    ) -> Event | None:
        """Retire a subscription and announce it, unless it was already retired.

        Returns the announcement when this call is the one that did the dropping, and
        publishes nothing itself: the caller inside :meth:`publish` queues it rather than
        recursing, and a caller on a delivery thread publishes it. ``None`` means another
        thread got there first and has already announced it — one drop, one announcement.
        """
        with self._lock:
            if not subscription._alive:
                return None
            subscription._alive = False
            self._subscriptions.remove(subscription)

        # Outside the lock: nothing below needs the registry, and a dropped subscriber's
        # queue can be large.
        subscription._discard()

        return Event(
            kind=LISTENER_FAILED,
            payload={
                "subscriber": subscription.subscriber,
                "reason": reason.value,
                "kind": str(kind),
                "detail": detail,
            },
        )

    def _matching(self, kind: EventKind) -> tuple[Subscription, ...]:
        """A snapshot of the live subscriptions this kind reaches.

        A snapshot rather than the list itself, because offering can drop a subscription and
        a dropped one is removed from that list while this loop is still walking it.
        """
        with self._lock:
            return tuple(
                subscription
                for subscription in self._subscriptions
                if subscription._alive and subscription.matches(kind)
            )


def encode_payload(payload: Mapping[str, object]) -> str:
    """Write one payload as the JSON every subscriber of that event reads.

    The one encoding in the host, on purpose. An in-process subscriber decodes this text out
    of its queue and a subscriber in another process decodes the same text off its pipe
    (:mod:`innytypes.events.transport` frames it without re-encoding it), so there is no wire
    format beside this one and no second place where "what JSON means here" could drift.

    ``allow_nan`` is off because `NaN` and `Infinity` are not JSON and nothing on the far side
    of a pipe is obliged to read them. The emitter already refuses them, naming the field
    (plan 0001); this is the same rule where it cannot be walked around.
    """
    return json.dumps(dict(payload), allow_nan=False)


def matches(pattern: EventKind | KindPrefix, kind: EventKind) -> bool:
    """Whether one subscription pattern covers one kind.

    A prefix matches on whole segments — ``monty.recorded.*`` covers ``monty.recorded.v1``
    and ``monty.recorded.v2`` but not ``monty.recorded-final.v1``, which is a different name
    rather than a longer spelling of the same one.
    """
    if isinstance(pattern, KindPrefix):
        return str(kind).startswith(f"{pattern.prefix}.")
    return pattern == kind
