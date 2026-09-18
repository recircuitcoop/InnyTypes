"""Running a subscriber's queue — the thread that carries a subscriber's own slowness.

:mod:`innytypes.events.bus` fills queues and never empties one. Something has to pump them,
and this is the host's answer in one process: **one thread per subscription**. A single shared
pump would put every subscriber behind whichever of them is slowest and would let one hung
handler stop the others, which is the design plan 0001 forbids — the per-subscriber queue
would be a bound with nothing behind it.

The thread does nothing clever on purpose. It calls
:meth:`~innytypes.events.bus.Subscription.deliver_next`, which already owns the two outcomes
that matter: a handler that raises drops its subscriber and announces it, and a handler that
never returns simply never returns — this thread stays inside it, the queue fills, and the
publisher drops that subscriber without ever waiting for this thread. That is why nothing here
tries to interrupt a handler: a stuck subscriber is already handled, one layer down.

A subscriber in another process is run by these same threads.
:mod:`innytypes.events.transport` does not replace the queue behind a pipe; it puts a handler
in front of one, so a remote subscriber is pumped by :meth:`run` like any other and a write
that blocks or raises costs exactly what a handler that hangs or raises costs.
"""

from __future__ import annotations

import threading

from innytypes.events.bus import Subscription

__all__ = ["ThreadedDelivery"]

# How long a thread with an empty queue waits before it looks at the stop flag again. Nothing
# about delivery depends on this number — an event queued during the wait wakes the thread
# immediately — it only bounds how long :meth:`ThreadedDelivery.close` waits on an idle one.
_WAKE_INTERVAL = 0.05


class ThreadedDelivery:
    """The delivery threads of a running host, started one per subscription."""

    def __init__(self, *, wake_interval: float = _WAKE_INTERVAL) -> None:
        self._wake_interval = wake_interval
        self._stopping = threading.Event()
        self._threads: list[threading.Thread] = []

    def run(self, subscription: Subscription) -> None:
        """Start delivering to one subscriber, on a thread of its own."""
        thread = threading.Thread(
            target=self._pump,
            args=(subscription,),
            name=f"innytypes-delivery-{subscription.subscriber}",
            # A daemon because a hung handler must not be able to keep the host alive. The
            # host's exit is the helper's business (plan 0003), never a subscriber's.
            daemon=True,
        )
        self._threads.append(thread)
        thread.start()

    def close(self, *, timeout: float = 2.0) -> None:
        """Stop delivering and wait for the threads that can still be waited on.

        A thread inside a handler that never returns is not waited on past ``timeout``: it is
        a daemon, and the subscriber it belongs to is already being dropped by its bound.
        """
        self._stopping.set()
        for thread in self._threads:
            thread.join(timeout=timeout)
        self._threads.clear()

    def _pump(self, subscription: Subscription) -> None:
        """Deliver to one subscriber until the host stops or that subscriber is dropped."""
        while not self._stopping.is_set() and subscription.alive:
            subscription.deliver_next(timeout=self._wake_interval)
