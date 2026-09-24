"""Shared fakes for the tests of ``innytypes.anytype_mcp``.

The gate runs on machines where Node is not installed and Anytype is not running, and that
is a contract rather than an accident of this laptop (docs/loop/SKILL.md, "the gate is
hermetic"). These fakes are how it is kept: a spawn that records its arguments instead of
launching a process, and an httpx transport that answers in-process instead of opening a
socket.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from itertools import count
from pathlib import Path

import httpx
import pytest

# First among the application's imports, and it has to be: it points the home directory at a
# scratch one before any `innytypes` module works a per-user path out (see its docstring).
import home_guard
from innytypes import logs
from innytypes.anytype_mcp.config import ServerConfig
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.helper import control, heartbeat

# A credential that exists only in this test suite. The word "fake" sits on the same line
# deliberately: that is the marker tests/test_no_secrets.py reads to tell a placeholder
# from a real leak.
FAKE_KEY = "fake-anytype-key-0123456789abcdef"

# `tests/test_home_guard.py` runs a whole pytest session of its own to watch the guard fail.
pytest_plugins = ["pytester"]


@pytest.fixture(autouse=True)
def nothing_written_into_a_real_home() -> Iterator[None]:
    """Fail the test after which anything was written into a home directory.

    Declared before every other automatic fixture, so it is set up first and torn down last:
    what another fixture's teardown writes is counted against the test that caused it too.
    """
    yield
    leaks = home_guard.collect_leaks()
    if leaks:
        pytest.fail(
            "this test wrote into a per-user home directory, which no test may touch:\n  "
            + "\n  ".join(leaks),
            pytrace=False,
        )


def pytest_sessionfinish(session: pytest.Session) -> None:
    """Fail the session for what was written outside any test — at import or collection."""
    leaks = home_guard.collect_leaks()
    home_guard.remove_sandbox()
    if leaks:
        print("\nwritten into a per-user home directory outside any test:\n  " + "\n  ".join(leaks))  # noqa: T201
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


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


@pytest.fixture(autouse=True)
def application_log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Where every test's application log lives — never this machine's own.

    `innytypes up`, every other CLI command and every addon process now attach to a log file
    as part of their own startup (plan 0012, slice 04), and the file they attach to is in the
    per-user log directory. On the machine of somebody who actually runs InnyTypes that is a
    file a *live* helper is appending to, so the gate would be writing into a real diagnostic
    record — and a test asserting on its contents would read somebody else's.

    Redirected three ways, because there are three ways a process finds the log and all three
    have to miss the real one:

    * :func:`innytypes.logs.default_log_path` is patched **on the module**, so every production
      reader is redirected by construction. That matters more than it looks:
      :func:`innytypes.children.default_addon_locations` reaches it through the module for
      exactly this reason, where a name imported at the top of that file would have been bound
      before the patch and would have gone on answering the real path;
    * :data:`~innytypes.logs.LOG_PATH_VARIABLE` is set, which is what a spawned child reads;
    * :data:`~innytypes.logs.LOG_LEVEL_VARIABLE` is set to `debug`, so what a test sees does
      not depend on what this machine's own `config.toml` happens to say.

    The package logger is put back afterwards. `start_logging` sets a level on it, and a level
    left behind would change how much a later test's `caplog` collects.
    """
    path = tmp_path / "gate-logs" / logs.LOG_FILENAME
    monkeypatch.setattr(logs, "default_log_path", lambda: path)
    monkeypatch.setenv(logs.LOG_PATH_VARIABLE, str(path))
    monkeypatch.setenv(logs.LOG_LEVEL_VARIABLE, "debug")

    package = logging.getLogger(logs.PACKAGE_LOGGER)
    level_before = package.level
    try:
        yield path
    finally:
        logs.stop_logging()
        package.setLevel(level_before)


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


@pytest.fixture(autouse=True)
def heartbeat_socket_path(
    runtime_directory: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Path]:
    """Where every test's heartbeat socket lives — never this machine's own.

    The pair of :func:`control_socket_path`, and needed for the same reason since plan 0010
    slice 02: `innytypes up` now beats on the MCP child's behalf, and the socket it beats on
    is the per-user runtime directory's. On the machine of somebody who actually runs
    InnyTypes that is a socket a *live* helper is listening on, so a test invoking `up`
    could put a beat about its own fake child into a real helper's registry. Every test gets
    a path of its own, and a test that wants both ends to meet asks for this one.

    Patched on the module for the same reason: both
    :class:`~innytypes.helper.heartbeat.HeartbeatListener` and
    :class:`~innytypes.helper.heartbeat.HeartbeatSender` read it there, so nothing has to
    remember to pass a path.
    """
    path = runtime_directory / f"beats-{next(_socket_names)}.sock"
    monkeypatch.setattr(heartbeat, "default_socket_path", lambda: path)
    yield path
    path.unlink(missing_ok=True)
