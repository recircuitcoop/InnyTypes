"""The host bringing up the MCP server as a core child — and carrying on when it cannot.

Two of the three behaviours here are **degradations**, and a degradation is the easiest
thing in the world to "pass" without writing any code: a host that never had a failure path
looks exactly like one whose failure path works. So each is staged from the real cause — a
key that genuinely is not on this machine, a health check that genuinely refuses — and each
test asserts *both* halves: nothing raised, and the host reached its running state with the
reason recorded.

Nothing here needs Node, a running Anytype, a process or a socket. The spawn records its
arguments, the health client answers through ``httpx.MockTransport``, the clock counts
instead of passing, and the run-state file lives under ``tmp_path``.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType

import httpx
import pytest

from conftest import FAKE_KEY
from innytypes import HOST_API_VERSION
from innytypes.addons.discovery import ENVIRONMENT_DIRNAME, MANIFEST_FILENAME
from innytypes.anytype_mcp.config import (
    ANYTYPE_VERSION,
    API_KEY_ENV_VAR,
    DEFAULT_API_BASE_URL,
    PACKAGE_NAME,
    PACKAGE_VERSION,
    load_config,
)
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.anytype_mcp.tools import load_tool_surface
from innytypes.children import MCP_CHILD_ID, ChildExit, ChildKind, RunStateFile
from innytypes.host import (
    AnytypeTools,
    Host,
    _log_child_exit,
    anytype_tools,
    build_host,
    default_mcp_supervisor,
)

# The pinned argv the MCP child must be launched with, spelled from the constants rather
# than copied, so a bump moves this line with the rest of the repository.
PINNED_ARGV = ["npx", "-y", f"{PACKAGE_NAME}@{PACKAGE_VERSION}"]

# A clock that counts instead of passing, so a start time is a fact rather than "now".
FIRST_TICK = 1_700_000_000.0


class FakeProcess:
    """Enough of a ``Popen`` to be started, stopped and asked how it ended."""

    def __init__(self, pid: int) -> None:
        self.pid = pid
        # Named as ``Popen`` names it: the MCP supervisor reads this when it reports an exit.
        self.returncode: int | None = None
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


@dataclass
class HostHarness:
    """A host wired to fakes, plus everything a test needs to assert about it."""

    host: Host
    run_state: RunStateFile
    # The (argv, environment) of every spawn attempted, in order — the MCP child's and the
    # addons' both, because one recording spawn is given to the whole host.
    spawns: list[tuple[list[str], dict[str, str]]] = field(default_factory=list)
    processes: dict[int, FakeProcess] = field(default_factory=dict)

    def spawned_ids(self) -> list[str]:
        """What was spawned, in order, by the id in each argv."""
        return [MCP_CHILD_ID if argv[0] == "npx" else argv[-1] for argv, _env in self.spawns]

    def process_for(self, child_id: str) -> FakeProcess:
        """The fake process behind one live child."""
        record = next(record for record in self.host.children.running() if record.id == child_id)
        return self.processes[record.pid]


def record_addon(root: Path, addon_id: str) -> Path:
    """One installed addon on disk, exactly as discovery expects to find it.

    Written out rather than hand-built as an :class:`InstalledAddon`, so the host's real
    path — discover, resolve, start — is the one under test. Nothing is installed: this is
    what `innytypes addons install` will have left behind (plan 0001 slice 08).
    """
    addon_root = root / addon_id
    (addon_root / ENVIRONMENT_DIRNAME).mkdir(parents=True)
    (addon_root / MANIFEST_FILENAME).write_text(
        json.dumps(
            {
                "id": addon_id,
                "version": "1.0.0",
                "host_api": HOST_API_VERSION,
                "requires": [],
                "emits": [],
                "subscribes": [],
            }
        ),
        encoding="utf-8",
    )
    return addon_root


MakeHost = Callable[..., HostHarness]


@pytest.fixture
def make_host(tmp_path: Path) -> Iterator[MakeHost]:
    """Build hosts that spawn nothing, open no socket and write only under ``tmp_path``."""
    clients: list[httpx.Client] = []

    def _make(
        *,
        key: str | None = FAKE_KEY,
        reachable: bool = True,
        addons: Sequence[str] = (),
    ) -> HostHarness:
        spawns: list[tuple[list[str], dict[str, str]]] = []
        processes: dict[int, FakeProcess] = {}
        exits: list[ChildExit] = []

        def handle(request: httpx.Request) -> httpx.Response:
            if not reachable:
                raise httpx.ConnectError("connection refused", request=request)
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
            # Process IDs that could not collide with this test runner's own.
            process = FakeProcess(pid=80_000 + len(spawns))
            processes[process.pid] = process
            return process

        def mcp() -> Supervisor:
            # The real key lookup, against an environment and a key file this test owns.
            # `key=None` therefore fails the way a machine with no key fails, in
            # `load_config`, rather than by a hand-raised error nothing else would produce.
            environment = {} if key is None else {API_KEY_ENV_VAR: key}
            return Supervisor(
                config=load_config(env=environment, key_file=tmp_path / "absent-key"),
                spawn=spawn,  # type: ignore[arg-type]
                health_client=client,
            )

        addons_root = tmp_path / "addons"
        addons_root.mkdir(exist_ok=True)
        for addon_id in addons:
            record_addon(addons_root, addon_id)

        run_state = RunStateFile(tmp_path / "run-state.json")
        ticks = iter(FIRST_TICK + step for step in range(1_000))
        host = build_host(
            addons_root=addons_root,
            mcp=mcp,
            spawn=spawn,
            run_state=run_state,
            report_exit=exits.append,
            clock=lambda: next(ticks),
            # An environment of its own, so nothing here depends on the shell the gate runs in.
            environment={"PATH": "/nonexistent"},
        )
        return HostHarness(host, run_state, spawns, processes)

    yield _make

    for client in clients:
        client.close()


def test_a_key_and_a_reachable_api_spawn_exactly_one_mcp_child(make_host: MakeHost) -> None:
    """The ordinary day: one MCP child, launched with the pinned argv, and nothing missing."""
    harness = make_host()

    report = harness.host.start()

    assert harness.spawned_ids() == [MCP_CHILD_ID]
    argv, _env = harness.spawns[0]
    assert argv == PINNED_ARGV
    assert [record.id for record in report.started] == [MCP_CHILD_ID]
    assert report.started[0].kind is ChildKind.MCP
    assert report.is_complete
    assert harness.host.is_running


def test_a_missing_key_is_reported_and_the_host_still_runs(make_host: MakeHost) -> None:
    """No key: the host has no MCP child at all, says why, and reaches its running state."""
    harness = make_host(key=None)

    report = harness.host.start()

    # Both halves of the acceptance line, in one test: it did not raise (we are here), and
    # the host is running.
    assert harness.host.is_running
    assert [degraded.component for degraded in report.degraded] == [MCP_CHILD_ID]
    assert API_KEY_ENV_VAR in report.degraded[0].reason
    assert not report.is_complete

    # Nothing was launched, and there is no MCP child to command: "this host has none" is a
    # different answer from "it is there and it failed", and the helper needs the true one.
    assert harness.spawns == []
    assert MCP_CHILD_ID not in harness.host.children.start_order


def test_an_unreachable_anytype_is_reported_and_the_host_still_runs(make_host: MakeHost) -> None:
    """Anytype not running: the health gate refuses, the host records it and carries on."""
    harness = make_host(reachable=False)

    report = harness.host.start()

    assert harness.host.is_running
    assert [degraded.component for degraded in report.degraded] == [MCP_CHILD_ID]
    # The reason names the URL that did not answer, which is what tells a user whether to
    # start the desktop app or fix ANYTYPE_API_BASE_URL.
    assert DEFAULT_API_BASE_URL in report.degraded[0].reason

    # The gate runs before the spawn, so no child was ever launched — and unlike the
    # keyless host, this one does have an MCP child to start once Anytype is up.
    assert harness.spawns == []
    assert MCP_CHILD_ID in harness.host.children.start_order


@pytest.mark.parametrize(
    ("key", "reachable"),
    [(None, True), (FAKE_KEY, False)],
    ids=["no key", "anytype unreachable"],
)
def test_addons_that_do_not_need_anytype_start_anyway(
    make_host: MakeHost, key: str | None, reachable: bool
) -> None:
    """Whichever way the MCP child is missing, every other child still comes up."""
    harness = make_host(key=key, reachable=reachable, addons=("alpha", "beta"))

    report = harness.host.start()

    assert harness.spawned_ids() == ["alpha", "beta"]
    assert [record.id for record in report.started] == ["alpha", "beta"]
    assert [degraded.component for degraded in report.degraded] == [MCP_CHILD_ID]
    assert harness.host.is_running


def test_a_broken_addon_is_named_and_stops_nothing(
    make_host: MakeHost, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """An addon whose manifest cannot be read is reported, not started, and fatal to nothing."""
    caplog.set_level(logging.WARNING)
    # Installed, and unreadable: an environment with nothing recorded beside it. Written
    # before the host is built, because discovery runs once, when it is assembled.
    (tmp_path / "addons" / "broken" / ENVIRONMENT_DIRNAME).mkdir(parents=True)

    harness = make_host(addons=("alpha",))
    report = harness.host.start()

    assert harness.spawned_ids() == [MCP_CHILD_ID, "alpha"]
    assert report.is_complete
    assert any("broken" in record.getMessage() for record in caplog.records)


def test_the_tool_surface_is_readable_without_importing_the_mcp_package(
    make_host: MakeHost,
) -> None:
    """One import, `innytypes.host`, and plain data out — with no Node anywhere near it."""
    harness = make_host()
    harness.host.start()

    tools = anytype_tools()

    # Everything an addon touches is defined by the host API, so nothing obliges it to
    # import `innytypes.anytype_mcp`: returning the MCP package's own `ToolSurface` here
    # would fail this line.
    assert type(tools) is AnytypeTools
    assert type(tools).__module__ == "innytypes.host"
    assert type(tools.signatures) is MappingProxyType
    assert all(
        isinstance(name, str) and isinstance(signature, str)
        for name, signature in tools.signatures.items()
    )
    assert tools.names == tuple(sorted(tools.signatures))
    assert tools.names
    assert all(signature.startswith("sha256:") for signature in tools.signatures.values())


def test_a_running_server_does_not_supersede_the_committed_surface(make_host: MakeHost) -> None:
    """The answer is the committed record, at the pinned pair, while the child is running.

    The decision this asserts (plan 0002, *What an addon is told the tools are*): a live
    server's surface is **evidence for a refresh**, never a quietly better answer. A host
    that asked its running child would answer something else here — the fake child answers
    nothing at all.
    """
    harness = make_host()
    harness.host.start()
    assert harness.host.children.running()[0].id == MCP_CHILD_ID

    tools = anytype_tools()
    committed = load_tool_surface()

    assert dict(tools.signatures) == dict(committed.tools)
    assert tools.source == committed.source
    assert tools.captured_at == committed.captured_at
    assert (tools.package_version, tools.anytype_version) == (PACKAGE_VERSION, ANYTYPE_VERSION)


def test_the_tool_surface_is_readable_on_a_host_that_has_no_mcp_child(
    make_host: MakeHost,
) -> None:
    """A degraded host still answers what the tools are — an addon decides with that."""
    harness = make_host(key=None)
    harness.host.start()

    assert anytype_tools().names == load_tool_surface().names


def test_shutdown_stops_the_mcp_child(make_host: MakeHost) -> None:
    """Shutdown terminates the child and forgets it, leaving nothing for anyone to signal."""
    harness = make_host()
    harness.host.start()
    process = harness.process_for(MCP_CHILD_ID)

    harness.host.shutdown()

    assert process.terminated
    assert harness.host.children.running() == ()
    # The record goes with the process: one left behind is the phantom plan 0003's identity
    # check exists to catch.
    assert harness.run_state.records() == ()
    assert not harness.host.is_running


def test_the_default_supervisor_is_built_from_the_ambient_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """What production injects when a test injects nothing: the key from the environment.

    The variable is set, so the key file is never consulted and this stays as hermetic as
    everything above it.
    """
    monkeypatch.setenv(API_KEY_ENV_VAR, FAKE_KEY)

    supervisor = default_mcp_supervisor()

    assert supervisor.command() == PINNED_ARGV


def test_a_child_exit_is_logged_when_no_helper_is_connected(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The default exit reporter says the report went nowhere, rather than dropping it."""
    caplog.set_level(logging.INFO)

    _log_child_exit(
        ChildExit(id=MCP_CHILD_ID, kind=ChildKind.MCP, pid=4242, exit_code=1, expected=False)
    )

    message = caplog.records[-1].getMessage()
    assert MCP_CHILD_ID in message
    assert "4242" in message
