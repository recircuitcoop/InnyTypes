"""The host bringing up the MCP server as a core child — and carrying on when it cannot.

Two of the three behaviours here are **degradations**, and a degradation is the easiest
thing in the world to "pass" without writing any code: a host that never had a failure path
looks exactly like one whose failure path works. So each is staged from the real cause — a
key that genuinely is not on this machine, a health check that genuinely refuses — and each
test asserts *both* halves: nothing raised, and the host reached its running state with the
reason recorded.

Nothing here needs Node, a running Anytype, a process or a real credential. The spawn
records its arguments, the health client answers through ``httpx.MockTransport``, the clock
counts instead of passing, and the run-state file and the proxy token both live under
``tmp_path``.

The loopback MCP service is the one part that is not a fake, because it cannot be: a
listener that never binds proves nothing about a port collision, and an endpoint that is
never spoken to proves nothing about what a dead child does to a tool call. So those tests
open a real socket on a **kernel-assigned** loopback port — never the configured default,
which is a port the user's own InnyTypes may be holding — and the child behind it is the
protocol fake from ``test_anytype_mcp_session``, speaking real MCP over a real socket pair.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import socket
import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any

import httpx
import pytest
from click.testing import Result

from conftest import FAKE_KEY
from innytypes import HOST_API_VERSION
from innytypes import host as host_module
from innytypes.addons.discovery import ENVIRONMENT_DIRNAME, MANIFEST_FILENAME
from innytypes.anytype_mcp.config import (
    ANYTYPE_VERSION,
    API_KEY_ENV_VAR,
    DEFAULT_API_BASE_URL,
    PACKAGE_NAME,
    PACKAGE_VERSION,
    load_config,
)
from innytypes.anytype_mcp.gateway import GatewayConfig, McpGateway, load_gateway_config
from innytypes.anytype_mcp.session import McpSession
from innytypes.anytype_mcp.supervisor import Supervisor, SupervisorError
from innytypes.anytype_mcp.tools import load_tool_surface
from innytypes.children import (
    MCP_CHILD_ID,
    ChildExit,
    ChildKind,
    ChildSupervisor,
    Command,
    CommandName,
    ExitReporter,
    RunStateFile,
)
from innytypes.helper.config import HelperSettings, McpEndpoint, RestartSettings
from innytypes.helper.control import ControlListener, SocketConnection
from innytypes.helper.launcher import EndpointChange, EndpointOutcome, move_endpoint
from innytypes.helper.restart import ScheduledRestart
from innytypes.host import (
    AnytypeTools,
    Host,
    _log_child_exit,
    anytype_tools,
    build_host,
    default_mcp_supervisor,
)
from test_anytype_mcp_gateway import free_port, send
from test_anytype_mcp_keys import leak_sources
from test_anytype_mcp_session import OTHER_TOOL, SURFACE, TOOL, Answer, FakeChild, answering
from test_control_channel import TIMEOUT, production_helper, run_up_with, write_helper_settings

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


class PipedChild(FakeChild):
    """The session fake from the session tests, plus the one thing a child needs here.

    :class:`~test_anytype_mcp_session.FakeChild` already is a child that speaks MCP over
    real pipes; what the *child supervisor* additionally reads off a process is its pid,
    because that is what goes into the run-state record.
    """

    def __init__(self, answer: Answer, pid: int) -> None:
        super().__init__(answer)
        self.pid = pid


class PipedChildren:
    """Every MCP child one host spawned, and what the next one will answer with.

    ``tools`` is mutable on purpose: a restart is only a *fresh* handshake and a *fresh*
    validation if the child that comes back can be a different child, and the child whose
    live surface disagrees with the committed one is how that is staged.
    """

    def __init__(self) -> None:
        self.tools: list[dict[str, Any]] = [TOOL]
        self.spawned: list[PipedChild] = []

    def spawn(self, pid: int) -> PipedChild:
        child = PipedChild(answering(list(self.tools)), pid)
        self.spawned.append(child)
        return child

    @property
    def latest(self) -> PipedChild:
        return self.spawned[-1]

    def close(self) -> None:
        for child in self.spawned:
            child.close()


@dataclass
class HostHarness:
    """A host wired to fakes, plus everything a test needs to assert about it."""

    host: Host
    run_state: RunStateFile
    # The (argv, environment) of every spawn attempted, in order — the MCP child's and the
    # addons' both, because one recording spawn is given to the whole host.
    spawns: list[tuple[list[str], dict[str, str]]] = field(default_factory=list)
    processes: dict[int, FakeProcess] = field(default_factory=dict)
    # Present only on a host built to serve: the piped MCP children, and the loopback port
    # its HTTP service was configured with. The port is configured either way, so a test can
    # assert that a host which must not listen did not.
    mcp_children: PipedChildren | None = None
    mcp_port: int = 0
    # The `config.toml` this host reads — which plugins may start, and since plan 0008 the
    # stored MCP address. Carried here because a saved endpoint change writes to it.
    settings: HelperSettings | None = None
    # Where this host's addons were discovered from, for the tests that run `innytypes up`.
    addons_root: Path | None = None

    @property
    def gateway(self) -> McpGateway | None:
        """The host's HTTP service, or ``None`` when it was never built.

        Reached through the private attribute because :class:`Host` exposes no accessor for
        it, and whether one exists at all is precisely what the first test below asserts.
        """
        return self.host._gateway

    def rpc(self, payload: dict[str, Any]) -> dict[str, Any]:
        """One JSON-RPC exchange over the real loopback endpoint this host is serving."""
        gateway = self.gateway
        assert gateway is not None, "this host has no HTTP service to speak to"
        status, body = send(
            self.mcp_port,
            json.dumps(payload).encode(),
            token=gateway.config.bearer_token,
        )
        assert status == 200, f"the MCP service answered {status}"
        decoded: dict[str, Any] = json.loads(body)
        return decoded

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
def make_host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[MakeHost]:
    """Build hosts that spawn nothing, open no socket and write only under ``tmp_path``."""
    clients: list[httpx.Client] = []
    hosts: list[Host] = []
    children_groups: list[PipedChildren] = []

    # `build_host` reads the proxy bearer token from the owner-only file production keeps it
    # in, and `load_gateway_config` takes that path only as a keyword default — so a host
    # built here would create a real credential under the developer's own
    # `~/.config/innytypes`. The gate is hermetic and uses no real credential (plan 0007), so
    # the seam `build_host` does not offer is supplied here instead. Everything else the host
    # passes — the environment, and since plan 0008 the stored `[mcp]` setting that beats it —
    # is forwarded untouched, so the precedence under test is the production one.
    def hermetic_gateway_config(
        env: Mapping[str, str] | None = None,
        *,
        settings: HelperSettings | None = None,
    ) -> GatewayConfig:
        return load_gateway_config(
            env,
            token_file=tmp_path / "credentials" / "mcp_proxy_token",
            settings=settings,
        )

    monkeypatch.setattr(host_module, "load_gateway_config", hermetic_gateway_config)

    def _make(
        *,
        key: str | None = FAKE_KEY,
        reachable: bool = True,
        addons: Sequence[str] = (),
        serve: bool = False,
        mcp_port: int | None = None,
        stored_endpoint: tuple[str, int] | None = None,
    ) -> HostHarness:
        spawns: list[tuple[list[str], dict[str, str]]] = []
        processes: dict[int, FakeProcess] = {}
        exits: list[ChildExit] = []
        # A child session factory is the whole difference between a host that serves and one
        # that does not: `build_host` opens no listener without one. `serve=False` is
        # therefore not "the HTTP service switched off" — it is a host whose child could
        # never be validated, which is the state the first test below is about.
        mcp_children = PipedChildren() if serve else None
        if mcp_children is not None:
            children_groups.append(mcp_children)
        # Never the default 31010: a test that took a real user port would fail on the
        # machine where InnyTypes is actually running.
        port = free_port() if mcp_port is None else mcp_port

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
        ) -> FakeProcess | PipedChild:
            # `channel` is the addon's event channel, which a real child inherits as its
            # standard input; a fake process has nothing to do with it.
            spawns.append((list(argv), dict(env)))
            # Process IDs that could not collide with this test runner's own.
            pid = 80_000 + len(spawns)
            if mcp_children is not None and argv[0] == "npx":
                # A serving host needs a child that really answers MCP, because the session
                # this spawn hands back is what the HTTP service routes through.
                return mcp_children.spawn(pid)
            process = FakeProcess(pid=pid)
            processes[process.pid] = process
            return process

        def mcp() -> Supervisor:
            # The real key lookup, against an environment and a key file this test owns.
            # `key=None` therefore fails the way a machine with no key fails, in
            # `load_config`, rather than by a hand-raised error nothing else would produce.
            key_environment = {} if key is None else {API_KEY_ENV_VAR: key}
            return Supervisor(
                config=load_config(env=key_environment, key_file=tmp_path / "absent-key"),
                spawn=spawn,  # type: ignore[arg-type]
                health_client=client,
                # The real session: a real handshake over the child's real pipes, and the
                # real committed-surface comparison. `SURFACE` is the session tests' own
                # committed record, so the fake child is judged exactly as the pinned one is.
                session_factory=(
                    (lambda process: McpSession(process, expected_signatures=SURFACE))
                    if serve
                    else None
                ),
            )

        addons_root = tmp_path / "addons"
        addons_root.mkdir(exist_ok=True)
        for addon_id in addons:
            record_addon(addons_root, addon_id)

        run_state = RunStateFile(tmp_path / "run-state.json")
        ticks = iter(FIRST_TICK + step for step in range(1_000))
        # A `config.toml` of this test's own. `build_host` reads two things from it — which
        # plugins may start, and the stored MCP address — and a host reading the developer's
        # real file would take whichever port that person had configured (plan 0008).
        settings = HelperSettings(tmp_path / "config.toml")
        if stored_endpoint is not None:
            settings.set_mcp_endpoint(*stored_endpoint)
        host = build_host(
            addons_root=addons_root,
            mcp=mcp,
            spawn=spawn,
            run_state=run_state,
            report_exit=exits.append,
            clock=lambda: next(ticks),
            # An environment of its own, so nothing here depends on the shell the gate runs
            # in. It carries the MCP port because `build_host` reads the HTTP service's
            # address from the same mapping the children are launched with.
            environment={"PATH": "/nonexistent", "INNYTYPES_MCP_PORT": str(port)},
            settings=settings,
        )
        hosts.append(host)
        # The port the harness talks to is the port the host was configured with, and a
        # stored setting is what decides that when there is one (plan 0008).
        served = port if stored_endpoint is None else stored_endpoint[1]
        return HostHarness(
            host, run_state, spawns, processes, mcp_children, served, settings, addons_root
        )

    yield _make

    # A listener and a reader thread outlive a test that failed before its own shutdown, and
    # the next test would then meet a port that is taken and a child that is still answering.
    for host in hosts:
        with contextlib.suppress(Exception):
            host.shutdown()
    for group in children_groups:
        group.close()
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


# --- the loopback MCP service, as the host owns it ----------------------------------------


def nothing_is_listening_on(port: int, host: str = "127.0.0.1") -> bool:
    """Whether this address is free — asked by taking it, which is the only honest way.

    A connection attempt would answer "refused" for a listener that exists and is merely
    busy, and would say nothing at all about a socket bound without `listen`. Binding it
    ourselves fails exactly when something else has it.
    """
    probe = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
    try:
        probe.bind((host, port))
    except OSError:
        return False
    finally:
        probe.close()
    return True


def test_no_listener_exists_before_child_validation_can_succeed(make_host: MakeHost) -> None:
    """A host whose child cannot be validated opens no port at all.

    The order in plan 0007 is not decoration: the endpoint exists to serve a child whose
    live tool surface has been compared with the committed one, so a listener that came up
    first would be a URL a client can configure, connect to and be refused by — and the
    refusal would look like the child being down rather than like a host that has no
    session to serve. `build_host` therefore builds the service only when the supervisor
    has a session factory, which is the only thing that can produce a validated session.
    """
    port = free_port()
    harness = make_host(mcp_port=port)

    report = harness.host.start()

    # Nothing was built, so nothing could have been started.
    assert harness.gateway is None
    assert not any(
        degraded.component == "innytypes.anytype-mcp-http" for degraded in report.degraded
    )
    # And nothing is on the configured address: the child did start, so a host that opened
    # its listener on any weaker condition than a validated session would be listening here.
    assert [record.id for record in report.started] == [MCP_CHILD_ID]
    assert nothing_is_listening_on(port)
    assert not any(thread.name == "innytypes-mcp-http" for thread in threading.enumerate())


def test_a_configured_port_collision_degrades_only_the_mcp_service(make_host: MakeHost) -> None:
    """Something else has the port: the service is named as degraded, the host runs on.

    Both halves of the acceptance line, and the half that is easiest to get wrong is the
    second one — a host that quietly bound the next free port would pass every "the host
    still runs" assertion while every configured client kept reaching nothing. The port a
    client was told about is the port or there is no service.
    """
    port = free_port()
    occupier = socket.socket(socket.AF_INET)
    occupier.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    occupier.bind(("127.0.0.1", port))
    occupier.listen(1)
    try:
        harness = make_host(serve=True, mcp_port=port, addons=("alpha",))

        report = harness.host.start()

        assert harness.host.is_running
        named = [
            degraded
            for degraded in report.degraded
            if degraded.component == "innytypes.anytype-mcp-http"
        ]
        assert len(named) == 1
        # The address is in the reason, because "the port is taken" without saying which
        # port leaves the user nothing to change.
        assert f"127.0.0.1:{port}" in named[0].reason

        # The host and the unrelated addon reached running state, and so did the child: the
        # collision is the HTTP service's alone.
        assert [record.id for record in report.started] == [MCP_CHILD_ID, "alpha"]

        # No second port was chosen. The service still holds the configured one and is not
        # running, rather than running somewhere nobody is configured to look.
        gateway = harness.gateway
        assert gateway is not None
        assert gateway.config.port == port
        assert not gateway.is_running
    finally:
        occupier.close()


def test_the_host_serves_the_stored_address_and_not_the_environment(
    make_host: MakeHost,
) -> None:
    """Plan 0008's inversion, asserted where it has to be true: on the wire.

    The harness always sets `INNYTYPES_MCP_PORT`, so this host is told two different things
    and has to prefer the stored one. Asserting the configuration alone would pass against a
    host that read the setting and then bound the variable anyway, so the proof is a real
    JSON-RPC exchange on the stored port and a refused connection on the other.
    """
    environment_port, stored_port = free_port(), free_port()
    assert environment_port != stored_port
    harness = make_host(
        serve=True,
        mcp_port=environment_port,
        stored_endpoint=("127.0.0.1", stored_port),
    )

    report = harness.host.start()

    assert harness.host.is_running
    assert not report.degraded
    gateway = harness.gateway
    assert gateway is not None
    assert (gateway.config.host, gateway.config.port) == ("127.0.0.1", stored_port)

    answer = harness.rpc({"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert answer == {"jsonrpc": "2.0", "id": 1, "result": {}}
    # And the address the variable named is not being served by anything.
    assert nothing_is_listening_on(environment_port)


def test_shutdown_closes_the_listener_before_it_stops_the_child() -> None:
    """The order, not merely that both happened.

    Stopping the child first leaves the port open in front of a service that can no longer
    answer, so a client's next request arrives at a listener whose session has gone: it is
    accepted, then refused, for as long as shutdown takes. Closing the listener first means
    a client is refused by the TCP stack, which is what "InnyTypes is not running" looks
    like. A test that only asserted both calls happened would pass on the wrong order.
    """
    order: list[str] = []

    class RecordingGateway:
        def stop(self) -> None:
            order.append("gateway")

    class RecordingChildren:
        def shutdown(self) -> None:
            order.append("children")

    host = Host(
        children=RecordingChildren(),  # type: ignore[arg-type]
        gateway=RecordingGateway(),  # type: ignore[arg-type]
    )

    host.shutdown()

    assert order == ["gateway", "children"]
    assert not host.is_running


def test_a_helper_requested_restart_restores_tools_only_after_a_fresh_validation(
    make_host: MakeHost,
) -> None:
    """Child death, a refused restart, then a good one — over the real HTTP endpoint.

    Three things are being kept apart here, and each of them is a way the service could be
    wrong while looking right: a dead child must make tools *unavailable* rather than
    stale; a restart whose child disagrees with the committed surface must restore nothing;
    and the HTTP service must never be the thing that restarts anything, because restart
    policy is the helper's (plan 0003) and a tool call may have mutated Anytype.
    """
    harness = make_host(serve=True)
    harness.host.start()
    children = harness.mcp_children
    assert children is not None

    listed = harness.rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert [tool["name"] for tool in listed["result"]["tools"]] == [TOOL["name"]]
    assert children.latest.methods == ["initialize", "notifications/initialized", "tools/list"]

    # The child dies, and the host observes it exactly as it does in production.
    children.latest.die()
    harness.host.children.poll()

    dead = harness.rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert dead["error"]["code"] == -32000
    assert "unavailable" in dead["error"]["message"]
    called = harness.rpc(
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": TOOL["name"]}}
    )
    assert called["error"]["code"] == -32000

    # And the service started nothing of its own while answering them.
    assert len(children.spawned) == 1

    # A restart whose child no longer matches the committed surface restores nothing: the
    # handshake succeeds and the validation does not, which is the half a test that only
    # killed and restarted a healthy child would never reach.
    children.tools = [TOOL, OTHER_TOOL]
    with pytest.raises(SupervisorError):
        harness.host.children.restart(MCP_CHILD_ID)

    assert len(children.spawned) == 2
    assert children.latest.terminated
    still_dead = harness.rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/list"})
    assert still_dead["error"]["code"] == -32000

    # A restart whose child does match restores them — after its own fresh handshake.
    children.tools = [TOOL]
    record = harness.host.children.restart(MCP_CHILD_ID)

    assert record.id == MCP_CHILD_ID
    assert len(children.spawned) == 3
    assert children.latest.methods == ["initialize", "notifications/initialized", "tools/list"]
    restored = harness.rpc({"jsonrpc": "2.0", "id": 5, "method": "tools/list"})
    # The live definitions, not the committed catalogue: the description is the child's.
    assert restored["result"]["tools"] == [TOOL]


def test_a_rebind_moves_the_endpoint_without_restarting_the_child_or_its_session(
    make_host: MakeHost,
) -> None:
    """A rebind is not a restart, asserted where the difference is expensive.

    Moving the endpoint by stopping and rebuilding the host would be the easy
    implementation and the wrong one: it would kill the Anytype child, throw away a
    validated session, and re-run a handshake — in the middle of whatever that child was
    doing, because a tool call may have mutated Anytype and restart policy is the helper's
    (plan 0003). So the whole child conversation is compared across the move: one spawn,
    one handshake, one validation, and the same child object answering afterwards through
    an address it knows nothing about.
    """
    harness = make_host(serve=True)
    harness.host.start()
    children = harness.mcp_children
    assert children is not None
    gateway = harness.gateway
    assert gateway is not None
    child = children.latest

    before = harness.rpc(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": TOOL["name"]}}
    )
    assert "result" in before
    conversation = list(child.methods)
    assert conversation == ["initialize", "notifications/initialized", "tools/list", "tools/call"]

    new_port = free_port()
    moved = gateway.rebind("127.0.0.1", new_port)

    assert (moved.host, moved.port) == ("127.0.0.1", new_port)
    status, body = send(
        new_port,
        json.dumps(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": TOOL["name"]}}
        ).encode(),
        token=gateway.config.bearer_token,
    )
    answer = json.loads(body)

    assert status == 200
    assert answer["result"] == before["result"]
    # The same child, still the same session: one spawn, one handshake, one validation, and
    # the only new frame is the call that just came in through the new address.
    assert len(children.spawned) == 1
    assert children.latest is child
    assert not child.terminated and not child.killed
    assert child.methods == [*conversation, "tools/call"]
    assert harness.host.is_running
    assert [record.id for record in harness.host.children.running()] == [MCP_CHILD_ID]
    # And the address the host started on is free, so no client can still be reaching it.
    assert nothing_is_listening_on(harness.mcp_port)


# --- the helper's endpoint change, over the channel `innytypes up` assembles -----------------


def with_a_helper(harness: HostHarness, drive: Callable[[ControlListener], None]) -> Result:
    """Run the real `innytypes up` on this harness's host, with a real helper listening.

    The host is this file's — a validated child, a real session, a real loopback listener —
    and everything joining the two is production: `up` starts the host, dials the socket,
    announces which process it is, and serves what arrives on it. ``drive`` runs on the
    helper's side while both are up, which is the only moment there is to send a command or
    to speak to the endpoint, because `up` stops everything again on its way out.

    The one thing given up by handing `up` a host that is already assembled is where a child
    exit goes; that path is proved in `tests/test_control_channel.py`, against a host `up`
    built itself.
    """
    assert harness.addons_root is not None
    listener = ControlListener(report_exit=lambda _: None, host_pid=os.getpid, timeout=10.0)
    listener.open()
    try:
        return run_up_with(
            build=lambda _root, _exits: harness.host,
            addons_root=harness.addons_root,
            drive=lambda _children: drive(listener),
        )
    finally:
        listener.close()


def accepted(listener: ControlListener) -> None:
    """Take the connection the host made on its way up. Asserts that it made one."""
    listener.poll()
    assert listener.host is not None, "the host `up` started never reached the helper"


def ping(port: int, token: str) -> tuple[int, object]:
    """One real JSON-RPC exchange with whatever is serving this loopback port."""
    status, body = send(
        port, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}).encode(), token=token
    )
    return status, json.loads(body)


PONG = (200, {"jsonrpc": "2.0", "id": 1, "result": {}})


def named_threads() -> list[str]:
    """Every thread this application named, and none of the ones it did not.

    ``Thread-N (process_request_thread)`` is one HTTP request being served, started and
    ended by :class:`~http.server.ThreadingHTTPServer` whenever it likes and outliving the
    request as a daemon. Counting those would make "nothing new was started to carry this"
    a question about who happened to be mid-request, which is nobody's claim.
    """
    return sorted(
        thread.name for thread in threading.enumerate() if not thread.name.startswith("Thread-")
    )


def occupy(port: int) -> socket.socket:
    """Hold a loopback port the way another program on this machine would hold it."""
    occupier = socket.socket(socket.AF_INET)
    occupier.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    occupier.bind(("127.0.0.1", port))
    occupier.listen(1)
    return occupier


def test_a_saved_endpoint_change_crosses_the_control_channel_and_moves_the_listener(
    make_host: MakeHost, runtime_directory: Path
) -> None:
    """The whole of this slice's outcome, end to end and over real sockets.

    A person's saved address leaves the helper as one command on the channel that already
    exists, the host binds it, and the answer that comes back is the address **being served**
    rather than the address that was asked for. The proof that it moved is a real JSON-RPC
    exchange on the new port and a refused connection on the old one, both made while the
    host is up.

    The acceptance also asks that no new channel, socket or file-watching path appear. Both
    halves of that are asserted here: the runtime directory holds exactly the one control
    socket it held before, and no thread was added — the HTTP listener's thread keeps its
    name across the move because it *is* the same service, moved.
    """
    harness = make_host(serve=True)
    assert harness.settings is not None and harness.gateway is not None
    token = harness.gateway.config.bearer_token
    new_port = free_port()
    changes: list[EndpointChange] = []
    answers: list[tuple[int, object]] = []
    old_port_free: list[bool] = []
    sockets: list[list[Path]] = []
    threads: list[list[str]] = []

    def look() -> None:
        sockets.append(sorted(path for path in runtime_directory.iterdir() if path.is_socket()))
        threads.append(named_threads())

    def drive(listener: ControlListener) -> None:
        accepted(listener)
        look()

        changes.append(move_endpoint(listener, "127.0.0.1", new_port, settings=harness.settings))

        answers.append(ping(new_port, token))
        old_port_free.append(nothing_is_listening_on(harness.mcp_port))
        look()

    result = with_a_helper(harness, drive)

    assert result.exit_code == 0, result.output
    (change,) = changes
    assert change.outcome is EndpointOutcome.MOVED
    assert change.url == f"http://127.0.0.1:{new_port}/mcp"
    # The address in the answer is the address being served, spoken to for real.
    assert answers == [PONG]
    assert old_port_free == [True]

    # Saved, and only now: the setting records the address the host confirmed it is serving.
    assert (harness.settings.mcp.host, harness.settings.mcp.port) == ("127.0.0.1", new_port)

    # One channel, and no second socket or thread put up to carry the change. The HTTP
    # listener's thread keeps its name across the move because it *is* the same service,
    # moved — and the control reader is the one that was already there.
    assert sockets[0] == sockets[1]
    assert len(sockets[0]) == 1
    assert threads[0] == threads[1]
    assert "innytypes-control" in threads[0]


def test_saving_the_address_already_being_served_answers_without_moving_anything(
    make_host: MakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pressing Save without editing anything: a success that touches nothing.

    Handed on to the listener, this would be a bind against a port **this service is
    holding**, and the person would be told their port is taken by their own MCP endpoint.
    So the request is answered where it is interpreted, and the four things that must not
    happen are each asserted rather than assumed: `rebind` is never called, the server
    object is the one that was already there, its listening socket is the same descriptor —
    so no port was closed and reopened — and the endpoint answers afterwards as if nothing
    had been asked of it, which it had not.

    It is still stored. An address can be the one being served and not yet the one saved,
    because it came from the environment variable or from the documented default, and
    saving it is how a person stops depending on either (plan 0008).
    """
    harness = make_host(serve=True)
    assert harness.settings is not None and harness.gateway is not None
    token = harness.gateway.config.bearer_token
    rebinds: list[tuple[str, int]] = []
    moved = McpGateway.rebind

    def watched(self: McpGateway, host: str, port: int) -> GatewayConfig:
        rebinds.append((host, port))
        return moved(self, host, port)

    monkeypatch.setattr(McpGateway, "rebind", watched)

    changes: list[EndpointChange] = []
    servers: list[object] = []
    descriptors: list[int] = []
    answers: list[tuple[int, object]] = []

    def look() -> None:
        gateway = harness.gateway
        assert gateway is not None and gateway._server is not None
        servers.append(gateway._server)
        descriptors.append(gateway._server.fileno())

    def drive(listener: ControlListener) -> None:
        accepted(listener)
        look()
        changes.append(
            move_endpoint(listener, "127.0.0.1", harness.mcp_port, settings=harness.settings)
        )
        look()
        answers.append(ping(harness.mcp_port, token))

    result = with_a_helper(harness, drive)

    assert result.exit_code == 0, result.output
    (change,) = changes
    assert change.outcome is EndpointOutcome.UNCHANGED
    assert change.served is True
    assert change.url == f"http://127.0.0.1:{harness.mcp_port}/mcp"
    assert change.reason is None

    # Nothing was moved: not by `rebind`, not by anything that replaced the server, and not
    # by anything that closed and reopened its socket.
    assert rebinds == []
    assert servers[0] is servers[1]
    assert descriptors[0] == descriptors[1]
    # And it is still serving, proved by speaking to it rather than by asking it.
    assert answers == [PONG]

    # Saved, because being served and being stored are different things.
    assert (harness.settings.mcp.host, harness.settings.mcp.port) == (
        "127.0.0.1",
        harness.mcp_port,
    )


def test_a_host_that_never_bound_may_not_claim_it_already_serves_that_address(
    make_host: MakeHost,
) -> None:
    """The dangerous half of "already serving that": a host serving nothing at all.

    This host is configured for a port something else is holding, so it has that address
    and no listener. Asked for exactly that address — which is what pressing Save on the
    unedited panel of a collided installation sends — a check written against the
    *configured* address rather than the *served* one would answer "already serving that",
    and the person would be told their endpoint is fine while nothing is listening on it.
    So the address is tried, the bind fails the way it failed at startup, and the reason
    they get is the true one.
    """
    taken = free_port()
    occupier = occupy(taken)
    harness = make_host(serve=True, mcp_port=taken)
    assert harness.settings is not None
    changes: list[EndpointChange] = []
    running: list[bool] = []

    def drive(listener: ControlListener) -> None:
        accepted(listener)
        changes.append(move_endpoint(listener, "127.0.0.1", taken, settings=harness.settings))
        gateway = harness.gateway
        assert gateway is not None
        running.append(gateway.is_running)

    try:
        result = with_a_helper(harness, drive)
    finally:
        occupier.close()

    assert result.exit_code == 0, result.output
    (change,) = changes
    assert change.outcome is EndpointOutcome.REFUSED
    assert change.served is False
    assert f"127.0.0.1:{taken}" in (change.reason or "")
    # Still not serving anything, and still nothing stored about an address it cannot hold.
    assert running == [False]
    assert harness.settings.mcp == McpEndpoint()


def test_a_refused_change_leaves_the_stored_setting_and_the_running_endpoint_untouched(
    make_host: MakeHost,
) -> None:
    """A mistyped port costs a message, not the endpoint that was working.

    Both halves are asserted where they have to be true. The endpoint is still answering,
    proved by a real exchange on it after the refusal rather than by the gateway's opinion of
    itself; and nothing was stored, so the next start binds what this one did — which is the
    whole reason the change is asked before it is saved.
    """
    harness = make_host(serve=True)
    assert harness.settings is not None and harness.gateway is not None
    token = harness.gateway.config.bearer_token
    taken = free_port()
    occupier = occupy(taken)
    changes: list[EndpointChange] = []
    answers: list[tuple[int, object]] = []
    served: list[tuple[str, int]] = []

    def drive(listener: ControlListener) -> None:
        accepted(listener)
        changes.append(move_endpoint(listener, "127.0.0.1", taken, settings=harness.settings))
        gateway = harness.gateway
        assert gateway is not None
        served.append((gateway.config.host, gateway.config.port))
        answers.append(ping(harness.mcp_port, token))

    try:
        result = with_a_helper(harness, drive)
    finally:
        occupier.close()

    assert result.exit_code == 0, result.output
    (change,) = changes
    assert change.outcome is EndpointOutcome.REFUSED
    assert f"127.0.0.1:{taken}" in (change.reason or "")
    assert change.url == ""
    # Still the same listener, on the same address, still answering.
    assert served == [("127.0.0.1", harness.mcp_port)]
    assert answers == [PONG]
    # And nothing was stored, so nothing about the next start changed either.
    assert harness.settings.mcp == McpEndpoint()


def test_a_host_whose_listener_never_bound_serves_the_address_it_is_given(
    make_host: MakeHost,
) -> None:
    """The case plan 0008 exists for: the configured port was taken, and the panel moves it.

    This host starts with its port already held by something else, so it has a gateway and no
    listener — degraded, exactly as `up` reports it. A request to move the endpoint then has
    nothing to move and everything to gain, so the address asked for is bound outright.
    Refusing here would leave the one person this plan is about unable to escape a collision
    from the application they are holding.
    """
    taken = free_port()
    occupier = occupy(taken)
    free = free_port()
    harness = make_host(serve=True, mcp_port=taken)
    assert harness.settings is not None and harness.gateway is not None
    token = harness.gateway.config.bearer_token
    changes: list[EndpointChange] = []
    running: list[bool] = []
    answers: list[tuple[int, object]] = []

    def drive(listener: ControlListener) -> None:
        accepted(listener)
        gateway = harness.gateway
        assert gateway is not None
        running.append(gateway.is_running)
        changes.append(move_endpoint(listener, "127.0.0.1", free, settings=harness.settings))
        answers.append(ping(free, token))

    try:
        result = with_a_helper(harness, drive)
    finally:
        occupier.close()

    assert result.exit_code == 0, result.output
    assert "not started innytypes.anytype-mcp-http: " in result.output
    assert running == [False], "this host was supposed to start with no listener at all"
    (change,) = changes
    assert change.outcome is EndpointOutcome.MOVED
    assert change.url == f"http://127.0.0.1:{free}/mcp"
    assert answers == [PONG]
    assert (harness.settings.mcp.host, harness.settings.mcp.port) == ("127.0.0.1", free)


def test_neither_credential_appears_in_a_control_message_an_answer_or_a_log(
    make_host: MakeHost,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Every frame either end wrote, read back, with both credentials looked for in all of it.

    The two are different secrets with different blast radii — the Anytype API key is the
    user's Anytype, the proxy bearer token is this host's MCP endpoint — and neither has any
    business on a channel whose only job is to carry commands between two of this
    application's own processes. A successful change and a refused one are both driven,
    because a refusal carries the host's own words and those are the words that get long.
    """
    caplog.set_level(logging.DEBUG)
    frames: list[str] = []
    written = SocketConnection.send

    def recording(self: SocketConnection, frame: str) -> None:
        """Watch every frame on its way out. The connection is still the production one."""
        frames.append(frame)
        written(self, frame)

    monkeypatch.setattr(SocketConnection, "send", recording)

    harness = make_host(serve=True)
    assert harness.settings is not None and harness.gateway is not None
    token = harness.gateway.config.bearer_token
    taken = free_port()
    occupier = occupy(taken)

    def drive(listener: ControlListener) -> None:
        accepted(listener)
        assert listener.send(Command(name=CommandName.LIST)).name is CommandName.LIST
        assert move_endpoint(listener, "127.0.0.1", free_port(), settings=harness.settings).served
        assert not move_endpoint(listener, "127.0.0.1", taken, settings=harness.settings).served

    try:
        result = with_a_helper(harness, drive)
    finally:
        occupier.close()

    assert result.exit_code == 0, result.output
    assert len(frames) > 3, "no frames were watched, so this test proved nothing"
    captured = capsys.readouterr()
    for secret in (FAKE_KEY, token):
        assert [frame for frame in frames if secret in frame] == []
        assert (
            leak_sources(secret, captured.out + result.output, captured.err, caplog.records) == []
        )


# --- the MCP child is killed, and the helper the application assembles brings it back --------

# How many supervision passes the wait below may take before it calls the run broken. It is a
# bound on a *state change*, not a span: with this test's configured backoff of zero the pass
# that hears the exit is the pass that issues the restart, so one is expected and anything
# under the bound still passes. The bound is small on purpose — every extra pass is another
# sample of the process table, and a wait that ran dozens of them would start counting
# interventions into the breaker and quarantine the very child it is waiting for.
MAX_PASSES = 4


def mcp_child_of(children: ChildSupervisor) -> bool:
    """Whether the host is running an MCP child right now, by its own record of it."""
    return any(record.id == MCP_CHILD_ID for record in children.running())


def tools_or_nothing(port: int, token: str) -> list[str] | None:
    """The tool names the endpoint answers with, or ``None`` when it cannot answer at all.

    Asserts nothing, because this is the question the bounded wait below asks over and over:
    a child that has not come back yet answers ``-32000 unavailable``, which is a state to
    wait through rather than a failure of the test.
    """
    status, body = send(
        port,
        json.dumps({"jsonrpc": "2.0", "id": 99, "method": "tools/list"}).encode(),
        token=token,
    )
    if status != 200:
        return None
    answer = json.loads(body)
    if "result" not in answer:
        return None
    return [tool["name"] for tool in answer["result"]["tools"]]


def test_the_helper_brings_the_killed_mcp_child_back_and_the_endpoint_serves_again(
    tmp_path: Path, runtime_directory: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Kill the MCP child; the shipped helper restarts it and a client is served again.

    **Why this exists.** Somebody asked whether the helper supervises the MCP server, and the
    only way to answer was to run the application and kill the child by hand. Nothing in the
    suite combined the MCP child with a crash, an exit or the restart policy, so the first
    answer given was wrong. The behaviour itself works — this guards it.

    **Nothing here is joined by hand.** The helper is :func:`production_helper`'s, which is
    the real :class:`~innytypes.helper.launcher.Application` and the real
    :func:`~innytypes.helper.supervision.build_supervision`, in the order `main` uses them:
    the application is holding the policy before anything can report an exit to it, and the
    exit is judged by ``application.child_exited`` rather than by a policy this test wired to
    the listener itself. That line — a fixture joining the listener to a policy of its own —
    is exactly what the shipped helper was missing for months while every test passed. The
    host is the one `innytypes up` builds, through the two seams `up` already has, so where a
    child's exit goes is `up`'s decision and not this test's.

    **What it waits for, and why the wait is bounded.** The restart policy backs off, so a
    fixed span of observation reads as "no restart" — that is how the hand answer went wrong.
    So this waits for a *state change*: the MCP child running again **and** the endpoint
    answering a real ``tools/list``. It waits by driving the helper's own pass, never by
    sleeping, and the delay between the exit and the restart is production's own configured
    number, read out of this test's `config.toml` by the production `build_supervision` and
    set to zero so that no real second is spent. The bound is :data:`MAX_PASSES` passes: a
    policy that never issues the restart then fails the run instead of looping for ever.

    **What a client sees is the proof.** A process existing is not recovery — the endpoint
    served the child's live tool surface before the kill, refused while it was dead, and
    serves it again afterwards, each asserted over the real loopback listener on a
    kernel-assigned port. No Node, no Anytype, no real credential and no fixed user port.
    """

    # The proxy bearer token lives in an owner-only file under the user's own config
    # directory, and `build_host` offers no seam for it — only `load_gateway_config` does. So
    # the same redirection `make_host` uses is applied here, and everything else the host
    # passes through is forwarded untouched.
    def hermetic_gateway_config(
        env: Mapping[str, str] | None = None,
        *,
        settings: HelperSettings | None = None,
    ) -> GatewayConfig:
        return load_gateway_config(
            env, token_file=tmp_path / "credentials" / "mcp_proxy_token", settings=settings
        )

    monkeypatch.setattr(host_module, "load_gateway_config", hermetic_gateway_config)

    port = free_port()
    children = PipedChildren()
    health = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200)))
    addons_root = tmp_path / "addons"
    addons_root.mkdir()
    run_state_path = tmp_path / "run-state.json"

    # The helper's numbers where the helper reads them from. Two attempts is one more than
    # this test needs, so a restart that had to be tried twice is still a pass rather than a
    # mystery; the zero delay is what keeps the wait below off the wall clock.
    settings = HelperSettings(tmp_path / "config.toml")
    write_helper_settings(settings.path, restart=RestartSettings(max_attempts=2, backoff=(0.0,)))

    exits: list[ChildExit] = []
    decisions: list[ScheduledRestart | None] = []
    deciders: list[Callable[[ChildExit], ScheduledRestart | None]] = []

    def report(exit_report: ChildExit) -> None:
        """What the helper does with an exit: record it, and hand it to the application.

        The hand-over is ``application.child_exited`` and nothing else, exactly as `main`'s
        own ``report_child_exit`` is — the application has a restart policy only because
        `build_supervision` gave it one.
        """
        exits.append(exit_report)
        decisions.append(deciders[0](exit_report))

    listener = ControlListener(report_exit=report, host_pid=os.getpid, timeout=TIMEOUT)
    listener.open()
    supervision = production_helper(
        listener=listener,
        settings=settings,
        run_state_path=run_state_path,
        root=addons_root,
        tmp_path=tmp_path,
        runtime_directory=runtime_directory,
        monkeypatch=monkeypatch,
        decide=deciders.append,
    )

    spawns: list[list[str]] = []
    ticks = iter(FIRST_TICK + step for step in range(1_000))

    def spawn(
        argv: Sequence[str], env: dict[str, str], *, channel: int | None = None
    ) -> PipedChild:
        spawns.append(list(argv))
        assert argv[0] == "npx", f"this host has only an MCP child, and it spawned {argv}"
        # Process IDs that could not collide with this test runner's own.
        return children.spawn(80_000 + len(spawns))

    def mcp() -> Supervisor:
        return Supervisor(
            config=load_config(env={API_KEY_ENV_VAR: FAKE_KEY}, key_file=tmp_path / "absent-key"),
            spawn=spawn,  # type: ignore[arg-type]
            health_client=health,
            # The real session: a real handshake over the child's real pipes and the real
            # comparison with a committed surface, so the child that comes back is validated
            # exactly as the pinned one is.
            session_factory=lambda process: McpSession(process, expected_signatures=SURFACE),
        )

    hosts: list[Host] = []

    def build(root: Path | None, report_exit: ExitReporter) -> Host:
        """The production assembly, with the seams `up` already has pointed at fakes.

        ``report_exit`` is `up`'s own — where a child's exit goes is the product's decision,
        and a host handed a reporter of this test's would carry nothing over the wire.
        """
        host = build_host(
            addons_root=root,
            mcp=mcp,
            spawn=spawn,  # type: ignore[arg-type]
            run_state=RunStateFile(run_state_path),
            report_exit=report_exit,
            clock=lambda: next(ticks),
            environment={"PATH": "/nonexistent", "INNYTYPES_MCP_PORT": str(port)},
            settings=settings,
        )
        hosts.append(host)
        return host

    served_before: list[list[str] | None] = []
    served_while_dead: list[list[str] | None] = []
    served_after: list[list[str] | None] = []
    passes: list[int] = []

    def drive(running: ChildSupervisor) -> None:
        listener.poll()
        assert listener.host is not None, "the host `up` started never reached the helper"
        # Reached through the private attribute for the same reason `HostHarness.gateway` is:
        # `Host` exposes no accessor for its listener.
        gateway = hosts[0]._gateway
        assert gateway is not None, "this host was supposed to serve an MCP endpoint"
        token = gateway.config.bearer_token

        served_before.append(tools_or_nothing(port, token))
        doomed = children.latest

        # The kill: the process is gone outright, which is what `kill -9` leaves behind.
        doomed.kill()
        # The host's own poll is what notices a child that died; in production that call is
        # in `up`'s supervise loop, and here this function is that loop.
        running.poll()
        served_while_dead.append(tools_or_nothing(port, token))

        for attempt in range(1, MAX_PASSES + 1):
            report = supervision.pass_once()
            assert [failure.step for failure in report.failures] == [], (
                f"a supervision pass named failures: {report.failures}"
            )
            if mcp_child_of(running) and tools_or_nothing(port, token) is not None:
                passes.append(attempt)
                break
        else:
            raise AssertionError(
                f"the MCP child did not come back within {MAX_PASSES} supervision passes; "
                f"running={[record.id for record in running.running()]} "
                f"pending={[one.child_id for one in supervision.policy.pending]}"
            )

        served_after.append(tools_or_nothing(port, token))

    try:
        result = run_up_with(build=build, addons_root=addons_root, drive=drive)
    finally:
        listener.close()
        if supervision.beats is not None:
            supervision.beats.close()
        children.close()
        health.close()

    assert result.exit_code == 0, result.output

    # The exit crossed the wire, and it crossed it as the MCP child's own unexpected death.
    assert [report.id for report in exits] == [MCP_CHILD_ID]
    assert exits[0].kind is ChildKind.MCP
    assert exits[0].expected is False
    assert exits[0].exit_code == -9

    # The application judged it and scheduled the return — through the policy
    # `build_supervision` handed it, which is the hop the shipped helper was missing.
    assert decisions[0] is not None
    assert supervision.policy.state(MCP_CHILD_ID).attempts == 1

    # And it was issued: a second child was spawned, with the pinned argv, and nothing else
    # ever was.
    assert spawns == [PINNED_ARGV, PINNED_ARGV]
    assert len(children.spawned) == 2
    assert children.latest is not children.spawned[0]
    assert passes == [1], f"the restart took {passes} supervision passes rather than one"

    # What a client saw across the whole thing: served, then refused, then served again by a
    # child that had to re-handshake and be re-validated to get there.
    assert served_before == [[TOOL["name"]]]
    assert served_while_dead == [None], "the endpoint kept answering for a child that was dead"
    assert served_after == [[TOOL["name"]]]
    # The child that came back did the whole conversation again: a fresh handshake and a
    # fresh validation before anything was served through it. What follows those three is
    # this test's own asking, which is why only the prefix is named.
    assert children.latest.methods[:3] == ["initialize", "notifications/initialized", "tools/list"]
