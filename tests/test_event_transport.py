"""The cross-process transport: the same guarantees, proved on both sides of the boundary.

**Nothing here opens a socket, a pipe or a subprocess, and nothing sleeps.** Both ends of every
connection live in this file: `linked_connections` returns two in-memory ends that hand frames
to each other, so "the addon process" below is a second `EventBus` with a transport in front of
it, driven by this test rather than by a scheduler. `StreamConnection`, the byte-stream
implementation the host really uses, is exercised over `io.BytesIO` — a stream with no operating
system behind it.

**The equivalence is asserted, not asserted about.** The matching and bound cases are
parametrized over `Local` and `Remote`, which present the same surface — subscribe, settle, read
what arrived — so every one of them runs twice, once through the in-process bus and once through
a pipe, and passes only if both answer identically. A transport that quietly matched differently,
or buffered without limit, would fail the cross-process half of a test its in-process half still
passes.

**The two threaded tests use barriers, never delays.** A connection whose far end never drains is
written as a `send` that really does not return until this test lets it, and the assertion is
that `publish` returned while that write was still stuck — a fact about what happened, not about
how long it took. The timeouts are failure guards: nothing that passes ever waits on one.

Each refusal is proved the hard way. Delete the bound check and the cross-process bound test goes
red; delete the `except` around a handler and the closed-pipe test stops seeing its announcement;
delete the `accepts` check and the forged-kind test passes an event the emitter would refuse.
"""

from __future__ import annotations

import io
import json
import threading
from collections import deque
from collections.abc import Iterator

import pytest

from innytypes import HOST_API_VERSION
from innytypes.addons.manifest import AddonManifest, parse_kind, parse_manifest, parse_subscription
from innytypes.events import (
    DEFAULT_QUEUE_BOUND,
    Event,
    EventBus,
    EventTransport,
    FramingError,
    KindRegistry,
    PeerGoneError,
    StreamConnection,
    Subscription,
    ThreadedDelivery,
    UnownedKindError,
    frame_event,
    unframe_event,
)

# How long a barrier may go untripped before the test calls the run broken. Nothing that passes
# ever waits this long: every wait below is released by the test's own next action.
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


class FakeConnection:
    """One end of an injected connection whose other end is also in this test.

    Two deques crossed over, and a gate. The gate is what makes "the far end is not reading"
    expressible without an operating system: hold it, and a `send` entered from a delivery
    thread stays inside the call until this test releases it — which is exactly what a write
    into a full pipe buffer does.
    """

    def __init__(self, *, outbox: deque[str], inbox: deque[str]) -> None:
        self.outbox = outbox
        self._inbox = inbox
        self.closed = False
        self.sending = threading.Event()
        self._gate = threading.Event()
        self._gate.set()

    def send(self, frame: str) -> None:
        self.sending.set()
        self._gate.wait(timeout=BARRIER_TIMEOUT)
        if self.closed:
            raise PeerGoneError("the connection is closed")
        self.outbox.append(frame)

    def receive(self) -> str | None:
        if self._inbox:
            return self._inbox.popleft()
        if self.closed:
            raise PeerGoneError("the far end closed the connection")
        return None

    def close(self) -> None:
        self.closed = True

    def hold(self) -> None:
        """Stop returning from `send` until `release`."""
        self._gate.clear()

    def release(self) -> None:
        self._gate.set()


def linked_connections() -> tuple[FakeConnection, FakeConnection]:
    """A host end and an addon end: what either sends, the other receives."""
    to_addon: deque[str] = deque()
    to_host: deque[str] = deque()
    return (
        FakeConnection(outbox=to_addon, inbox=to_host),
        FakeConnection(outbox=to_host, inbox=to_addon),
    )


class Local:
    """A subscriber in the host's own process — the shape slice 05 delivers to."""

    def __init__(
        self,
        bus: EventBus,
        subscriber: str,
        *patterns: str,
        queue_bound: int | None = None,
    ) -> None:
        self.collector = Collector()
        self.subscription = bus.subscribe(
            subscriber=subscriber,
            patterns=[parse_subscription(pattern) for pattern in patterns],
            handler=self.collector,
            queue_bound=queue_bound,
        )

    def settle(self) -> None:
        """Carry everything queued as far as it goes."""
        self.subscription.deliver_pending()

    @property
    def events(self) -> list[Event]:
        return self.collector.events

    @property
    def kinds(self) -> list[str]:
        return self.collector.kinds


class Remote:
    """The same subscriber one process further out, with both ends of its pipe in this test.

    The addon process is modelled honestly rather than stubbed: it has its own bus for what
    arrives, its own spool for what it emits, and a transport between them and the pipe. The
    two are separate on purpose — an addon is a client of the host's one bus, not the owner of
    a second one — which is also what keeps an addon subscribed to its own kinds from bouncing
    them between the processes forever.
    """

    def __init__(
        self,
        bus: EventBus,
        subscriber: str,
        *patterns: str,
        queue_bound: int | None = None,
    ) -> None:
        parsed = [parse_subscription(pattern) for pattern in patterns]
        self.host_side, self.addon_side = linked_connections()

        self.local_bus = EventBus()
        self.spool = EventBus()
        self.collector = Collector()
        self.inbox = self.local_bus.subscribe(
            subscriber=subscriber,
            patterns=parsed,
            handler=self.collector,
        )
        self.addon_end = EventTransport(
            peer="innytypes",
            connection=self.addon_side,
            outbound=self.spool,
            forwards=[parse_subscription(f"{subscriber}.*")],
            inbound=self.local_bus.publish,
        )

        self.host_end = EventTransport(
            peer=subscriber,
            connection=self.host_side,
            outbound=bus,
            forwards=parsed,
            inbound=bus.publish,
            accepts=[parse_subscription(f"{subscriber}.*")],
            queue_bound=queue_bound,
        )

    @property
    def subscription(self) -> Subscription:
        """What the host bus sees: the peer's queue, its bound and its liveness."""
        return self.host_end.subscription

    def settle(self) -> None:
        """Carry everything queued host-side all the way to the far-end handler."""
        while self.host_end.pump_outbound():
            pass
        while self.addon_end.pump_inbound():
            pass
        self.inbox.deliver_pending()

    @property
    def events(self) -> list[Event]:
        return self.collector.events

    @property
    def kinds(self) -> list[str]:
        return self.collector.kinds


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


# --- an event reaches another process ------------------------------------------------------


def test_an_emitted_event_arrives_on_the_far_end_exactly_as_it_was_emitted() -> None:
    bus = EventBus()
    registry = KindRegistry()
    emitter = registry.emitter_for(
        manifest("monty", emits=("monty.recorded.v1",)), sink=bus.publish
    )
    remote = Remote(bus, "whodunnit", "monty.*")

    emitter.emit("monty.recorded.v1", {"path": "/a.wav", "duration": 12, "tags": ["draft"]})

    # Step by step rather than through `settle`, because each step is one of the claims: the
    # host queued it, the wire carried JSON, the far end decoded that JSON into the event.
    assert remote.host_end.pump_outbound()
    on_the_wire = remote.host_side.outbox[0]
    assert json.loads(on_the_wire) == {
        "kind": "monty.recorded.v1",
        "payload": {"path": "/a.wav", "duration": 12, "tags": ["draft"]},
    }

    assert remote.addon_end.pump_inbound()
    remote.inbox.deliver_pending()

    assert remote.kinds == ["monty.recorded.v1"]
    assert remote.events[0].payload == {"path": "/a.wav", "duration": 12, "tags": ["draft"]}
    assert remote.events[0].kind == parse_kind("monty.recorded.v1")


def test_a_frame_is_one_line_so_a_stream_can_tell_where_it_ends() -> None:
    framed = frame_event(Event(kind=parse_kind("monty.recorded.v1"), payload={"note": "a\nb"}))

    # The newline inside the payload survives as an escape, so the terminator the stream reads
    # for is the only newline in the frame.
    assert "\n" not in framed
    assert unframe_event(framed).payload == {"note": "a\nb"}


# --- matching is the same on both sides ----------------------------------------------------

MATCHING = [
    pytest.param(
        ("whodunnit.transcribed.v1",),
        (
            "whodunnit.transcribed.v1",
            "whodunnit.transcribed.v2",
            "whodunnit.failed.v1",
            "monty.found.v1",
        ),
        ["whodunnit.transcribed.v1"],
        id="an-exact-kind-and-nothing-else",
    ),
    pytest.param(
        ("whodunnit.*",),
        ("whodunnit.transcribed.v1", "whodunnit.failed.v1", "monty.found.v1"),
        ["whodunnit.transcribed.v1", "whodunnit.failed.v1"],
        id="a-family-and-nothing-outside-it",
    ),
    pytest.param(
        ("monty.recorded.*",),
        ("monty.recorded.v1", "monty.recorded.v2"),
        ["monty.recorded.v1", "monty.recorded.v2"],
        id="every-version-of-one-kind",
    ),
    pytest.param(
        ("monty.recorded.*",),
        ("monty.recorded-final.v1",),
        [],
        id="a-prefix-stops-at-a-segment-boundary",
    ),
    pytest.param(
        ("whodunnit.*", "whodunnit.transcribed.v1"),
        ("whodunnit.transcribed.v1",),
        ["whodunnit.transcribed.v1"],
        id="two-patterns-that-both-match-deliver-once",
    ),
]


@pytest.mark.parametrize(("patterns", "published", "expected"), MATCHING)
@pytest.mark.parametrize("subscriber", [Local, Remote], ids=["in-process", "cross-process"])
def test_matching_is_identical_on_both_sides_of_the_process_boundary(
    subscriber: type[Local] | type[Remote],
    patterns: tuple[str, ...],
    published: tuple[str, ...],
    expected: list[str],
) -> None:
    bus = EventBus()
    listening = subscriber(bus, "summarize", *patterns)

    for index, kind in enumerate(published):
        publish(bus, kind, index=index)
    listening.settle()

    assert listening.kinds == expected


@pytest.mark.parametrize("subscriber", [Local, Remote], ids=["in-process", "cross-process"])
def test_a_subscriber_reads_the_payload_that_was_published(
    subscriber: type[Local] | type[Remote],
) -> None:
    bus = EventBus()
    listening = subscriber(bus, "summarize", "monty.recorded.v1")

    payload: dict[str, object] = {"path": "/a.wav", "tags": ["draft"]}
    bus.publish(Event(kind=parse_kind("monty.recorded.v1"), payload=payload))

    # The publisher edits its own dict afterwards, which is what it could not do if the event
    # had already gone down a pipe — and, because the bus encodes once at publish, cannot do
    # to an in-process subscriber either.
    payload["path"] = "/moved.wav"
    listening.settle()

    assert listening.events[0].payload == {"path": "/a.wav", "tags": ["draft"]}


# --- the bound is the same bound -----------------------------------------------------------


@pytest.mark.parametrize("subscriber", [Local, Remote], ids=["in-process", "cross-process"])
def test_a_subscriber_that_is_never_drained_stops_at_the_bound_and_is_dropped(
    subscriber: type[Local] | type[Remote],
) -> None:
    bus = EventBus(queue_bound=2)
    listening = subscriber(bus, "summarize", "monty.recorded.v1")

    # Nothing drains the far end at all: no pump, no delivery thread, nobody reading the pipe.
    sizes = []
    for index in range(8):
        publish(bus, "monty.recorded.v1", index=index)
        sizes.append(listening.subscription.pending)

    assert max(sizes) == 2
    assert not listening.subscription.alive
    assert listening.subscription.pending == 0

    listening.settle()
    assert listening.events == []


def test_a_remote_subscriber_is_bounded_at_the_hosts_own_default() -> None:
    bus = EventBus()

    assert Remote(bus, "summarize", "monty.*").host_end.subscription.queue_bound == (
        Local(bus, "whodunnit", "monty.*").subscription.queue_bound
    )
    assert Remote(bus, "monty", "monty.*").host_end.subscription.queue_bound == DEFAULT_QUEUE_BOUND


def test_an_emit_returns_while_the_far_end_is_still_not_reading(
    delivery: ThreadedDelivery,
) -> None:
    bus = EventBus(queue_bound=2)
    remote = Remote(bus, "whodunnit", "monty.recorded.v1")
    heard = Local(bus, "innytypes-helper", "innytypes.*", queue_bound=8)
    # The outbound half of a transport is a subscription, so the host's own delivery threads
    # run it — there is no second mechanism to start.
    delivery.run(remote.host_end.subscription)

    remote.host_side.hold()
    try:
        publish(bus, "monty.recorded.v1", index=0)
        assert remote.host_side.sending.wait(timeout=BARRIER_TIMEOUT), "nothing was ever written"

        # The write is stuck inside `send` right now. If publishing took the far end's pace
        # into account at all, none of these three lines could return.
        for index in range(1, 4):
            publish(bus, "monty.recorded.v1", index=index)

        assert not remote.host_side.closed
        assert remote.host_side.outbox == deque()
    finally:
        remote.host_side.release()

    assert not remote.host_end.subscription.alive
    heard.settle()
    assert heard.kinds == ["innytypes.listener-failed.v1"]
    assert heard.events[0].payload["subscriber"] == "whodunnit"
    assert heard.events[0].payload["reason"] == "overflow"


# --- a peer that is gone -------------------------------------------------------------------


def test_a_peer_whose_pipe_is_closed_is_dropped_and_announced_exactly_once() -> None:
    bus = EventBus()
    remote = Remote(bus, "whodunnit", "monty.recorded.v1")
    heard = Local(bus, "innytypes-helper", "innytypes.*")

    publish(bus, "monty.recorded.v1", index=0)
    remote.settle()
    assert remote.kinds == ["monty.recorded.v1"]

    # Mid-stream: the addon process has been receiving, and now its end of the pipe goes away.
    remote.host_side.close()
    publish(bus, "monty.recorded.v1", index=1)
    assert remote.host_end.pump_outbound()

    assert not remote.host_end.subscription.alive
    assert remote.host_end.subscription not in bus.subscriptions()

    # And it is announced once, not once per event that can no longer be delivered.
    publish(bus, "monty.recorded.v1", index=2)
    publish(bus, "monty.recorded.v1", index=3)
    heard.settle()

    assert heard.kinds == ["innytypes.listener-failed.v1"]
    payload = heard.events[0].payload
    assert payload["subscriber"] == "whodunnit"
    assert payload["reason"] == "raised"
    assert payload["kind"] == "monty.recorded.v1"
    assert "PeerGoneError" in str(payload["detail"])


def test_reading_from_a_peer_that_has_exited_is_a_named_error() -> None:
    bus = EventBus()
    remote = Remote(bus, "whodunnit", "monty.recorded.v1")

    # Nothing has arrived yet, which is not the same fact and is not an error.
    assert remote.host_end.pump_inbound() is False

    remote.host_side.close()
    with pytest.raises(PeerGoneError, match="closed the connection"):
        remote.host_end.pump_inbound()

    assert not remote.host_end.alive


def test_closing_a_transport_stops_it_forwarding_even_over_a_live_connection() -> None:
    bus = EventBus()
    remote = Remote(bus, "whodunnit", "monty.recorded.v1")

    remote.host_end.close()
    publish(bus, "monty.recorded.v1", index=0)
    assert remote.host_end.pump_outbound()

    assert not remote.host_end.alive
    assert remote.host_side.outbox == deque()


def test_one_dead_peer_leaves_the_other_addon_processes_receiving() -> None:
    bus = EventBus()
    dead = Remote(bus, "whodunnit", "monty.*")
    living = Remote(bus, "summarize", "monty.*")

    dead.host_side.close()
    publish(bus, "monty.recorded.v1", path="/a.wav")
    dead.host_end.pump_outbound()
    living.settle()

    assert not dead.host_end.subscription.alive
    assert living.host_end.subscription.alive
    assert living.kinds == ["monty.recorded.v1"]


# --- an addon process emitting -------------------------------------------------------------


def test_an_addon_process_emits_through_its_transport_onto_the_hosts_bus() -> None:
    bus = EventBus()
    remote = Remote(bus, "whodunnit", "monty.*")
    heard = Local(bus, "summarize", "whodunnit.*")

    # The emitter inside the addon's process is the bound one slice 04 built; its sink is the
    # spool the transport drains, so the addon's emit never touches the pipe itself.
    registry = KindRegistry()
    emitter = registry.emitter_for(
        manifest("whodunnit", emits=("whodunnit.transcribed.v1",)),
        sink=remote.spool.publish,
    )
    emitter.emit("whodunnit.transcribed.v1", {"text": "hello"})

    assert remote.addon_end.pump_outbound()
    assert remote.host_end.pump_inbound()
    heard.settle()

    assert heard.kinds == ["whodunnit.transcribed.v1"]
    assert heard.events[0].payload == {"text": "hello"}


def test_an_addon_emit_stops_at_its_own_bound_when_the_host_is_not_reading() -> None:
    remote = Remote(EventBus(), "whodunnit", "monty.*")
    spool = remote.spool
    outbound = remote.addon_end.subscription
    heard = Local(spool, "whodunnit-self", "innytypes.*")

    # Nothing pumps the addon's outbound queue, so the host is a subscriber that never reads.
    for index in range(DEFAULT_QUEUE_BOUND + 4):
        spool.publish(Event(kind=parse_kind("whodunnit.transcribed.v1"), payload={"i": index}))

    assert not outbound.alive
    heard.settle()
    assert heard.kinds == ["innytypes.listener-failed.v1"]
    assert heard.events[0].payload["subscriber"] == "innytypes"
    assert heard.events[0].payload["reason"] == "overflow"


def test_the_host_refuses_a_kind_the_peer_on_that_connection_does_not_own() -> None:
    bus = EventBus()
    remote = Remote(bus, "whodunnit", "monty.*")
    heard = Local(bus, "summarize", "monty.*")

    # A frame is bytes: a child process can write any kind it likes into one. Inside the host
    # the bound emitter makes this impossible, so the boundary checks the same rule.
    forged = frame_event(Event(kind=parse_kind("monty.recorded.v1"), payload={"path": "/a.wav"}))
    remote.addon_side.send(forged)

    with pytest.raises(UnownedKindError, match="not a kind it may emit"):
        remote.host_end.pump_inbound()

    heard.settle()
    assert heard.events == []


# --- framing refuses ------------------------------------------------------------------------


def test_framing_refuses_a_payload_json_cannot_write() -> None:
    # Straight at the framer, not through an emitter: the emitter's own check is slice 04's,
    # and a frame can be built without one.
    event = Event(kind=parse_kind("monty.recorded.v1"), payload={"speakers": {"ada", "bob"}})

    with pytest.raises(FramingError, match="monty.recorded.v1"):
        frame_event(event)


def test_framing_refuses_a_number_json_has_no_way_to_write() -> None:
    event = Event(kind=parse_kind("monty.recorded.v1"), payload={"level": float("inf")})

    with pytest.raises(FramingError, match="cannot be framed"):
        frame_event(event)


@pytest.mark.parametrize(
    ("frame", "complaint"),
    [
        pytest.param("not json at all", "a frame is JSON", id="not-json"),
        pytest.param('{"kind": "monty.recorded.v1"}', "exactly the fields", id="missing-payload"),
        pytest.param('["monty.recorded.v1", {}]', "exactly the fields", id="not-an-object"),
        pytest.param('{"kind": 7, "payload": {}}', "`kind` is a string", id="kind-not-a-string"),
        pytest.param(
            '{"kind": "monty.recorded.v1", "payload": []}',
            "`payload` is a JSON object",
            id="payload-not-an-object",
        ),
        pytest.param(
            '{"kind": "monty.recorded", "payload": {}}',
            "not an event kind",
            id="kind-without-a-version",
        ),
    ],
)
def test_unframing_refuses_what_it_cannot_read_by_name(frame: str, complaint: str) -> None:
    with pytest.raises(FramingError, match=complaint):
        unframe_event(frame)


# --- the byte stream the host really uses ---------------------------------------------------


def test_a_stream_connection_writes_one_newline_terminated_frame_per_event() -> None:
    written = io.BytesIO()
    connection = StreamConnection(reader=io.BytesIO(), writer=written)

    connection.send(frame_event(Event(kind=parse_kind("monty.recorded.v1"), payload={"i": 1})))
    connection.send(frame_event(Event(kind=parse_kind("monty.recorded.v1"), payload={"i": 2})))

    lines = written.getvalue().split(b"\n")
    assert lines[-1] == b""
    assert [json.loads(line)["payload"]["i"] for line in lines[:-1]] == [1, 2]


def test_a_stream_connection_reads_back_the_events_that_were_written_to_it() -> None:
    written = io.BytesIO()
    sender = StreamConnection(reader=io.BytesIO(), writer=written)
    sender.send(frame_event(Event(kind=parse_kind("monty.recorded.v1"), payload={"path": "/a"})))
    sender.send(frame_event(Event(kind=parse_kind("monty.recorded.v2"), payload={"path": "/b"})))

    receiver = StreamConnection(reader=io.BytesIO(written.getvalue()), writer=io.BytesIO())

    received = []
    for _ in range(2):
        frame = receiver.receive()
        assert frame is not None
        received.append(unframe_event(frame))

    assert [str(event.kind) for event in received] == ["monty.recorded.v1", "monty.recorded.v2"]
    assert [event.payload["path"] for event in received] == ["/a", "/b"]

    # The end of the stream is the far end being gone, which is the fact a supervisor needs.
    with pytest.raises(PeerGoneError, match="the stream is at its end"):
        receiver.receive()


def test_a_closed_stream_is_a_gone_peer_in_both_directions() -> None:
    stream = io.BytesIO()
    connection = StreamConnection(reader=stream, writer=stream)
    connection.close()
    # Closing what is already closed is not a failure worth raising at whoever is tidying up.
    connection.close()

    with pytest.raises(PeerGoneError, match="the connection is gone"):
        connection.send("{}")
    with pytest.raises(PeerGoneError, match="the connection is gone"):
        connection.receive()


def test_a_frame_that_is_not_utf8_is_refused_rather_than_guessed_at() -> None:
    connection = StreamConnection(reader=io.BytesIO(b"\xff\xfe\n"), writer=io.BytesIO())

    with pytest.raises(FramingError, match="UTF-8"):
        connection.receive()


def test_a_transport_over_a_byte_stream_carries_an_event_end_to_end() -> None:
    # The transport and the real connection together, with `io.BytesIO` standing in for the
    # socketpair slice 07 will hand it — no operating system anywhere in the path.
    wire = io.BytesIO()
    host_bus = EventBus()
    host_end = EventTransport(
        peer="whodunnit",
        connection=StreamConnection(reader=io.BytesIO(), writer=wire),
        outbound=host_bus,
        forwards=[parse_subscription("monty.*")],
        inbound=host_bus.publish,
    )
    addon_bus = EventBus()
    arrived = Collector()
    inbox = addon_bus.subscribe(
        subscriber="whodunnit",
        patterns=[parse_subscription("monty.*")],
        handler=arrived,
    )

    publish(host_bus, "monty.recorded.v1", path="/a.wav")
    assert host_end.pump_outbound()

    addon_end = EventTransport(
        peer="innytypes",
        connection=StreamConnection(reader=io.BytesIO(wire.getvalue()), writer=io.BytesIO()),
        outbound=EventBus(),
        forwards=[parse_subscription("whodunnit.*")],
        inbound=addon_bus.publish,
    )
    assert addon_end.pump_inbound()
    inbox.deliver_pending()

    assert arrived.kinds == ["monty.recorded.v1"]
    assert arrived.events[0].payload == {"path": "/a.wav"}
