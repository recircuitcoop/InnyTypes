"""Lifecycle of the Node child, asserted without Node being installed.

Every test here injects a fake spawn. That is the point: the gate must be green on a
clean clone where npm has never run.
"""

from __future__ import annotations

import pytest

from innytypes.anytype_mcp.config import PACKAGE_NAME, ServerConfig
from innytypes.anytype_mcp.supervisor import Supervisor, SupervisorError

FAKE_KEY = "test-key"


class FakeProcess:
    """Enough of a Popen to drive the supervisor's state machine."""

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


def make_supervisor() -> tuple[Supervisor, list[tuple[list[str], dict[str, str]]]]:
    """A supervisor whose spawn records its arguments instead of launching anything."""
    calls: list[tuple[list[str], dict[str, str]]] = []

    def spawn(argv, env):  # type: ignore[no-untyped-def]
        calls.append((list(argv), dict(env)))
        return FakeProcess()

    return Supervisor(config=ServerConfig(api_key=FAKE_KEY), spawn=spawn), calls  # type: ignore[arg-type]


def test_command_launches_the_exactly_pinned_package() -> None:
    supervisor, _ = make_supervisor()

    assert supervisor.command() == ["npx", "-y", f"{PACKAGE_NAME}@1.2.10"]


def test_start_passes_the_credential_through_the_environment() -> None:
    supervisor, calls = make_supervisor()

    supervisor.start()

    _argv, env = calls[0]
    assert "OPENAPI_MCP_HEADERS" in env
    assert FAKE_KEY in env["OPENAPI_MCP_HEADERS"]


def test_starting_twice_is_refused() -> None:
    supervisor, _ = make_supervisor()
    supervisor.start()

    with pytest.raises(SupervisorError):
        supervisor.start()


def test_stop_terminates_and_clears_the_child() -> None:
    supervisor, _ = make_supervisor()
    supervisor.start()

    assert supervisor.is_running
    assert supervisor.stop() == 0
    assert not supervisor.is_running


def test_stopping_when_nothing_runs_is_not_an_error() -> None:
    supervisor, _ = make_supervisor()

    assert supervisor.stop() is None
