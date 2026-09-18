"""Lifecycle of the Node child, asserted without Node being installed.

Every test here uses the harness from conftest.py, which injects both a fake spawn and a
fake health client. That is the point: the gate must be green on a clean clone where npm
has never run and Anytype has never been installed.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from conftest import FAKE_KEY, SupervisorHarness
from innytypes.anytype_mcp.config import PACKAGE_NAME
from innytypes.anytype_mcp.supervisor import SupervisorError

MakeSupervisor = Callable[..., SupervisorHarness]


def test_command_launches_the_exactly_pinned_package(make_supervisor: MakeSupervisor) -> None:
    harness = make_supervisor()

    assert harness.supervisor.command() == ["npx", "-y", f"{PACKAGE_NAME}@1.2.10"]


def test_start_passes_the_credential_through_the_environment(
    make_supervisor: MakeSupervisor,
) -> None:
    harness = make_supervisor()

    harness.supervisor.start()

    _argv, env = harness.spawns[0]
    assert "OPENAPI_MCP_HEADERS" in env
    assert FAKE_KEY in env["OPENAPI_MCP_HEADERS"]


def test_starting_twice_is_refused(make_supervisor: MakeSupervisor) -> None:
    harness = make_supervisor()
    harness.supervisor.start()

    with pytest.raises(SupervisorError):
        harness.supervisor.start()


def test_stop_terminates_and_clears_the_child(make_supervisor: MakeSupervisor) -> None:
    harness = make_supervisor()
    harness.supervisor.start()

    assert harness.supervisor.is_running
    assert harness.supervisor.stop() == 0
    assert not harness.supervisor.is_running


def test_stopping_when_nothing_runs_is_not_an_error(make_supervisor: MakeSupervisor) -> None:
    harness = make_supervisor()

    assert harness.supervisor.stop() is None
