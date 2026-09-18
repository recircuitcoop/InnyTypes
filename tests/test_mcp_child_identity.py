"""The MCP child's record has to survive the helper's identity check.

The host launches the MCP server through `npx`, which is a Node script: the OS reports the
`node` binary as that process's image, not the path that was launched. A record holding the
launched path could therefore never match all three facts, so the helper would forget the MCP
child as a phantom — safe, but it would also mean the helper could never stop, kill or
orphan-clean the one child plan 0003 most needs it to manage.

The fix is on the writing side: record what the OS reports. The identity rule itself is
untouched, and the last test here holds it to that.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from innytypes.anytype_mcp.config import ServerConfig
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.children import ChildSupervisor, RunStateFile
from innytypes.helper.processes import (
    ManagedProcesses,
    ProcessFacts,
    Signal,
    Verdict,
)

FAKE_KEY = "test-key-not-a-real-credential"

# Where `npx` lives, and what the OS reports for the process it becomes.
NPX_PATH = "/opt/homebrew/bin/npx"
NODE_BINARY = "/opt/homebrew/Cellar/node/24.1.0/bin/node"


class FakeProcess:
    """Just enough of a process for the supervisor: it is alive until it is told otherwise."""

    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self.terminated = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode if self.returncode is not None else 0


class FakeTable:
    """A process table a test writes out by hand."""

    def __init__(self, facts: dict[int, ProcessFacts]) -> None:
        self.facts_by_pid = facts

    def facts(self, pid: int) -> ProcessFacts | None:
        return self.facts_by_pid.get(pid)


class RecordingSignaller:
    def __init__(self) -> None:
        self.sent: list[tuple[int, Signal]] = []

    def __call__(self, pid: int, signal: Signal) -> None:
        self.sent.append((pid, signal))


@pytest.fixture
def run_state(tmp_path: Path) -> RunStateFile:
    return RunStateFile(tmp_path / "run-state.json")


def mcp_supervisor(process: FakeProcess) -> Supervisor:
    def spawn(argv, env):  # type: ignore[no-untyped-def]
        assert argv[0] == "npx"
        return process  # type: ignore[return-value]

    # The health gate runs before the spawn, and with no client injected it asks the real
    # machine whether Anytype's local API answers — so these tests passed only while the
    # developer happened to have Anytype open, and failed on a machine where it was closed.
    # Nothing here is about the health gate; it is a precondition to reach the record being
    # tested, so it is injected and always reachable.
    reachable = httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(200)))
    return Supervisor(config=ServerConfig(api_key=FAKE_KEY), spawn=spawn, health_client=reachable)


def host_with(
    process: FakeProcess,
    run_state: RunStateFile,
    *,
    image_of,
    started_at: float = 1000.0,
):
    """A host whose only child is the MCP server, launched through `npx`."""

    def spawn(argv, env, *, channel=None):  # type: ignore[no-untyped-def]
        return process  # type: ignore[return-value]

    return ChildSupervisor(
        mcp=mcp_supervisor(process),
        addons=[],
        run_state=run_state,
        report_exit=lambda _exit: None,
        spawn=spawn,
        clock=lambda: started_at,
        image_of=image_of,
    )


def test_the_mcp_childs_record_verifies_against_the_image_the_os_reports(
    run_state: RunStateFile,
) -> None:
    """The record the host writes is the one the helper's three-fact check accepts."""
    process = FakeProcess()
    host = host_with(process, run_state, image_of=lambda _pid: NODE_BINARY)

    host.start("innytypes.anytype_mcp")

    (record,) = run_state.records()
    assert record.executable == NODE_BINARY  # not NPX_PATH

    table = FakeTable(
        {
            process.pid: ProcessFacts(
                pid=process.pid,
                started_at=record.started_at,
                executable=NODE_BINARY,
            )
        }
    )
    managed = ManagedProcesses(
        run_state=run_state,
        table=table,
        send_signal=RecordingSignaller(),
    )

    assert managed.check(record).verdict is Verdict.ALIVE


def test_recording_the_launched_path_would_never_have_verified(
    run_state: RunStateFile,
) -> None:
    """Proof the old behaviour was the defect, not a preference: it is a phantom."""
    process = FakeProcess()
    # image_of answering None is exactly the old behaviour: record what was launched.
    host = host_with(process, run_state, image_of=lambda _pid: None)

    host.start("innytypes.anytype_mcp")
    (record,) = run_state.records()

    table = FakeTable(
        {
            process.pid: ProcessFacts(
                pid=process.pid,
                started_at=record.started_at,
                executable=NODE_BINARY,
            )
        }
    )
    managed = ManagedProcesses(
        run_state=run_state,
        table=table,
        send_signal=RecordingSignaller(),
    )

    assert managed.check(record).verdict is Verdict.REUSED


def test_the_helper_can_stop_the_mcp_child_through_the_ordinary_path(
    run_state: RunStateFile,
) -> None:
    """What the fix is for: the signal actually reaches the child."""
    process = FakeProcess()
    host = host_with(process, run_state, image_of=lambda _pid: NODE_BINARY)
    host.start("innytypes.anytype_mcp")
    (record,) = run_state.records()

    signaller = RecordingSignaller()
    table = FakeTable(
        {
            process.pid: ProcessFacts(
                pid=process.pid,
                started_at=record.started_at,
                executable=NODE_BINARY,
            )
        }
    )
    managed = ManagedProcesses(
        run_state=run_state,
        table=table,
        send_signal=signaller,
        stop_timeout=0.0,
    )

    managed.stop(record)

    assert signaller.sent[0] == (process.pid, Signal.TERMINATE)


def test_an_unrelated_program_at_a_reused_id_is_still_never_signalled(
    run_state: RunStateFile,
) -> None:
    """The identity rule is unchanged: this fix writes a truer record, it does not loosen it."""
    process = FakeProcess()
    host = host_with(process, run_state, image_of=lambda _pid: NODE_BINARY)
    host.start("innytypes.anytype_mcp")
    (record,) = run_state.records()

    signaller = RecordingSignaller()
    table = FakeTable(
        {
            # Same process id, a completely different program.
            process.pid: ProcessFacts(
                pid=process.pid,
                started_at=record.started_at + 5_000.0,
                executable="/Applications/Some Other App.app/Contents/MacOS/other",
            )
        }
    )
    managed = ManagedProcesses(
        run_state=run_state,
        table=table,
        send_signal=signaller,
    )

    managed.stop(record)

    assert signaller.sent == []
    assert run_state.records() == ()


def test_an_image_the_os_cannot_report_falls_back_to_what_was_launched(
    run_state: RunStateFile,
) -> None:
    """A process table that will not answer must not stop a child from starting."""
    process = FakeProcess()
    host = host_with(process, run_state, image_of=lambda _pid: None)

    record = host.start("innytypes.anytype_mcp")

    assert record.executable.endswith("npx")
