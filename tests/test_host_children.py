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

import subprocess
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import pytest

from conftest import FAKE_KEY
from innytypes import HOST_API_VERSION
from innytypes.addons.discovery import ENVIRONMENT_DIRNAME, MANIFEST_FILENAME, InstalledAddon
from innytypes.addons.manifest import AddonManifest, parse_manifest
from innytypes.anytype_mcp.config import PACKAGE_NAME, PACKAGE_VERSION, ServerConfig
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.children import (
    ADDON_RUNNER_MODULE,
    MCP_CHILD_ID,
    ChildError,
    ChildExit,
    ChildKind,
    ChildRecord,
    ChildSupervisor,
    Command,
    CommandName,
    RunStateError,
    RunStateFile,
    UnknownChildError,
    addon_command,
    addon_interpreter,
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
    ) -> ChildrenHarness:
        spawns: list[tuple[list[str], dict[str, str]]] = []
        reports: list[ChildExit] = []
        processes: dict[int, FakeProcess] = {}

        def handle(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200)

        client = httpx.Client(transport=httpx.MockTransport(handle))
        clients.append(client)

        def spawn(argv: Sequence[str], env: dict[str, str]) -> FakeProcess:
            spawns.append((list(argv), dict(env)))
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
            spawn=spawn,
            clock=FakeClock(),
            # An environment of its own, so nothing here depends on the shell the gate runs in.
            environment={"PATH": "/nonexistent"},
        )
        return ChildrenHarness(supervisor, run_state, spawns, reports, processes)

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
