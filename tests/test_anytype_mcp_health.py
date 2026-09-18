"""Reachability of Anytype's local API, and the start it gates, asserted without Anytype.

The second half of this file is about the gate rather than the check. A supervisor that
launches the Node server while the desktop app is absent produces a child that runs and
fails every tool call, which reads as a broken wrapper rather than as an app that is not
running. Reporting it once, at start, is the whole point.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from conftest import FAKE_KEY, SupervisorHarness
from innytypes.anytype_mcp.config import ServerConfig
from innytypes.anytype_mcp.health import is_api_reachable
from innytypes.anytype_mcp.supervisor import ApiUnreachableError, SupervisorError

MakeSupervisor = Callable[..., SupervisorHarness]


def client_returning(status_code: int) -> httpx.Client:
    transport = httpx.MockTransport(lambda request: httpx.Response(status_code))
    return httpx.Client(transport=transport)


def client_raising() -> httpx.Client:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    return httpx.Client(transport=httpx.MockTransport(boom))


def test_a_live_api_is_reachable() -> None:
    assert is_api_reachable(ServerConfig(api_key=FAKE_KEY), client=client_returning(200))


def test_an_unauthorized_api_is_still_reachable() -> None:
    # 401 means the app is up and the key is wrong. Different fix, different report.
    assert is_api_reachable(ServerConfig(api_key=FAKE_KEY), client=client_returning(401))


def test_a_refused_connection_is_not_an_exception() -> None:
    assert not is_api_reachable(ServerConfig(api_key=FAKE_KEY), client=client_raising())


def test_a_server_error_is_not_reachable() -> None:
    assert not is_api_reachable(ServerConfig(api_key=FAKE_KEY), client=client_returning(503))


def test_the_request_carries_the_pinned_api_version() -> None:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(record))
    is_api_reachable(ServerConfig(api_key=FAKE_KEY), client=client)

    assert seen[0].headers["Anytype-Version"] == "2025-11-08"


# --- the start gate ---------------------------------------------------------------------


def test_start_consults_the_injected_health_client(make_supervisor: MakeSupervisor) -> None:
    # If the supervisor opened its own client this list would stay empty and the test
    # machine would have had to answer on port 31009. It is the hermetic-gate proof.
    harness = make_supervisor(reachable=True)

    harness.supervisor.start()

    assert len(harness.health_requests) == 1
    assert harness.health_requests[0].url.host == "127.0.0.1"


def test_start_proceeds_when_the_api_answers(make_supervisor: MakeSupervisor) -> None:
    harness = make_supervisor(reachable=True)

    harness.supervisor.start()

    assert len(harness.spawns) == 1
    assert harness.supervisor.is_running


def test_start_refuses_when_the_api_is_unreachable(make_supervisor: MakeSupervisor) -> None:
    harness = make_supervisor(reachable=False)

    with pytest.raises(ApiUnreachableError):
        harness.supervisor.start()

    # The refusal has to happen before the spawn, or the "gate" is only a log line.
    assert harness.health_requests
    assert harness.spawns == []
    assert not harness.supervisor.is_running


def test_the_unreachable_error_is_a_supervisor_error() -> None:
    # Callers that only care that starting failed keep working; callers that want to say
    # "start Anytype" can distinguish it. Both need this to be true.
    assert issubclass(ApiUnreachableError, SupervisorError)


def test_the_unreachable_error_names_the_base_url_and_not_the_key(
    make_supervisor: MakeSupervisor,
) -> None:
    harness = make_supervisor(reachable=False)

    with pytest.raises(ApiUnreachableError) as caught:
        harness.supervisor.start()

    message = str(caught.value)
    assert harness.config.api_base_url in message
    assert FAKE_KEY not in message
    assert harness.config.openapi_mcp_headers() not in message


def test_the_unreachable_error_redacts_a_key_embedded_in_the_base_url(
    make_supervisor: MakeSupervisor,
) -> None:
    # ANYTYPE_API_BASE_URL is user-supplied, so "the URL is never secret" is an assumption
    # rather than a fact. An exception message is logged by whoever catches it.
    config = ServerConfig(api_key=FAKE_KEY, api_base_url=f"http://u:{FAKE_KEY}@127.0.0.1:31009")
    harness = make_supervisor(reachable=False, config=config)

    with pytest.raises(ApiUnreachableError) as caught:
        harness.supervisor.start()

    message = str(caught.value)
    assert FAKE_KEY not in message
    assert "127.0.0.1:31009" in message
