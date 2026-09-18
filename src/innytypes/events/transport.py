"""The bus across a process boundary — the same rules, one pipe further out.

Addons run as separate processes (plan 0001), so most subscribers are not in the host's
interpreter at all. The danger in a transport is not that it fails to deliver: it is that it
delivers with **weaker promises** than the bus behind it, so that an addon's behaviour depends
on which side of a pipe it happens to run. Everything below exists to make that impossible.

**A remote subscriber is a subscription whose handler is a pipe.** That is the whole design.
:class:`EventTransport` does not re-implement bounding, dropping or matching; it calls
:meth:`~innytypes.events.bus.EventBus.subscribe` like anything else and hands it a handler
that writes the event to the connection. So the bound is the bus's bound, the matching is the
bus's matching, and the two ways a subscriber dies are the two the bus already knows:

* the far end **stops reading** — the pipe's buffer fills, the write inside the handler blocks,
  that subscriber's queue fills behind it and the publisher drops it at its bound, exactly as
  it drops a subscriber whose handler never returns;
* the far end **is gone** — the write raises, which is a handler raising, so the subscriber is
  dropped and the drop is announced as ``innytypes.listener-failed.v1`` naming the addon.

Neither path is written twice, which is why neither can drift from the other.

**One encoding, one wire format.** The bus already encodes each payload once at publish
(:func:`~innytypes.events.bus.encode_payload`); a frame splices that text into
``{"kind": ..., "payload": ...}`` rather than serialising the payload a second time. A
subscriber across the pipe therefore reads the bytes an in-process subscriber would have read.

**Frames are newline-delimited JSON over a byte stream.** The encoded payload is ASCII with no
literal newline in it — `json.dumps` escapes them — so a newline is an unambiguous end of
frame, and a stream that is half-read resumes at the next one. The alternative, a binary
length prefix, buys nothing here and costs the thing that matters most when a child process
misbehaves: a dump of the pipe is readable.

**The stream is one `AF_UNIX`, `SOCK_STREAM` socketpair per child**, created when the host
spawns it (slice 07) and wrapped with ``StreamConnection(reader=f, writer=f)`` over
``sock.makefile("rwb")``. One bidirectional connection per addon process, nothing shared
between them, so one addon that dies or stalls is one connection's problem. A datagram socket
would give message boundaries for free and take something back that is not for sale: a full
datagram buffer drops in the kernel, silently, which is the one behaviour this bus refuses —
here a slow reader becomes backpressure, and backpressure becomes a **visible** drop with an
announcement naming the subscriber. This is not the helper's heartbeat socket (plan 0003
slice 02): that is a per-user socket in the runtime directory, owned by the helper, and it
exists precisely so that heartbeats survive a dead host. Different channel, different owner,
different lifetime.

**The boundary re-checks what the boundary can no longer take on trust.** Inside the host, an
addon may only emit kinds its own id namespaces because the emitter it was handed is bound to
that id. A frame arriving from a child process is just bytes, so the host end checks the same
rule again — ``accepts`` — and refuses the frame by name rather than publishing another
addon's kind on that addon's behalf.

Running the pumps is the caller's business, and slice 07's: the outbound direction is a
subscription, so :class:`~innytypes.events.delivery.ThreadedDelivery` already runs it, and the
inbound direction is ``while transport.alive: transport.pump_inbound()`` on the reader thread
the host opens for that child. Both are driven explicitly in tests, which is how this slice is
tested without a process, a socket or a sleep anywhere in it.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from contextlib import suppress
from typing import IO, Protocol

from innytypes.addons.manifest import EventKind, KindPrefix, ManifestError, parse_kind
from innytypes.events.bus import EventBus, Subscription, encode_payload, matches
from innytypes.events.emitter import Event, EventSink, UnownedKindError

__all__ = [
    "Connection",
    "EventTransport",
    "FramingError",
    "PeerGoneError",
    "StreamConnection",
    "TransportError",
    "frame_event",
    "unframe_event",
]

# What separates one frame from the next on a byte stream. Safe as a terminator because an
# encoded payload never contains one: `json.dumps` writes a newline inside a string as `\n`.
FRAME_TERMINATOR = b"\n"


class TransportError(Exception):
    """Raised when an event cannot cross the boundary.

    One base for both halves of that — a frame that cannot be written or read, and a peer
    that is no longer there — so a supervisor can catch "this child's channel is unusable"
    once, and then ask which of the two it was.
    """


class FramingError(TransportError):
    """Raised when an event cannot be written as a frame, or a frame read as an event."""


class PeerGoneError(TransportError):
    """Raised when the far end of a connection is closed, or its process has exited."""


class Connection(Protocol):
    """One end of a duplex, message-at-a-time channel to exactly one peer.

    A protocol rather than a class so the host can hand the transport a socket in production
    and a test can hand it both ends of an in-memory pair. :class:`StreamConnection` is the
    implementation the host uses.
    """

    def send(self, frame: str) -> None:
        """Write one frame, or raise :class:`PeerGoneError` if the far end is gone."""
        ...

    def receive(self) -> str | None:
        """The next frame, or ``None`` when none has arrived.

        Raises :class:`PeerGoneError` when the far end has closed: a peer that is gone is a
        fact to report, never an empty read that looks like a quiet moment.
        """
        ...

    def close(self) -> None:
        """Release this end. Sending or receiving afterwards is a gone peer."""
        ...


class StreamConnection(Connection):
    """Newline-delimited JSON frames over a byte stream — the host's real connection.

    Built over a socketpair in slice 07 (``sock.makefile("rwb")`` as both ``reader`` and
    ``writer``), and over a pair of pipes if a child ever has no socket. It never returns
    ``None`` from :meth:`receive`: a byte stream has no "nothing arrived yet", it blocks until
    there is a frame or the far end is gone, which is why the reader lives on its own thread.

    It inherits the protocol rather than merely satisfying it, so that the one connection the
    host ships is checked against the seam every test injects into.
    """

    def __init__(self, *, reader: IO[bytes], writer: IO[bytes]) -> None:
        self._reader = reader
        self._writer = writer

    def send(self, frame: str) -> None:
        """Write one frame and flush it, so the far end sees it now rather than eventually."""
        try:
            self._writer.write(frame.encode("utf-8") + FRAME_TERMINATOR)
            self._writer.flush()
        except (OSError, ValueError) as error:
            # ValueError is what a closed file object raises, OSError what a broken pipe does.
            # Both mean the same thing to a publisher: this subscriber is not there any more.
            raise PeerGoneError(
                f"the connection is gone: {type(error).__name__}: {error}"
            ) from error

    def receive(self) -> str | None:
        """Read one frame, blocking until there is one or the far end closes."""
        try:
            line = self._reader.readline()
        except (OSError, ValueError) as error:
            raise PeerGoneError(
                f"the connection is gone: {type(error).__name__}: {error}"
            ) from error

        if not line:
            raise PeerGoneError("the far end closed the connection: the stream is at its end")

        try:
            return line.decode("utf-8").removesuffix(FRAME_TERMINATOR.decode())
        except UnicodeDecodeError as error:
            raise FramingError(f"a frame is UTF-8 JSON, and this one is not: {error}") from error

    def close(self) -> None:
        """Close both directions, ignoring a stream that is closed already."""
        for stream in (self._writer, self._reader):
            # Closing what is already closed, or what died with the child, is not a failure
            # worth raising at whoever is tidying up.
            with suppress(OSError, ValueError):
                stream.close()


def frame_event(event: Event) -> str:
    """Write one event as the frame that goes on the wire.

    Refuses a payload JSON cannot write, naming the kind — the same refusal the emitter makes
    at emit time, kept here as well because a frame can be built without an emitter and a
    payload that cannot make the trip must never be discovered by the far end instead.
    """
    try:
        encoded = encode_payload(event.payload)
    except (TypeError, ValueError) as error:
        raise FramingError(
            f"the payload of {event.kind} cannot be framed: {type(error).__name__}: {error}. "
            "Every event crosses a process boundary as JSON, so a payload JSON cannot write "
            "is refused here rather than sent as something else."
        ) from error

    # Spliced, not re-encoded: `encoded` is the text the bus already produced at publish, so
    # a subscriber across the pipe reads exactly the bytes an in-process one reads.
    return f'{{"kind": {json.dumps(str(event.kind))}, "payload": {encoded}}}'


def unframe_event(frame: str) -> Event:
    """Read one frame back into an event, or refuse it by name.

    Every refusal is a :class:`FramingError` rather than a silently skipped frame: a child
    that sends something this cannot read is a bug to report, and dropping it quietly would
    turn that bug into a subscriber that misses one event in twenty.
    """
    try:
        decoded = json.loads(frame)
    except ValueError as error:
        raise FramingError(f"a frame is JSON, and this one is not: {error}") from error

    if not isinstance(decoded, dict) or set(decoded) != {"kind", "payload"}:
        raise FramingError(
            f"a frame is a JSON object with exactly the fields `kind` and `payload`, got {frame!r}"
        )

    kind, payload = decoded["kind"], decoded["payload"]
    if not isinstance(kind, str) or not isinstance(payload, dict):
        raise FramingError(
            f"a frame's `kind` is a string and its `payload` is a JSON object, got "
            f"{type(kind).__name__} and {type(payload).__name__}"
        )

    try:
        # The grammar is the manifest module's. A transport does not get its own opinion about
        # what a kind looks like.
        parsed = parse_kind(kind)
    except ManifestError as error:
        raise FramingError(f"a frame's `kind` is not an event kind: {error}") from error

    return Event(kind=parsed, payload=payload)


class EventTransport:
    """One end of one connection: what it forwards out, and what it accepts in.

    The host builds one per addon process, with the bus on ``outbound`` and ``inbound``, the
    addon's ``subscribes`` as ``forwards``, and ``accepts`` set to the addon's own namespace::

        EventTransport(
            peer="whodunnit",
            connection=StreamConnection(reader=pipe, writer=pipe),
            outbound=bus,
            forwards=manifest.subscribes,
            inbound=bus.publish,
            accepts=[parse_subscription("whodunnit.*")],
        )

    The addon process builds the mirror image, and there the two sides are **not** the same
    bus: what it emits goes to an outbound spool the transport drains, and what arrives is
    published on its local bus. That asymmetry is deliberate — an addon is a client of the
    host's one bus rather than the owner of a second one — and it is also what stops an addon
    that subscribes to its own kinds from bouncing its events between the two processes
    forever.
    """

    def __init__(
        self,
        *,
        peer: str,
        connection: Connection,
        outbound: EventBus,
        forwards: Iterable[EventKind | KindPrefix],
        inbound: EventSink,
        accepts: Iterable[EventKind | KindPrefix] | None = None,
        queue_bound: int | None = None,
    ) -> None:
        self._peer = peer
        self._connection = connection
        self._inbound = inbound
        self._accepts = None if accepts is None else tuple(accepts)
        self._closed = False
        # Subscribed under the peer's own id, so the `innytypes.listener-failed.v1` that a
        # drop produces names the addon a reader has to go and look at.
        self._subscription = outbound.subscribe(
            subscriber=peer,
            patterns=forwards,
            handler=self._forward,
            queue_bound=queue_bound,
        )

    @property
    def subscription(self) -> Subscription:
        """The peer's subscription on the outbound bus: its queue, its bound, its liveness."""
        return self._subscription

    @property
    def alive(self) -> bool:
        """Whether this end still carries events in either direction."""
        return self._subscription.alive and not self._closed

    def pump_outbound(self) -> bool:
        """Put one queued event on the wire. Returns whether there was one.

        Nothing but a rename of :meth:`~innytypes.events.bus.Subscription.deliver_next`, and
        that is the point: a remote subscriber is drained by the same call, on the same kind
        of thread, with the same consequences when the write blocks or raises.
        """
        return self._subscription.deliver_next()

    def pump_inbound(self) -> bool:
        """Take one frame off the wire and publish it. Returns whether there was one.

        Raises :class:`PeerGoneError` when the far end has closed — the fact a supervisor
        needs — and :class:`FramingError` or
        :class:`~innytypes.events.emitter.UnownedKindError` when what arrived may not be
        published as it stands.
        """
        try:
            frame = self._connection.receive()
        except PeerGoneError:
            self._closed = True
            raise

        if frame is None:
            return False

        event = unframe_event(frame)
        if self._accepts is not None and not any(
            matches(pattern, event.kind) for pattern in self._accepts
        ):
            raise UnownedKindError(
                f"{self._peer!r} sent {event.kind} over its own connection, and that is not a "
                "kind it may emit. Inside the host an emitter is bound to one addon's id so a "
                "subscriber can trust who sent what; a frame is bytes, so the boundary checks "
                "the same rule rather than taking the sender's word for it."
            )

        self._inbound(event)
        return True

    def close(self) -> None:
        """Release this end.

        The peer stops being a subscriber from here on: the next event the bus tries to
        forward finds the connection closed, and that subscriber is dropped and announced
        like any other that is no longer there — which, by then, it is.
        """
        self._closed = True
        self._connection.close()

    def _forward(self, event: Event) -> None:
        """The handler behind the peer's subscription: one event, onto the wire.

        It runs on the peer's own delivery thread, never on a publisher's, so a slow or
        wedged write costs the peer its queue and costs the publisher nothing.
        """
        if self._closed:
            raise PeerGoneError(f"the connection to {self._peer!r} is closed")
        self._connection.send(frame_event(event))
