"""The host's children, asserted without a process, a socket or a sleep anywhere.

The behaviour this slice exists for is an **absence** — the host never restarts a child — and
an absence is the easiest thing in the world to "pass" by writing no code at all. So the tests
below are written so that *adding* a respawn turns one of them red: a child whose fake process
is dead the instant it is spawned is polled again and again, and the number of spawns is
asserted to stay at one until a command from the helper arrives.

Everything that touches the outside world is injected, exactly as the tests of
`innytypes.anytype_mcp` already inject it: the spawn records its arguments instead of
launching anything, the health client answers in-process instead of opening a socket, the
clock counts instead of passing, and the run-state file lives under `tmp_path`.
"""

from __future__ import annotations

import contextlib
import json
import logging
import multiprocessing
import os
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import pytest

from conftest import FAKE_KEY
from innytypes import HOST_API_VERSION, children
from innytypes.addons.discovery import ENVIRONMENT_DIRNAME, MANIFEST_FILENAME, InstalledAddon
from innytypes.addons.manifest import AddonManifest, parse_manifest
from innytypes.addons.secrets import SECRETS_ROOT_VARIABLE, default_secrets_root
from innytypes.addons.settings import SETTINGS_PATH_VARIABLE, default_settings_path
from innytypes.anytype_mcp.config import PACKAGE_NAME, PACKAGE_VERSION, ServerConfig
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.children import (
    ADDON_RUNNER_MODULE,
    MCP_CHILD_ID,
    RUN_STATE_LOCK_POLL,
    RUN_STATE_VERSION,
    ChildError,
    ChildExit,
    ChildKind,
    ChildRecord,
    ChildStartFailure,
    ChildSupervisor,
    Command,
    CommandName,
    Descendant,
    DisabledChildError,
    HoldsBack,
    ProcessTree,
    RunStateError,
    RunStateFile,
    SystemProcessTree,
    UnknownChildError,
    _psutil_process,
    _psutil_wait,
    _release_exclusive_lock,
    _take_exclusive_lock,
    addon_command,
    addon_interpreter,
    default_addon_locations,
)

# The clock starts somewhere recognisable and steps by a whole second per reading, so a
# `started_at` in a record can be asserted exactly rather than "something float-ish".
FIRST_TICK = 1_700_000_000.0
TICK = 1.0


class FakeProcess:
    """Enough of a ``Popen`` to drive a child through its whole life.

    ``exit_code`` set at construction is a child that was dead before the host could look at
    it, which is how "a child that exits" is staged. ``ignores_terminate`` is the child that
    has to be killed on shutdown.
    """

    def __init__(
        self,
        pid: int,
        *,
        exit_code: int | None = None,
        ignores_terminate: bool = False,
    ) -> None:
        self.pid = pid
        # Named as ``Popen`` names it: `innytypes.anytype_mcp.Supervisor` reads this attribute
        # when it reports the Node child's exit.
        self.returncode = exit_code
        self.ignores_terminate = ignores_terminate
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        if not self.ignores_terminate:
            self.returncode = 0

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            if timeout is not None:
                # What a real child that is ignoring `terminate` does to a bounded wait.
                raise subprocess.TimeoutExpired(cmd="fake-child", timeout=timeout)
            self.returncode = 0
        return self.returncode


class FakeClock:
    """A clock that counts instead of passing, so a start time is a fact a test can name."""

    def __init__(self) -> None:
        self.readings = 0

    def __call__(self) -> float:
        reading = FIRST_TICK + self.readings * TICK
        self.readings += 1
        return reading


@dataclass
class ChildrenHarness:
    """A child supervisor wired to fakes, plus everything a test needs to assert about it."""

    supervisor: ChildSupervisor
    run_state: RunStateFile
    # The (argv, environment) of every spawn that was attempted, in order.
    spawns: list[tuple[list[str], dict[str, str]]] = field(default_factory=list)
    # Every child exit the host reported to the (injected) helper.
    reports: list[ChildExit] = field(default_factory=list)
    # Every fake process handed out, by the process ID the host recorded for it.
    processes: dict[int, FakeProcess] = field(default_factory=dict)
    # Every child the host said it could not start at all, in order. A separate list from
    # `reports` because they are separate reporters carrying separate facts, and a test that
    # kept them in one would not be able to tell which one arrived.
    start_failures: list[ChildStartFailure] = field(default_factory=list)

    def spawned_ids(self) -> list[str]:
        """The children that were spawned, in spawn order, by the id in their argv."""
        return [MCP_CHILD_ID if argv[0] == "npx" else argv[-1] for argv, _env in self.spawns]

    def process_for(self, child_id: str) -> FakeProcess:
        """The fake process behind one live child."""
        record = next(record for record in self.supervisor.running() if record.id == child_id)
        return self.processes[record.pid]


def manifest(
    addon_id: str,
    *,
    version: str = "1.0.0",
    requires: Sequence[str] = (),
    emits: Sequence[str] = (),
    subscribes: Sequence[str] = (),
) -> AddonManifest:
    """One parsed manifest, so no test invents a shape the grammar would refuse."""
    return parse_manifest(
        {
            "id": addon_id,
            "version": version,
            "host_api": HOST_API_VERSION,
            "requires": list(requires),
            "emits": list(emits),
            "subscribes": list(subscribes),
        }
    )


def installed(root: Path, addon_manifest: AddonManifest) -> InstalledAddon:
    """One addon as discovery would report it, without anything being written to disk."""
    addon_root = root / addon_manifest.id
    return InstalledAddon(
        id=addon_manifest.id,
        manifest=addon_manifest,
        root=addon_root,
        environment=addon_root / ENVIRONMENT_DIRNAME,
        manifest_path=addon_root / MANIFEST_FILENAME,
    )


def _nothing_holds_it_back(child_id: str) -> str | None:
    """The fixture's default: every child this supervisor has is allowed to run."""
    return None


def locations_under(root: Path, addon_id: str) -> Mapping[str, str]:
    """Where one addon's per-user files are, as this test's own directories.

    The production answer is :func:`~innytypes.children.default_addon_locations`, and the one
    test that compares the two is below; everything else here uses this, so no test in this
    file names a directory belonging to whoever is running the gate.
    """
    return {
        SETTINGS_PATH_VARIABLE: str(root / "config" / "plugins" / f"{addon_id}.toml"),
        SECRETS_ROOT_VARIABLE: str(root / "config" / "secrets"),
    }


MakeChildren = Callable[..., ChildrenHarness]


@pytest.fixture
def make_children(tmp_path: Path) -> Iterator[MakeChildren]:
    """Build child supervisors that spawn nothing and write only under ``tmp_path``."""
    clients: list[httpx.Client] = []

    def _make(
        *,
        addons: Sequence[InstalledAddon] = (),
        exit_code: int | None = None,
        ignores_terminate: bool = False,
        spawn_refuses: str = "",
        holds_back: HoldsBack = _nothing_holds_it_back,
        process_tree: ProcessTree | None = None,
    ) -> ChildrenHarness:
        spawns: list[tuple[list[str], dict[str, str]]] = []
        reports: list[ChildExit] = []
        processes: dict[int, FakeProcess] = {}
        start_failures: list[ChildStartFailure] = []

        def handle(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200)

        client = httpx.Client(transport=httpx.MockTransport(handle))
        clients.append(client)

        def spawn(
            argv: Sequence[str],
            env: dict[str, str],
            *,
            channel: int | None = None,
        ) -> FakeProcess:
            # `channel` is the addon's event channel, which a real child inherits as its
            # standard input; a fake process has nothing to do with it.
            spawns.append((list(argv), dict(env)))
            if spawn_refuses:
                # A machine that cannot launch what it says is installed: a missing
                # interpreter, a binary that is not executable. `OSError` is what the real
                # `subprocess.Popen` raises for both.
                raise OSError(spawn_refuses)
            # Process IDs that could not collide with this test runner's own.
            process = FakeProcess(
                pid=90_000 + len(spawns),
                exit_code=exit_code,
                ignores_terminate=ignores_terminate,
            )
            processes[process.pid] = process
            return process

        run_state = RunStateFile(tmp_path / "run-state.json")
        supervisor = ChildSupervisor(
            mcp=Supervisor(
                config=ServerConfig(api_key=FAKE_KEY),
                spawn=spawn,  # type: ignore[arg-type]
                health_client=client,
            ),
            addons=addons,
            run_state=run_state,
            report_exit=reports.append,
            report_start_failure=start_failures.append,
            spawn=spawn,
            clock=FakeClock(),
            # An environment of its own, so nothing here depends on the shell the gate runs in.
            environment={"PATH": "/nonexistent"},
            # Per-user locations of its own too, for the same reason: what an addon is told
            # about where its files are must be this test's directory and never a real one.
            locations=lambda addon_id: locations_under(tmp_path, addon_id),
            holds_back=holds_back,
            process_tree=process_tree,
        )
        return ChildrenHarness(supervisor, run_state, spawns, reports, processes, start_failures)

    yield _make

    for client in clients:
        client.close()


def three_addons(tmp_path: Path) -> list[InstalledAddon]:
    """Three addons whose manifests force the order alpha, beta, gamma.

    `beta` only *subscribes* to alpha, which is an ordering edge and not a requirement;
    `gamma` requires beta outright. Both kinds of edge therefore have to be honoured for the
    order to come out right.
    """
    return [
        installed(tmp_path, manifest("alpha", emits=["alpha.started.v1"])),
        installed(tmp_path, manifest("beta", subscribes=["alpha.*"])),
        installed(tmp_path, manifest("gamma", requires=["beta==1.0.0"])),
    ]


# --- A child that exits is reported, and the host starts nothing ------------------------


@pytest.mark.parametrize("child_id", [MCP_CHILD_ID, "alpha"])
def test_a_child_that_exits_is_reported_once_and_never_respawned(
    make_children: MakeChildren, tmp_path: Path, child_id: str
) -> None:
    """The absence this slice is about: polling a dead child forever spawns nothing.

    If a respawn were ever added to `poll`, the spawn count below would climb with every
    poll and this test would go red — which is the only way an absence can be tested.
    """
    harness = make_children(
        addons=[installed(tmp_path, manifest("alpha"))],
        exit_code=17,
    )
    harness.supervisor.start_all()
    spawns_after_start = harness.spawned_ids().count(child_id)

    for _ in range(5):
        harness.supervisor.poll()

    assert spawns_after_start == 1
    assert harness.spawned_ids().count(child_id) == 1

    reported = [report for report in harness.reports if report.id == child_id]
    assert len(reported) == 1
    assert reported[0].exit_code == 17
    assert reported[0].expected is False


def test_an_exit_report_carries_the_kind_and_the_process_id(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))], exit_code=3)
    records = {record.id: record for record in harness.supervisor.start_all()}

    harness.supervisor.poll()

    reports = {report.id: report for report in harness.reports}
    assert reports["alpha"].kind is ChildKind.ADDON
    assert reports[MCP_CHILD_ID].kind is ChildKind.MCP
    assert reports["alpha"].pid == records["alpha"].pid


def test_a_child_that_exited_is_no_longer_listed(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))], exit_code=1)
    harness.supervisor.start_all()

    harness.supervisor.poll()

    assert harness.supervisor.running() == ()


# --- A child that never started is reported too, and differently -------------------------


def test_a_child_that_cannot_be_spawned_is_reported_to_the_helper_with_the_reason(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """The defect this slice is about: `start` raised, and nobody was told.

    Before this, a spawn that failed produced an exception and nothing else — no record, no
    report, and in a packaged application no visible reason either, because the only account
    of it was a line on the host's own stdout.

    Both halves are asserted, because either one alone is the bug: the helper **is** told,
    naming the child and carrying the failure's own words; and the child is **not** recorded
    as running, so nothing afterwards tries to stop or signal a process that never existed.
    """
    harness = make_children(
        addons=[installed(tmp_path, manifest("alpha"))],
        spawn_refuses="its interpreter is missing",
    )

    with pytest.raises(OSError, match="its interpreter is missing"):
        harness.supervisor.start("alpha")

    assert [failure.id for failure in harness.start_failures] == ["alpha"]
    assert harness.start_failures[0].kind is ChildKind.ADDON
    assert "its interpreter is missing" in harness.start_failures[0].reason

    # Not running, by every account there is of what is running.
    assert harness.supervisor.running() == ()
    assert harness.run_state.records() == ()


def test_a_failed_start_is_not_reported_as_an_exit(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """The distinction the restart policy needs: this is not a crash.

    A child that never started has no process id and no exit code, so a report shaped like a
    :class:`ChildExit` would have to invent both. Nothing reaches the exit reporter at all.
    """
    harness = make_children(
        addons=[installed(tmp_path, manifest("alpha"))],
        spawn_refuses="its interpreter is missing",
    )

    with pytest.raises(OSError):
        harness.supervisor.start("alpha")

    assert harness.reports == []
    assert len(harness.start_failures) == 1
    # And it is not a ChildExit wearing a different name: it carries no pid and no code.
    assert not hasattr(harness.start_failures[0], "pid")
    assert not hasattr(harness.start_failures[0], "exit_code")


def test_a_child_the_user_switched_off_is_not_reported_as_a_failed_start(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """Held back is not failed, and the two must not arrive as the same sentence.

    A plugin waiting to be switched on is named in the host's own `held` list, where the word
    already says what to do about it. Reporting it here as well would tell the helper
    something is wrong with a plugin that is perfectly fine, and would be a second vocabulary
    for a fact the host already has one for.
    """
    harness = make_children(
        addons=[installed(tmp_path, manifest("alpha"))],
        holds_back=lambda child_id: "disabled" if child_id == "alpha" else None,
    )

    with pytest.raises(DisabledChildError):
        harness.supervisor.start("alpha")

    assert harness.start_failures == []
    assert harness.spawns == []


def test_a_restart_whose_start_fails_tells_the_helper_the_child_is_not_coming_back(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """The failure reaches the helper wherever the start came from, command included.

    `start` is reached from the host's own startup, from `start_all`, and from a `restart`
    the helper itself asked for. The refusal answers only the last of those, so the report is
    what makes the other two visible — and reporting it inside `start` is what makes all
    three the same path rather than three places to remember.
    """
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])
    harness.supervisor.start("alpha")
    assert harness.start_failures == []

    # The machine changes underneath a running host: the next spawn will not work.
    harness.supervisor._spawn = _refusing_spawn  # noqa: SLF001 - no seam for a later change

    with pytest.raises(OSError, match="the environment was deleted"):
        harness.supervisor.execute(Command(name=CommandName.RESTART, child_id="alpha"))

    # The stop half of the restart happened and was reported as expected; the start half
    # failed and was reported as a failure. Two facts, two reports, neither lost.
    assert [report.id for report in harness.reports] == ["alpha"]
    assert harness.reports[0].expected is True
    assert [failure.id for failure in harness.start_failures] == ["alpha"]
    assert "the environment was deleted" in harness.start_failures[0].reason
    assert harness.supervisor.running() == ()


def _refusing_spawn(
    argv: Sequence[str], env: dict[str, str], *, channel: int | None = None
) -> FakeProcess:
    """A spawn that has stopped working, for a host that was up when it did."""
    raise OSError("the environment was deleted")


# --- The helper's commands, one test per command -----------------------------------------


def test_a_restart_command_spawns_the_child_exactly_once_more(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])
    harness.supervisor.start_all()

    result = harness.supervisor.execute(Command(name=CommandName.RESTART, child_id="alpha"))

    assert harness.spawned_ids().count("alpha") == 2
    assert [record.id for record in result.children] == ["alpha"]
    assert [record.id for record in harness.supervisor.running()] == [MCP_CHILD_ID, "alpha"]


def test_a_kill_command_kills_the_child_without_a_polite_stop(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])
    harness.supervisor.start_all()
    process = harness.process_for("alpha")

    harness.supervisor.execute(Command(name=CommandName.KILL, child_id="alpha"))

    assert process.killed is True
    assert process.terminated is False
    assert [record.id for record in harness.supervisor.running()] == [MCP_CHILD_ID]
    assert harness.reports[-1] == ChildExit(
        id="alpha", kind=ChildKind.ADDON, pid=process.pid, exit_code=-9, expected=True
    )


def test_a_kill_command_kills_the_mcp_child_too(make_children: MakeChildren) -> None:
    """The Node child is killed through the supervisor that owns it, not around it."""
    harness = make_children()
    harness.supervisor.start(MCP_CHILD_ID)
    process = harness.process_for(MCP_CHILD_ID)

    harness.supervisor.execute(Command(name=CommandName.KILL, child_id=MCP_CHILD_ID))

    assert process.killed is True
    assert harness.supervisor.running() == ()
    # Its supervisor let go of it, so the helper's restart command can start it again.
    harness.supervisor.start(MCP_CHILD_ID)
    assert len(harness.spawns) == 2


def test_a_stop_command_stops_the_child_politely(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])
    harness.supervisor.start_all()
    process = harness.process_for("alpha")

    harness.supervisor.execute(Command(name=CommandName.STOP, child_id="alpha"))

    assert process.terminated is True
    assert process.killed is False
    assert harness.reports[-1].expected is True


def test_a_start_command_starts_a_child_that_is_not_running(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])
    harness.supervisor.start(MCP_CHILD_ID)

    result = harness.supervisor.execute(Command(name=CommandName.START, child_id="alpha"))

    assert [record.id for record in result.children] == ["alpha"]
    assert harness.spawned_ids() == [MCP_CHILD_ID, "alpha"]


def test_a_list_command_returns_every_live_child_with_its_identity(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=three_addons(tmp_path))
    started = harness.supervisor.start_all()
    harness.supervisor.execute(Command(name=CommandName.KILL, child_id="beta"))

    result = harness.supervisor.execute(Command(name=CommandName.LIST))

    assert result.name is CommandName.LIST
    assert [record.id for record in result.children] == [MCP_CHILD_ID, "alpha", "gamma"]
    # The identity, not just the name: the helper needs all three facts before it may signal.
    assert result.children == tuple(record for record in started if record.id != "beta")
    assert all(record.pid and record.started_at and record.executable for record in result.children)


def test_a_group_is_stopped_whole_before_any_of_it_is_started_again(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """A coordinated update stops the whole group first, or it runs new code against old."""
    harness = make_children(addons=three_addons(tmp_path))
    harness.supervisor.start_all()
    stopped_before_restart = [
        harness.process_for(child_id) for child_id in ("alpha", "beta", "gamma")
    ]

    result = harness.supervisor.execute(
        Command(name=CommandName.RESTART_GROUP, group=("gamma", "alpha", "beta"))
    )

    assert all(process.terminated for process in stopped_before_restart)
    # Started again in the resolver's order, not in the order the helper listed them.
    assert [record.id for record in result.children] == ["alpha", "beta", "gamma"]
    assert harness.spawned_ids() == [
        MCP_CHILD_ID,
        "alpha",
        "beta",
        "gamma",
        "alpha",
        "beta",
        "gamma",
    ]


def test_a_command_naming_a_child_this_host_does_not_have_is_refused(
    make_children: MakeChildren,
) -> None:
    harness = make_children()

    with pytest.raises(UnknownChildError, match="nonesuch"):
        harness.supervisor.execute(Command(name=CommandName.RESTART, child_id="nonesuch"))


def test_a_group_naming_a_child_this_host_does_not_have_is_refused(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """Refused whole: half a group restarted is worse than none of it."""
    harness = make_children(addons=three_addons(tmp_path))
    harness.supervisor.start_all()

    with pytest.raises(UnknownChildError, match="delta"):
        harness.supervisor.execute(
            Command(name=CommandName.RESTART_GROUP, group=("alpha", "delta"))
        )

    assert harness.spawned_ids() == [MCP_CHILD_ID, "alpha", "beta", "gamma"]


def test_a_command_that_names_no_child_at_all_is_refused(make_children: MakeChildren) -> None:
    harness = make_children()

    with pytest.raises(ChildError, match="names the child"):
        harness.supervisor.execute(Command(name=CommandName.STOP))


# --- The run-state file ------------------------------------------------------------------


def test_every_spawned_child_is_written_to_the_run_state_file(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """Process ID, start time and executable path — the three facts a safe kill needs."""
    addons = three_addons(tmp_path)
    harness = make_children(addons=addons)

    started = harness.supervisor.start_all()

    written = {record.id: record for record in harness.run_state.records()}
    assert set(written) == {MCP_CHILD_ID, "alpha", "beta", "gamma"}
    assert written == {record.id: record for record in started}

    alpha = written["alpha"]
    assert alpha.pid == harness.process_for("alpha").pid
    assert alpha.started_at == FIRST_TICK + TICK
    assert alpha.executable == str(addon_interpreter(addons[0].environment))
    assert alpha.parent_pid == written[MCP_CHILD_ID].parent_pid


def test_the_mcp_record_names_the_executable_that_was_launched(
    make_children: MakeChildren,
) -> None:
    harness = make_children()

    harness.supervisor.start(MCP_CHILD_ID)

    (record,) = harness.run_state.records()
    assert Path(record.executable).name == "npx"
    assert record.kind is ChildKind.MCP


def test_stopping_a_child_removes_its_record(make_children: MakeChildren, tmp_path: Path) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])
    harness.supervisor.start_all()

    harness.supervisor.execute(Command(name=CommandName.STOP, child_id="alpha"))

    assert [record.id for record in harness.run_state.records()] == [MCP_CHILD_ID]


def test_a_child_that_exits_on_its_own_loses_its_record_too(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """A record that outlives its process is the phantom the helper's check exists to catch."""
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))], exit_code=9)
    harness.supervisor.start_all()

    harness.supervisor.poll()

    assert harness.run_state.records() == ()


def test_a_record_written_by_another_process_is_left_alone(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """The helper writes the host's own record into this file; the host must not erase it."""
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])
    helpers_record = ChildRecord(
        id="innytypes",
        kind=ChildKind.HOST,
        pid=4_242,
        started_at=1.0,
        executable="/usr/bin/innytypes",
        parent_pid=4_240,
    )
    harness.run_state.write(helpers_record)

    harness.supervisor.start_all()
    harness.supervisor.shutdown()

    assert harness.run_state.records() == (helpers_record,)


def test_forgetting_a_record_that_was_never_written_changes_nothing(tmp_path: Path) -> None:
    run_state = RunStateFile(tmp_path / "run-state.json")
    kept = ChildRecord(
        id="alpha",
        kind=ChildKind.ADDON,
        pid=11,
        started_at=1.0,
        executable="/usr/bin/python",
        parent_pid=10,
    )
    run_state.write(kept)

    run_state.forget("never-existed")

    assert run_state.records() == (kept,)


def test_a_run_state_file_that_is_not_json_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "run-state.json"
    path.write_text("half a file, truncated by a crash", encoding="utf-8")

    with pytest.raises(RunStateError, match="not UTF-8 JSON"):
        RunStateFile(path).records()


def test_a_run_state_file_that_is_not_a_run_state_document_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "run-state.json"
    path.write_text('{"records": "all of them"}', encoding="utf-8")

    with pytest.raises(RunStateError, match="run-state document"):
        RunStateFile(path).records()


@pytest.mark.parametrize(
    ("record", "field"),
    [
        ('{"id": "alpha", "pid": 1}', "kind"),
        ('{"id": "alpha", "kind": "addon", "pid": "4242"}', "pid"),
        (
            '{"id": "alpha", "kind": "addon", "pid": 1, "started_at": "noon"}',
            "started_at",
        ),
        (
            '{"id": "alpha", "kind": "addon", "pid": 1, "started_at": 1.0, '
            '"executable": "/bin/sh", "parent_pid": true}',
            "parent_pid",
        ),
    ],
)
def test_a_malformed_record_is_refused_by_the_field_that_is_wrong(
    tmp_path: Path, record: str, field: str
) -> None:
    """Named by field, because the reader has to know which one to go and fix."""
    path = tmp_path / "run-state.json"
    path.write_text(f'{{"version": 1, "records": [{record}]}}', encoding="utf-8")

    with pytest.raises(RunStateError, match=f"`{field}`"):
        RunStateFile(path).records()


def test_reading_a_run_state_file_that_does_not_exist_yet_is_not_an_error(
    tmp_path: Path,
) -> None:
    assert RunStateFile(tmp_path / "nothing-here.json").records() == ()


# --- One file, two writers ---------------------------------------------------------------
#
# `os.replace` keeps this file from ever being read half-written. It does nothing at all
# about the other way two writers ruin it: each reads the same file, each adds its own
# record, each writes the whole thing back, and the one that writes second has no trace of
# the first one's record in what it wrote. That is what happened on the running application:
# immediately after startup the file held the host, the helper and the Anytype app but not
# the MCP child, while that child was running and serving.

# How many real processes hammer the file at once, and how many records each one adds. Small
# enough to cost a fraction of a second, large enough that no run without the lock survives
# it: every one of these writes reads the whole file first, so a single collision anywhere
# leaves one id missing from the end state for good.
CONCURRENT_WRITERS = 3
RECORDS_EACH = 40


def write_records_in_another_process(path: str, prefix: str, count: int, ready: object) -> None:
    """One of several **real** processes writing its own records into one run-state file.

    At module scope, and taking only picklable arguments, because the spawn start method
    starts the child by importing this module and looking the function up by name — a closure
    could not be started at all. That constraint is the point: nothing here is a stand-in for
    concurrency, it is two operating-system processes writing one file at the same moment.
    """
    from innytypes.children import ChildKind as Kind
    from innytypes.children import ChildRecord as Record
    from innytypes.children import RunStateFile as File

    run_state = File(Path(path))
    # Every writer waits here, so the writes overlap instead of queueing behind each other's
    # process startup — which on a spawn platform is much longer than the write itself.
    ready.wait()  # type: ignore[attr-defined]
    for index in range(count):
        run_state.write(
            Record(
                id=f"{prefix}-{index}",
                kind=Kind.ADDON,
                pid=1_000 + index,
                started_at=float(index),
                executable=f"/usr/bin/{prefix}",
                parent_pid=1,
            )
        )


def test_records_written_by_several_processes_at_once_are_all_still_there(
    tmp_path: Path,
) -> None:
    """The defect, driven by real concurrent writers rather than a simulation of them.

    Each process adds ids nobody else ever writes, so the end state is arithmetic: every id
    must be present. Without the lock a write that read the file before a sibling's write
    landed drops that sibling's record permanently, because nothing ever adds it again.
    """
    path = tmp_path / "run-state.json"
    context = multiprocessing.get_context("spawn")
    ready = context.Barrier(CONCURRENT_WRITERS)

    writers = [
        context.Process(
            target=write_records_in_another_process,
            args=(str(path), f"writer{number}", RECORDS_EACH, ready),
        )
        for number in range(CONCURRENT_WRITERS)
    ]
    for writer in writers:
        writer.start()
    for writer in writers:
        # Generous, and never reached: the work is a few hundred small writes. It is here so
        # a deadlock introduced by a future lock fails this test rather than hanging the gate.
        writer.join(timeout=60)

    assert [writer.exitcode for writer in writers] == [0] * CONCURRENT_WRITERS
    assert {record.id for record in RunStateFile(path).records()} == {
        f"writer{number}-{index}"
        for number in range(CONCURRENT_WRITERS)
        for index in range(RECORDS_EACH)
    }


def test_the_locked_write_keeps_the_files_format_exactly(tmp_path: Path) -> None:
    """A helper and a host of different versions still read each other's records.

    The lock is a sidecar file and changes nothing about what is written, which is what makes
    the fix safe to ship on one side of the pair before the other.
    """
    path = tmp_path / "run-state.json"
    record = ChildRecord(
        id="alpha",
        kind=ChildKind.ADDON,
        pid=11,
        started_at=1.0,
        executable="/usr/bin/python",
        parent_pid=10,
    )

    RunStateFile(path).write(record)

    document = json.loads(path.read_text(encoding="utf-8"))
    assert document == {"version": RUN_STATE_VERSION, "records": [record.to_document()]}
    # The lock lives beside the file, not inside it: a reader that knows nothing about it
    # reads exactly what it always read.
    assert (tmp_path / ".run-state.json.lock").exists()


def test_a_writer_that_cannot_take_the_lock_writes_anyway_and_says_so(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A lock nobody can take must not be able to hold up a startup.

    Held here exactly as the other process would hold it, on the same sidecar file through
    the same call. With no time to wait, the writer gives up, warns, and writes: a lost
    record is recoverable and a host that never comes up is not.
    """
    path = tmp_path / "run-state.json"
    record = ChildRecord(
        id="alpha",
        kind=ChildKind.ADDON,
        pid=11,
        started_at=1.0,
        executable="/usr/bin/python",
        parent_pid=10,
    )
    handle = os.open(tmp_path / ".run-state.json.lock", os.O_RDWR | os.O_CREAT, 0o600)
    assert _take_exclusive_lock(handle) is True

    try:
        with caplog.at_level(logging.WARNING, logger="innytypes.children"):
            RunStateFile(path, lock_timeout=0.0).write(record)
    finally:
        _release_exclusive_lock(handle)
        os.close(handle)

    assert RunStateFile(path).records() == (record,)
    assert "still held" in caplog.text


def test_the_lock_is_given_back_so_the_next_writer_can_have_it(tmp_path: Path) -> None:
    """Held for one read-modify-write and no longer, or the second write would be the last."""
    path = tmp_path / "run-state.json"
    run_state = RunStateFile(path, lock_timeout=0.0)
    for index in range(3):
        run_state.write(
            ChildRecord(
                id=f"alpha-{index}",
                kind=ChildKind.ADDON,
                pid=index,
                started_at=float(index),
                executable="/usr/bin/python",
                parent_pid=1,
            )
        )
    run_state.forget("alpha-1")

    # Nothing timed out, which it would have had the first write kept the lock: with no time
    # to wait, a writer that found the lock held would have written without it.
    handle = os.open(tmp_path / ".run-state.json.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        assert _take_exclusive_lock(handle) is True
    finally:
        _release_exclusive_lock(handle)
        os.close(handle)

    assert [record.id for record in run_state.records()] == ["alpha-0", "alpha-2"]


def test_a_writer_waits_for_a_held_lock_and_then_gets_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The ordinary contended case: the other writer is mid-write, so this one waits.

    The other writer finishes **exactly when this one starts waiting**, because that is the
    one moment a test can name without a timer: the wait itself is the signal. No real time
    passes, and the ordering cannot come out any other way on a loaded machine.
    """
    path = tmp_path / "run-state.json"
    record = ChildRecord(
        id="alpha",
        kind=ChildKind.ADDON,
        pid=11,
        started_at=1.0,
        executable="/usr/bin/python",
        parent_pid=10,
    )
    handle = os.open(tmp_path / ".run-state.json.lock", os.O_RDWR | os.O_CREAT, 0o600)
    assert _take_exclusive_lock(handle) is True
    waited: list[float] = []

    class TheOtherWriterFinishing:
        """A clock whose `sleep` is the other process letting go of the lock."""

        monotonic = staticmethod(time.monotonic)

        @staticmethod
        def sleep(seconds: float) -> None:
            waited.append(seconds)
            _release_exclusive_lock(handle)

    monkeypatch.setattr(children, "time", TheOtherWriterFinishing)
    try:
        with caplog.at_level(logging.WARNING, logger="innytypes.children"):
            RunStateFile(path).write(record)
    finally:
        os.close(handle)

    # It found the lock held, waited once, and took it on the next look.
    assert waited == [RUN_STATE_LOCK_POLL]
    assert RunStateFile(path).records() == (record,)
    # Taken rather than given up on: a writer that gave up says so, and this one had nothing
    # to say.
    assert "still held" not in caplog.text


def test_a_lock_file_that_cannot_be_opened_does_not_stop_the_write(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The sidecar is a convenience, never a precondition.

    A directory that is a file — or any other reason the lock cannot be opened — leaves the
    write to fail or succeed on its own terms, with the real path in the real message.
    """
    path = tmp_path / "run-state.json"
    run_state = RunStateFile(path)
    # A directory where the lock file has to go: opening it for writing fails, opening the
    # run-state file beside it does not.
    (tmp_path / ".run-state.json.lock").mkdir()

    with caplog.at_level(logging.WARNING, logger="innytypes.children"):
        run_state.write(
            ChildRecord(
                id="alpha",
                kind=ChildKind.ADDON,
                pid=11,
                started_at=1.0,
                executable="/usr/bin/python",
                parent_pid=10,
            )
        )

    assert [record.id for record in run_state.records()] == ["alpha"]
    assert "could not be opened" in caplog.text


# --- The Node MCP child is the anytype_mcp supervisor's, not a second copy of it ----------


def test_the_mcp_child_is_launched_with_the_pinned_argv(make_children: MakeChildren) -> None:
    """The argv reaching the injected spawn is the one `innytypes.anytype_mcp` builds."""
    harness = make_children()

    harness.supervisor.start(MCP_CHILD_ID)

    argv, env = harness.spawns[0]
    assert argv == ["npx", "-y", f"{PACKAGE_NAME}@{PACKAGE_VERSION}"]
    # Its environment is the supervisor's too — the credential goes through that module alone.
    assert "OPENAPI_MCP_HEADERS" in env


def test_the_mcp_child_is_stopped_through_its_own_supervisor(
    make_children: MakeChildren,
) -> None:
    harness = make_children()
    harness.supervisor.start(MCP_CHILD_ID)
    process = harness.process_for(MCP_CHILD_ID)

    harness.supervisor.execute(Command(name=CommandName.STOP, child_id=MCP_CHILD_ID))

    assert process.terminated is True
    # The MCP supervisor's own state went with it, so it can be started again.
    harness.supervisor.start(MCP_CHILD_ID)
    assert len(harness.spawns) == 2


# --- Addons start in the resolver's order ------------------------------------------------


def test_addon_children_start_in_the_resolvers_order(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """Handed to the host backwards; started in the order the resolver computes."""
    harness = make_children(addons=list(reversed(three_addons(tmp_path))))

    harness.supervisor.start_all()

    assert harness.spawned_ids() == [MCP_CHILD_ID, "alpha", "beta", "gamma"]
    assert harness.supervisor.start_order == (MCP_CHILD_ID, "alpha", "beta", "gamma")


def test_an_addon_the_resolver_holds_back_is_never_spawned(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """Degradation, not a crash: the rest of the host starts without it."""
    harness = make_children(
        addons=[
            installed(tmp_path, manifest("alpha")),
            installed(tmp_path, manifest("lonely", requires=["absent==1.0.0"])),
        ]
    )

    harness.supervisor.start_all()

    assert harness.spawned_ids() == [MCP_CHILD_ID, "alpha"]
    assert [held.id for held in harness.supervisor.held_back] == ["lonely"]
    with pytest.raises(UnknownChildError):
        harness.supervisor.execute(Command(name=CommandName.START, child_id="lonely"))


def test_an_addon_is_launched_by_its_own_interpreter_running_the_host_runner(
    tmp_path: Path,
) -> None:
    addon = installed(tmp_path, manifest("alpha"))

    interpreter = addon_interpreter(addon.environment)
    # Its own environment's interpreter, never the host's: an addon's dependencies must not be
    # able to break the host's.
    assert interpreter.is_relative_to(addon.environment)
    assert addon_command(addon) == (str(interpreter), "-m", ADDON_RUNNER_MODULE, "alpha")


def test_every_addon_is_told_where_its_own_per_user_files_are(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """Plan 0012, slice 01: the addon does not go looking, because it cannot.

    An addon environment holds no third-party library, so the process that needs its settings
    path is the one process that cannot resolve one. The host can, has already validated the
    values in that file, and is what spawns the process — so it puts both locations in the
    environment the child inherits, bound to that child's own id.
    """
    harness = make_children(addons=three_addons(tmp_path))

    harness.supervisor.start_all()

    told = {argv[-1]: env for argv, env in harness.spawns if argv[0] != "npx"}
    assert sorted(told) == ["alpha", "beta", "gamma"]

    for addon_id, env in told.items():
        assert env[SETTINGS_PATH_VARIABLE] == str(
            tmp_path / "config" / "plugins" / f"{addon_id}.toml"
        )
        assert env[SECRETS_ROOT_VARIABLE] == str(tmp_path / "config" / "secrets")
        # The rest of the environment is still the host's, so this is an addition and not a
        # replacement of what a child inherits.
        assert env["PATH"] == "/nonexistent"

    # Bound to one addon each: no child is told where another child's settings are.
    settings_files = {env[SETTINGS_PATH_VARIABLE] for env in told.values()}
    assert len(settings_files) == len(told)


def test_what_the_host_tells_an_addon_is_this_users_own_files() -> None:
    """The production seam, which every test above replaces with a directory of its own.

    Resolved rather than spelled out again: one answer to \"where does innytypes keep a
    plugin's settings\", and the runner reads exactly these two variables.
    """
    told = default_addon_locations("monty")

    assert Path(told[SETTINGS_PATH_VARIABLE]) == default_settings_path("monty")
    assert Path(told[SECRETS_ROOT_VARIABLE]) == default_secrets_root()


def test_starting_a_child_that_is_already_running_is_refused(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])
    harness.supervisor.start_all()

    with pytest.raises(ChildError, match="already running"):
        harness.supervisor.execute(Command(name=CommandName.START, child_id="alpha"))


# --- Shutdown leaves no orphan -----------------------------------------------------------


def test_shutdown_stops_every_running_child(make_children: MakeChildren, tmp_path: Path) -> None:
    harness = make_children(addons=three_addons(tmp_path))
    harness.supervisor.start_all()
    processes = [harness.processes[record.pid] for record in harness.supervisor.running()]

    harness.supervisor.shutdown()

    assert all(process.terminated for process in processes)
    assert harness.supervisor.running() == ()
    assert harness.run_state.records() == ()
    assert len(harness.reports) == len(processes)
    assert all(report.expected for report in harness.reports)


def test_a_child_that_ignores_terminate_is_killed(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))], ignores_terminate=True)
    harness.supervisor.start_all()
    stubborn = harness.process_for("alpha")

    harness.supervisor.shutdown()

    assert stubborn.terminated is True
    assert stubborn.killed is True
    assert harness.supervisor.running() == ()


def test_shutdown_stops_children_in_reverse_start_order(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """A subscriber goes before the publisher it reads, so nothing outlives what it needs."""
    harness = make_children(addons=three_addons(tmp_path))
    harness.supervisor.start_all()

    harness.supervisor.shutdown()

    assert [report.id for report in harness.reports] == [
        "gamma",
        "beta",
        "alpha",
        MCP_CHILD_ID,
    ]


def test_shutting_down_twice_stops_nothing_the_second_time(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])
    harness.supervisor.start_all()

    harness.supervisor.shutdown()
    reported = len(harness.reports)
    harness.supervisor.shutdown()

    assert len(harness.reports) == reported


def test_stopping_a_child_that_has_already_died_signals_nothing(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """A dead child is reported and forgotten; nothing is signalled at its process ID."""
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))], exit_code=5)
    harness.supervisor.start_all()
    process = harness.process_for("alpha")

    assert harness.supervisor.stop("alpha") == 5

    assert process.terminated is False
    assert process.killed is False
    assert harness.reports[-1].exit_code == 5


def test_stopping_a_child_that_is_not_running_is_not_an_error(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    harness = make_children(addons=[installed(tmp_path, manifest("alpha"))])

    assert harness.supervisor.stop("alpha") is None
    assert harness.supervisor.kill("alpha") is None
    assert harness.reports == []


# --- Nor does it leave a grandchild -------------------------------------------------------
#
# The host tracks `npx exec @anyproto/anytype-mcp`. What actually serves MCP is the `node`
# process underneath it, and on the running application that one survived the stop, was
# reparented to launchd, ignored a polite stop and had to be killed by hand. `shutdown`'s own
# docstring says a child the host leaves running is a child nothing owns, holding a socket
# the next host will try to open — and a grandchild is exactly that child.


@dataclass
class FakeProcessTree:
    """A process tree that answers from a script and records what it was asked to do.

    ``witness`` is read at the moment the descendants are asked for, which is the whole of
    what this fix is about: asked after the tracked process is gone, the answer is empty,
    because an orphan's parent is init and nothing connects it to this host any more.
    """

    beneath: dict[int, tuple[Descendant, ...]] = field(default_factory=dict)
    survivors: tuple[Descendant, ...] = ()
    witness: FakeProcess | None = None
    read_for: list[int] = field(default_factory=list)
    alive_when_read: list[bool] = field(default_factory=list)
    stopped: list[Descendant] = field(default_factory=list)
    timeouts: list[float] = field(default_factory=list)

    def descendants(self, record: ChildRecord) -> tuple[Descendant, ...]:
        self.read_for.append(record.pid)
        if self.witness is not None:
            self.alive_when_read.append(self.witness.poll() is None)
        return self.beneath.get(record.pid, ())

    def stop(self, descendants: Sequence[Descendant], *, timeout: float) -> tuple[Descendant, ...]:
        self.stopped.extend(descendants)
        self.timeouts.append(timeout)
        return self.survivors


class FakeTreeProcess:
    """Enough of a ``psutil.Process`` to drive the whole sweep with nothing to kill."""

    def __init__(
        self,
        pid: int,
        *,
        started_at: float = 0.0,
        executable: str = "/usr/local/bin/node",
        parent: int = 0,
        children: Sequence[FakeTreeProcess] = (),
        ignores_terminate: bool = False,
    ) -> None:
        self.pid = pid
        self.started_at = started_at
        self.executable = executable
        self.parent = parent
        self._children = tuple(children)
        self.ignores_terminate = ignores_terminate
        self.terminated = False
        self.killed = False

    def create_time(self) -> float:
        return self.started_at

    def exe(self) -> str:
        return self.executable

    def ppid(self) -> int:
        return self.parent

    def children(self, recursive: bool = False) -> Sequence[FakeTreeProcess]:
        assert recursive is True, "a grandchild is a descendant; only a recursive walk sees it"
        return self._children

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True


def tree_of(*processes: FakeTreeProcess) -> SystemProcessTree:
    """A real :class:`SystemProcessTree` reading a process table a test wrote out.

    The class under test, with only the two calls that touch the machine replaced — the same
    shape `innytypes.helper.processes` uses to assert the identity rule without a process.
    """
    table = {process.pid: process for process in processes}
    waits: list[float] = []

    def lookup(pid: int) -> FakeTreeProcess | None:
        return table.get(pid)

    def wait(watched: Sequence[FakeTreeProcess], timeout: float) -> Sequence[FakeTreeProcess]:
        waits.append(timeout)
        return [process for process in watched if process.ignores_terminate and not process.killed]

    made = SystemProcessTree(lookup=lookup, wait=wait)  # type: ignore[arg-type]
    made.waits = waits  # type: ignore[attr-defined]
    return made


def a_child_record(pid: int, *, started_at: float = 0.0, parent: int = 7) -> ChildRecord:
    """The MCP child's record, as the host wrote it."""
    return ChildRecord(
        id=MCP_CHILD_ID,
        kind=ChildKind.MCP,
        pid=pid,
        started_at=started_at,
        executable="/usr/local/bin/node",
        parent_pid=parent,
    )


def test_stopping_a_child_ends_everything_running_beneath_it(
    make_children: MakeChildren,
) -> None:
    """The whole group goes, not only the process the host holds a handle to."""
    node = Descendant(pid=51, started_at=5.0)
    grandchild = Descendant(pid=52, started_at=6.0)
    tree = FakeProcessTree()
    harness = make_children(process_tree=tree)
    harness.supervisor.start(MCP_CHILD_ID)
    tracked = harness.process_for(MCP_CHILD_ID)
    tree.witness = tracked
    tree.beneath[tracked.pid] = (node, grandchild)

    harness.supervisor.execute(Command(name=CommandName.STOP, child_id=MCP_CHILD_ID))

    assert tracked.terminated is True
    assert tree.stopped == [node, grandchild]
    # Read while the tracked process was still alive. Afterwards the link is gone: its
    # children have been reparented, and nothing ties them to this host any more.
    assert tree.alive_when_read == [True]
    # The timeout a descendant gets is the one the host already gives a child it stops, so a
    # stubborn grandchild cannot outlive the shutdown that is waiting for it.
    assert tree.timeouts == [5.0]


def test_killing_a_child_ends_everything_running_beneath_it_too(
    make_children: MakeChildren,
) -> None:
    """`kill` is the forced path, and a forced stop that leaves a grandchild is not forced."""
    node = Descendant(pid=51, started_at=5.0)
    tree = FakeProcessTree()
    harness = make_children(process_tree=tree)
    harness.supervisor.start(MCP_CHILD_ID)
    tracked = harness.process_for(MCP_CHILD_ID)
    tree.witness = tracked
    tree.beneath[tracked.pid] = (node,)

    harness.supervisor.execute(Command(name=CommandName.KILL, child_id=MCP_CHILD_ID))

    assert tracked.killed is True
    assert tree.stopped == [node]
    assert tree.alive_when_read == [True]


def test_shutdown_ends_what_is_beneath_every_child(
    make_children: MakeChildren, tmp_path: Path
) -> None:
    """Plan 0001's promise, kept for the processes the host never had a handle to."""
    tree = FakeProcessTree()
    harness = make_children(addons=three_addons(tmp_path), process_tree=tree)
    harness.supervisor.start_all()
    beneath = {
        record.pid: Descendant(pid=record.pid + 500, started_at=float(record.pid))
        for record in harness.supervisor.running()
    }
    tree.beneath.update({pid: (descendant,) for pid, descendant in beneath.items()})

    harness.supervisor.shutdown()

    assert sorted(descendant.pid for descendant in tree.stopped) == sorted(
        descendant.pid for descendant in beneath.values()
    )


def test_a_child_with_nothing_beneath_it_asks_for_no_sweep(
    make_children: MakeChildren,
) -> None:
    """The ordinary case costs one question and no signals at all."""
    tree = FakeProcessTree()
    harness = make_children(process_tree=tree)
    harness.supervisor.start(MCP_CHILD_ID)
    tracked = harness.process_for(MCP_CHILD_ID)

    harness.supervisor.stop(MCP_CHILD_ID)

    assert tree.read_for == [tracked.pid]
    assert tree.stopped == []
    assert tree.timeouts == []


def test_a_descendant_that_survives_a_forced_kill_is_named(
    make_children: MakeChildren, caplog: pytest.LogCaptureFixture
) -> None:
    """A process that outlives a kill is a fact about this machine, and hiding it is worse.

    The host's own child has stopped, so the stop succeeds: a shutdown that refused to finish
    because one grandchild would not die is a shutdown the user cannot rely on.
    """
    stubborn = Descendant(pid=51, started_at=5.0)
    tree = FakeProcessTree(survivors=(stubborn,))
    harness = make_children(process_tree=tree)
    harness.supervisor.start(MCP_CHILD_ID)
    tree.beneath[harness.process_for(MCP_CHILD_ID).pid] = (stubborn,)

    with caplog.at_level(logging.ERROR, logger="innytypes.children"):
        harness.supervisor.stop(MCP_CHILD_ID)

    assert "still running beneath" in caplog.text
    assert "51" in caplog.text
    assert harness.supervisor.running() == ()


def test_a_host_sweeps_the_real_process_tree_unless_it_is_told_otherwise(
    make_children: MakeChildren,
) -> None:
    """The assembly, not the seam: a fix nothing wires up is a fix that never runs.

    Reaching into the supervisor because there is nothing else to look at — the whole claim
    is about what a host that was handed no tree at all does, and the alternative would be to
    let a real grandchild be the assertion.
    """
    harness = make_children()

    assert isinstance(harness.supervisor._process_tree, SystemProcessTree)


# --- The real sweep: read the tree, stop it, escalate, report ----------------------------


def test_the_descendants_of_a_child_are_read_recursively() -> None:
    """A plugin that forks a process that forks ten more has eleven descendants, not one."""
    grandchild = FakeTreeProcess(pid=52, started_at=6.0)
    node = FakeTreeProcess(pid=51, started_at=5.0)
    npx = FakeTreeProcess(pid=50, started_at=1.0, parent=7, children=(node, grandchild))

    found = tree_of(npx, node, grandchild).descendants(a_child_record(50, started_at=1.0))

    assert found == (Descendant(pid=51, started_at=5.0), Descendant(pid=52, started_at=6.0))


def test_a_start_time_within_the_tolerance_is_still_the_recorded_child() -> None:
    """The record's clock and the OS's are read a spawn apart, so they never match exactly."""
    node = FakeTreeProcess(pid=51, started_at=5.0)
    npx = FakeTreeProcess(pid=50, started_at=1.4, parent=7, children=(node,))

    found = tree_of(npx, node).descendants(a_child_record(50, started_at=1.0))

    assert found == (Descendant(pid=51, started_at=5.0),)


@pytest.mark.parametrize(
    ("process", "why"),
    [
        (FakeTreeProcess(pid=50, started_at=900.0, parent=7), "started at another moment"),
        (
            FakeTreeProcess(pid=50, started_at=1.0, parent=7, executable="/bin/somebody-else"),
            "a different program",
        ),
        (FakeTreeProcess(pid=50, started_at=1.0, parent=4_242), "somebody else's child"),
    ],
)
def test_nothing_is_read_beneath_a_process_that_is_not_the_recorded_child(
    process: FakeTreeProcess, why: str
) -> None:
    """The rule the helper applies before every signal, applied one level up.

    A process ID that now means something else has descendants, and they belong to whoever
    owns it. Reading them would be the first step towards signalling them.
    """
    process._children = (FakeTreeProcess(pid=51, started_at=5.0),)

    assert tree_of(process).descendants(a_child_record(50, started_at=1.0)) == ()


def test_nothing_is_read_beneath_a_process_the_table_will_not_describe() -> None:
    """No such process, a zombie, or one we may not look at: all three sweep nothing."""
    assert tree_of().descendants(a_child_record(50)) == ()


def test_every_descendant_is_asked_politely_first() -> None:
    node = FakeTreeProcess(pid=51, started_at=5.0)
    grandchild = FakeTreeProcess(pid=52, started_at=6.0)
    tree = tree_of(node, grandchild)

    survivors = tree.stop(
        (Descendant(pid=51, started_at=5.0), Descendant(pid=52, started_at=6.0)), timeout=5.0
    )

    assert (node.terminated, node.killed) == (True, False)
    assert (grandchild.terminated, grandchild.killed) == (True, False)
    assert survivors == ()
    # One wait, bounded by the timeout the host already uses for a child it stops.
    assert tree.waits == [5.0]  # type: ignore[attr-defined]


def test_a_descendant_that_ignores_the_polite_stop_is_killed_within_the_timeout() -> None:
    """The `node` process on the day this was written: it ignored a polite stop.

    Both waits are bounded by the host's existing stop timeout, so a grandchild cannot make
    a shutdown take longer than the child it was hiding under already could.
    """
    node = FakeTreeProcess(pid=51, started_at=5.0, ignores_terminate=True)
    tree = tree_of(node)

    survivors = tree.stop((Descendant(pid=51, started_at=5.0),), timeout=5.0)

    assert (node.terminated, node.killed) == (True, True)
    assert survivors == ()
    assert tree.waits == [5.0, 5.0]  # type: ignore[attr-defined]


def test_a_descendant_that_survives_the_kill_comes_back_as_a_survivor() -> None:
    """Reported rather than retried forever, so the caller can say it out loud."""

    class Unkillable(FakeTreeProcess):
        def kill(self) -> None:
            self.killed = False

    node = Unkillable(pid=51, started_at=5.0, ignores_terminate=True)

    assert tree_of(node).stop((Descendant(pid=51, started_at=5.0),), timeout=5.0) == (
        Descendant(pid=51, started_at=5.0),
    )


def test_a_descendant_whose_process_id_was_reused_is_never_signalled() -> None:
    """Between the reading and the signalling, an ID can come to mean somebody else."""
    somebody_else = FakeTreeProcess(pid=51, started_at=900.0)

    survivors = tree_of(somebody_else).stop((Descendant(pid=51, started_at=5.0),), timeout=5.0)

    assert (somebody_else.terminated, somebody_else.killed) == (False, False)
    assert survivors == ()


def test_a_descendant_that_has_already_gone_is_not_waited_for() -> None:
    """Nothing left to end is a finished sweep, not an empty wait."""
    tree = tree_of()

    assert tree.stop((Descendant(pid=51, started_at=5.0),), timeout=5.0) == ()
    assert tree.waits == []  # type: ignore[attr-defined]


class VanishingProcess(FakeTreeProcess):
    """A process that goes away between being looked at and being acted on.

    The commonest thing that happens during a sweep, and the one that must not become an
    exception out of a shutdown: by the time the host gets to a grandchild, the child it
    hung off has already been terminated and taken it with it.
    """

    def create_time(self) -> float:
        raise OSError("this process is gone")

    def exe(self) -> str:
        raise OSError("this process is gone")

    def children(self, recursive: bool = False) -> Sequence[FakeTreeProcess]:
        raise OSError("this process is gone")

    def terminate(self) -> None:
        raise OSError("this process is gone")

    def kill(self) -> None:
        raise OSError("this process is gone")


def test_a_child_that_vanishes_while_its_tree_is_read_sweeps_nothing() -> None:
    vanishing = VanishingProcess(pid=50)

    assert tree_of(vanishing).descendants(a_child_record(50)) == ()


def test_a_child_whose_tree_vanishes_mid_walk_sweeps_nothing() -> None:
    """The identity check passed; the process went away before its children were read."""

    class GoneAfterVerifying(FakeTreeProcess):
        def children(self, recursive: bool = False) -> Sequence[FakeTreeProcess]:
            raise OSError("this process is gone")

    gone = GoneAfterVerifying(pid=50, started_at=1.0, parent=7)

    assert tree_of(gone).descendants(a_child_record(50, started_at=1.0)) == ()


def test_a_descendant_that_vanishes_before_it_is_signalled_is_a_finished_sweep() -> None:
    vanishing = VanishingProcess(pid=51)

    assert tree_of(vanishing).stop((Descendant(pid=51, started_at=5.0),), timeout=5.0) == ()


def test_a_descendant_that_goes_as_it_is_signalled_does_not_break_the_sweep() -> None:
    """The window between looking at a process and signalling it is real, and it is normal.

    Its parent has just been terminated and took it with it. Raising out of here would turn
    an ordinary shutdown into an exception out of :meth:`ChildSupervisor.stop`.
    """

    class GoneAtTheSignal(FakeTreeProcess):
        def terminate(self) -> None:
            raise OSError("this process is gone")

    node = GoneAtTheSignal(pid=51, started_at=5.0)
    sibling = FakeTreeProcess(pid=52, started_at=6.0)

    survivors = tree_of(node, sibling).stop(
        (Descendant(pid=51, started_at=5.0), Descendant(pid=52, started_at=6.0)), timeout=5.0
    )

    assert survivors == ()
    # The rest of the sweep still happened: one process refusing a signal must not stop the
    # next one from being asked.
    assert sibling.terminated is True


# --- The real process table, asked about this very interpreter and nothing else ----------


def test_the_real_process_lookup_describes_this_process() -> None:
    """The production seam, on the one process this suite is allowed to know about."""
    process = _psutil_process(os.getpid())

    assert process is not None
    assert process.pid == os.getpid()
    assert Path(process.exe()).is_file()
    assert process.ppid() > 0


def test_the_real_process_lookup_refuses_a_process_id_that_names_a_group() -> None:
    """On POSIX 0 and negatives address process *groups*, and `psutil` would answer for one."""
    assert _psutil_process(0) is None
    assert _psutil_process(-1) is None


def test_the_real_process_lookup_says_nothing_about_a_process_that_is_not_there() -> None:
    # Above every process ID this platform hands out, so it names nothing on any machine.
    assert _psutil_process(2**30) is None


# --- The whole thing, against real processes ---------------------------------------------
#
# Everything above drives the sweep through stand-ins, which is what lets it assert the
# escalation without a process to kill. This one is the defect itself: a child that starts a
# child, stopped through the host, with the grandchild's process ID looked up in the real
# process table afterwards. No Node, no Anytype, no socket, no port and no fixed path — just
# this interpreter, twice, exactly as `npx` is this machine's Node, twice.

# A child that starts a child and then does nothing, which is all `npx exec` is. The sleeps
# are long because nothing ever waits for them: both processes are stopped by the test.
CHILD_THAT_STARTS_A_CHILD = (
    "import subprocess, sys, time\n"
    "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])\n"
    "time.sleep(600)\n"
)


def the_grandchild_of(pid: int) -> int:
    """The process ID beneath ``pid``, once there is one. Waits on the fact, not the clock."""
    import psutil

    parent = psutil.Process(pid)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        beneath = parent.children(recursive=True)
        if beneath:
            return int(beneath[0].pid)
        time.sleep(0.005)
    raise AssertionError(f"process {pid} never started a child, so there is nothing to sweep")


def still_running(pid: int) -> bool:
    """Whether that process ID still names a process that has not exited."""
    import psutil

    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except (psutil.Error, OSError):
        return False


def test_stopping_a_real_child_leaves_no_real_grandchild(tmp_path: Path) -> None:
    """The whole group is gone, not only the process the host holds a handle to."""
    import psutil

    def spawn(
        argv: Sequence[str], env: dict[str, str], *, channel: int | None = None
    ) -> subprocess.Popen[bytes]:
        # The addon's real argv names an interpreter that was never installed; what is being
        # asserted is the stop, so this launches the one interpreter that is certainly here.
        return subprocess.Popen(
            [sys.executable, "-c", CHILD_THAT_STARTS_A_CHILD],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    supervisor = ChildSupervisor(
        mcp=None,
        addons=[installed(tmp_path, manifest("alpha"))],
        run_state=RunStateFile(tmp_path / "run-state.json"),
        report_exit=lambda _exit: None,
        report_start_failure=lambda _failure: None,
        spawn=spawn,
        # The real clock, the real process image and the real process tree: this test is
        # about what the production defaults do to real processes.
    )
    record = supervisor.start("alpha")
    grandchild = the_grandchild_of(record.pid)
    assert grandchild != record.pid

    supervisor.stop("alpha")
    left_behind = [pid for pid in (record.pid, grandchild) if still_running(pid)]

    # Cleaned up before the assertion, so a failure reports a leak rather than causing one.
    for pid in left_behind:
        with contextlib.suppress(psutil.Error, OSError):
            psutil.Process(pid).kill()

    assert left_behind == []


def test_the_real_wait_answers_at_once_when_there_is_nothing_to_wait_for() -> None:
    """Nothing to wait for costs no time at all, which is what keeps a shutdown bounded."""
    assert list(_psutil_wait((), 5.0)) == []


def test_the_real_wait_answers_with_what_is_still_running() -> None:
    """The half of ``wait_procs`` this application acts on: the ones that did **not** go.

    Asked about this very interpreter, with no time to wait, and nothing is signalled — so
    the answer is this process, still here.
    """
    this_process = _psutil_process(os.getpid())
    assert this_process is not None

    assert [process.pid for process in _psutil_wait([this_process], 0.0)] == [os.getpid()]
