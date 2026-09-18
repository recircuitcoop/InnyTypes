"""Never signal the wrong process, asserted without a process to signal.

The behaviour this slice exists for is again an **absence** — a record whose process ID has
been reused receives *nothing* — and the easiest way to "pass" that is to write no check at
all. So the tests below hand the helper a process table in which the recorded ID belongs to
an unrelated program, and assert that the injected signal function was never called, that the
record was deleted, and that the two kinds of phantom are told apart.

The check itself is three comparisons, and each one is worth a red test on its own: there is
a record here that differs only in its start time, and another that differs only in its
executable path. Delete either comparison from
:meth:`~innytypes.helper.processes.ManagedProcesses._verdict` and exactly one of them turns a
signal loose on a program that has nothing to do with this application.

Everything that touches the machine is injected, as the rest of this suite already injects
it: the process table is a dictionary, the signal function appends to a list, the clock
counts and the sleep advances that count instead of passing. The one test that reads the real
process table reads it about **this** interpreter and signals nothing.
"""

from __future__ import annotations

import os
import time
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from innytypes.children import ChildKind, ChildRecord, RunStateFile
from innytypes.helper.processes import (
    START_TIME_TOLERANCE,
    Identified,
    ManagedProcesses,
    ProcessFacts,
    Signal,
    SignalRefusedError,
    Stop,
    SystemProcessTable,
    Verdict,
    default_signaller,
)

# The machine these tests describe: a helper that spawned a host, a host that spawned the MCP
# server and one plugin. The numbers are recognisable on sight so a failure message reads.
HELPER_PID = 4100
HOST_PID = 4200
MCP_PID = 4321
PLUGIN_PID = 4500

# Wall-clock seconds, the clock a record's `started_at` is written in.
STARTED_AT = 1_700_000_000.0

HOST_EXECUTABLE = "/usr/local/bin/innytypes"
MCP_EXECUTABLE = "/opt/homebrew/bin/npx"
PLUGIN_EXECUTABLE = "/Users/someone/.local/share/innytypes/addons/whodunnit/env/bin/python"

# A program that has nothing to do with this application, which is what a reused process ID
# turns out to be running.
STRANGER_EXECUTABLE = "/Applications/Ledger.app/Contents/MacOS/Ledger"


def a_record(
    *,
    id: str = "innytypes.anytype_mcp",
    kind: ChildKind = ChildKind.MCP,
    pid: int = MCP_PID,
    started_at: float = STARTED_AT,
    executable: str = MCP_EXECUTABLE,
    parent_pid: int = HOST_PID,
) -> ChildRecord:
    """One record, as the host writes it, with everything nameable by keyword."""
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
MCP_RECORD = a_record()
PLUGIN_RECORD = a_record(
    id="whodunnit",
    kind=ChildKind.ADDON,
    pid=PLUGIN_PID,
    executable=PLUGIN_EXECUTABLE,
)


@dataclass
class FakeProcessTable:
    """The OS process table as plain data: a process is a dictionary entry, nothing more."""

    processes: dict[int, ProcessFacts] = field(default_factory=dict)
    # Process IDs that go away by themselves once they have been looked at this many times:
    # a process that exits on its own while the helper is waiting for it to.
    exits_after: dict[int, int] = field(default_factory=dict)
    looks: Counter[int] = field(default_factory=Counter)

    def facts(self, pid: int) -> ProcessFacts | None:
        self.looks[pid] += 1
        limit = self.exits_after.get(pid)
        if limit is not None and self.looks[pid] > limit:
            self.processes.pop(pid, None)
        return self.processes.get(pid)

    def running(
        self, pid: int, *, started_at: float = STARTED_AT, executable: str = MCP_EXECUTABLE
    ) -> None:
        """Say that this process ID is in use, by a process with these facts."""
        self.processes[pid] = ProcessFacts(pid=pid, started_at=started_at, executable=executable)

    def running_as_recorded(self, record: ChildRecord) -> None:
        """Say that the process this record names really is the one that has its ID."""
        self.running(record.pid, started_at=record.started_at, executable=record.executable)


@dataclass
class Machine:
    """A run-state file, a process table, a signal function and a clock that never waits.

    ``events`` is the ordering the awkward acceptance criteria are asserted on: every signal
    and every relaunch lands in the one list, in the order it happened.
    """

    managed: ManagedProcesses
    run_state: RunStateFile
    table: FakeProcessTable
    events: list[tuple[str, int]]
    # Process IDs that ignore a polite stop, and process IDs that ignore even a kill.
    stubborn: set[int]
    unkillable: set[int]

    @property
    def signals(self) -> list[tuple[str, int]]:
        """Only the signals, for the tests whose whole claim is that there were none."""
        return [event for event in self.events if event[0] in {"terminate", "kill"}]

    def recorded_ids(self) -> list[str]:
        """The ids still in the run-state file, read back off the disk."""
        return [record.id for record in self.run_state.records()]


@pytest.fixture
def machine(tmp_path: Path) -> Iterator[Machine]:
    """A helper wired to fakes: nothing here can reach a real process."""
    table = FakeProcessTable()
    events: list[tuple[str, int]] = []
    stubborn: set[int] = set()
    unkillable: set[int] = set()
    now = [0.0]

    def send_signal(pid: int, which: Signal) -> None:
        events.append((str(which), pid))
        if pid in unkillable:
            return
        if which is Signal.KILL or pid not in stubborn:
            table.processes.pop(pid, None)

    def clock() -> float:
        return now[0]

    def sleep(seconds: float) -> None:
        # The only thing a sleep does in this suite: move the clock the timeout is measured
        # against. A test that hangs here is a test asserting against a real wait.
        now[0] += seconds

    run_state = RunStateFile(tmp_path / "run-state.json")
    yield Machine(
        managed=ManagedProcesses(
            run_state=run_state,
            table=table,
            send_signal=send_signal,
            clock=clock,
            sleep=sleep,
            stop_timeout=5.0,
            poll_interval=1.0,
        ),
        run_state=run_state,
        table=table,
        events=events,
        stubborn=stubborn,
        unkillable=unkillable,
    )


# --------------------------------------------------------------------------------------
# The record itself: written by the host, read back by the helper.
# --------------------------------------------------------------------------------------


def test_a_record_survives_a_full_round_trip_through_the_run_state_file(
    machine: Machine,
) -> None:
    # Written with the host's writer (`innytypes.children`) and read with the helper's
    # reader, because the two halves being the same record is the contract, not a detail.
    machine.run_state.write(MCP_RECORD)

    read_back = machine.managed.records()

    assert read_back == (MCP_RECORD,)
    only = read_back[0]
    assert only.pid == MCP_PID
    assert only.started_at == STARTED_AT
    assert only.executable == MCP_EXECUTABLE
    # The spawning process's identity: what makes an orphan visible at all.
    assert only.parent_pid == HOST_PID


def test_every_record_in_the_file_is_read_not_just_the_first(machine: Machine) -> None:
    for record in (HOST_RECORD, MCP_RECORD, PLUGIN_RECORD):
        machine.run_state.write(record)

    assert machine.recorded_ids() == ["innytypes", "innytypes.anytype_mcp", "whodunnit"]


def test_stopping_a_process_removes_its_record_from_the_run_state_file(
    machine: Machine,
) -> None:
    machine.run_state.write(MCP_RECORD)
    machine.table.running_as_recorded(MCP_RECORD)

    stopped = machine.managed.stop(MCP_RECORD)

    assert stopped.outcome is Stop.TERMINATED
    assert machine.recorded_ids() == []
    assert machine.signals == [("terminate", MCP_PID)]


# --------------------------------------------------------------------------------------
# The check that matters: a reused process ID is forgotten, never signalled.
# --------------------------------------------------------------------------------------


def test_a_process_id_now_belonging_to_another_program_is_never_signalled(
    machine: Machine,
) -> None:
    # The case this whole slice exists for. The ID is in use, the start time is plausible,
    # and the program behind it is somebody else's.
    machine.run_state.write(MCP_RECORD)
    machine.table.running(MCP_PID, started_at=STARTED_AT, executable=STRANGER_EXECUTABLE)

    stopped = machine.managed.stop(MCP_RECORD)

    assert machine.signals == []
    assert stopped.outcome is Stop.FORGOTTEN
    assert stopped.signalled is False
    assert machine.recorded_ids() == []


def test_a_process_id_reused_by_a_later_start_of_the_same_program_is_never_signalled(
    machine: Machine,
) -> None:
    # The other half of the reuse case, and the one the executable comparison cannot catch:
    # same path, different process, because the ID came round again hours later.
    machine.run_state.write(MCP_RECORD)
    machine.table.running(MCP_PID, started_at=STARTED_AT + 6 * 60 * 60, executable=MCP_EXECUTABLE)

    stopped = machine.managed.stop(MCP_RECORD)

    assert machine.signals == []
    assert stopped.outcome is Stop.FORGOTTEN
    assert machine.recorded_ids() == []


def test_a_reused_process_id_is_called_reused_and_an_absent_one_is_called_gone(
    machine: Machine,
) -> None:
    # Two phantoms, treated identically and named differently: one is a record nobody
    # cleaned up, the other is a number that now belongs to a stranger.
    machine.run_state.write(MCP_RECORD)
    machine.run_state.write(PLUGIN_RECORD)
    machine.table.running(MCP_PID, started_at=STARTED_AT, executable=STRANGER_EXECUTABLE)

    reused = machine.managed.check(MCP_RECORD)
    gone = machine.managed.check(PLUGIN_RECORD)

    assert reused.verdict is Verdict.REUSED
    assert gone.verdict is Verdict.GONE
    assert machine.signals == []
    assert machine.recorded_ids() == []


def test_a_record_that_still_matches_is_left_in_the_file(machine: Machine) -> None:
    # The check that could otherwise pass by deleting everything it is shown.
    machine.run_state.write(MCP_RECORD)
    machine.table.running_as_recorded(MCP_RECORD)

    identified = machine.managed.check(MCP_RECORD)

    assert identified.verdict is Verdict.ALIVE
    assert identified.is_ours
    assert identified.facts == ProcessFacts(
        pid=MCP_PID, started_at=STARTED_AT, executable=MCP_EXECUTABLE
    )
    assert machine.recorded_ids() == ["innytypes.anytype_mcp"]


def test_a_start_time_a_moment_later_than_the_record_still_matches(machine: Machine) -> None:
    # The record is written by the parent once the spawn returns, so it is always a little
    # later than the moment the OS noted. An exact comparison would match nothing at all in
    # production, and a check that never matches is a check that has stopped existing.
    machine.run_state.write(MCP_RECORD)
    machine.table.running(
        MCP_PID, started_at=STARTED_AT - START_TIME_TOLERANCE / 2, executable=MCP_EXECUTABLE
    )

    assert machine.managed.check(MCP_RECORD).verdict is Verdict.ALIVE


def test_a_start_time_beyond_the_tolerance_is_a_different_process(machine: Machine) -> None:
    machine.run_state.write(MCP_RECORD)
    machine.table.running(
        MCP_PID, started_at=STARTED_AT - START_TIME_TOLERANCE - 1, executable=MCP_EXECUTABLE
    )

    assert machine.managed.check(MCP_RECORD).verdict is Verdict.REUSED
    assert machine.signals == []


def test_a_process_table_that_answers_about_another_process_is_not_believed(
    machine: Machine, tmp_path: Path
) -> None:
    # Defence against the seam itself. A table implementation that answers the question it
    # was not asked would otherwise hand this module a set of facts that match perfectly and
    # belong to somebody else.
    class LyingTable:
        def facts(self, pid: int) -> ProcessFacts:
            return ProcessFacts(pid=pid + 1, started_at=STARTED_AT, executable=MCP_EXECUTABLE)

    run_state = RunStateFile(tmp_path / "lying.json")
    run_state.write(MCP_RECORD)
    managed = ManagedProcesses(run_state=run_state, table=LyingTable(), send_signal=_never_signal)

    assert managed.check(MCP_RECORD).verdict is Verdict.REUSED
    assert run_state.records() == ()


def test_live_keeps_the_processes_that_are_still_there_and_forgets_the_rest(
    machine: Machine,
) -> None:
    for record in (HOST_RECORD, MCP_RECORD, PLUGIN_RECORD):
        machine.run_state.write(record)
    machine.table.running_as_recorded(HOST_RECORD)
    machine.table.running(PLUGIN_PID, started_at=STARTED_AT, executable=STRANGER_EXECUTABLE)

    live = machine.managed.live()

    assert [identified.record.id for identified in live] == ["innytypes"]
    assert machine.recorded_ids() == ["innytypes"]
    assert machine.signals == []


def test_a_recorded_process_id_of_zero_is_never_even_looked_up(machine: Machine) -> None:
    # `os.kill(0, …)` signals this process's own group — the helper, the host and every
    # child at once. A record holding that number is refused before anything is asked about
    # it, rather than trusted never to exist.
    impossible = a_record(id="broken", pid=0)
    machine.run_state.write(impossible)
    machine.table.running(0, started_at=STARTED_AT, executable=MCP_EXECUTABLE)

    stopped = machine.managed.stop(impossible)

    assert stopped.outcome is Stop.FORGOTTEN
    assert machine.signals == []
    assert machine.recorded_ids() == []


def test_the_real_signaller_refuses_a_process_id_that_names_a_group() -> None:
    # The last line of defence, in the one function that can end a process this application
    # did not start. It raises rather than signalling, so nothing reaches `os.kill`.
    for pid in (0, -1, -4321):
        with pytest.raises(SignalRefusedError, match="process group"):
            default_signaller(pid, Signal.TERMINATE)


# --------------------------------------------------------------------------------------
# Orphans: the one phantom that *is* signalled, and the order it happens in.
# --------------------------------------------------------------------------------------


def test_a_child_whose_parent_is_gone_is_an_orphan(machine: Machine) -> None:
    # The host died; its record is still in the file and its MCP server is still running.
    machine.run_state.write(HOST_RECORD)
    machine.run_state.write(MCP_RECORD)
    machine.table.running_as_recorded(MCP_RECORD)

    orphans = machine.managed.orphans()

    assert [record.id for record in orphans] == ["innytypes.anytype_mcp"]
    # Finding an orphan signals nothing by itself; stopping it is a separate act.
    assert machine.signals == []


def test_a_child_whose_parent_is_alive_is_not_an_orphan(machine: Machine) -> None:
    # The whole chain is up: the helper, the host it spawned, the MCP server the host
    # spawned. Nothing here is anybody's leftover.
    machine.run_state.write(HOST_RECORD)
    machine.run_state.write(MCP_RECORD)
    machine.table.running(HELPER_PID, started_at=STARTED_AT, executable=HOST_EXECUTABLE)
    machine.table.running_as_recorded(HOST_RECORD)
    machine.table.running_as_recorded(MCP_RECORD)

    assert machine.managed.orphans() == ()


def test_a_parent_whose_own_process_id_was_reused_counts_as_gone(machine: Machine) -> None:
    # The parent has a record, so its identity is checked in full rather than by asking
    # whether *something* holds its number. Something does; it is not the host.
    machine.run_state.write(HOST_RECORD)
    machine.run_state.write(MCP_RECORD)
    machine.table.running(HOST_PID, started_at=STARTED_AT, executable=STRANGER_EXECUTABLE)
    machine.table.running_as_recorded(MCP_RECORD)

    orphans = machine.managed.orphans()

    assert [record.id for record in orphans] == ["innytypes.anytype_mcp"]
    # The parent's own record failed the check, so it was forgotten — and never signalled.
    assert machine.recorded_ids() == ["innytypes.anytype_mcp"]
    assert machine.signals == []


def test_a_parent_with_no_record_of_its_own_is_settled_by_liveness(machine: Machine) -> None:
    # Whoever launched the helper has no record in this file. The fallback errs towards
    # "not an orphan", because the other direction signals a process nothing has verified.
    machine.run_state.write(HOST_RECORD)
    machine.table.running_as_recorded(HOST_RECORD)
    machine.table.running(HELPER_PID, started_at=STARTED_AT, executable=HOST_EXECUTABLE)

    assert machine.managed.orphans() == ()

    machine.table.processes.pop(HELPER_PID)

    assert [record.id for record in machine.managed.orphans()] == ["innytypes"]


def test_an_orphan_is_asked_politely_before_it_is_killed(machine: Machine) -> None:
    machine.run_state.write(HOST_RECORD)
    machine.run_state.write(MCP_RECORD)
    machine.table.running_as_recorded(MCP_RECORD)
    machine.stubborn.add(MCP_PID)

    stopped = machine.managed.stop(machine.managed.orphans()[0])

    assert machine.signals == [("terminate", MCP_PID), ("kill", MCP_PID)]
    assert stopped.outcome is Stop.KILLED
    assert machine.recorded_ids() == []


def test_an_orphan_that_goes_quietly_is_never_killed(machine: Machine) -> None:
    machine.run_state.write(HOST_RECORD)
    machine.run_state.write(MCP_RECORD)
    machine.table.running_as_recorded(MCP_RECORD)

    stopped = machine.managed.stop(machine.managed.orphans()[0])

    assert machine.signals == [("terminate", MCP_PID)]
    assert stopped.outcome is Stop.TERMINATED


def test_a_process_that_survives_a_kill_keeps_its_record(machine: Machine) -> None:
    # A record removed here would hide a process nothing in this application can stop.
    machine.run_state.write(MCP_RECORD)
    machine.table.running_as_recorded(MCP_RECORD)
    machine.unkillable.add(MCP_PID)

    stopped = machine.managed.stop(MCP_RECORD)

    assert stopped.outcome is Stop.STILL_RUNNING
    assert machine.signals == [("terminate", MCP_PID), ("kill", MCP_PID)]
    assert machine.recorded_ids() == ["innytypes.anytype_mcp"]


def test_every_orphan_is_stopped_before_the_host_is_relaunched(machine: Machine) -> None:
    # The acceptance criterion in one list: a stubborn leftover MCP server is asked, then
    # killed, and only then does the relaunch run. A relaunch that happened first would
    # bring a new host up beside the old host's children.
    machine.run_state.write(HOST_RECORD)
    machine.run_state.write(MCP_RECORD)
    machine.run_state.write(PLUGIN_RECORD)
    machine.table.running_as_recorded(MCP_RECORD)
    machine.table.running_as_recorded(PLUGIN_RECORD)
    machine.stubborn.add(MCP_PID)

    def relaunch() -> None:
        machine.events.append(("relaunch", HOST_PID))

    stopped = machine.managed.clear_before(relaunch)

    assert machine.events == [
        ("terminate", MCP_PID),
        ("kill", MCP_PID),
        ("terminate", PLUGIN_PID),
        ("relaunch", HOST_PID),
    ]
    assert [one.outcome for one in stopped] == [Stop.KILLED, Stop.TERMINATED]
    assert machine.recorded_ids() == []


def test_a_relaunch_with_nothing_to_clear_still_happens(machine: Machine) -> None:
    # Without this, `clear_before` could satisfy the ordering test by never relaunching.
    def relaunch() -> None:
        machine.events.append(("relaunch", HOST_PID))

    assert machine.managed.clear_before(relaunch) == ()
    assert machine.events == [("relaunch", HOST_PID)]


def test_a_sweep_of_nothing_but_phantoms_sends_no_signal_at_all(machine: Machine) -> None:
    # Every record in the file is a lie, in a different way: one process is gone, one ID
    # belongs to a stranger, one started six hours after it was recorded.
    for record in (HOST_RECORD, MCP_RECORD, PLUGIN_RECORD):
        machine.run_state.write(record)
    machine.table.running(MCP_PID, started_at=STARTED_AT, executable=STRANGER_EXECUTABLE)
    machine.table.running(
        PLUGIN_PID, started_at=STARTED_AT + 6 * 60 * 60, executable=PLUGIN_EXECUTABLE
    )

    def relaunch() -> None:
        machine.events.append(("relaunch", HOST_PID))

    machine.managed.clear_before(relaunch)

    assert machine.signals == []
    assert machine.recorded_ids() == []


def test_a_process_that_exits_between_the_polite_stop_and_the_deadline_is_not_killed(
    machine: Machine,
) -> None:
    # The wait is a poll, so this is the case where the process is still there on the first
    # look and gone on a later one. It must not collect a kill on the way.
    machine.run_state.write(MCP_RECORD)
    machine.table.running_as_recorded(MCP_RECORD)
    machine.stubborn.add(MCP_PID)
    machine.table.exits_after[MCP_PID] = 3

    stopped = machine.managed.stop(MCP_RECORD)

    assert stopped.outcome is Stop.TERMINATED
    assert machine.signals == [("terminate", MCP_PID)]
    assert machine.recorded_ids() == []


# --------------------------------------------------------------------------------------
# The production process table, asked about this very interpreter and nothing else.
# --------------------------------------------------------------------------------------


def test_the_real_process_table_describes_this_process() -> None:
    facts = SystemProcessTable().facts(os.getpid())

    assert facts is not None
    assert facts.pid == os.getpid()
    # Wall-clock seconds, the same clock a record's `started_at` is written in — which is
    # the whole reason the two can be compared at all.
    assert 0 < facts.started_at <= time.time()
    assert Path(facts.executable).is_file()


def test_the_real_process_table_matches_a_record_built_from_it(tmp_path: Path) -> None:
    # The adapter and the check, together, on the one process this suite is allowed to know
    # about. Nothing is signalled: only `check` is called.
    table = SystemProcessTable()
    facts = table.facts(os.getpid())
    assert facts is not None

    identified: Identified = ManagedProcesses(
        run_state=RunStateFile(tmp_path / "run-state.json"),
        table=table,
        send_signal=_never_signal,
    ).check(
        a_record(
            id="tests",
            pid=facts.pid,
            started_at=facts.started_at,
            executable=facts.executable,
        )
    )

    assert identified.verdict is Verdict.ALIVE


def test_the_real_process_table_says_nothing_about_an_unused_process_id() -> None:
    assert SystemProcessTable().facts(_unused_pid()) is None


def test_the_real_process_table_refuses_a_process_id_that_names_a_group() -> None:
    assert SystemProcessTable().facts(0) is None


def _never_signal(pid: int, which: Signal) -> None:
    raise AssertionError(f"nothing in this suite may signal process {pid} ({which})")


def _unused_pid() -> int:
    """A process ID nothing on this machine is using, found by asking which ones are."""
    import psutil

    used = set(psutil.pids())
    for candidate in range(90_000, 99_999):
        if candidate not in used:
            return candidate
    raise AssertionError("this machine has no free process id in the range this test uses")
