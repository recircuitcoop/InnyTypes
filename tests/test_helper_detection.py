"""The tick that decides something is wrong, asserted with no process and no clock of its own.

Three rules here are the ones worth breaking on purpose, because each of them is an
**absence** that a careless implementation passes by doing nothing:

*The grace window.* A value over its limit for less than `breach_grace` must produce **no
signal at all**. Delete the window and :func:`test_a_spike_inside_the_grace_window_is_not_acted_on`
turns red, because the very first tick that sees the spike kills the process.

*No profile means never stale.* A plugin that never promised heartbeats, and the Anytype
desktop app which sends none at all, must never be judged stale however long they say nothing.
Delete that rule and :func:`test_a_process_without_a_profile_is_never_judged_stale` turns red
within one window.

*Polite stop before kill.* Every stop is `TERMINATE`, then a wait, then `KILL` — and a process
that goes on the polite stop is never killed. Reverse or shorten that and
:func:`test_the_polite_stop_comes_first_and_the_kill_only_after` and its Anytype twin turn red.

Everything that touches the machine is injected: the process table and the resource probe are
one dictionary-backed fake, the clock counts instead of passing, the sleep between a polite
stop and a kill advances that count, and heartbeats are a dictionary a test writes into. The
one test that reads the real machine reads it about **this** interpreter and signals nothing.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from innytypes.addons.manifest import StabilityProfile
from innytypes.children import ChildKind, ChildRecord, RunStateFile
from innytypes.helper.config import DEFAULT_MAX_CHILDREN, HelperNumbers
from innytypes.helper.detection import (
    STALE_INTERVALS,
    HealthWatch,
    Limit,
    NoHeartbeats,
    Observation,
)
from innytypes.helper.processes import (
    ManagedProcesses,
    ProcessFacts,
    ResourceSample,
    Signal,
    Stop,
    SystemProcessTable,
    Verdict,
)

# The machine these tests describe, with numbers recognisable on sight in a failure message.
HELPER_PID = 4100
HOST_PID = 4200
PLUGIN_PID = 4500
ANYTYPE_PID = 4700

STARTED_AT = 1_700_000_000.0

HOST_EXECUTABLE = "/usr/local/bin/innytypes"
PLUGIN_EXECUTABLE = "/Users/someone/.local/share/innytypes/addons/whodunnit/env/bin/python"
ANYTYPE_EXECUTABLE = "/Applications/Anytype.app/Contents/MacOS/Anytype"
STRANGER_EXECUTABLE = "/Applications/Ledger.app/Contents/MacOS/Ledger"

# The helper's own numbers, used as they ship unless a test says otherwise.
NUMBERS = HelperNumbers()
DEFAULTS = NUMBERS.defaults
TICK = NUMBERS.tick
GRACE = DEFAULTS.breach_grace
STOP_TIMEOUT = NUMBERS.stop_timeout


def a_record(
    *,
    id: str = "whodunnit",
    kind: ChildKind = ChildKind.ADDON,
    pid: int = PLUGIN_PID,
    started_at: float = STARTED_AT,
    executable: str = PLUGIN_EXECUTABLE,
    parent_pid: int = HOST_PID,
) -> ChildRecord:
    """One record, as whoever spawned the process wrote it."""
    return ChildRecord(
        id=id,
        kind=kind,
        pid=pid,
        started_at=started_at,
        executable=executable,
        parent_pid=parent_pid,
    )


HOST_RECORD = a_record(
    id="innytypes",
    kind=ChildKind.HOST,
    pid=HOST_PID,
    executable=HOST_EXECUTABLE,
    parent_pid=HELPER_PID,
)
PLUGIN_RECORD = a_record()
ANYTYPE_RECORD = a_record(
    id="anytype-app",
    kind=ChildKind.ANYTYPE_APP,
    pid=ANYTYPE_PID,
    executable=ANYTYPE_EXECUTABLE,
    parent_pid=HELPER_PID,
)


def calm(**changed: float | int) -> ResourceSample:
    """A process using nothing anyone would object to, with one field nameable per call."""
    sample = {"rss_mb": 64.0, "cpu_seconds": 0.0, "open_files": 12, "children": 0}
    sample.update(changed)
    return ResourceSample(
        rss_mb=float(sample["rss_mb"]),
        cpu_seconds=float(sample["cpu_seconds"]),
        open_files=int(sample["open_files"]),
        children=int(sample["children"]),
    )


class FakeClock:
    """A clock that only moves when a test says so, and when a sleep is waited out."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def sleep(self, seconds: float) -> None:
        """The sleep the stop sequence polls on: time passes, this test run does not."""
        self.now += seconds


@dataclass
class FakeMachine:
    """The OS process table and the resource probe, as plain data a test writes.

    One object because the real :class:`SystemProcessTable` is one object, and because a test
    that had to keep two fakes agreeing about which processes exist would eventually fail to.
    """

    facts_by_pid: dict[int, ProcessFacts] = field(default_factory=dict)
    samples: dict[int, ResourceSample] = field(default_factory=dict)
    # Every `resources` call, in order, so "one sample per process per tick" is countable.
    sampled: list[int] = field(default_factory=list)

    def run(self, record: ChildRecord, sample: ResourceSample | None = None) -> None:
        """Put the process this record names on the machine, using ``sample``."""
        self.facts_by_pid[record.pid] = ProcessFacts(
            pid=record.pid,
            started_at=record.started_at,
            executable=record.executable,
        )
        self.samples[record.pid] = calm() if sample is None else sample

    def end(self, pid: int) -> None:
        """The process exits: it leaves the table, and there is nothing left to measure."""
        self.facts_by_pid.pop(pid, None)
        self.samples.pop(pid, None)

    def facts(self, pid: int) -> ProcessFacts | None:
        return self.facts_by_pid.get(pid)

    def resources(self, pid: int) -> ResourceSample | None:
        self.sampled.append(pid)
        return self.samples.get(pid)


class FakeHeartbeats:
    """The progress markers the helper has received, as a dictionary a test writes into."""

    def __init__(self) -> None:
        self.markers: dict[str, float] = {}

    def progress_at(self, process_id: str) -> float | None:
        return self.markers.get(process_id)


@dataclass
class Fixture:
    """One helper watching one machine, with every seam reachable from the test."""

    watch: HealthWatch
    machine: FakeMachine
    clock: FakeClock
    heartbeats: FakeHeartbeats
    signals: list[tuple[int, Signal]]
    run_state: RunStateFile

    def tick(self, *, after: float = 0.0) -> tuple[Observation, ...]:
        """Let ``after`` seconds pass, then run one tick."""
        self.clock.advance(after)
        return self.watch.tick()

    def of(self, record_id: str, observations: tuple[Observation, ...]) -> Observation:
        """The one observation about ``record_id``, or a failure naming what was there."""
        for observation in observations:
            if observation.record.id == record_id:
                return observation
        pytest.fail(f"no observation for {record_id!r}: {[o.record.id for o in observations]}")


def watching(
    tmp_path: Path,
    *records: ChildRecord,
    profiles: dict[str, StabilityProfile] | None = None,
    numbers: HelperNumbers | None = None,
) -> Fixture:
    """A helper watching exactly these processes, all of them running and all of them calm."""
    run_state = RunStateFile(tmp_path / "run-state.json")
    machine = FakeMachine()
    for record in records:
        run_state.write(record)
        machine.run(record)

    clock = FakeClock()
    signals: list[tuple[int, Signal]] = []
    published = {} if profiles is None else profiles

    processes = ManagedProcesses(
        run_state=run_state,
        table=machine,
        send_signal=lambda pid, which: signals.append((pid, which)),
        clock=clock,
        sleep=clock.sleep,
        stop_timeout=(HelperNumbers() if numbers is None else numbers).stop_timeout,
    )
    heartbeats = FakeHeartbeats()
    watch = HealthWatch(
        processes=processes,
        probe=machine,
        numbers=numbers,
        heartbeats=heartbeats,
        profiles=lambda record: published.get(record.id),
        clock=clock,
    )
    return Fixture(
        watch=watch,
        machine=machine,
        clock=clock,
        heartbeats=heartbeats,
        signals=signals,
        run_state=run_state,
    )


# --- the tick samples everything, once ------------------------------------------------------


def test_every_managed_process_is_sampled_once_per_tick(tmp_path: Path) -> None:
    """One sample per managed process per tick — not one per record, and not two."""
    fixture = watching(tmp_path, HOST_RECORD, PLUGIN_RECORD, ANYTYPE_RECORD)

    observations = fixture.tick()

    assert sorted(fixture.machine.sampled) == sorted([HOST_PID, PLUGIN_PID, ANYTYPE_PID])
    assert {observation.record.id for observation in observations} == {
        "innytypes",
        "whodunnit",
        "anytype-app",
    }

    fixture.tick(after=TICK)
    assert sorted(fixture.machine.sampled) == sorted([HOST_PID, PLUGIN_PID, ANYTYPE_PID] * 2)


def test_a_sample_carries_memory_cpu_open_files_and_children(tmp_path: Path) -> None:
    """All four numbers the plan names reach the observation for every process."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    fixture.machine.samples[PLUGIN_PID] = calm(
        rss_mb=512, cpu_seconds=3.0, open_files=40, children=2
    )

    observation = fixture.of("whodunnit", fixture.tick())

    assert observation.sample is not None
    assert observation.sample.rss_mb == 512
    assert observation.sample.cpu_seconds == 3.0
    assert observation.sample.open_files == 40
    assert observation.sample.children == 2
    # One sample cannot be a rate: CPU over the window is unknown until there are two.
    assert observation.cpu_over_window is None


def test_a_phantom_record_is_never_sampled_and_never_signalled(tmp_path: Path) -> None:
    """The identity check comes first: a reused process ID is forgotten, not measured."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    fixture.machine.facts_by_pid[PLUGIN_PID] = ProcessFacts(
        pid=PLUGIN_PID,
        started_at=STARTED_AT,
        executable=STRANGER_EXECUTABLE,
    )
    fixture.machine.samples[PLUGIN_PID] = calm(rss_mb=99_999)

    observation = fixture.of("whodunnit", fixture.tick())

    assert observation.verdict is Verdict.REUSED
    assert observation.sample is None
    assert observation.breaches == ()
    assert fixture.machine.sampled == []
    assert fixture.signals == []
    assert fixture.run_state.records() == ()


def test_a_process_that_goes_between_the_check_and_the_sample_is_not_judged(
    tmp_path: Path,
) -> None:
    """A reading we do not have is not a reading of zero, and it is not a breach either."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    del fixture.machine.samples[PLUGIN_PID]

    observation = fixture.of("whodunnit", fixture.tick())

    assert observation.verdict is Verdict.ALIVE
    assert observation.sample is None
    assert observation.breaches == ()
    assert fixture.signals == []


# --- staleness ------------------------------------------------------------------------------


CHATTY = StabilityProfile(heartbeat_interval=5.0)
STALE_AFTER = STALE_INTERVALS * 5.0


def test_a_process_that_stops_progressing_is_judged_stale(tmp_path: Path) -> None:
    """Alive, still sending nothing new, and past its window: that is what stale means."""
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": CHATTY})
    fixture.heartbeats.markers["whodunnit"] = 100.0

    assert not fixture.of("whodunnit", fixture.tick()).stale

    # The marker never moves again, however many heartbeats arrive.
    assert not fixture.of("whodunnit", fixture.tick(after=STALE_AFTER)).stale
    assert fixture.of("whodunnit", fixture.tick(after=0.001)).stale


def test_a_process_still_making_progress_is_not_stale(tmp_path: Path) -> None:
    """A marker that keeps moving resets the window every time, for as long as it moves."""
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": CHATTY})
    fixture.heartbeats.markers["whodunnit"] = 100.0
    fixture.tick()

    for step in range(10):
        fixture.heartbeats.markers["whodunnit"] = 101.0 + step
        assert not fixture.of("whodunnit", fixture.tick(after=STALE_AFTER - 0.5)).stale


def test_heartbeats_that_stop_are_the_same_as_progress_that_stops(tmp_path: Path) -> None:
    """Silence is judged on the helper's clock, so a heartbeat source going quiet is stale."""
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": CHATTY})
    fixture.heartbeats.markers["whodunnit"] = 100.0
    fixture.tick()

    # Not "the marker stopped moving" — the heartbeat itself is gone.
    fixture.heartbeats.markers.clear()
    assert fixture.of("whodunnit", fixture.tick(after=STALE_AFTER + 1)).stale


def test_a_plugin_that_never_sent_a_heartbeat_at_all_goes_stale(tmp_path: Path) -> None:
    """It published an interval, so silence from the first tick onward is a broken promise."""
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": CHATTY})

    assert not fixture.of("whodunnit", fixture.tick()).stale
    assert fixture.of("whodunnit", fixture.tick(after=STALE_AFTER + 1)).stale


def test_a_process_without_a_profile_is_never_judged_stale(tmp_path: Path) -> None:
    """The rule the whole slice can get wrong: no promise, no staleness — ever."""
    fixture = watching(tmp_path, HOST_RECORD, PLUGIN_RECORD)

    for _ in range(20):
        observations = fixture.tick(after=STALE_AFTER * 10)
        assert not fixture.of("whodunnit", observations).stale
        assert not fixture.of("innytypes", observations).stale

    # And nothing was signalled on the way, because staleness was never reached.
    assert fixture.signals == []


def test_a_profile_with_limits_but_no_heartbeat_promise_is_never_stale(tmp_path: Path) -> None:
    """Publishing resource limits is not publishing a heartbeat interval."""
    limits_only = StabilityProfile(max_rss_mb=2048)
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": limits_only})

    assert not fixture.of("whodunnit", fixture.tick(after=STALE_AFTER * 100)).stale


def test_a_profile_may_name_its_own_stale_window(tmp_path: Path) -> None:
    """`stale_after` wins over three heartbeat intervals when the manifest names both."""
    patient = StabilityProfile(heartbeat_interval=5.0, stale_after=600.0)
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": patient})
    fixture.tick()

    assert not fixture.of("whodunnit", fixture.tick(after=599.0)).stale
    assert fixture.of("whodunnit", fixture.tick(after=2.0)).stale


def test_staleness_never_signals_anything_here(tmp_path: Path) -> None:
    """Stale is a decision reported to the restart policy, not an act of this slice."""
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": CHATTY})
    fixture.tick()

    assert fixture.of("whodunnit", fixture.tick(after=STALE_AFTER + 1)).stale
    assert fixture.signals == []
    assert fixture.run_state.records() == (PLUGIN_RECORD,)


# --- the grace window -------------------------------------------------------------------------


def hungry() -> ResourceSample:
    """A sample over the memory limit and nowhere near any other one."""
    return calm(rss_mb=DEFAULTS.max_rss_mb + 1)


def test_a_spike_inside_the_grace_window_is_not_acted_on(tmp_path: Path) -> None:
    """Over the limit, but not for long enough: a breach is reported and nothing is signalled."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    fixture.machine.samples[PLUGIN_PID] = hungry()

    observation = fixture.of("whodunnit", fixture.tick())
    assert [breach.limit for breach in observation.breaches] == [Limit.MEMORY]
    assert observation.breaches[0].duration == 0
    assert observation.sustained == ()
    assert not observation.acted
    assert fixture.signals == []

    # Still inside the window, right up to its last instant.
    observation = fixture.of("whodunnit", fixture.tick(after=GRACE))
    assert observation.breaches[0].duration == GRACE
    assert observation.sustained == ()
    assert fixture.signals == []


def test_the_same_value_sustained_past_the_grace_window_is_acted_on(tmp_path: Path) -> None:
    """The boundary from the other side: one instant past the grace and the helper acts."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    fixture.machine.samples[PLUGIN_PID] = hungry()

    fixture.tick()
    assert fixture.signals == []

    observation = fixture.of("whodunnit", fixture.tick(after=GRACE + 0.001))
    assert observation.sustained[0].limit is Limit.MEMORY
    assert observation.sustained[0].value == DEFAULTS.max_rss_mb + 1
    assert observation.sustained[0].allowed == DEFAULTS.max_rss_mb
    assert observation.acted
    assert [which for _, which in fixture.signals][0] is Signal.TERMINATE


def test_a_value_that_comes_back_under_the_limit_restarts_the_grace_window(
    tmp_path: Path,
) -> None:
    """A spike that ends is not half a breach: the next one starts its window from zero."""
    fixture = watching(tmp_path, PLUGIN_RECORD)

    fixture.machine.samples[PLUGIN_PID] = hungry()
    fixture.tick()
    fixture.machine.samples[PLUGIN_PID] = calm()
    fixture.tick(after=GRACE - 1)
    fixture.machine.samples[PLUGIN_PID] = hungry()

    observation = fixture.of("whodunnit", fixture.tick(after=2.0))
    assert observation.breaches[0].duration == 0
    assert fixture.signals == []

    assert fixture.of("whodunnit", fixture.tick(after=GRACE + 0.001)).acted


def test_a_profiles_own_grace_window_is_the_one_in_force(tmp_path: Path) -> None:
    """A plugin that asked for a longer rope gets it, and is not killed before its end."""
    patient = StabilityProfile(breach_grace=600.0)
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": patient})
    fixture.machine.samples[PLUGIN_PID] = hungry()

    fixture.tick()
    assert not fixture.of("whodunnit", fixture.tick(after=GRACE * 5)).acted
    assert fixture.signals == []

    assert fixture.of("whodunnit", fixture.tick(after=600.0)).acted


def test_a_record_that_leaves_and_returns_starts_a_fresh_grace_window(tmp_path: Path) -> None:
    """The grace clock belongs to a run of a process, not to its id."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    fixture.machine.samples[PLUGIN_PID] = hungry()
    fixture.tick()

    # It goes, and comes back under a new record with the same id.
    fixture.run_state.forget(PLUGIN_RECORD.id)
    fixture.machine.end(PLUGIN_PID)
    fixture.tick(after=GRACE - 5)

    returned = a_record(started_at=STARTED_AT + 1_000)
    fixture.run_state.write(returned)
    fixture.machine.run(returned, hungry())

    assert fixture.of("whodunnit", fixture.tick(after=10.0)).breaches[0].duration == 0
    assert fixture.signals == []


# --- the four limits ---------------------------------------------------------------------------


def test_cpu_is_measured_over_the_window_from_two_totals(tmp_path: Path) -> None:
    """Cumulative CPU time plus the time between samples is what "90 % for 2 min" means."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    fixture.machine.samples[PLUGIN_PID] = calm(cpu_seconds=0.0)
    fixture.tick()

    # Half a core over the next ten seconds.
    fixture.clock.advance(10.0)
    fixture.machine.samples[PLUGIN_PID] = calm(cpu_seconds=5.0)
    observation = fixture.of("whodunnit", fixture.watch.tick())

    assert observation.cpu_over_window == pytest.approx(50.0)
    assert observation.breaches == ()


def test_sustained_cpu_over_its_limit_is_a_breach(tmp_path: Path) -> None:
    """A core and a half, held past the grace window, is stopped like any other breach."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    burnt = 0.0
    fixture.machine.samples[PLUGIN_PID] = calm(cpu_seconds=burnt)
    fixture.tick()

    acted = False
    for _ in range(int((GRACE + DEFAULTS.cpu_window) / TICK) + 2):
        burnt += TICK * 1.5
        fixture.machine.samples[PLUGIN_PID] = calm(cpu_seconds=burnt)
        observation = fixture.of("whodunnit", fixture.tick(after=TICK))
        assert observation.cpu_over_window == pytest.approx(150.0)
        if observation.acted:
            acted = True
            break

    assert acted
    assert [which for _, which in fixture.signals][0] is Signal.TERMINATE


def test_cpu_inside_the_window_cannot_be_hidden_by_a_later_idle_sample(
    tmp_path: Path,
) -> None:
    """The window keeps a sample from before its edge, so a burst is measured over the window."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    fixture.machine.samples[PLUGIN_PID] = calm(cpu_seconds=0.0)
    fixture.tick()

    # One second of CPU, then nothing for ten. Over the eleven-second window that is ~9 %,
    # which is the honest answer and not the 0 % the newest pair of samples would give.
    fixture.machine.samples[PLUGIN_PID] = calm(cpu_seconds=1.0)
    fixture.tick(after=1.0)
    observation = fixture.of("whodunnit", fixture.tick(after=10.0))

    assert observation.cpu_over_window == pytest.approx(100 / 11)


def test_open_files_over_the_limit_is_a_breach(tmp_path: Path) -> None:
    fixture = watching(tmp_path, PLUGIN_RECORD)
    fixture.machine.samples[PLUGIN_PID] = calm(open_files=DEFAULTS.max_open_files + 1)

    fixture.tick()
    observation = fixture.of("whodunnit", fixture.tick(after=GRACE + 1))

    assert [breach.limit for breach in observation.sustained] == [Limit.OPEN_FILES]
    assert observation.acted


def test_children_over_the_helper_wide_default_is_a_breach(tmp_path: Path) -> None:
    """`max_children` is the one limit a manifest may leave to the helper, so it is resolved."""
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": StabilityProfile()})
    assert StabilityProfile().max_children is None
    fixture.machine.samples[PLUGIN_PID] = calm(children=DEFAULT_MAX_CHILDREN + 1)

    fixture.tick()
    observation = fixture.of("whodunnit", fixture.tick(after=GRACE + 1))

    assert [breach.limit for breach in observation.sustained] == [Limit.CHILDREN]
    assert observation.sustained[0].allowed == DEFAULT_MAX_CHILDREN


def test_a_profile_may_raise_a_limit_above_the_helper_wide_default(tmp_path: Path) -> None:
    """A plugin that published 2 GB is watched against 2 GB, not against the default 1 GB."""
    roomy = StabilityProfile(max_rss_mb=2048, max_children=64)
    fixture = watching(tmp_path, PLUGIN_RECORD, profiles={"whodunnit": roomy})
    fixture.machine.samples[PLUGIN_PID] = calm(rss_mb=1500, children=48)

    fixture.tick()
    assert fixture.of("whodunnit", fixture.tick(after=GRACE * 2)).breaches == ()
    assert fixture.signals == []


def test_the_helper_wide_defaults_can_be_raised_in_the_config(tmp_path: Path) -> None:
    """`[helper.defaults]` is where a process with no profile gets its limits from."""
    numbers = HelperNumbers(defaults=StabilityProfile(max_rss_mb=4096, breach_grace=5.0))
    fixture = watching(tmp_path, HOST_RECORD, numbers=numbers)
    fixture.machine.samples[HOST_PID] = calm(rss_mb=2048)

    fixture.tick()
    assert fixture.of("innytypes", fixture.tick(after=GRACE * 2)).breaches == ()


# --- polite stop, then kill --------------------------------------------------------------------


def breaching(fixture: Fixture, record: ChildRecord) -> tuple[Observation, ...]:
    """Hold ``record`` over its memory limit until the grace window has run out."""
    fixture.machine.samples[record.pid] = hungry()
    fixture.tick()
    return fixture.tick(after=GRACE + 1)


def test_the_polite_stop_comes_first_and_the_kill_only_after(tmp_path: Path) -> None:
    """A process that ignores the polite stop is killed — and only in that order."""
    fixture = watching(tmp_path, PLUGIN_RECORD)

    observation = fixture.of("whodunnit", breaching(fixture, PLUGIN_RECORD))

    assert fixture.signals == [(PLUGIN_PID, Signal.TERMINATE), (PLUGIN_PID, Signal.KILL)]
    assert observation.stopped is not None
    assert observation.stopped.outcome is Stop.STILL_RUNNING


def test_a_process_that_goes_on_the_polite_stop_is_never_killed(tmp_path: Path) -> None:
    """The forced kill is what happens when asking failed, not part of asking."""
    fixture = watching(tmp_path, PLUGIN_RECORD)

    def politely(pid: int, which: Signal) -> None:
        fixture.signals.append((pid, which))
        if which is Signal.TERMINATE:
            fixture.machine.end(pid)

    fixture.watch = HealthWatch(
        processes=ManagedProcesses(
            run_state=fixture.run_state,
            table=fixture.machine,
            send_signal=politely,
            clock=fixture.clock,
            sleep=fixture.clock.sleep,
            stop_timeout=STOP_TIMEOUT,
        ),
        probe=fixture.machine,
        heartbeats=fixture.heartbeats,
        clock=fixture.clock,
    )

    observation = fixture.of("whodunnit", breaching(fixture, PLUGIN_RECORD))

    assert fixture.signals == [(PLUGIN_PID, Signal.TERMINATE)]
    assert observation.stopped is not None
    assert observation.stopped.outcome is Stop.TERMINATED
    assert fixture.run_state.records() == ()


def test_the_kill_waits_out_the_stop_timeout_before_it_is_sent(tmp_path: Path) -> None:
    """The wait between the two is the stop timeout, on the helper's own clock."""
    fixture = watching(tmp_path, PLUGIN_RECORD)
    started_at = fixture.clock.now

    breaching(fixture, PLUGIN_RECORD)

    # Two waits: one before the kill, one to confirm the kill worked. Neither slept for real.
    assert fixture.clock.now - started_at >= GRACE + 1 + STOP_TIMEOUT


# --- the Anytype desktop app is not a special case (D5) -----------------------------------------


def test_the_anytype_desktop_app_is_stopped_politely_then_killed(tmp_path: Path) -> None:
    """D5 in full: the same rule, the same order, on the one process with unsaved work."""
    fixture = watching(tmp_path, ANYTYPE_RECORD)

    observation = fixture.of("anytype-app", breaching(fixture, ANYTYPE_RECORD))

    assert observation.sustained[0].limit is Limit.MEMORY
    assert fixture.signals == [(ANYTYPE_PID, Signal.TERMINATE), (ANYTYPE_PID, Signal.KILL)]
    assert observation.stopped is not None


def test_the_anytype_desktop_app_is_given_the_same_grace_window(tmp_path: Path) -> None:
    """A spike in the app the user is typing into is a spike, not a reason to lose their work."""
    fixture = watching(tmp_path, ANYTYPE_RECORD)
    fixture.machine.samples[ANYTYPE_PID] = hungry()

    fixture.tick()
    assert not fixture.of("anytype-app", fixture.tick(after=GRACE)).acted
    assert fixture.signals == []


def test_the_anytype_desktop_app_is_never_judged_stale(tmp_path: Path) -> None:
    """It sends no heartbeat, so it has no window to miss — watched for resources only."""
    fixture = watching(tmp_path, ANYTYPE_RECORD)

    for _ in range(5):
        observation = fixture.of("anytype-app", fixture.tick(after=STALE_AFTER * 10))
        assert not observation.stale
        assert observation.sample is not None

    assert fixture.signals == []


# --- the defaults, and the real machine ---------------------------------------------------------


def test_a_helper_with_no_heartbeat_source_hears_nothing(tmp_path: Path) -> None:
    """The honest default: a helper built without a heartbeat socket has heard from nobody."""
    assert NoHeartbeats().progress_at("whodunnit") is None

    run_state = RunStateFile(tmp_path / "run-state.json")
    run_state.write(PLUGIN_RECORD)
    machine = FakeMachine()
    machine.run(PLUGIN_RECORD)
    clock = FakeClock()
    signals: list[tuple[int, Signal]] = []
    watch = HealthWatch(
        processes=ManagedProcesses(
            run_state=run_state,
            table=machine,
            send_signal=lambda pid, which: signals.append((pid, which)),
            clock=clock,
            sleep=clock.sleep,
        ),
        probe=machine,
        clock=clock,
    )

    watch.tick()
    clock.advance(STALE_AFTER * 10)

    # No profile, so still not stale, and nothing was signalled for the silence.
    assert not watch.tick()[0].stale
    assert signals == []


def test_the_real_process_table_measures_this_interpreter() -> None:
    """The one look at the real machine: this process, read and not touched."""
    sample = SystemProcessTable().resources(os.getpid())

    assert sample is not None
    assert sample.rss_mb > 0
    assert sample.cpu_seconds >= 0
    assert sample.open_files > 0
    assert sample.children >= 0


def test_the_real_process_table_measures_nothing_it_may_not_name() -> None:
    """Process IDs that address a group are refused here exactly as they are for identity."""
    assert SystemProcessTable().resources(0) is None
    assert SystemProcessTable().resources(-1) is None


def test_the_real_process_table_answers_nothing_for_a_process_that_is_not_there() -> None:
    """Cannot measure and is not there are one answer here, and it is never a sample of zeroes."""
    # Above every process ID this platform hands out, so it names nothing on any machine.
    assert SystemProcessTable().resources(2**30) is None
