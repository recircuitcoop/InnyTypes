"""Reachability of Anytype's local API, asserted without Anytype running."""

from __future__ import annotations

import httpx

from anytype_mcp.config import ServerConfig
from anytype_mcp.health import is_api_reachable

FAKE_KEY = "test-key"


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
