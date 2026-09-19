"""Process identity: the check every signal the helper sends has to pass first.

The single most dangerous thing this application can do is **kill an unrelated program**
because an old record's process ID was reused by the OS (plan 0003, *Phantom detection*). So
a process ID alone is never enough to act on, and this module is where that rule is
implemented once, for every later slice: the restart policy (slice 05), the resource killer
(slice 04) and the quit sequence (slice 07) all signal through :class:`ManagedProcesses` or
they are signalling on a number they cannot vouch for.

**The rule, in full.** A record in the run-state file holds a process ID, a start time and an
executable path. Before anything is signalled, all three are re-read from the OS process
table and compared. All three must still match. If even one differs — or the ID belongs to
nothing at all — the record is a **phantom**: the helper deletes it and sends **zero**
signals. It only ever forgets. That is the whole of the response, and it is deliberately not
"kill it anyway, it is probably ours".

**Two kinds of phantom, and only one of them is ever signalled.** A *stale record* is an ID
that now belongs to a different program; it is forgotten, never touched. An *orphan* is a
process whose own identity still matches but whose recorded **parent** is gone — a child the
host left behind when it died — and that one is stopped, politely first and forcibly after,
**before** the host is relaunched, so a new host never starts next to a leftover MCP server
or plugin. :meth:`ManagedProcesses.clear_before` is that ordering, expressed so it cannot be
got wrong by a caller that means well.

**Every seam that touches the machine is injected**, which is what lets the gate assert all
of this without a process to kill: the process table is a :class:`ProcessTable`, the signal
is a :data:`Signaller`, and the clock and the sleep between polls are callables. A test
describes processes as plain data and asserts on a list of signals that were asked for — most
often, on that list being empty.

**Three comparisons, and what each one costs when it is wrong.**

*The process ID* is exact, and a record whose ID is below 1 is never even looked up:
``os.kill(0, …)`` signals this process's own group and a negative ID signals a group by
number, so neither is a number this module is willing to carry to the OS.

*The start time* is compared **within a tolerance** (:data:`START_TIME_TOLERANCE`), because
the two values being compared are not produced by the same act. The OS notes when the process
began; the writer of the record reads the wall clock a moment later, once the spawn call has
returned. Exact equality would therefore never match anything, and the check would fail safe
into never acting at all — which is a check that has quietly stopped existing. The window is
seconds wide, which a spawn never exceeds and a reused ID essentially never lands in, and it
is only ever half of the answer: the executable path has to match too.

*The executable path* is compared exactly. The failure mode of a strict comparison here is
that a record is **forgotten** rather than acted on, never that the wrong process is
signalled, so strictness costs the application a missed restart at worst. It does mean a
launcher whose recorded path is not the path the OS will report — a wrapper script such as
``npx``, whose process image is the Node binary — writes records this check can never verify,
and an unverifiable record is one nothing will ever signal. That is the safe direction, and
it is written down in plan 0003 rather than discovered later.
"""

from __future__ import annotations

import os
import signal
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from innytypes.children import ChildRecord, RunStateFile
from innytypes.helper.config import HelperNumbers
from innytypes.logs import get_logger

__all__ = [
    "FORCE_SIGNAL",
    "POLL_INTERVAL",
    "START_TIME_TOLERANCE",
    "Identified",
    "ManagedProcesses",
    "ProcessFacts",
    "ProcessSnapshot",
    "ProcessTable",
    "ResourceProbe",
    "ResourceSample",
    "Signal",
    "SignalRefusedError",
    "Signaller",
    "Stop",
    "Stopped",
    "SystemProcessTable",
    "Verdict",
    "default_signaller",
    "facts_from",
    "open_file_count",
    "sample_from",
]

log = get_logger(__name__)

# How far the start time in a record may sit from the start time the OS reports and still be
# the same process. See the module docstring: the two are read at two different moments, so
# the gap is the spawn itself, and it is milliseconds. Seconds of room costs nothing, because
# a match also requires the executable path to be identical.
START_TIME_TOLERANCE = 2.0

# How often a process is looked at again while waiting for it to go. Short, because this wait
# sits between a polite stop and a forced kill, and every tick of it is a user waiting.
POLL_INTERVAL = 0.1

# The forced stop. Windows has no `SIGKILL`, and `os.kill` there turns `SIGTERM` into a
# `TerminateProcess` call, which is the closest that platform has to the same act. Looked up
# rather than written as a literal for that reason, and it needed nothing further on Windows
# (plan 0003 slice 16): a process ended by `TerminateProcess` is ended.
FORCE_SIGNAL = signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM

# The stop timeout comes from the helper's own settings, so the default here is *that*
# default rather than a second number that could disagree with it.
DEFAULT_STOP_TIMEOUT = HelperNumbers().stop_timeout


class SignalRefusedError(RuntimeError):
    """Raised when something asks for a signal to a process ID that means something else."""


@dataclass(frozen=True)
class ProcessFacts:
    """What the OS says about one process right now: the three facts a record is checked on.

    Deliberately not "the process": nothing here is a handle, and nothing can be done to a
    process through this object. The helper is not the parent of most of what it watches — it
    did not spawn the MCP server or the plugins, the host did — so it has no pipe, no
    ``Popen`` and no ``wait``. All it has is what the process table will tell it, which is
    exactly what this carries.
    """

    pid: int
    started_at: float
    executable: str


@dataclass(frozen=True)
class ResourceSample:
    """What one process is using right now, as the sampling tick reads it (plan 0003).

    ``cpu_seconds`` is **cumulative CPU time**, not a percentage, and that is deliberate. A
    percentage is a rate, and a rate needs two moments; the OS only ever knows the total. The
    helper turns two totals and the time between them into "CPU over its window"
    (:mod:`innytypes.helper.detection`), which is the number `max_cpu_percent` is compared
    against — so the window in the profile is measured by the code that owns the window,
    rather than being a number passed to the process table and hoped for.
    """

    rss_mb: float
    cpu_seconds: float
    open_files: int
    children: int


class ProcessTable(Protocol):
    """The OS process table, as this module reads it: one question, asked by process ID."""

    def facts(self, pid: int) -> ProcessFacts | None:
        """What the OS says about ``pid``, or ``None`` when it will not say.

        ``None`` covers both "no such process" and "this process exists but its identity
        cannot be read", because the helper's response to the two is the same one: a record
        it cannot verify is a record it will not act on.
        """
        ...


class ResourceProbe(Protocol):
    """The second question the tick asks the OS about a process: what is it using?

    A protocol of its own rather than another method on :class:`ProcessTable`, because the two
    are asked for different reasons and by different callers: identity is asked before every
    signal and must never be skipped, while resources are asked once a tick and may legitimately
    come back empty. :class:`SystemProcessTable` answers both, so a caller that wants the real
    machine still passes one object.
    """

    def resources(self, pid: int) -> ResourceSample | None:
        """What ``pid`` is using, or ``None`` when the OS will not say.

        ``None`` again covers "gone" and "may not look", and again means the same thing: a
        process the helper cannot measure is one it will not judge this tick.
        """
        ...


class ProcessSnapshot(Protocol):
    """One process as ``psutil`` describes it: the five questions this module ever asks.

    A protocol rather than ``psutil.Process`` itself, because it is what makes the two readers
    below testable. The gate runs on macOS and must nonetheless be able to assert that a
    **Windows** process — which counts handles where POSIX counts file descriptors — is read
    into the same :class:`ProcessFacts` and :class:`ResourceSample` every other slice consumes.
    A test describes that process as a plain object with these methods, and no Windows API is
    ever called.
    """

    def create_time(self) -> float: ...

    def exe(self) -> str: ...

    def memory_info(self) -> object: ...

    def cpu_times(self) -> object: ...

    # A `Sequence` rather than a `list`, because a list is invariant: `psutil.Process.children`
    # answers `list[Process]`, which is not a `list[object]` however little of it is read.
    def children(self, recursive: bool = ...) -> Sequence[object]: ...


def open_file_count(process: ProcessSnapshot) -> int:
    """How many files this process holds open, asked the way this platform counts them.

    The one genuine difference between the platforms' process tables, and the reason this is a
    function rather than a line. POSIX counts **file descriptors** (``num_fds``); Windows has
    no such thing and counts **handles** (``num_handles``) — a wider notion that includes open
    files but also every other kernel object the process holds. `psutil` offers exactly one of
    the two on any given machine, so asking for the one that is there is the whole of the
    port: ``stability.max_open_files`` then means "too many kernel objects" on Windows and
    "too many descriptors" elsewhere, which is the same runaway in both cases and is what the
    limit is there to catch.

    A process object offering neither is not a process table this module can measure, and the
    caller turns that into the same ``None`` every other unreadable process gets.
    """
    for name in ("num_fds", "num_handles"):
        counter = getattr(process, name, None)
        if counter is not None:
            return int(counter())

    raise AttributeError(
        "this process table counts neither open file descriptors nor open handles, so there "
        "is no open-file number to compare against the stability profile"
    )


def facts_from(process: ProcessSnapshot, *, pid: int) -> ProcessFacts:
    """The three facts a record is checked on, read out of one process, on any platform."""
    return ProcessFacts(pid=pid, started_at=process.create_time(), executable=process.exe())


def sample_from(process: ProcessSnapshot) -> ResourceSample:
    """What one process is using, read out of it, on any platform."""
    times = process.cpu_times()
    memory = process.memory_info()

    return ResourceSample(
        rss_mb=float(memory.rss) / (1024 * 1024),  # type: ignore[attr-defined]
        # User plus system: a process burning a core inside the kernel is burning a core, and
        # a limit that only counted user time would never see it.
        cpu_seconds=float(times.user) + float(times.system),  # type: ignore[attr-defined]
        open_files=open_file_count(process),
        # Recursive: a plugin that forks a process that forks ten more has eleven children by
        # the only measure the limit is there to catch.
        children=len(process.children(recursive=True)),
    )


class SystemProcessTable:
    """The real process table of this machine, read through ``psutil``.

    One class for macOS, Linux and Windows, because `psutil` answers all three and the helper's
    questions are the same everywhere. What the platforms disagree about is how open files are
    counted, and that disagreement lives in :func:`open_file_count` alone.

    The import sits inside the method rather than at the top of the module. Nothing in the
    gate reads the real process table — every test injects its own table — and a module-wide
    import would make every one of those tests pay for a library they never call.
    """

    def facts(self, pid: int) -> ProcessFacts | None:
        """Ask the OS about one process, answering ``None`` for anything it will not tell."""
        import psutil

        if pid < 1:
            # Not a process this module will ask about: on POSIX these numbers address
            # process *groups*, and `psutil` would happily answer for the one at 0.
            return None

        try:
            process = psutil.Process(pid)
            # One trip into the OS for both facts, so they cannot come from two moments.
            with process.oneshot():
                return facts_from(process, pid=pid)
        except (psutil.Error, OSError) as error:
            # A process that has gone, a zombie, or another user's process we may not read.
            # All three are "cannot vouch for this", and that is what `None` means here.
            log.debug("the process table would not describe process %s: %s", pid, error)
            return None

    def resources(self, pid: int) -> ResourceSample | None:
        """Read one process's memory, CPU time, open files and children in a single trip."""
        import psutil

        if pid < 1:
            return None

        try:
            process = psutil.Process(pid)
            with process.oneshot():
                return sample_from(process)
        except (psutil.Error, OSError, AttributeError) as error:
            log.debug("the process table would not measure process %s: %s", pid, error)
            return None


class Signal(StrEnum):
    """The two signals this application ever sends, named rather than numbered.

    A name rather than ``signal.SIGTERM`` so the seam a test injects carries no platform in
    it: what a test asserts is *that a polite stop was asked for before a forced one*, which
    is the behaviour, not the number the OS was handed.
    """

    TERMINATE = "terminate"
    KILL = "kill"


# The one way a signal leaves this application: a process ID and which of the two signals.
# A callable, so a test injects a list to append to, and "no signal was sent" is an empty
# list rather than a mock nobody configured.
Signaller = Callable[[int, Signal], None]


def default_signaller(pid: int, which: Signal) -> None:
    """Send one signal to one process ID, refusing the IDs that do not mean one process.

    ``os.kill`` with a process ID of 0 signals **this process's own group** — the helper, the
    host and every child at once — and a negative ID signals a group by number. Neither is
    ever what a run-state record holds, so both are refused here rather than assumed
    impossible. This is the one function in the application that can end a process it did not
    start, and the identity check in :class:`ManagedProcesses` is what is supposed to have
    happened before it is called.
    """
    if pid < 1:
        raise SignalRefusedError(
            f"{pid} is not a process this application may signal: on this platform a process "
            "ID of zero or less addresses a process group, not one process"
        )

    os.kill(pid, FORCE_SIGNAL if which is Signal.KILL else signal.SIGTERM)


class Verdict(StrEnum):
    """What the OS said about a record's process when it was last asked.

    ``REUSED`` and ``GONE`` are both phantoms and are treated identically — forget, signal
    nothing — but they are two different things to read in a log a week later: one is a
    process that ended without its record being cleaned up, the other is a number now
    belonging to a program nobody here has ever heard of.
    """

    ALIVE = "alive"
    GONE = "gone"
    REUSED = "reused"


@dataclass(frozen=True)
class Identified:
    """One record, checked against the OS, and what came back."""

    record: ChildRecord
    verdict: Verdict
    # What the process table said, when it said anything. For `REUSED` these are the facts of
    # the *other* program, which is what makes a log line about it worth reading.
    facts: ProcessFacts | None

    @property
    def is_ours(self) -> bool:
        """Whether this really is the process the record names, and may be acted on."""
        return self.verdict is Verdict.ALIVE


class Stop(StrEnum):
    """How an attempt to stop one process ended."""

    # The record failed the identity check. Nothing was signalled; the record is gone.
    FORGOTTEN = "forgotten"
    # It went on the polite stop.
    TERMINATED = "terminated"
    # It ignored the polite stop and had to be killed.
    KILLED = "killed"
    # It is still there after the forced kill. The record is **kept**: a process that
    # outlives a kill is a fact about this machine, and forgetting it would hide it.
    STILL_RUNNING = "still-running"


@dataclass(frozen=True)
class Stopped:
    """What stopping one process did, and to which record."""

    record: ChildRecord
    outcome: Stop

    @property
    def signalled(self) -> bool:
        """Whether this attempt sent the process any signal at all."""
        return self.outcome is not Stop.FORGOTTEN


class ManagedProcesses:
    """Every process in the run-state file, as the helper is allowed to act on it.

    Built with the run-state file the host and the helper share, a process table to check
    records against, and the function that actually signals. Nothing else in the helper may
    hold the signaller: a caller that signals around this object is a caller that skipped the
    identity check, and the check is the only thing standing between a stale record and an
    unrelated program.

    Two clocks are in play and they are not the same clock. Records carry **wall-clock**
    start times, because that is the clock a process start time is read from the OS in. The
    timeouts here are measured on a **monotonic** clock, because a wait between a polite stop
    and a forced kill must not be lengthened or skipped by the machine's time changing under
    it.
    """

    def __init__(
        self,
        *,
        run_state: RunStateFile,
        table: ProcessTable,
        send_signal: Signaller = default_signaller,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        stop_timeout: float = DEFAULT_STOP_TIMEOUT,
        poll_interval: float = POLL_INTERVAL,
        start_time_tolerance: float = START_TIME_TOLERANCE,
    ) -> None:
        self._run_state = run_state
        self._table = table
        self._send_signal = send_signal
        self._clock = clock
        self._sleep = sleep
        self._stop_timeout = stop_timeout
        self._poll_interval = poll_interval
        self._tolerance = start_time_tolerance

    def records(self) -> tuple[ChildRecord, ...]:
        """Every record in the file, as written. Nothing is checked and nothing is forgotten."""
        return self._run_state.records()

    def check(self, record: ChildRecord) -> Identified:
        """Re-read one record's three facts from the OS, **forgetting the record if any differ**.

        Checking is not a free look: a record that fails is deleted here and now, because the
        plan's answer to a phantom is that the helper forgets it, and a phantom left in the
        file is one the next pass would have to decide about all over again.
        """
        facts = None if record.pid < 1 else self._table.facts(record.pid)
        verdict = self._verdict(record, facts)

        if verdict is not Verdict.ALIVE:
            log.info(
                "forgetting the record for %s (process %s): %s",
                record.id,
                record.pid,
                "no process has that id any more"
                if verdict is Verdict.GONE
                else "that id now belongs to a different program",
            )
            self._run_state.forget(record.id)

        return Identified(record=record, verdict=verdict, facts=facts)

    def live(self) -> tuple[Identified, ...]:
        """Every record whose process is still the one it names, phantoms forgotten on the way."""
        return tuple(
            identified
            for identified in (self.check(record) for record in self.records())
            if identified.is_ours
        )

    def orphans(self) -> tuple[ChildRecord, ...]:
        """Every live process whose recorded parent is gone: a child nothing owns any more.

        The parent is checked through **its own record** whenever it has one, which is the
        point of storing a parent's process ID rather than a second copy of its three facts:
        the parent's identity is verified in full, by exactly the same check, and the two
        copies cannot drift apart because there is only one. A parent with no record at all —
        whoever launched the helper, say — is settled by bare liveness, and that fallback
        errs towards "not an orphan", because the cost of being wrong in the other direction
        is a signal to a process whose identity nothing here has confirmed.
        """
        checked = tuple(self.check(record) for record in self.records())
        by_pid = {identified.record.pid: identified.verdict for identified in checked}

        return tuple(
            identified.record
            for identified in checked
            if identified.is_ours and not self._parent_is_alive(identified.record, by_pid)
        )

    def stop(self, record: ChildRecord) -> Stopped:
        """Stop one process: identity first, then politely, then forcibly.

        The identity check is not a precondition a caller could forget — it is the first
        thing this method does, and a record that fails it leaves here having been deleted
        with no signal sent at all.
        """
        if not self.check(record).is_ours:
            return Stopped(record=record, outcome=Stop.FORGOTTEN)

        log.info("stopping %s (process %s)", record.id, record.pid)
        self._send_signal(record.pid, Signal.TERMINATE)
        if self._wait_for_exit(record, timeout=self._stop_timeout):
            self._run_state.forget(record.id)
            return Stopped(record=record, outcome=Stop.TERMINATED)

        log.warning("%s (process %s) ignored the polite stop; killing it", record.id, record.pid)
        self._send_signal(record.pid, Signal.KILL)
        # A second wait rather than a second grace period: a killed process is already gone,
        # and this is what confirms it before its record is removed.
        if self._wait_for_exit(record, timeout=self._stop_timeout):
            self._run_state.forget(record.id)
            return Stopped(record=record, outcome=Stop.KILLED)

        log.error("%s (process %s) is still running after a forced kill", record.id, record.pid)
        return Stopped(record=record, outcome=Stop.STILL_RUNNING)

    def clear_before(self, relaunch: Callable[[], None]) -> tuple[Stopped, ...]:
        """Stop every orphan, and **only then** run ``relaunch``.

        The ordering is the whole reason this method exists rather than two calls at the call
        site. A host relaunched first would come up beside the leftover MCP server and
        plugins of the host that died, both halves holding the same sockets, and the second
        set would be the ones nobody has a record of. Whether to relaunch at all, how often
        and with what backoff is the restart policy's business (plan 0003 slice 05); all this
        promises is that the ground is clear when it runs.
        """
        stopped = tuple(self.stop(orphan) for orphan in self.orphans())
        relaunch()
        return stopped

    def _verdict(self, record: ChildRecord, facts: ProcessFacts | None) -> Verdict:
        """All three facts, compared. Any one of them differing is a phantom."""
        if facts is None:
            return Verdict.GONE

        if facts.pid != record.pid:
            return Verdict.REUSED

        if abs(facts.started_at - record.started_at) > self._tolerance:
            return Verdict.REUSED

        if facts.executable != record.executable:
            return Verdict.REUSED

        return Verdict.ALIVE

    def _parent_is_alive(self, record: ChildRecord, by_pid: Mapping[int, Verdict]) -> bool:
        """Whether the process that spawned ``record`` is still there."""
        verdict = by_pid.get(record.parent_pid)
        if verdict is not None:
            # The parent has a record of its own, so its full identity has just been checked.
            return verdict is Verdict.ALIVE

        return self._table.facts(record.parent_pid) is not None

    def _wait_for_exit(self, record: ChildRecord, *, timeout: float) -> bool:
        """Poll until this record's process is no longer there, or the timeout runs out.

        The wait re-runs the identity check rather than asking whether *something* still has
        that process ID, because a process that dies and has its ID immediately reused is
        gone for every purpose this method serves — and signalling the reuser would be the
        exact accident this module exists to prevent.
        """
        deadline = self._clock() + timeout

        while True:
            if self._verdict(record, self._table.facts(record.pid)) is not Verdict.ALIVE:
                return True
            if self._clock() >= deadline:
                return False
            self._sleep(self._poll_interval)
