"""The host's end of one addon child's event channel — the socketpair, and the two pumps.

:mod:`innytypes.events.transport` says what a connection between the host and an addon process
*means*; this module is where the host actually **opens** one. It is the missing half an audit
found: every rule of the bus was landed and tested, and no module outside :mod:`innytypes.events`
ever built an :class:`~innytypes.events.bus.EventBus`, a
:class:`~innytypes.events.emitter.KindRegistry` or an
:class:`~innytypes.events.transport.EventTransport`, so a running host had a bus wired to
nothing at all.

Three choices here are load-bearing.

**The channel is opened by whoever spawns the child, because the child end has to be
inherited.** :meth:`AddonChannels.open` creates the ``AF_UNIX``/``SOCK_STREAM`` socketpair plan
0001 specifies, keeps the host end and hands the caller the **child end's file descriptor**;
:mod:`innytypes.children` gives that descriptor to the spawn as the child's standard input and
then closes its own copy. Closing it is not tidiness: while the host holds a copy of the child
end, a child that dies never looks gone, because the socket still has a writer.

**Standard input carries it, so nothing has to be passed at all.** Every process inherits fd 0
by construction, which is what makes the handoff free of ``pass_fds`` bookkeeping and of an
environment variable naming a number. Standard *output* and standard error stay ordinary pipes,
so an addon that prints cannot corrupt the event stream — which is exactly what would happen if
the channel were fd 1.

**The boundary re-checks both rules the emitter checks.** Inside a process an addon may emit
only kinds it owns *and* kinds its manifest declared. A frame is bytes and carries neither
guarantee, so the host end refuses a kind outside the peer's namespace (``accepts``) and refuses
a kind no manifest registered (the inbound sink below). The one exception is
``innytypes.addon-failed.v1``: the runner is host code, holding the socket the addon never
sees, and its report is how "this addon could not start" reaches the host at all.

Nothing here restarts anything, and nothing here decides an addon is unhealthy: a channel that
dies drops the peer as the bus already drops any subscriber, and the process it belonged to is
:mod:`innytypes.children`'s business.
"""

from __future__ import annotations

import socket
import threading
from dataclasses import dataclass
from typing import IO, Protocol, cast

from innytypes.addons.manifest import AddonManifest, KindPrefix
from innytypes.events.bus import ADDON_FAILED, EventBus
from innytypes.events.delivery import ThreadedDelivery
from innytypes.events.emitter import Event, EventError, KindRegistry, UnregisteredKindError
from innytypes.events.transport import (
    EventTransport,
    PeerGoneError,
    StreamConnection,
    TransportError,
)
from innytypes.logs import get_logger

__all__ = [
    "NO_ADDON_CHANNELS",
    "AddonChannels",
    "NoAddonChannels",
    "SocketPairChannels",
]

log = get_logger(__name__)

# How long a channel being closed waits for its own reader thread. Nothing that is working
# waits this long: closing the connection is what wakes the reader, immediately. It bounds the
# one case that cannot be woken — a reader inside a peer that will not return a read.
_READER_JOIN_TIMEOUT = 2.0


class AddonChannels(Protocol):
    """How the child supervisor obtains, and releases, one addon's event channel.

    A protocol because the supervisor must not have to know whether this host has a bus:
    :data:`NO_ADDON_CHANNELS` is the honest "no channel" answer for a test that is about
    processes, and :class:`SocketPairChannels` is what a real host is built with.
    """

    def open(self, addon_id: str, manifest: AddonManifest) -> int | None:
        """The file descriptor the child inherits, or ``None`` when there is no channel.

        The caller closes the descriptor once the child has it. The host keeps its own end.
        """
        ...

    def close(self, addon_id: str) -> None:
        """Release one addon's channel. Closing what was never opened is not an error."""
        ...


class NoAddonChannels:
    """A host with no event channel for its addons: every addon is spawned without one.

    Not a fallback production ever takes — :func:`innytypes.host.build_host` always passes a
    real one — but the truthful default for a supervisor built to exercise spawning, stopping
    and the run-state file, where a socketpair per child would buy a test nothing.
    """

    def open(self, addon_id: str, manifest: AddonManifest) -> int | None:
        return None

    def close(self, addon_id: str) -> None:
        return None


# The one shared instance, so "this supervisor has no channels" is a fact a reader recognises
# rather than a fresh object whose type they have to go and look up.
NO_ADDON_CHANNELS: AddonChannels = NoAddonChannels()


@dataclass(frozen=True)
class _Channel:
    """One addon's transport, and the two threads that move events on it."""

    transport: EventTransport
    delivery: ThreadedDelivery
    reader: threading.Thread

    def close(self) -> None:
        """Stop both pumps and release the host end.

        The transport is closed first because that is what wakes the reader: a thread blocked
        on a read returns the moment its connection is gone, which is the only way to end a
        blocking read that has not been given one.
        """
        self.transport.close()
        self.delivery.close()
        self.reader.join(timeout=_READER_JOIN_TIMEOUT)


class SocketPairChannels:
    """Every live addon channel of one host, over one bus.

    Built once, in :func:`innytypes.host.build_host`, with the host's single
    :class:`~innytypes.events.bus.EventBus` and
    :class:`~innytypes.events.emitter.KindRegistry`. One channel per addon process: nothing is
    shared between two addons, so one addon that dies or stalls is one connection's problem.
    """

    def __init__(
        self,
        *,
        bus: EventBus,
        kinds: KindRegistry,
        queue_bound: int | None = None,
    ) -> None:
        self._bus = bus
        self._kinds = kinds
        self._queue_bound = queue_bound
        self._channels: dict[str, _Channel] = {}

    def open(self, addon_id: str, manifest: AddonManifest) -> int:
        """Open one addon's channel and return the descriptor its process inherits.

        The addon's declared kinds are registered here rather than at discovery, because this
        is the moment the host starts accepting frames from that addon and the registration is
        what the inbound check reads.
        """
        self.close(addon_id)
        self._kinds.register(*manifest.emits)

        host_end, child_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        # One file object in both directions, exactly as `StreamConnection` documents: a
        # socket is duplex, so a single `rwb` stream is the whole connection.
        # `cast` because `makefile` is typed as returning a `BufferedRWPair`, which reads,
        # writes, flushes and closes exactly as `IO[bytes]` requires without being one
        # nominally.
        stream = cast(IO[bytes], host_end.makefile("rwb"))
        # The stream is now the descriptor's one owner: closing the socket object here leaves
        # the descriptor open until the stream is closed, and it means there is exactly one
        # thing to close later rather than two that can disagree about whether it is shut.
        host_end.close()
        connection = StreamConnection(reader=stream, writer=stream)

        transport = EventTransport(
            peer=addon_id,
            connection=connection,
            outbound=self._bus,
            # What the host sends this addon is exactly what its manifest subscribed to. The
            # matching, the bound and the drop are the bus's, one pipe further out.
            forwards=manifest.subscribes,
            inbound=self._inbound(addon_id),
            # A frame is bytes and carries no binding, so the namespace rule is checked again
            # here rather than taken on the sender's word.
            accepts=[KindPrefix(prefix=addon_id), ADDON_FAILED],
            queue_bound=self._queue_bound,
        )

        delivery = ThreadedDelivery()
        # The outbound direction is a subscription like any other, so it is pumped by the same
        # threads every other subscriber is pumped by.
        delivery.run(transport.subscription)

        reader = threading.Thread(
            target=self._pump_inbound,
            args=(addon_id, transport),
            name=f"innytypes-channel-{addon_id}",
            # A daemon: a child that will not close its end must not be able to keep the host
            # alive. The host's exit is the helper's business (plan 0003).
            daemon=True,
        )
        reader.start()

        self._channels[addon_id] = _Channel(transport=transport, delivery=delivery, reader=reader)

        # Detached rather than closed: the socket object gives up ownership of the descriptor,
        # and the caller closes it once the child has inherited it. Two owners of one
        # descriptor is a descriptor closed twice.
        return child_end.detach()

    def close(self, addon_id: str) -> None:
        """Release one addon's channel, if it has one."""
        channel = self._channels.pop(addon_id, None)
        if channel is None:
            return
        channel.close()
        log.info("closed the event channel to %s", addon_id)

    def peers(self) -> tuple[str, ...]:
        """Every addon with a live channel, in the order they were opened."""
        return tuple(self._channels)

    def _inbound(self, addon_id: str) -> _InboundSink:
        """The sink a frame from ``addon_id`` is published through."""
        return _InboundSink(bus=self._bus, kinds=self._kinds, peer=addon_id)

    def _pump_inbound(self, addon_id: str, transport: EventTransport) -> None:
        """Read that child's frames until its end of the channel is gone.

        A frame that cannot be read, or that names a kind this addon may not publish, is
        reported and the channel stays open: one bad frame is a bug in one addon, and dropping
        the whole connection for it would take every other event of that addon with it.
        """
        while transport.alive:
            try:
                transport.pump_inbound()
            except PeerGoneError:
                log.info("the event channel to %s is closed at the far end", addon_id)
                return
            except EventError as error:
                # **The third record an event leaves** (plan 0012, slice 04), and the one the
                # whole thing exists to make readable. WARNING, and deliberately: a refusal is
                # not routine — an addon has emitted something it may not, which means either a
                # manifest that is wrong or a plugin that is. It is a level above an accepted
                # event on purpose, because "accepted" and "refused" have to be tellable apart
                # by somebody scrolling, not only by somebody reading every word.
                log.warning("event refused from %s: %s", addon_id, error)
            except (TransportError, ValueError) as error:
                # Not an event at all: bytes that could not be read as one. A different
                # sentence because it sends the reader somewhere else entirely — at the
                # transport, not at a manifest.
                log.warning("unreadable frame from %s: %s", addon_id, error)


class _InboundSink:
    """What a frame from one addon becomes on the host's bus, once it has been judged.

    A class rather than a closure so the two facts it carries — which peer, and which
    registry — are visible to a reader of a traceback.
    """

    def __init__(self, *, bus: EventBus, kinds: KindRegistry, peer: str) -> None:
        self._bus = bus
        self._kinds = kinds
        self._peer = peer

    def __call__(self, event: Event) -> None:
        if event.kind != ADDON_FAILED and not self._kinds.is_registered(event.kind):
            raise UnregisteredKindError(
                f"{self._peer!r} sent {event.kind}, which no manifest declared. An addon may "
                "emit only kinds its manifest `emits` lists; inside its own process its "
                "emitter refuses the rest, and a frame is bytes, so the same rule is checked "
                "here rather than taken on the sender's word."
            )

        # **The second record an event leaves** (plan 0012, slice 04). INFO rather than the
        # emit's DEBUG: an event that crossed the process boundary and was accepted is the
        # fact a reader of this log most often wants, and it is one line per event that
        # actually arrived rather than one per event any process merely tried to send.
        log.info("event accepted: %s from %s", event.kind, self._peer)
        self._bus.publish(event)
