"""The sampling tick: what each managed process is using, whether it still works, when it goes.

Once a tick (`helper.tick`, 5 s by default) this module looks at every process in the
run-state file and answers two questions the plan keeps deliberately apart (plan 0003,
*Health watching* and *Stabilization*):

*Is it still making progress?* A process that is **alive but has stopped working** is
**stale** — no heartbeat, or no change in its progress marker, for longer than `stale_after`
(D4). Staleness is *judged and reported* here and nothing else: what to do about it is the
restart policy, which is slice 05.

*Is it using more than it promised?* Memory, CPU over its window, open files and child
processes are compared against the profile in force, and a value over its line must stay over
it for longer than `breach_grace` before the helper does anything. **A short spike is not a
breach**, and that sentence is the entire reason the grace window exists: without it the first
tick that catches a plugin loading a model would kill it.

**A process without a stability profile is never judged stale, and is always watched for
resources.** The two halves of that rule are equally load-bearing. A plugin that never
published a `heartbeat_interval` never promised to send heartbeats, so judging it stale would
be punishing it for missing messages it never agreed to send — and the Anytype desktop app,
which sends no heartbeat at all, would be killed within a minute of every launch. But it is
still watched under the helper-wide limits, because a process that eats 8 GB is a problem
whether or not it ever promised anything.

**Acting means asking politely first.** On a sustained breach the helper hands the record to
:meth:`~innytypes.helper.processes.ManagedProcesses.stop`, which re-checks the process's
identity, sends a polite stop, waits out `stop_timeout`, and only then kills. Nothing in this
module signals anything directly — there is no import of `signal` here and no process ID is
ever carried to the OS except through that one identity-checked path. **The Anytype desktop
app goes through exactly the same path** (D5): the owner accepted that a forced kill can lose
unsaved work, on condition that the polite stop always comes first.

**What is not here.** Restarting what was stopped, the backoff and the attempt count (slice
05), the breaker and quarantine (slice 06), the plugin-supplied health check and the socket
heartbeats travel over (slice 02). This module reports; the policy above it decides.

**CPU over a window is computed here, from two totals.** The OS only ever knows how much CPU
time a process has used in total — a *percentage* is a rate, and a rate needs two moments. So
:class:`~innytypes.helper.processes.ResourceSample` carries cumulative `cpu_seconds`, and the
percentage compared against `max_cpu_percent` is the difference between this sample and the
oldest one still inside `cpu_window`, over the time between them. The window in the profile is
therefore measured by the code that owns it, and a limit of "90 % over 2 minutes" means what it
says rather than whatever averaging the process table happened to do. Until two samples exist,
CPU is simply **unknown** and cannot breach, which costs one tick at startup.

Every seam is injected, as in :mod:`innytypes.helper.processes`: the resource probe, the clock,
the heartbeats and the per-process profiles. A test describes a machine as plain data and
asserts on what was sampled, judged and signalled — with no process to sample and no sleeping.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from innytypes.addons.manifest import StabilityProfile
from innytypes.children import ChildRecord
from innytypes.helper.config import DEFAULT_MAX_CHILDREN, HelperNumbers
from innytypes.helper.processes import (
    ManagedProcesses,
    ResourceProbe,
    ResourceSample,
    Stopped,
    Verdict,
)
from innytypes.logs import get_logger

__all__ = [
    "STALE_INTERVALS",
    "Breach",
    "HealthWatch",
    "Heartbeats",
    "Limit",
    "NoHeartbeats",
    "Observation",
    "Profiles",
    "no_profile",
]

log = get_logger(__name__)

# How many missed heartbeats make a process stale when its profile names an interval but no
# window of its own: plan 0003 D4 and D8, "stale after 3 x heartbeat interval". It is not a
# setting in `config.toml` on purpose — `helper.defaults` deliberately holds no heartbeat
# numbers, because they are a plugin's promise about itself rather than the user's policy.
STALE_INTERVALS = 3.0


class Limit(StrEnum):
    """The four things a managed process is watched against, named rather than numbered."""

    MEMORY = "memory"
    CPU = "cpu"
    OPEN_FILES = "open-files"
    CHILDREN = "children"


@dataclass(frozen=True)
class Breach:
    """One limit a process is over, and for how long it has been over it.

    Carries the numbers rather than a sentence about them, because the plan says a kill is
    "written to the local log with the numbers that triggered it" and a caller that has to
    re-derive them would be re-deriving them from a different sample.
    """

    limit: Limit
    value: float
    allowed: float
    # Seconds since the value first went over its line, as of this tick. It resets to zero
    # the moment the value comes back under, which is what makes a spike a spike.
    duration: float
    grace: float

    @property
    def sustained(self) -> bool:
        """Whether this has outlasted the grace window and is therefore worth acting on.

        Strictly longer, not "as long as": the plan says a breach must last *longer than*
        `breach_grace` before the helper acts, so a value that has been over for exactly the
        grace window is still inside it.
        """
        return self.duration > self.grace


@dataclass(frozen=True)
class Observation:
    """What one tick saw, judged and did about one managed process.

    This is the whole report: slice 05 reads :attr:`stale` and :attr:`stopped` to decide
    whether anything comes back, and slice 06 counts the interventions. Nothing here is a
    request to restart, and there is no field that could be mistaken for one.
    """

    record: ChildRecord
    # What the identity check said. Anything but `ALIVE` means the record was a phantom: it
    # has been forgotten, nothing was sampled, and nothing was signalled.
    verdict: Verdict
    # `None` when there was nothing to measure — a phantom, or a process that went away
    # between the identity check and the sample.
    sample: ResourceSample | None
    # CPU over `cpu_window`, as a percentage of one core. `None` until two samples exist.
    cpu_over_window: float | None
    stale: bool
    # Every limit over its line at this instant, whether or not the grace window has run out.
    breaches: tuple[Breach, ...]
    # The stop this tick performed, or `None` when it did not act.
    stopped: Stopped | None

    @property
    def sustained(self) -> tuple[Breach, ...]:
        """The breaches that outlasted their grace window: the ones that are acted on."""
        return tuple(breach for breach in self.breaches if breach.sustained)

    @property
    def acted(self) -> bool:
        """Whether this tick asked for the process to be stopped."""
        return self.stopped is not None


class Heartbeats(Protocol):
    """The heartbeats the helper has received, as this module needs to read them.

    Deliberately one question, because it is the only one staleness turns on. Slice 02 owns
    the heartbeat's full shape and the socket it arrives over; anything that can answer "what
    is the progress marker on the latest heartbeat from this process" satisfies this.
    """

    def progress_at(self, process_id: str) -> float | None:
        """The `progress_at` marker of the latest heartbeat, or ``None`` when there is none.

        ``None`` means "this process has not told us anything we can compare", whether it has
        never sent a heartbeat or its heartbeats have stopped. Both are the same to the rule
        below: progress is a marker that **changed**, and nothing else counts as one.
        """
        ...


class NoHeartbeats:
    """The heartbeat source for a helper that has none: nothing has ever reported progress.

    The honest default rather than a convenience. A process with no profile is unaffected —
    it is never judged stale anyway — and a plugin that published a `heartbeat_interval` and
    then sent nothing is exactly what "stale" means, so silence being judged is correct even
    when the silence is the helper's own missing socket.
    """

    def progress_at(self, process_id: str) -> float | None:
        """Nothing has been heard from anyone."""
        return None


# How the tick finds the profile a process published. A callable rather than a registry,
# because the answer comes from somewhere different for each kind of process: an addon's
# manifest for a plugin, and nothing at all for the host, the MCP server and Anytype.
Profiles = Callable[[ChildRecord], StabilityProfile | None]


def no_profile(record: ChildRecord) -> StabilityProfile | None:
    """The default lookup: nothing published a profile, so everything uses the defaults."""
    return None


@dataclass
class _Progress:
    """The last progress marker seen for one process, and when it last changed."""

    marker: float | None
    changed_at: float


class HealthWatch:
    """The sampling tick: samples every managed process, judges it, and stops what has to go.

    Built with the :class:`~innytypes.helper.processes.ManagedProcesses` that owns the
    run-state file and the signalling — this class holds no signaller of its own, so there is
    no path from a resource reading to a process ID that skips the identity check.

    It is **stateful between ticks**, and has to be: a grace window, a CPU window and "when
    did this last make progress" are all questions about the past. The state is keyed by
    record id and dropped the moment a record leaves the file, so a process that is stopped
    and later started again is judged from scratch rather than inheriting the grace clock of
    the run that got it killed.
    """

    def __init__(
        self,
        *,
        processes: ManagedProcesses,
        probe: ResourceProbe,
        numbers: HelperNumbers | None = None,
        heartbeats: Heartbeats | None = None,
        profiles: Profiles = no_profile,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._processes = processes
        self._probe = probe
        self._numbers = HelperNumbers() if numbers is None else numbers
        self._heartbeats = NoHeartbeats() if heartbeats is None else heartbeats
        self._profiles = profiles
        self._clock = clock

        # Per record id, the CPU samples still inside the window: (when, cumulative seconds).
        self._cpu: dict[str, list[tuple[float, float]]] = {}
        # Per record id, when each limit now over its line first went over it.
        self._over_since: dict[str, dict[Limit, float]] = {}
        # Per record id, the progress marker and when it last changed.
        self._progress: dict[str, _Progress] = {}

    @property
    def profiles(self) -> Profiles:
        """The lookup this watch judges against, for a caller that has to ask it too.

        The one such caller is the helper's tick, which needs a stopped process's
        ``restartable`` flag (:mod:`innytypes.helper.supervision`). It reads the lookup from
        here rather than holding a second copy, so the profile that decided the breach is
        always the profile that decides the relaunch.
        """
        return self._profiles

    def tick(self) -> tuple[Observation, ...]:
        """One pass over every managed process: check, sample, judge, and stop what must go.

        Every record is reported, including the phantoms — a record that was forgotten is a
        thing that happened to this machine, and a caller that only saw the survivors could
        not tell it from a process that was never recorded.
        """
        now = self._clock()
        observations: list[Observation] = []

        for record in self._processes.records():
            identified = self._processes.check(record)
            if not identified.is_ours:
                # `check` has already deleted the record. Nothing is sampled and nothing is
                # signalled: that is the whole of the response to a phantom.
                observations.append(self._nothing_to_judge(record, verdict=identified.verdict))
                continue

            observations.append(self._judge(record, now=now))

        # Only the processes actually measured this tick keep their state. A phantom, or a
        # process that went away mid-tick, leaves nothing behind for the next one to inherit.
        self._forget_all_but(
            {
                observation.record.id
                for observation in observations
                if observation.sample is not None
            }
        )
        return tuple(observations)

    # --- one process ------------------------------------------------------------------------

    def _judge(self, record: ChildRecord, *, now: float) -> Observation:
        """Sample one live process, judge it against its profile, and act if it has to be."""
        limits = self._profiles(record)
        sample = self._probe.resources(record.pid)

        if sample is None:
            # It passed the identity check a moment ago and cannot be measured now. Judge
            # nothing: a reading we do not have is not a reading of zero.
            return self._nothing_to_judge(record, verdict=Verdict.ALIVE)

        window = _cpu_window(limits, self._numbers)
        cpu = self._cpu_over_window(record.id, sample, now=now, window=window)
        breaches = self._breaches(record.id, sample, cpu_over_window=cpu, limits=limits, now=now)
        stale = self._is_stale(record, limits=limits, now=now)

        stopped = None
        sustained = tuple(breach for breach in breaches if breach.sustained)
        if sustained:
            for breach in sustained:
                log.warning(
                    "%s (process %s) has been over its %s limit for %.0fs: %.1f against %.1f",
                    record.id,
                    record.pid,
                    breach.limit,
                    breach.duration,
                    breach.value,
                    breach.allowed,
                )
            # The only way this module ever reaches a process: identity re-checked, polite
            # stop, wait, forced kill.
            stopped = self._processes.stop(record)

        if stale:
            log.warning(
                "%s (process %s) is alive but has made no progress within its window",
                record.id,
                record.pid,
            )

        return Observation(
            record=record,
            verdict=Verdict.ALIVE,
            sample=sample,
            cpu_over_window=cpu,
            stale=stale,
            breaches=breaches,
            stopped=stopped,
        )

    def _nothing_to_judge(self, record: ChildRecord, *, verdict: Verdict) -> Observation:
        """A record there was nothing to measure: a phantom, or a process that just went."""
        return Observation(
            record=record,
            verdict=verdict,
            sample=None,
            cpu_over_window=None,
            stale=False,
            breaches=(),
            stopped=None,
        )

    # --- staleness --------------------------------------------------------------------------

    def _is_stale(
        self, record: ChildRecord, *, limits: StabilityProfile | None, now: float
    ) -> bool:
        """Whether this process is alive but has stopped making progress.

        The judgement is made on the **helper's own clock**, from the marker changing rather
        than from the value the marker holds: a process's `progress_at` is written against
        that process's clock, and comparing two clocks would make staleness a question about
        whose watch is right. So a heartbeat that never arrived and a heartbeat whose marker
        has not moved are the same thing here — which is exactly what D4 says they are, and
        what stops a loop spinning without progress from looking healthy.
        """
        window = _stale_after(limits)
        if window is None:
            # No profile, or a profile that never promised heartbeats. Watched for liveness,
            # phantoms and resources; never judged stale. Removing this is the whole bug.
            return False

        marker = self._heartbeats.progress_at(record.id)
        seen = self._progress.get(record.id)

        if seen is None:
            # First sight of this process. The window starts now, so a process that has just
            # been started is given its full window before anything is said about it.
            self._progress[record.id] = _Progress(marker=marker, changed_at=now)
            return False

        if marker is not None and marker != seen.marker:
            self._progress[record.id] = _Progress(marker=marker, changed_at=now)
            return False

        return now - seen.changed_at > window

    # --- resources --------------------------------------------------------------------------

    def _cpu_over_window(
        self, record_id: str, sample: ResourceSample, *, now: float, window: float
    ) -> float | None:
        """CPU used since the oldest sample still inside the window, as a percentage of a core.

        ``None`` when there is nothing to compare against yet — one sample, or two taken at
        the same instant. An unknown rate is never a breach.
        """
        samples = self._cpu.setdefault(record_id, [])
        samples.append((now, sample.cpu_seconds))

        # Keep one sample from before the window as well as everything inside it: dropping it
        # would shorten the window to the newest sample and make a short burst look sustained.
        cutoff = now - window
        while len(samples) > 1 and samples[1][0] <= cutoff:
            samples.pop(0)

        oldest_at, oldest_seconds = samples[0]
        elapsed = now - oldest_at
        if elapsed <= 0:
            return None

        return (sample.cpu_seconds - oldest_seconds) / elapsed * 100

    def _breaches(
        self,
        record_id: str,
        sample: ResourceSample,
        *,
        cpu_over_window: float | None,
        limits: StabilityProfile | None,
        now: float,
    ) -> tuple[Breach, ...]:
        """Every limit over its line right now, each with how long it has been over.

        A value back under its line clears that limit's clock, so the next time it goes over
        it starts its grace window again from zero.
        """
        profile = self._numbers.defaults if limits is None else limits
        grace = profile.breach_grace
        since = self._over_since.setdefault(record_id, {})

        readings: list[tuple[Limit, float, float]] = [
            (Limit.MEMORY, sample.rss_mb, profile.max_rss_mb),
            (Limit.OPEN_FILES, float(sample.open_files), float(profile.max_open_files)),
            (Limit.CHILDREN, float(sample.children), float(_max_children(limits, self._numbers))),
        ]
        if cpu_over_window is not None:
            readings.append((Limit.CPU, cpu_over_window, profile.max_cpu_percent))

        breaches: list[Breach] = []
        for limit, value, allowed in readings:
            if value <= allowed:
                since.pop(limit, None)
                continue

            started = since.setdefault(limit, now)
            breaches.append(
                Breach(
                    limit=limit,
                    value=value,
                    allowed=allowed,
                    duration=now - started,
                    grace=grace,
                )
            )

        # A limit we did not read this tick (CPU, before two samples exist) keeps its clock:
        # it was not observed to be under its line, and clearing it would be a claim.
        return tuple(breaches)

    # --- state that does not outlive its record ----------------------------------------------

    def _forget(self, record_id: str) -> None:
        """Drop everything remembered about one process."""
        self._cpu.pop(record_id, None)
        self._over_since.pop(record_id, None)
        self._progress.pop(record_id, None)

    def _forget_all_but(self, live: set[str]) -> None:
        """Drop the state of every process that is no longer in the run-state file."""
        for record_id in set(self._cpu) | set(self._over_since) | set(self._progress):
            if record_id not in live:
                self._forget(record_id)


# --- the profile in force, field by field -------------------------------------------------


def _stale_after(limits: StabilityProfile | None) -> float | None:
    """The window a process may go without progress, or ``None`` when it is never stale.

    Three cases, and the ``None`` is the one that matters. No profile at all: never stale. A
    profile with its own `stale_after`: that. A profile that named only a heartbeat interval:
    three of them (D4). A profile that named neither is back to never — it published limits,
    not a promise about heartbeats.
    """
    if limits is None:
        return None
    if limits.stale_after is not None:
        return limits.stale_after
    if limits.heartbeat_interval is not None:
        return STALE_INTERVALS * limits.heartbeat_interval
    return None


def _cpu_window(limits: StabilityProfile | None, numbers: HelperNumbers) -> float:
    """The window CPU is measured over: the profile's, or the helper-wide default."""
    return numbers.defaults.cpu_window if limits is None else limits.cpu_window


def _max_children(limits: StabilityProfile | None, numbers: HelperNumbers) -> int:
    """The child-process limit: the one profile field whose absence really is inheritance.

    `max_children` is the only limit a manifest may leave unset — the plan calls its default
    "the helper-wide default" rather than a number — so it is the only one resolved here. The
    others carry the same defaults in both places by construction (`HelperNumbers.defaults`
    *is* a `StabilityProfile`), so a profile's value is always the value in force.
    """
    if limits is not None and limits.max_children is not None:
        return limits.max_children

    helper_wide = numbers.defaults.max_children
    return DEFAULT_MAX_CHILDREN if helper_wide is None else helper_wide
