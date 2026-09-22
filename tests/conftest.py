"""Shared fakes for the tests of ``innytypes.anytype_mcp``.

The gate runs on machines where Node is not installed and Anytype is not running, and that
is a contract rather than an accident of this laptop (docs/loop/SKILL.md, "the gate is
hermetic"). These fakes are how it is kept: a spawn that records its arguments instead of
launching a process, and an httpx transport that answers in-process instead of opening a
socket.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from itertools import count
from pathlib import Path

import httpx
import pytest

from innytypes.anytype_mcp.config import ServerConfig
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.helper import control

# A credential that exists only in this test suite. The word "fake" sits on the same line
# deliberately: that is the marker tests/test_no_secrets.py reads to tell a placeholder
# from a real leak.
FAKE_KEY = "fake-anytype-key-0123456789abcdef"


class FakeProcess:
    """Enough of a ``Popen`` to drive the supervisor's state machine."""

    def __init__(self) -> None:
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
        return self.returncode if self.returncode is not None else 0

    def exit_with(self, code: int) -> None:
        """Make the child look like it died on its own, with no signal from the supervisor."""
        self.returncode = code


@dataclass
class SupervisorHarness:
    """A supervisor wired to fakes, plus everything a test needs to assert about it."""

    supervisor: Supervisor
    config: ServerConfig
    # The (argv, environment) of every spawn the supervisor attempted.
    spawns: list[tuple[list[str], dict[str, str]]] = field(default_factory=list)
    # Every request the injected health client was asked to make.
    health_requests: list[httpx.Request] = field(default_factory=list)


@pytest.fixture
def make_supervisor() -> Iterator[Callable[..., SupervisorHarness]]:
    """Build supervisors that never spawn a process and never open a socket."""
    clients: list[httpx.Client] = []

    def _make(*, reachable: bool = True, config: ServerConfig | None = None) -> SupervisorHarness:
        harness_config = ServerConfig(api_key=FAKE_KEY) if config is None else config
        spawns: list[tuple[list[str], dict[str, str]]] = []
        health_requests: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            # Recorded before the refusal, so an unreachable API still proves the
            # supervisor consulted the injected client rather than the real network.
            health_requests.append(request)
            if not reachable:
                raise httpx.ConnectError("connection refused", request=request)
            return httpx.Response(200)

        client = httpx.Client(transport=httpx.MockTransport(handle))
        clients.append(client)

        def spawn(argv: Sequence[str], env: dict[str, str]) -> FakeProcess:
            spawns.append((list(argv), dict(env)))
            return FakeProcess()

        supervisor = Supervisor(
            config=harness_config,
            spawn=spawn,  # type: ignore[arg-type]
            health_client=client,
        )
        return SupervisorHarness(supervisor, harness_config, spawns, health_requests)

    yield _make

    for client in clients:
        client.close()


@pytest.fixture(scope="session")
def runtime_directory() -> Iterator[Path]:
    """A stand-in for the per-user runtime directory, short enough to hold a socket path.

    Not ``tmp_path``: a Unix domain socket path is limited to about 104 bytes on macOS and
    pytest's own temporary paths are most of that before a filename is added — the same
    constraint the heartbeat and control sockets' own tests already work around.
    """
    directory = Path(tempfile.mkdtemp(prefix="inny-rt-"))
    try:
        yield directory
    finally:
        shutil.rmtree(directory, ignore_errors=True)


_socket_names = count(1)


@pytest.fixture(autouse=True)
def control_socket_path(runtime_directory: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Where every test's control socket lives — never this machine's own.

    `innytypes up` connects to the helper's control socket as part of its own startup (plan
    0008, slice 03), and the path it dials is the per-user runtime directory's. On the
    machine of somebody who actually runs InnyTypes that is the socket a *live* helper is
    listening on, so a test invoking `up` would behave differently depending on whether the
    application happened to be open. Every test therefore gets a path of its own, and a test
    that wants both ends of the channel to meet asks for this one.

    Patched on the module rather than on its callers, so every production reader —
    :func:`~innytypes.helper.control.connect_to_helper` and
    :class:`~innytypes.helper.control.ControlListener` alike — is redirected by construction
    and nothing has to remember to pass a path.
    """
    path = runtime_directory / f"control-{next(_socket_names)}.sock"
    monkeypatch.setattr(control, "default_control_socket_path", lambda: path)
    yield path
    path.unlink(missing_ok=True)
