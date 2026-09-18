"""What the helper watches each managed process against, and what it currently sees.

A heartbeat says what a process claims (:mod:`innytypes.helper.heartbeat`). This module says
what the helper expects of it — the limits, the promise of heartbeats, the process's own health
check — and puts the two together into one :class:`Observation` per process, which is what
slice 04 judges and slice 05 acts on.

**Opting in to being judged stale.** An addon publishes an optional ``stability`` section in
its manifest (:class:`~innytypes.addons.manifest.StabilityProfile`). The field that matters
here is ``heartbeat_interval``: it is the addon's *promise* to report progress that often, and
``stale_after`` (3 × the interval by default) is how long the helper waits before calling the
silence a problem. An addon with no ``stability`` section — or with one that names no interval
— promised nothing, so it is **never judged stale**. It is still watched: for liveness, for
phantoms and for resources, under the helper-wide defaults in ``[helper.defaults]``. Plan 0003
says this in one sentence and it is worth being precise about why it is not a special case in
the code: :attr:`WatchPolicy.stale_deadline` returns ``None`` when there is no promise, and a
judge with no deadline has nothing to judge.

**Resolution fills only what is genuinely open.** The manifest parser already restates the
plan's documented defaults for every limit it reads, so a profile that reached this module has
real numbers for memory, CPU, open files and the breach grace. The one field it deliberately
leaves ``None`` is ``max_children``, which the plan calls "the helper-wide default" — that is
this module's job, from the helper's configuration. An addon with no profile at all is watched
under the helper-wide defaults in full.

**The addon's own health check (D4).** An addon may expose a check the helper calls. It is a
plain callable here, injected by whoever starts watching the process, because a real one will
cross a process boundary in a later slice and the seam should not have to change when it does.
A check that raises is **not healthy**: an addon whose own health check blows up has answered
the question, and the helper reporting "unknown" there would be softer than the truth.

This module judges nothing else. Whether a silence is too long, whether a breach has outlasted
its grace, whether to restart: slices 04 and 05, which read the observations made here.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass, replace

from innytypes.addons.manifest import StabilityProfile
from innytypes.anytype_mcp.logs import get_logger
from innytypes.helper.config import DEFAULT_MAX_CHILDREN, HelperNumbers
from innytypes.helper.heartbeat import HeartbeatRegistry, ReceivedHeartbeat

__all__ = [
    "HealthCheck",
    "Observation",
    "WatchPolicy",
    "Watchlist",
    "resolve_profile",
]

log = get_logger(__name__)

# What an addon's own health check looks like from the helper's side: ask, get an answer.
# Injected rather than discovered, so that a check which crosses a process boundary later
# changes nothing here (plan 0003, D4).
HealthCheck = Callable[[], bool]


def resolve_profile(
    declared: StabilityProfile | None, *, defaults: StabilityProfile
) -> StabilityProfile:
    """The limits actually in force for one process.

    ``declared`` is the addon's ``stability`` section, or ``None`` when it published none —
    which is not a failure and not a reason to stop watching it. The result is the helper-wide
    defaults in that case, with ``heartbeat_interval`` and ``stale_after`` left unset, because
    a process that never promised heartbeats is never judged stale.
    """
    if declared is None:
        # Never inherit a heartbeat promise from the defaults: the helper's own numbers say
        # what a breach is, and only an addon can say how often it will report progress.
        return replace(
            defaults,
            heartbeat_interval=None,
            stale_after=None,
            max_children=_max_children(defaults),
        )

    if declared.max_children is None:
        return replace(declared, max_children=_max_children(defaults))
    return declared


def _max_children(defaults: StabilityProfile) -> int:
    """The helper-wide child limit, which is the one limit a manifest may leave open."""
    return DEFAULT_MAX_CHILDREN if defaults.max_children is None else defaults.max_children


@dataclass(frozen=True)
class WatchPolicy:
    """Everything the helper needs to watch one process, resolved once.

    Built by :meth:`Watchlist.watch` so that a process is watched from the moment it is known
    about, rather than from its first heartbeat — a process that never sends one is exactly the
    case this whole plan is about.
    """

    process_id: str
    profile: StabilityProfile
    health_check: HealthCheck | None = None

    @property
    def promises_heartbeats(self) -> bool:
        """Whether this process said how often it would report progress."""
        return self.profile.heartbeat_interval is not None

    @property
    def stale_after(self) -> float | None:
        """How long a silence may last before it means something, or ``None`` for never."""
        return self.profile.stale_after


@dataclass(frozen=True)
class Observation:
    """One process as the helper sees it right now: the policy, the last beat, the check.

    The verdicts are not here, and that is the point. :attr:`silent_for` and
    :attr:`stale_deadline` are the two facts a stale judgement is made from, and slice 04 is
    where it is made — with the guarantee this slice provides: a process that promised no
    heartbeats has **no deadline**, whatever the elapsed time, so there is nothing to judge.
    """

    policy: WatchPolicy
    latest: ReceivedHeartbeat | None
    health: bool | None
    now: float

    @property
    def process_id(self) -> str:
        return self.policy.process_id

    @property
    def silent_for(self) -> float | None:
        """Seconds since the last beat arrived, or ``None`` if none ever has."""
        if self.latest is None:
            return None
        return self.now - self.latest.received_at

    @property
    def stale_deadline(self) -> float | None:
        """The moment this process's silence starts to mean something.

        ``None`` when it promised no heartbeats, and ``None`` before its first beat — there is
        no deadline to miss until there is something to be silent *since*. A process that never
        starts at all is caught by the process table, not by this.
        """
        if self.latest is None or self.policy.stale_after is None:
            return None
        return self.latest.received_at + self.policy.stale_after


class Watchlist:
    """Every process the helper is watching, and what it currently sees of each.

    The registry is injected rather than owned: the socket fills it from whichever thread polls
    (:class:`~innytypes.helper.heartbeat.HeartbeatListener`), and the helper's tick reads it
    here. One clock, the registry's, so the "now" of an observation and the "received_at" of a
    beat can be compared without asking which clock each came from.
    """

    def __init__(
        self,
        *,
        registry: HeartbeatRegistry,
        defaults: StabilityProfile | None = None,
    ) -> None:
        self._registry = registry
        self._defaults = HelperNumbers().defaults if defaults is None else defaults
        self._lock = threading.Lock()
        self._policies: dict[str, WatchPolicy] = {}

    @property
    def defaults(self) -> StabilityProfile:
        """The helper-wide limits an addon that declared none is watched against."""
        return self._defaults

    def watch(
        self,
        process_id: str,
        *,
        stability: StabilityProfile | None = None,
        health_check: HealthCheck | None = None,
    ) -> WatchPolicy:
        """Start watching one process, resolving its limits against the helper-wide defaults."""
        policy = WatchPolicy(
            process_id=process_id,
            profile=resolve_profile(stability, defaults=self._defaults),
            health_check=health_check,
        )
        with self._lock:
            self._policies[process_id] = policy
        return policy

    def policy_for(self, process_id: str) -> WatchPolicy:
        """The policy in force for ``process_id``, defaulting for one nobody registered.

        A beat from a process the helper was never told about is still a process of this user
        on this machine, so it is watched under the helper-wide defaults rather than ignored.
        """
        with self._lock:
            policy = self._policies.get(process_id)
        if policy is not None:
            return policy
        return WatchPolicy(
            process_id=process_id, profile=resolve_profile(None, defaults=self._defaults)
        )

    def observe(self, process_id: str) -> Observation:
        """One process, as of now: its policy, its latest beat, and its own health check."""
        policy = self.policy_for(process_id)
        return Observation(
            policy=policy,
            latest=self._registry.latest(process_id),
            health=_ask(policy),
            now=self._registry.now(),
        )

    def observations(self) -> tuple[Observation, ...]:
        """Every watched process and every process that has beaten, sorted by id."""
        with self._lock:
            watched = set(self._policies)
        return tuple(
            self.observe(process_id) for process_id in sorted(watched | set(self._registry.ids()))
        )


def _ask(policy: WatchPolicy) -> bool | None:
    """The addon's own health check, or ``None`` when it declared none.

    A check that raises is answered ``False``. It is the addon's own code saying it cannot tell
    whether it is well, and the helper has no better source than that.
    """
    if policy.health_check is None:
        return None

    try:
        return policy.health_check()
    except Exception as error:  # noqa: BLE001 - an addon's own code, and never the helper's crash
        log.warning("the health check of %r raised: %s", policy.process_id, error)
        return False
