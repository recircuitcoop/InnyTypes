"""Subscription matching and bounded, fire-and-forget delivery — the receive side of the bus.

Concurrency is what makes this slice easy to test badly, so nothing below sleeps and nothing
below passes or fails according to which thread was scheduled first.

Most of these tests run no threads at all. `EventBus.publish` only ever fills queues, so "the
emitter did not block" is asserted as *what happened* — the handler was never called and the
event is sitting in the subscriber's queue — rather than as elapsed time. A test then pumps
the queue itself, which makes every ordering in this file a written-down one.

The two tests that do run threads use barriers, never delays: a handler announces that it has
been entered and then waits to be let go, and the test asserts that its own `publish` returned
while that handler was still inside. The timeouts on `threading.Event.wait` are failure
guards — they bound a broken run, they never decide a passing one.

Each drop path is proved the hard way too: deleting the bound check, or the `except` around a
handler, turns the matching test red, because the easiest way to "pass" a requirement to drop
a subscriber is to keep delivering to it.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator

import pytest

from innytypes import HOST_API_VERSION
from innytypes.addons.manifest import AddonManifest, parse_kind, parse_manifest, parse_subscription
from innytypes.events import (
    LISTENER_FAILED,
    DropReason,
    Event,
    EventBus,
    EventHandler,
    KindRegistry,
    Subscription,
    ThreadedDelivery,
)

# How long a barrier may go untripped before the test calls the run broken. Nothing that
# passes ever waits this long: every wait below is released by the test's own next action.
BARRIER_TIMEOUT = 10.0


class Collector:
    """A handler that records what it was handed instead of doing anything with it."""

    def __init__(self) -> None:
        self.events: list[Event] = []

    def __call__(self, event: Event) -> None:
        self.events.append(event)

    @property
    def kinds(self) -> list[str]:
        """Every kind received, in arrival order."""
        return [str(event.kind) for event in self.events]


class Latch(Collector):
    """A collector that also trips a barrier when one particular kind arrives.

    This is how a threaded test waits for delivery without waiting for *time*: the barrier is
    tripped by the delivery itself, so the test resumes the moment the fact it needs is true.
    """

    def __init__(self, awaited: str) -> None:
        super().__init__()
        self._awaited = awaited
        self.arrived = threading.Event()

    def __call__(self, event: Event) -> None:
        super().__call__(event)
        if str(event.kind) == self._awaited:
            self.arrived.set()


class Blocked:
    """A handler that enters, says so, and does not return until the test lets it go.

    A subscriber that hangs is not simulated here — this one really does hold its delivery
    thread inside the handler for as long as the test wants it held.
    """

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = 0

    def __call__(self, event: Event) -> None:
        self.calls += 1
        self.entered.set()
        self.release.wait(timeout=BARRIER_TIMEOUT)


def subscribe(
    bus: EventBus,
    subscriber: str,
    *patterns: str,
    handler: EventHandler,
    queue_bound: int | None = None,
) -> Subscription:
    """Subscribe with patterns spelled as an addon would spell them in its manifest."""
    return bus.subscribe(
        subscriber=subscriber,
        patterns=[parse_subscription(pattern) for pattern in patterns],
        handler=handler,
        queue_bound=queue_bound,
    )


def watch(
    bus: EventBus,
    subscriber: str,
    *patterns: str,
    queue_bound: int | None = None,
) -> tuple[Subscription, Collector]:
    """A subscription and the collector behind it, the pair most tests want."""
    collector = Collector()
    subscription = subscribe(bus, subscriber, *patterns, handler=collector, queue_bound=queue_bound)
    return subscription, collector


def publish(bus: EventBus, kind: str, **payload: object) -> None:
    """Publish one event straight at the bus, the way a bound emitter's sink does."""
    bus.publish(Event(kind=parse_kind(kind), payload=payload))


def manifest(addon_id: str, *, emits: tuple[str, ...] = ()) -> AddonManifest:
    """One parsed manifest, so no test invents a shape the grammar would refuse."""
    return parse_manifest(
        {
            "id": addon_id,
            "version": "1.0.0",
            "host_api": HOST_API_VERSION,
            "requires": [],
            "emits": list(emits),
            "subscribes": [],
        }
    )


@pytest.fixture
def delivery() -> Iterator[ThreadedDelivery]:
    """Real delivery threads, stopped however the test ends."""
    running = ThreadedDelivery()
    try:
        yield running
    finally:
        running.close()


# --- matching ------------------------------------------------------------------------------


def test_an_exact_subscription_receives_that_kind_and_nothing_else() -> None:
    bus = EventBus()
    subscription, seen = watch(bus, "summarize", "whodunnit.transcribed.v1")

    publish(bus, "whodunnit.transcribed.v1", text="hello")
    publish(bus, "whodunnit.transcribed.v2", text="hello")
    publish(bus, "whodunnit.failed.v1", error="no audio")
    publish(bus, "monty.found.v1", path="/a.wav")
    subscription.deliver_pending()

    # v2 is a different kind, not a newer spelling of the same one — that is the whole
    # reason the version sits inside the kind.
    assert seen.kinds == ["whodunnit.transcribed.v1"]


def test_a_prefix_subscription_takes_its_family_and_nothing_outside_it() -> None:
    bus = EventBus()
    subscription, seen = watch(bus, "summarize", "whodunnit.*")

    publish(bus, "whodunnit.transcribed.v1", text="hello")
    publish(bus, "whodunnit.failed.v1", error="no audio")
    publish(bus, "monty.found.v1", path="/a.wav")
    subscription.deliver_pending()

    assert seen.kinds == ["whodunnit.transcribed.v1", "whodunnit.failed.v1"]


def test_a_prefix_matches_every_version_of_a_kind() -> None:
    bus = EventBus()
    subscription, seen = watch(bus, "summarize", "monty.recorded.*")

    publish(bus, "monty.recorded.v1", path="/a.wav")
    publish(bus, "monty.recorded.v2", path="/a.wav", duration=12)
    subscription.deliver_pending()

    # A payload change is a new kind, and a subscriber that asked for the family said it
    # wants both spellings.
    assert seen.kinds == ["monty.recorded.v1", "monty.recorded.v2"]


def test_a_prefix_stops_at_a_segment_boundary() -> None:
    bus = EventBus()
    subscription, seen = watch(bus, "summarize", "monty.recorded.*")

    publish(bus, "monty.recorded-final.v1", path="/a.wav")
    subscription.deliver_pending()

    # `recorded-final` is a different name, not a longer spelling of `recorded`. A plain
    # string prefix would have matched it.
    assert seen.kinds == []


def test_two_patterns_that_both_match_deliver_the_event_once() -> None:
    bus = EventBus()
    subscription, seen = watch(bus, "summarize", "whodunnit.*", "whodunnit.transcribed.v1")

    publish(bus, "whodunnit.transcribed.v1", text="hello")
    subscription.deliver_pending()

    assert seen.kinds == ["whodunnit.transcribed.v1"]


# --- the emitter never blocks --------------------------------------------------------------


def test_publish_queues_the_event_and_calls_no_handler() -> None:
    bus = EventBus(queue_bound=4)
    called: list[Event] = []

    def handler(event: Event) -> None:  # pragma: no cover - the point is that it is not run
        called.append(event)

    subscription = subscribe(bus, "summarize", "monty.recorded.v1", handler=handler)

    publish(bus, "monty.recorded.v1", path="/a.wav")

    # This is the invariant, stated as a fact rather than as a stopwatch: publish returned,
    # and whatever the subscriber would have done has not happened yet.
    assert called == []
    assert subscription.pending == 1


def test_the_bus_is_the_sink_a_bound_emitter_was_built_to_take() -> None:
    bus = EventBus()
    registry = KindRegistry()
    emitter = registry.emitter_for(
        manifest("monty", emits=("monty.recorded.v1",)), sink=bus.publish
    )
    subscription, seen = watch(bus, "whodunnit", "monty.*")

    emitter.emit("monty.recorded.v1", {"path": "/a.wav"})
    subscription.deliver_pending()

    assert seen.kinds == ["monty.recorded.v1"]
    assert seen.events[0].payload == {"path": "/a.wav"}


def test_an_emit_returns_while_a_subscriber_is_still_inside_its_handler(
    delivery: ThreadedDelivery,
) -> None:
    bus = EventBus(queue_bound=8)
    blocked = Blocked()
    subscription = subscribe(bus, "whodunnit", "monty.recorded.v1", handler=blocked)
    delivery.run(subscription)

    try:
        publish(bus, "monty.recorded.v1", path="/a.wav")
        assert blocked.entered.wait(timeout=BARRIER_TIMEOUT), "the handler was never entered"

        # The handler is inside the call right now and has not been let go. If publish took
        # the subscriber's pace into account at all, this line could not return.
        publish(bus, "monty.recorded.v1", path="/b.wav")

        assert not blocked.release.is_set()
        assert blocked.calls == 1
    finally:
        blocked.release.set()


# --- falling behind ------------------------------------------------------------------------


def test_a_subscriber_that_falls_behind_is_dropped_at_its_bound() -> None:
    bus = EventBus(queue_bound=2)
    subscription, seen = watch(bus, "summarize", "monty.recorded.v1")

    publish(bus, "monty.recorded.v1", index=1)
    publish(bus, "monty.recorded.v1", index=2)
    assert subscription.alive

    publish(bus, "monty.recorded.v1", index=3)

    assert not subscription.alive
    assert subscription not in bus.subscriptions()
    assert seen.events == []


def test_the_queue_never_grows_past_the_bound() -> None:
    bus = EventBus(queue_bound=2)
    subscription, _seen = watch(bus, "summarize", "monty.recorded.v1")

    sizes = []
    for index in range(8):
        publish(bus, "monty.recorded.v1", index=index)
        sizes.append(subscription.pending)

    # Never a queue that grew to hold what the subscriber never read — and eight events
    # later there is no queue at all, because the subscriber was dropped rather than fed.
    assert max(sizes) == 2
    assert not subscription.alive
    assert subscription.pending == 0


def test_a_dropped_subscriber_loses_what_it_had_not_read() -> None:
    bus = EventBus(queue_bound=1)
    subscription, seen = watch(bus, "summarize", "monty.recorded.v1")

    publish(bus, "monty.recorded.v1", index=1)
    publish(bus, "monty.recorded.v1", index=2)

    assert subscription.deliver_pending() == 0
    assert seen.events == []
    assert subscription.pending == 0

    # And it stays gone: a later event does not reach it either.
    publish(bus, "monty.recorded.v1", index=3)
    assert subscription.deliver_pending() == 0


# --- the drop is announced -----------------------------------------------------------------


def test_dropping_an_overflowed_subscriber_is_announced_as_listener_failed() -> None:
    bus = EventBus(queue_bound=1)
    _slow, _ignored = watch(bus, "summarize", "monty.recorded.v1")
    watcher, heard = watch(bus, "innytypes-helper", "innytypes.*", queue_bound=8)

    publish(bus, "monty.recorded.v1", index=1)
    publish(bus, "monty.recorded.v1", index=2)
    watcher.deliver_pending()

    assert heard.kinds == ["innytypes.listener-failed.v1"]
    payload = heard.events[0].payload
    assert payload["subscriber"] == "summarize"
    assert payload["reason"] == "overflow"
    assert payload["kind"] == "monty.recorded.v1"
    assert "1" in str(payload["detail"])


def test_a_handler_that_raises_is_dropped_and_announced() -> None:
    bus = EventBus()

    def handler(event: Event) -> None:
        raise RuntimeError("the transcript directory is gone")

    dying = subscribe(bus, "whodunnit", "monty.recorded.v1", handler=handler)
    watcher, heard = watch(bus, "innytypes-helper", "innytypes.listener-failed.v1")

    publish(bus, "monty.recorded.v1", index=1)
    assert dying.deliver_pending() == 1
    watcher.deliver_pending()

    assert not dying.alive
    assert heard.kinds == ["innytypes.listener-failed.v1"]
    payload = heard.events[0].payload
    assert payload["subscriber"] == "whodunnit"
    assert payload["reason"] == "raised"
    assert "the transcript directory is gone" in str(payload["detail"])


def test_dropping_one_subscriber_leaves_the_others_receiving() -> None:
    bus = EventBus(queue_bound=1)
    slow, missed = watch(bus, "summarize", "monty.recorded.v1")
    keeping_up, seen = watch(bus, "whodunnit", "monty.recorded.v1")

    for index in range(3):
        publish(bus, "monty.recorded.v1", index=index)
        keeping_up.deliver_pending()

    assert not slow.alive
    assert missed.events == []
    assert keeping_up.alive
    assert [event.payload["index"] for event in seen.events] == [0, 1, 2]


def test_the_announcement_of_a_lost_announcement_does_not_recur_forever() -> None:
    # Both subscribers hear about drops *and* fall behind, so dropping either one produces an
    # announcement that the other cannot take. Delivery has to stop on its own.
    bus = EventBus(queue_bound=1)
    first, _a = watch(bus, "summarize", "monty.recorded.v1", "innytypes.*")
    second, _b = watch(bus, "whodunnit", "monty.recorded.v1", "innytypes.*")

    publish(bus, "monty.recorded.v1", index=1)
    publish(bus, "monty.recorded.v1", index=2)

    assert not first.alive
    assert not second.alive
    assert bus.subscriptions() == ()


def test_a_subscriber_dropped_twice_is_announced_once() -> None:
    # The race no test can schedule: a publisher finding the queue full at the same moment
    # the subscriber's own delivery thread catches its handler raising. Both call the drop,
    # and only one of them may remove the subscription and announce it — so it is called
    # twice here directly, which is the only way to put the two calls in a written-down order.
    bus = EventBus()
    subscription, _ignored = watch(bus, "summarize", "monty.recorded.v1")
    kind = parse_kind("monty.recorded.v1")

    first = bus._drop(subscription, reason=DropReason.OVERFLOW, kind=kind, detail="full")
    second = bus._drop(subscription, reason=DropReason.RAISED, kind=kind, detail="boom")

    assert first is not None
    assert second is None
    assert bus.subscriptions() == ()


def test_the_host_announcement_obeys_the_kind_grammar() -> None:
    # `innytypes.listener-failed` on its own is not a kind and could not be subscribed to by
    # name. The host's own events are public API under the same rule as an addon's.
    assert str(LISTENER_FAILED) == "innytypes.listener-failed.v1"
    assert parse_kind(str(LISTENER_FAILED)) == LISTENER_FAILED


# --- what a subscriber receives ------------------------------------------------------------


def test_a_subscriber_reads_a_copy_the_publisher_can_no_longer_change() -> None:
    bus = EventBus()
    subscription, seen = watch(bus, "summarize", "monty.recorded.v1")

    payload: dict[str, object] = {"path": "/a.wav", "tags": ["draft"]}
    bus.publish(Event(kind=parse_kind("monty.recorded.v1"), payload=payload))

    # The publisher keeps hold of its own dict and edits it after the fact, which is exactly
    # what it could not do if the event had already gone down a pipe.
    payload["path"] = "/moved.wav"
    tags = payload["tags"]
    assert isinstance(tags, list)
    tags.append("final")

    subscription.deliver_pending()

    assert seen.events[0].payload == {"path": "/a.wav", "tags": ["draft"]}


def test_two_subscribers_each_read_their_own_copy() -> None:
    bus = EventBus()
    first, one = watch(bus, "summarize", "monty.recorded.v1")
    second, two = watch(bus, "whodunnit", "monty.recorded.v1")

    publish(bus, "monty.recorded.v1", path="/a.wav")
    first.deliver_pending()

    received = one.events[0].payload
    assert isinstance(received, dict)
    received["path"] = "/rewritten.wav"

    second.deliver_pending()

    assert two.events[0].payload == {"path": "/a.wav"}


# --- real threads --------------------------------------------------------------------------


def test_a_stuck_subscriber_is_dropped_while_the_others_keep_receiving(
    delivery: ThreadedDelivery,
) -> None:
    bus = EventBus()
    blocked = Blocked()
    # A bound of one, so a single event left waiting behind the stuck handler is already all
    # the room this subscriber has.
    stuck = subscribe(bus, "whodunnit", "monty.recorded.v1", handler=blocked, queue_bound=1)
    heard = Latch(str(LISTENER_FAILED))
    healthy = subscribe(
        bus,
        "summarize",
        "monty.recorded.v1",
        "innytypes.*",
        handler=heard,
        queue_bound=64,
    )
    delivery.run(stuck)
    delivery.run(healthy)

    try:
        publish(bus, "monty.recorded.v1", index=0)
        assert blocked.entered.wait(timeout=BARRIER_TIMEOUT), "the handler was never entered"

        # One to fill the stuck subscriber's queue, one it has nowhere to put.
        publish(bus, "monty.recorded.v1", index=1)
        publish(bus, "monty.recorded.v1", index=2)

        assert heard.arrived.wait(timeout=BARRIER_TIMEOUT), "the drop was never announced"
    finally:
        blocked.release.set()

    assert not stuck.alive
    assert stuck not in bus.subscriptions()
    assert healthy.alive

    announcement = heard.events[-1]
    assert announcement.payload["subscriber"] == "whodunnit"
    assert announcement.payload["reason"] == "overflow"
    # The queue is FIFO, so everything published before the drop reached the healthy
    # subscriber before the announcement of it did.
    assert heard.kinds[:3] == ["monty.recorded.v1"] * 3
