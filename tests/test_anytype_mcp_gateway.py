"""The public loopback MCP endpoint, with no Anytype, Node or Codex.

This is the only network-facing surface the application has, so most of what is asserted
here is a **refusal**: a bind that never happens, a header that is not believed, a token
that stopped working, a body that is too large, a ninth simultaneous request, a body that
never arrives. A refusal is the easiest behaviour in the world to pass by accident — a
service that never had the check looks exactly like one whose check works — so each one is
staged from the real cause and each asserts both halves: the bounded failure, and that the
child was never reached.

Nothing here needs Node, Anytype, a real credential or a fixed user port. Every listener
binds a kernel-assigned port on loopback, every child session is a fake that records what
it was asked, and the two credentials in the file are obviously-fake literals.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import logging
import socket
import struct
import threading
import time
import warnings
from collections.abc import Callable, Iterator
from http import HTTPStatus
from pathlib import Path
from typing import Any

import pytest

from conftest import FAKE_KEY
from innytypes import logs
from innytypes.anytype_mcp import gateway as gateway_module
from innytypes.anytype_mcp.config import API_KEY_ENV_VAR
from innytypes.anytype_mcp.endpoint import DEFAULT_HOST, DEFAULT_PORT
from innytypes.anytype_mcp.gateway import (
    MAX_BODY_BYTES,
    MAX_CONCURRENT_REQUESTS,
    GatewayConfig,
    GatewayError,
    McpGateway,
    configured_address,
    configured_endpoint,
    load_gateway_config,
    load_or_create_proxy_token,
)
from innytypes.anytype_mcp.protocol import MCP_PROTOCOL_VERSION
from innytypes.anytype_mcp.session import SessionError
from innytypes.helper.config import HelperSettings
from test_anytype_mcp_keys import leaks

TOKEN = "fake-mcp-proxy-token-0123456789"
TOOL = {"name": "get_object", "inputSchema": {"type": "object"}}
PING: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": "ping"}

# The finite header bounds this service has are the standard library's, and they are what
# answers 431. Named from `http.client` rather than copied, so a Python that moves them
# moves these tests with it. `_MAXHEADERS` counts the blank line that ends the block, so
# the last header a request may carry is the 99th.
MAX_HEADER_LINE_BYTES = http.client._MAXLINE
MAX_HEADERS = http.client._MAXHEADERS
FIXED_HEADERS = 3  # Host, Authorization and Content-Length, which every request carries.


class FakeSession:
    closed = False
    tools = (TOOL,)

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        assert method == "tools/call"
        return {"content": [{"type": "text", "text": params["name"]}]}


class RecordingSession:
    """A child session that records what it was asked instead of asking a child."""

    closed = False
    tools = (TOOL,)

    def __init__(self, error: SessionError | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.error = error

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((method, dict(params)))
        if self.error is not None:
            raise self.error
        return {"content": [{"type": "text", "text": params["name"]}]}


class LeakySession:
    """A child session whose every answer carries the Anytype API key.

    Three shapes, because a child answer has three ways to carry one out and only one of
    them is an exception. The pinned child turns a non-2xx Anytype response into a
    *successful* CallToolResult whose ``content[0].text`` is the upstream body
    (``@anyproto/anytype-mcp``, ``src/mcp/proxy.ts`` and ``src/client/http-client.ts``), so
    a refusal quoting a request header arrives as a result rather than as a raised
    ``SessionError`` — and a live tool description is copied out by ``tools/list`` without
    any refusal being involved at all.
    """

    closed = False

    def __init__(self, key: str, *, error: SessionError | None = None) -> None:
        self.tools = (
            {
                "name": "get_object",
                "description": f"Reads one object. Upstream sends Authorization: Bearer {key}",
                "inputSchema": {"type": "object", "properties": {"note": {"const": key}}},
            },
        )
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.error = error
        self._key = key

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((method, dict(params)))
        if self.error is not None:
            raise self.error
        return {
            "content": [{"type": "text", "text": f'401 {{"Authorization":"Bearer {self._key}"}}'}],
            "isError": True,
        }


class BlockingSession:
    """A child that holds one tool call open until the test lets it go.

    The only way to have a request that is genuinely *in flight* across a rebind: a real
    connection, past every header check, waiting inside the child while the listener that
    accepted it is taken away.
    """

    closed = False
    tools = (TOOL,)

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.entered.set()
        assert self.release.wait(timeout=20.0), "the test never released the child"
        return {"content": [{"type": "text", "text": params["name"]}]}


def free_port(host: str = "127.0.0.1") -> int:
    probe = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
    probe.bind((host, 0))
    port = probe.getsockname()[1]
    probe.close()
    return int(port)


def can_bind(host: str) -> bool:
    """Whether this machine has the address family ``host`` needs at all."""
    probe = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
    try:
        probe.bind((host, 0))
    except OSError:
        return False
    finally:
        probe.close()
    return True


class UnprovenAcceptance(UserWarning):
    """An acceptance bullet this machine was unable to put to the test."""


def skip_unproven(bullet: str, reason: str) -> None:
    """Skip, and say which acceptance bullet this machine therefore leaves unproven.

    A bare `pytest.skip` is how half a bullet disappears: on a host without the address
    family, the IPv6 half of "binds only the configured loopback address" simply stops
    being asserted, and a run that never mentions it reads exactly like a run that proved
    it. The warning is what a run still shows without `-rs`, so the gap is visible where
    the gate is read rather than only in the file.
    """
    warnings.warn(
        f"acceptance left unproven on this machine: {bullet} ({reason})",
        UnprovenAcceptance,
        stacklevel=2,
    )
    pytest.skip(f"{bullet}: {reason}")


@contextlib.contextmanager
def serving(
    session: Callable[[], Any] | None = None,
    *,
    token: str = TOKEN,
    host: str = "127.0.0.1",
) -> Iterator[tuple[McpGateway, int]]:
    """A started gateway on a kernel-assigned loopback port, always stopped again."""
    port = free_port(host)
    source = (lambda: FakeSession()) if session is None else session
    gateway = McpGateway(GatewayConfig(host=host, port=port, bearer_token=token), source)
    gateway.start()
    try:
        yield gateway, port
    finally:
        gateway.stop()


def request_head(
    port: int,
    *extra: str,
    length: int,
    token: str = TOKEN,
    host_header: str | None = None,
) -> bytes:
    """The bytes of one POST /mcp header block, spelled out header by header."""
    lines = [
        "POST /mcp HTTP/1.1",
        f"Host: 127.0.0.1:{port}" if host_header is None else f"Host: {host_header}",
        f"Authorization: Bearer {token}",
        f"Content-Length: {length}",
        *extra,
    ]
    return ("\r\n".join(lines) + "\r\n\r\n").encode()


def answer_to(port: int, request: bytes, *, timeout: float = 5.0) -> int:
    """The status code the service answers these exact bytes with.

    The code rather than the whole status line: Python 3.13 renamed 413's reason phrase
    from "Request Entity Too Large" to "Content Too Large", and what this file is asserting
    is the refusal, not the wording the standard library happens to ship.
    """
    connection = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        connection.sendall(request)
        status_line = connection.makefile("rb").readline().decode()
        return int(status_line.split()[1])
    finally:
        connection.close()


def post(port: int, payload: object, *, token: str = TOKEN) -> tuple[int, dict[str, Any]]:
    status, body = send(port, json.dumps(payload).encode(), token=token)
    return status, json.loads(body)


def send(
    port: int,
    body: bytes,
    *,
    token: str | None = TOKEN,
    headers: dict[str, str] | None = None,
    host: str = "127.0.0.1",
    timeout: float = 5.0,
) -> tuple[int, bytes]:
    """One POST to /mcp with full control of the headers, returning status and raw body."""
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    sent = {"Content-Type": "application/json"}
    if token is not None:
        sent["Authorization"] = f"Bearer {token}"
    sent.update(headers or {})
    try:
        connection.request("POST", "/mcp", body=body, headers=sent)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def converse(port: int, bodies: list[bytes], *, timeout: float = 10.0) -> list[tuple[int, Any]]:
    """Several POSTs down one kept-alive connection, in order.

    `http.client` opens a fresh connection per request, which is exactly what hides a
    connection the service has quietly stopped being able to read from.
    """
    connection = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        reader = connection.makefile("rb")
        answers: list[tuple[int, Any]] = []
        for body in bodies:
            connection.sendall(request_head(port, length=len(body)) + body)
            status_line = reader.readline().decode()
            assert status_line, "the service stopped answering on this connection"
            length = 0
            while (header := reader.readline()) not in (b"\r\n", b"\n", b""):
                name, _, value = header.decode().partition(":")
                if name.lower() == "content-length":
                    length = int(value.strip())
            answers.append((int(status_line.split()[1]), json.loads(reader.read(length))))
        return answers
    finally:
        connection.close()


def padded_ping(total: int) -> bytes:
    """A valid JSON-RPC ping whose encoded body is exactly ``total`` bytes long."""
    skeleton: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"pad": ""}}
    overhead = len(json.dumps(skeleton, separators=(",", ":")).encode())
    skeleton["params"] = {"pad": "p" * (total - overhead)}
    body = json.dumps(skeleton, separators=(",", ":")).encode()
    assert len(body) == total
    return body


# --- the address it may bind -------------------------------------------------------------


@pytest.mark.parametrize(
    "host",
    [
        "0.0.0.0",  # the IPv4 wildcard: every interface, including the LAN one
        "::",  # the IPv6 wildcard, which on many systems also accepts IPv4
        "localhost",  # a name, and a name is resolved by something this host does not own
        "127.0.0.1.nip.io",  # a name that resolves to loopback is still a name
        "192.168.1.2",  # a LAN address
        "10.0.0.5",  # another LAN address
        "93.184.216.34",  # a public address
        "",  # nothing at all
    ],
)
def test_gateway_refuses_every_non_numeric_non_loopback_bind(host: str) -> None:
    with pytest.raises(GatewayError):
        GatewayConfig(host=host, bearer_token=TOKEN)


@pytest.mark.parametrize("port", [0, -1, 65536])
def test_gateway_refuses_a_port_outside_the_range_a_socket_has(port: int) -> None:
    with pytest.raises(GatewayError, match="between 1 and 65535"):
        GatewayConfig(port=port, bearer_token=TOKEN)


def test_gateway_refuses_to_serve_without_a_proxy_token() -> None:
    """An empty token compares equal to an empty Authorization header — no token, no service."""
    with pytest.raises(GatewayError, match="token is empty"):
        GatewayConfig(bearer_token="")


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.2", "::1"])
def test_gateway_accepts_every_numeric_loopback_address(host: str) -> None:
    """Both families, and the whole 127/8 block — refused above, accepted here."""
    config = GatewayConfig(host=host, port=31010, bearer_token=TOKEN)

    assert config.host == host
    # An IPv6 address in a URL is bracketed or the port cannot be told from the address.
    expected = f"[{host}]" if ":" in host else host
    assert config.url == f"http://{expected}:31010/mcp"


@pytest.mark.parametrize("host", ["127.0.0.1", "::1"])
def test_each_accepted_loopback_address_actually_serves_the_endpoint(host: str) -> None:
    """Accepting an address the listener cannot bind would be a configuration that lies.

    `ThreadingHTTPServer` is IPv4-only as it comes, so `::1` was accepted by `GatewayConfig`
    and then refused by `start()` with "nodename nor servname provided" until the listener
    chose its family from the configured address.
    """
    if not can_bind(host):
        skip_unproven(
            f"the public service binds and serves the configured loopback address {host}",
            f"this machine cannot bind {host}",
        )

    with serving(host=host) as (gateway, port):
        status, body = send(port, json.dumps(PING).encode(), host=host)

    assert (status, json.loads(body)["result"]) == (200, {})
    assert gateway.config.url.endswith(f":{port}/mcp")


def test_proxy_token_is_persistent_and_owner_only(tmp_path: Path) -> None:
    path = tmp_path / "credentials" / "mcp_proxy_token"

    first = load_or_create_proxy_token(path)
    second = load_or_create_proxy_token(path)

    assert first == second
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700


def test_independent_http_client_lists_and_calls_tools() -> None:
    port = free_port()
    gateway = McpGateway(GatewayConfig(port=port, bearer_token=TOKEN), lambda: FakeSession())  # type: ignore[arg-type]
    gateway.start()
    try:
        status, initialized = post(
            port, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
        )
        assert status == 200
        assert initialized["result"]["capabilities"] == {"tools": {}}

        _, listed = post(port, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert listed["result"]["tools"] == [TOOL]

        _, called = post(
            port,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "get_object", "arguments": {}},
            },
        )
        assert called["result"]["content"][0]["text"] == "get_object"
    finally:
        gateway.stop()


def test_authentication_is_checked_before_the_body() -> None:
    port = free_port()
    gateway = McpGateway(GatewayConfig(port=port, bearer_token=TOKEN), lambda: FakeSession())  # type: ignore[arg-type]
    gateway.start()
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        connection.request(
            "POST",
            "/mcp",
            body=b"not-json",
            headers={"Authorization": "Bearer wrong", "Content-Length": "8"},
        )
        response = connection.getresponse()
        assert response.status == 401
        assert "invalid JSON" not in response.read().decode()
        connection.close()
    finally:
        gateway.stop()


def test_port_collision_is_named_and_never_moves_to_another_port() -> None:
    port = free_port()
    first = McpGateway(GatewayConfig(port=port, bearer_token=TOKEN), lambda: FakeSession())  # type: ignore[arg-type]
    second = McpGateway(GatewayConfig(port=port, bearer_token=TOKEN), lambda: FakeSession())  # type: ignore[arg-type]
    first.start()
    try:
        with pytest.raises(GatewayError, match=rf"127\.0\.0\.1:{port}"):
            second.start()
        assert not second.is_running
    finally:
        first.stop()


def test_unavailable_child_is_an_mcp_error_not_a_second_child() -> None:
    port = free_port()
    gateway = McpGateway(GatewayConfig(port=port, bearer_token=TOKEN), lambda: None)
    gateway.start()
    try:
        status, response = post(port, {"jsonrpc": "2.0", "id": 4, "method": "tools/list"})
        assert status == 200
        assert response["error"]["message"] == "the Anytype MCP child is unavailable"
    finally:
        gateway.stop()


# --- the two credentials -----------------------------------------------------------------


def test_rotating_the_proxy_token_refuses_the_value_it_replaced(tmp_path: Path) -> None:
    """Rotation is what disconnects a client that should no longer reach Anytype.

    A token file that is replaced but whose old value still works is not a rotation at all,
    and it is the failure nobody notices: every configured client keeps working, which is
    exactly what it looks like when the rotation worked.
    """
    path = tmp_path / "credentials" / "mcp_proxy_token"
    first = load_or_create_proxy_token(path)

    with serving(token=first) as (_, port):
        assert send(port, json.dumps(PING).encode(), token=first)[0] == 200

    path.unlink()
    second = load_or_create_proxy_token(path)

    assert second != first
    assert len(second) >= 32
    with serving(token=second) as (_, port):
        assert send(port, json.dumps(PING).encode(), token=first)[0] == 401
        assert send(port, json.dumps(PING).encode(), token=second)[0] == 200


def test_the_anytype_api_key_reaches_no_request_response_url_error_or_log(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    """The key stays with the child. Only the proxy token crosses this boundary.

    Every shape a child answer can take is staged, because the bullet is about the wire and
    not about one code path. A live tool definition and a tool result cross this boundary on
    the success path, with no refusal anywhere, and the child's own refusal for Anytype is a
    *result* rather than an exception (``LeakySession``). A version of this test staged only
    from the raised ``SessionError`` passed against a gateway that copied the other two out
    untouched, which is what it looks like when a test covers less than its name.
    """
    caplog.set_level(logging.DEBUG)
    # Registered exactly as `ServerConfig` registers it when the host reads the key.
    logs.protect(FAKE_KEY)
    refusal = SessionError(
        f'the Anytype MCP child refused tools/call: 401 {{"Authorization":"Bearer {FAKE_KEY}"}}'
    )
    environment = {API_KEY_ENV_VAR: FAKE_KEY, "INNYTYPES_MCP_PORT": str(free_port())}

    config = load_gateway_config(environment, token_file=tmp_path / "credentials" / "token")

    assert config.bearer_token != FAKE_KEY
    assert FAKE_KEY not in config.url
    assert FAKE_KEY not in repr(config)

    wire: list[bytes] = []

    def exchange(session: LeakySession) -> list[dict[str, Any]]:
        """initialize, tools/list and tools/call against one leaking session."""
        answers: list[dict[str, Any]] = []
        with serving(lambda: session) as (_, port):
            for payload in (
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "get_object"},
                },
            ):
                request = json.dumps(payload).encode()
                wire.append(request)
                _, response = send(port, request)
                wire.append(response)
                answers.append(json.loads(response))
        return answers

    answered = exchange(LeakySession(FAKE_KEY))
    raised = exchange(LeakySession(FAKE_KEY, error=refusal))

    # The live definitions `tools/list` copies out of the child, description and schema.
    listed = answered[1]["result"]["tools"][0]
    assert logs.REDACTED in listed["description"]
    assert listed["inputSchema"]["properties"]["note"]["const"] == logs.REDACTED
    # The successful call result, which is how an Anytype refusal actually comes back.
    assert logs.REDACTED in answered[2]["result"]["content"][0]["text"]
    # And the one shape that is an exception.
    assert raised[2]["error"]["code"] == -32000
    assert logs.REDACTED in raised[2]["error"]["message"]

    assert all(FAKE_KEY.encode() not in frame for frame in wire)
    assert leaks(FAKE_KEY, capsys, caplog) == []


# --- who is allowed to speak to it --------------------------------------------------------


@pytest.mark.parametrize(
    ("header", "value", "why"),
    [
        ("Host", "innytypes.attacker.example", "a name the browser was told is this service"),
        ("Host", "127.0.0.1:1", "the right address on a port this service does not own"),
        ("Host", "", "no Host at all"),
        ("Origin", "http://innytypes.attacker.example", "a page served by a real site"),
        ("Origin", "http://localhost:{port}", "a name rather than an address"),
        ("Origin", "http://127.0.0.1:1", "loopback, on another port"),
        ("Origin", "null", "an opaque origin"),
    ],
)
def test_a_request_from_anywhere_but_the_configured_endpoint_is_refused(
    header: str,
    value: str,
    why: str,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The DNS-rebinding path: a name that resolves to 127.0.0.1 and a page that follows it.

    ``why`` is unused by the assertions and is the point of each row: it is what the row
    stages, and a row nobody can read is a row nobody maintains.
    """
    caplog.set_level(logging.DEBUG)
    session = RecordingSession()

    with serving(lambda: session) as (_, port):
        status, body = send(
            port,
            json.dumps(PING).encode(),
            headers={header: value.format(port=port)},
        )

    assert status == 403
    # Refused before the child, and before either credential could be written anywhere.
    assert session.calls == []
    assert TOKEN.encode() not in body
    assert leaks(TOKEN, capsys, caplog) == []


def test_the_configured_loopback_origin_is_the_one_that_is_served() -> None:
    """The refusals above are worth nothing unless the allowed form actually works."""
    with serving() as (_, port):
        status, body = send(
            port,
            json.dumps(PING).encode(),
            headers={"Origin": f"http://127.0.0.1:{port}"},
        )

    assert (status, json.loads(body)["result"]) == (200, {})


# --- the complete Streamable HTTP exchange ------------------------------------------------


def test_the_whole_mcp_exchange_runs_and_preserves_every_json_rpc_id() -> None:
    """initialize, initialized, ping, tools/list, tools/call — in one client's session.

    The ids are deliberately not 1, 2, 3: a service that echoed a counter of its own would
    pass a sequential test and break every real client, which matches requests to responses
    by the id it chose.
    """
    session = RecordingSession()

    with serving(lambda: session) as (_, port):
        status, initialized = post(
            port, {"jsonrpc": "2.0", "id": "init-a", "method": "initialize", "params": {}}
        )
        assert status == 200
        assert initialized["id"] == "init-a"
        assert initialized["result"]["protocolVersion"] == MCP_PROTOCOL_VERSION
        assert initialized["result"]["capabilities"] == {"tools": {}}

        # A notification has no id and is answered with no body at all.
        accepted, empty = send(
            port, json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode()
        )
        assert (accepted, empty) == (202, b"")

        _, pinged = post(port, {"jsonrpc": "2.0", "id": 77, "method": "ping"})
        assert (pinged["id"], pinged["result"]) == (77, {})

        _, listed = post(port, {"jsonrpc": "2.0", "id": "list-1", "method": "tools/list"})
        assert (listed["id"], listed["result"]["tools"]) == ("list-1", [TOOL])

        _, called = post(
            port,
            {
                "jsonrpc": "2.0",
                "id": 91,
                "method": "tools/call",
                "params": {"name": "get_object", "arguments": {"id": "abc"}},
            },
        )
        assert (called["id"], called["result"]["content"][0]["text"]) == (91, "get_object")

        _, unknown = post(port, {"jsonrpc": "2.0", "id": "x-9", "method": "resources/list"})

    assert unknown == {
        "jsonrpc": "2.0",
        "id": "x-9",
        "error": {"code": -32601, "message": "method not found"},
    }
    assert [method for method, _params in session.calls] == ["tools/call"]
    assert session.calls[0][1]["arguments"] == {"id": "abc"}


@pytest.mark.parametrize(
    "params",
    [
        {"name": "delete_everything", "arguments": {}},
        {"name": "get_objectt"},
        {"arguments": {}},
        {"name": 7},
        "not-an-object",
    ],
)
def test_tools_call_refuses_an_unvalidated_name_before_the_child_hears_of_it(
    params: object,
) -> None:
    """The validated set is the whole authorisation model for what a client may run.

    So the assertion that matters is not the error code but ``session.calls``: a name that
    was checked *after* the call reached the child would already have mutated Anytype.
    """
    session = RecordingSession()

    with serving(lambda: session) as (_, port):
        _, response = post(
            port, {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": params}
        )

    assert response["error"]["code"] == -32602
    assert session.calls == []


def test_a_body_that_is_not_an_mcp_request_is_refused_as_json_rpc() -> None:
    """Malformed input gets a JSON-RPC error, not an HTTP one: the caller speaks MCP.

    And the id is null rather than invented — there is no id to echo when the body could
    not be read, and a made-up one would match a request the client never sent.
    """
    session = RecordingSession()

    with serving(lambda: session) as (_, port):
        status, malformed = send(port, b"{not json at all")
        _, wrong_shape = send(port, b'["jsonrpc", "2.0"]')

    assert status == 200
    assert json.loads(malformed) == {
        "jsonrpc": "2.0",
        "id": None,
        "error": {"code": -32700, "message": "invalid JSON"},
    }
    assert json.loads(wrong_shape)["error"]["code"] == -32600
    assert session.calls == []


def test_only_post_to_the_mcp_path_is_served() -> None:
    """One method and one path. Anything else is a client that is not speaking to us."""
    with serving() as (_, port):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request("GET", "/mcp", headers={"Authorization": f"Bearer {TOKEN}"})
            refused_method = connection.getresponse()
            refused_method.read()
        finally:
            connection.close()

        elsewhere = answer_to(
            port,
            b"POST /admin HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nContent-Length: 0\r\n\r\n" % port,
        )

    assert refused_method.status == HTTPStatus.METHOD_NOT_ALLOWED
    assert elsewhere == HTTPStatus.NOT_FOUND


def test_starting_a_running_service_is_refused_rather_than_binding_twice() -> None:
    with serving() as (gateway, _):
        with pytest.raises(GatewayError, match="already running"):
            gateway.start()
        assert gateway.is_running


# --- the four bounds ----------------------------------------------------------------------


def test_a_body_at_the_bound_is_served_and_one_byte_over_it_is_refused() -> None:
    with serving() as (_, port):
        status, body = send(port, padded_ping(MAX_BODY_BYTES))
        assert (status, json.loads(body)["result"]) == (200, {})

        # Announced, not sent: the refusal must come from the declared length, so an
        # oversized body is never read into this process at all.
        over = request_head(port, length=MAX_BODY_BYTES + 1)
        assert answer_to(port, over) == HTTPStatus.REQUEST_ENTITY_TOO_LARGE


def test_a_body_whose_length_is_not_a_number_is_refused() -> None:
    with serving() as (_, port):
        connection = socket.create_connection(("127.0.0.1", port), timeout=5)
        try:
            connection.sendall(
                f"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                f"Authorization: Bearer {TOKEN}\r\n\r\n".encode()
            )
            status_line = connection.makefile("rb").readline().decode()
        finally:
            connection.close()

    assert int(status_line.split()[1]) == HTTPStatus.LENGTH_REQUIRED


def test_a_header_block_at_the_bound_is_served_and_one_header_over_it_is_refused() -> None:
    body = json.dumps(PING).encode()
    # The blank line that ends the block counts against the standard library's bound, so
    # the last header a request may carry is the one before it.
    at_bound = [f"X-Pad-{index}: v" for index in range(MAX_HEADERS - FIXED_HEADERS - 1)]
    over_bound = [f"X-Pad-{index}: v" for index in range(MAX_HEADERS - FIXED_HEADERS)]

    with serving() as (_, port):
        served = answer_to(port, request_head(port, *at_bound, length=len(body)) + body)
        refused = answer_to(port, request_head(port, *over_bound, length=len(body)) + body)

    assert served == HTTPStatus.OK
    assert refused == HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE


def test_a_header_line_at_the_bound_is_served_and_one_byte_over_it_is_refused() -> None:
    body = json.dumps(PING).encode()
    overhead = len("X-Pad: \r\n")
    at_bound = "X-Pad: " + "v" * (MAX_HEADER_LINE_BYTES - overhead)
    over_bound = "X-Pad: " + "v" * (MAX_HEADER_LINE_BYTES - overhead + 1)

    with serving() as (_, port):
        served = answer_to(port, request_head(port, at_bound, length=len(body)) + body)
        refused = answer_to(port, request_head(port, over_bound, length=len(body)) + body)

    assert served == HTTPStatus.OK
    assert refused == HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE


def test_the_concurrency_bound_admits_its_full_count_and_refuses_the_next() -> None:
    """Eight calls in flight at once, and a ninth that is told so rather than queued.

    Queuing the ninth would be the quiet failure: a client that waits forever looks like a
    slow Anytype, and the bound that exists to stop this service being taken over by one
    misbehaving client would never be reached.
    """
    arrived = threading.Semaphore(0)
    finish = threading.Event()
    statuses: list[int] = []

    class BlockingSession:
        closed = False
        tools = (TOOL,)

        def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
            arrived.release()
            assert finish.wait(10), "the test released the calls"
            return {"content": [{"type": "text", "text": params["name"]}]}

    call = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_object"}}
    ).encode()

    with serving(lambda: BlockingSession()) as (_, port):

        def occupy() -> None:
            statuses.append(send(port, call, timeout=15)[0])

        threads = [
            threading.Thread(target=occupy, name=f"occupy-{index}", daemon=True)
            for index in range(MAX_CONCURRENT_REQUESTS)
        ]
        for thread in threads:
            thread.start()
        for _ in range(MAX_CONCURRENT_REQUESTS):
            assert arrived.acquire(timeout=10), "every admitted call reached the child"

        refused, body = send(port, call)
        assert (refused, json.loads(body)) == (429, {"error": "request bound is full"})

        finish.set()
        for thread in threads:
            thread.join(timeout=10)

        # The slots come back: the bound is a bound, not a fuse.
        assert send(port, json.dumps(PING).encode())[0] == 200

    assert statuses == [200] * MAX_CONCURRENT_REQUESTS


def test_a_body_that_never_arrives_times_out_and_gives_its_slot_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The silent half of the slow-loris path; the dribbling half is the test below.

    A client that announces a body and then says nothing held a handler thread and one of
    the ``MAX_CONCURRENT_REQUESTS`` slots for as long as it liked, so eight of them took
    the whole service down with no error anywhere. What answers this one is the
    per-operation bound, and that bound answers nothing else: a client that keeps sending
    is a client whose every read completes. The constant is shortened here because a test
    that waits out the real one is a test nobody runs — which works because the handler
    class is built when a listener starts and reads the constant then
    (`McpGateway._listen`, which `start` and `rebind` both go through).
    """
    monkeypatch.setattr(gateway_module, "REQUEST_TIMEOUT_SECONDS", 0.3)
    stalled: list[socket.socket] = []

    with serving() as (_, port):
        started = time.monotonic()
        for _ in range(MAX_CONCURRENT_REQUESTS):
            connection = socket.create_connection(("127.0.0.1", port), timeout=10)
            connection.sendall(request_head(port, length=64) + b'{"jsonrpc"')
            stalled.append(connection)

        answers = [
            int(connection.makefile("rb").readline().decode().split()[1]) for connection in stalled
        ]
        elapsed = time.monotonic() - started
        for connection in stalled:
            connection.close()

        # Every slot is back, so the service is still there for the next client.
        assert send(port, json.dumps(PING).encode())[0] == 200

    assert answers == [HTTPStatus.REQUEST_TIMEOUT] * MAX_CONCURRENT_REQUESTS
    assert elapsed < 5, f"the bound did not apply; the stalls took {elapsed:.1f}s"


def test_a_body_dribbled_a_byte_at_a_time_times_out_and_gives_its_slot_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The slow-loris variant a per-socket-operation bound cannot see.

    `BaseHTTPRequestHandler.timeout` bounds one read, and a client that sends a byte every
    fraction of a second keeps every one of those reads fast while its announced body never
    finishes. Eight of them held every `MAX_CONCURRENT_REQUESTS` slot for as long as they
    kept dribbling and a fresh client was answered 429 — the same denial as the silent
    variant above, reached by never being silent. `MAX_RECEIVE_SECONDS` bounds the request
    as a whole instead, so the slots come back whatever the spacing is.

    The per-operation bound is deliberately raised rather than shortened here: a pass must
    come from the request deadline, not from a socket read that happened to expire.
    """
    monkeypatch.setattr(gateway_module, "MAX_RECEIVE_SECONDS", 0.5)
    monkeypatch.setattr(gateway_module, "REQUEST_TIMEOUT_SECONDS", 30.0)
    stalled: list[socket.socket] = []
    dribblers: list[threading.Thread] = []
    stop = threading.Event()

    def dribble(connection: socket.socket) -> None:
        """One byte at a time, for as long as the service will listen."""
        while not stop.is_set():
            try:
                connection.sendall(b" ")
            except OSError:
                return  # answered and closed, which is the point of the test
            time.sleep(0.05)

    with serving() as (_, port):
        started = time.monotonic()
        for _ in range(MAX_CONCURRENT_REQUESTS):
            connection = socket.create_connection(("127.0.0.1", port), timeout=10)
            # A body announced and then delivered far too slowly to ever arrive.
            connection.sendall(request_head(port, length=MAX_BODY_BYTES))
            stalled.append(connection)
            dribbler = threading.Thread(target=dribble, args=(connection,), daemon=True)
            dribbler.start()
            dribblers.append(dribbler)

        answers = [
            int(connection.makefile("rb").readline().decode().split()[1]) for connection in stalled
        ]
        elapsed = time.monotonic() - started
        stop.set()
        for dribbler in dribblers:
            dribbler.join(timeout=5)
        for connection in stalled:
            connection.close()

        # Every slot is back, so the service is still there for the next client.
        assert send(port, json.dumps(PING).encode())[0] == 200

    assert answers == [HTTPStatus.REQUEST_TIMEOUT] * MAX_CONCURRENT_REQUESTS
    assert elapsed < 5, f"the request deadline did not apply; the dribbles took {elapsed:.1f}s"


def test_the_request_deadline_does_not_bound_a_slow_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The deadline is on the client's bytes, not on Anytype's answer.

    A call that outlives the deadline still has to come back, which is what makes the
    deadline a receive bound rather than a call bound — and it is what the expiry being a
    *half*-close buys: the read side is what ends, so the answer still has a way out. A
    full close or a shutdown of both directions would pass the dribbler test above and
    fail this one.
    """
    monkeypatch.setattr(gateway_module, "MAX_RECEIVE_SECONDS", 0.2)

    class SlowSession:
        closed = False
        tools = (TOOL,)

        def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
            time.sleep(0.6)  # three times the deadline this request is served under
            return {"content": [{"type": "text", "text": params["name"]}]}

    call = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_object"}}
    ).encode()

    with serving(lambda: SlowSession()) as (_, port):
        # Two calls down one connection: the second is what shows the deadline stopped
        # applying when the first request was read, rather than expiring inside the child
        # and taking the connection's read side with it.
        answers = converse(port, [call, call])

    assert [status for status, _ in answers] == [200, 200]
    assert [body["result"]["content"][0]["text"] for _, body in answers] == ["get_object"] * 2


def test_a_client_that_leaves_before_its_answer_is_not_a_traceback(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A disconnect is how requests end on a network surface, not a fault to report.

    Unguarded, writing an answer to a socket the client has gone from reaches
    `socketserver.handle_error`, which prints a stack trace per dropped connection. The
    slow-loris probing that produced the bounds above is exactly the traffic that produces
    those, and a log with a traceback in it for every client that pressed ctrl-c is a log
    nobody reads the real entries out of.
    """
    arrived = threading.Semaphore(0)
    gone = threading.Event()

    class WaitingSession:
        closed = False
        tools = (TOOL,)

        def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
            arrived.release()
            assert gone.wait(5), "the test let go of the call"
            return {"content": [{"type": "text", "text": params["name"]}]}

    call = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_object"}}
    ).encode()

    with serving(lambda: WaitingSession()) as (_, port):
        idle = set(threading.enumerate())
        connection = socket.create_connection(("127.0.0.1", port), timeout=5)
        # SO_LINGER with a zero timeout, so closing sends a reset rather than a polite
        # FIN: the answer then has demonstrably nowhere to go by the time it is written.
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        connection.sendall(request_head(port, length=len(call)) + call)
        assert arrived.acquire(timeout=5), "the call reached the child"

        connection.close()
        gone.set()

        # The handler thread ends after anything it prints has been printed, so waiting for
        # it is what makes the assertion below about this service rather than about timing.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and set(threading.enumerate()) - idle:
            time.sleep(0.02)
        assert not set(threading.enumerate()) - idle, "the abandoned handler never finished"

        # And the slot it was holding came back, the same as for any other ending.
        assert send(port, json.dumps(PING).encode())[0] == 200

    assert "Traceback" not in capsys.readouterr().err


def test_a_notification_from_a_client_that_leaves_is_not_a_traceback(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The same ending, on the service's other write path.

    A notification is answered with a bare 202 rather than through `_send_http`, so its
    write is a second place a departed client gets written to, and a guard that is correct
    only by symmetry with the tested one is the assumption this round has already caught
    twice elsewhere.

    Nothing on the notification path reaches the child, so there is nothing in the service
    to hold the request open against. The barrier is a subclass that waits inside
    `_dispatch` and then calls it: `_post`, its 202 branch and the guard on it are exactly
    what ships, and all the subclass decides is when the client gets to leave.
    """
    arrived = threading.Semaphore(0)
    gone = threading.Event()

    class PausingGateway(McpGateway):
        def _dispatch(self, request: dict[str, Any]) -> dict[str, Any] | None:
            arrived.release()
            assert gone.wait(5), "the test let go of the notification"
            return super()._dispatch(request)

    notification = json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode()
    port = free_port()
    gateway = PausingGateway(GatewayConfig(port=port, bearer_token=TOKEN), lambda: FakeSession())  # type: ignore[arg-type]
    gateway.start()
    try:
        idle = set(threading.enumerate())
        connection = socket.create_connection(("127.0.0.1", port), timeout=5)
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        connection.sendall(request_head(port, length=len(notification)) + notification)
        assert arrived.acquire(timeout=5), "the notification reached the service"

        connection.close()
        gone.set()

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and set(threading.enumerate()) - idle:
            time.sleep(0.02)
        assert not set(threading.enumerate()) - idle, "the abandoned handler never finished"

        # And the slot the notification was holding came back, the same as for any answer.
        assert send(port, json.dumps(PING).encode())[0] == 200
    finally:
        gateway.stop()

    assert "Traceback" not in capsys.readouterr().err


# --- shutdown ------------------------------------------------------------------------------


def test_shutdown_closes_the_listener_and_leaves_no_thread_or_bound_port_behind() -> None:
    """What "stopped" has to mean, or the next start collides with the last one.

    The host stops the gateway before it stops the child (``Host.shutdown``), so by the time
    the child goes there is nothing left that could take a request for it.
    """
    before = set(threading.enumerate())
    port = free_port()
    gateway = McpGateway(GatewayConfig(port=port, bearer_token=TOKEN), lambda: FakeSession())
    gateway.start()
    assert send(port, json.dumps(PING).encode())[0] == 200

    gateway.stop()

    assert not gateway.is_running
    with pytest.raises(OSError):
        send(port, json.dumps(PING).encode(), timeout=2)

    # The port is free for whoever wants it next, including the next InnyTypes.
    reclaim = socket.socket()
    reclaim.bind(("127.0.0.1", port))
    reclaim.close()

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        left = [thread for thread in threading.enumerate() if thread not in before]
        if not left:
            break
        time.sleep(0.05)
    assert [thread.name for thread in threading.enumerate() if thread not in before] == []

    # Stopping a stopped service is not an error: shutdown runs on paths that already failed.
    gateway.stop()


# --- the stored address wins over the environment (plan 0008, slice 01) -----------------------


def helper_settings(tmp_path: Path, document: str = "") -> HelperSettings:
    """Helper settings over a `config.toml` of this test's own, never the real one.

    A fresh file per call, because several of these tests compare a configured machine with
    an unconfigured one and a shared path would make the second half read the first half's
    setting.
    """
    path = tmp_path / f"config-{len(list(tmp_path.glob('config-*.toml')))}.toml"
    path.write_text(document, encoding="utf-8")
    return HelperSettings(path)


def stored_endpoint(tmp_path: Path, host: str, port: int) -> HelperSettings:
    return helper_settings(tmp_path, f'[mcp]\nhost = "{host}"\nport = {port}\n')


def unconfigured(tmp_path: Path) -> HelperSettings:
    return helper_settings(tmp_path)


def test_nothing_stored_leaves_the_environment_in_charge(tmp_path: Path) -> None:
    """An existing installation changes nothing until someone edits the setting.

    This is the compatibility promise of plan 0008 in one assertion: with no `[mcp]` section
    the reading is plan 0007's reading, variables and defaults alike.
    """
    settings = unconfigured(tmp_path)
    port = free_port()

    assert configured_address({"INNYTYPES_MCP_PORT": str(port)}, settings=settings) == (
        "127.0.0.1",
        port,
    )
    assert configured_address(
        {"INNYTYPES_MCP_HOST": "::1", "INNYTYPES_MCP_PORT": str(port)}, settings=settings
    ) == ("::1", port)
    assert configured_address({}, settings=settings) == (DEFAULT_HOST, DEFAULT_PORT)
    # And the same answer with no settings at all, which is what a caller that has none gets.
    assert configured_address({"INNYTYPES_MCP_PORT": str(port)}) == ("127.0.0.1", port)


def test_a_stored_address_beats_the_environment(tmp_path: Path) -> None:
    """The owner's decision: the setting wins, because one that loses cannot be used.

    The variables cannot be given to a Briefcase bundle started from an icon, so a stored
    value that lost to them would leave the person this plan exists for with no way to move
    their endpoint.
    """
    settings = stored_endpoint(tmp_path, "127.0.0.2", 32010)

    assert configured_address(
        {"INNYTYPES_MCP_HOST": "127.0.0.3", "INNYTYPES_MCP_PORT": "31999"}, settings=settings
    ) == ("127.0.0.2", 32010)


def test_the_variable_that_is_being_ignored_is_named(tmp_path: Path) -> None:
    """A setting that silently beats the environment is as confusing as one that loses.

    Slice 04 puts this sentence on the screen. What this slice owes it is the fact, and the
    fact has to name the variable rather than say "something" — a person who set
    `INNYTYPES_MCP_PORT` in a login script needs to know which one stopped mattering.
    """
    settings = stored_endpoint(tmp_path, "127.0.0.2", 32010)

    both = configured_endpoint(
        {"INNYTYPES_MCP_HOST": "127.0.0.3", "INNYTYPES_MCP_PORT": "31999"}, settings=settings
    )
    assert both.stored
    assert both.ignored_variables == ("INNYTYPES_MCP_HOST", "INNYTYPES_MCP_PORT")

    # A variable that is not set is not being ignored, and neither is anything when nothing
    # is stored.
    assert configured_endpoint({}, settings=settings).ignored_variables == ()
    untouched = configured_endpoint(
        {"INNYTYPES_MCP_PORT": "31999"}, settings=unconfigured(tmp_path)
    )
    assert not untouched.stored
    assert untouched.ignored_variables == ()


def test_each_key_wins_on_its_own(tmp_path: Path) -> None:
    """A stored port does not quietly take the address with it.

    Storing one key and having the other silently revert to `127.0.0.1` would move a person
    off an `INNYTYPES_MCP_HOST` they set deliberately, the first time they touched the port.
    """
    settings = helper_settings(tmp_path, "[mcp]\nport = 32010\n")

    endpoint = configured_endpoint(
        {"INNYTYPES_MCP_HOST": "127.0.0.3", "INNYTYPES_MCP_PORT": "31999"}, settings=settings
    )

    assert (endpoint.host, endpoint.port) == ("127.0.0.3", 32010)
    assert endpoint.ignored_variables == ("INNYTYPES_MCP_PORT",)


def test_a_stored_port_survives_an_unreadable_environment_variable(tmp_path: Path) -> None:
    """A variable nobody is reading cannot break the address that is being read.

    Without the precedence, `INNYTYPES_MCP_PORT=thirty-one-thousand` refuses the whole
    configuration. With a stored port it is simply not consulted, and a person with a stale
    variable in a shell profile is not locked out of their own setting.
    """
    settings = stored_endpoint(tmp_path, "127.0.0.1", 32010)

    assert configured_address({"INNYTYPES_MCP_PORT": "thirty-one-thousand"}, settings=settings) == (
        "127.0.0.1",
        32010,
    )
    # And with nothing stored it is still the refusal plan 0007 documented.
    with pytest.raises(GatewayError, match="INNYTYPES_MCP_PORT must be a whole number"):
        configured_address(
            {"INNYTYPES_MCP_PORT": "thirty-one-thousand"}, settings=unconfigured(tmp_path)
        )


def test_the_listener_binds_what_the_one_reader_answered(tmp_path: Path) -> None:
    """`load_gateway_config` is not a second reading: it is the same one, plus a token."""
    settings = stored_endpoint(tmp_path, "127.0.0.1", 32010)
    environment = {"INNYTYPES_MCP_HOST": "127.0.0.3", "INNYTYPES_MCP_PORT": "31999"}

    config = load_gateway_config(
        environment, token_file=tmp_path / "credentials" / "token", settings=settings
    )

    assert (config.host, config.port) == configured_address(environment, settings=settings)
    assert config.url == configured_endpoint(environment, settings=settings).url


# --- moving a live listener (plan 0008, slice 02) -----------------------------------------
#
# One rule, and every test below is an angle on it: bind the new address while the old one
# is still serving, and close the old one only afterwards. That ordering is what makes a
# change that cannot be served *free* — a mistyped port costs a person a message, not the
# MCP endpoint their clients are configured against.

# The name `McpGateway` gives its serving thread. Counted rather than merely looked for,
# because "no thread left behind" is a statement about how many there are.
LISTENER_THREAD = "innytypes-mcp-http"


def listener_threads() -> set[threading.Thread]:
    """Every live gateway serving thread in this process, by the name the gateway gives it."""
    return {thread for thread in threading.enumerate() if thread.name == LISTENER_THREAD}


@contextlib.contextmanager
def occupied(host: str = "127.0.0.1") -> Iterator[int]:
    """A loopback port some other program is really listening on.

    Listening, not merely bound: `SO_REUSEADDR` forgives a second bind against some
    half-closed states, and a collision the kernel forgives is not the collision a person
    meets when their port is genuinely in use.
    """
    port = free_port(host)
    blocker = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
    blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    blocker.bind((host, port))
    blocker.listen(1)
    try:
        yield port
    finally:
        blocker.close()


def free_again(port: int, host: str = "127.0.0.1") -> None:
    """Assert nothing holds this address, by taking it — the only honest way to ask.

    A refused connection would say the same thing about a listener that exists and is
    merely busy, and nothing at all about a socket bound without `listen`.
    """
    reclaim = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
    reclaim.bind((host, port))
    reclaim.close()


def test_a_rebind_moves_the_endpoint_and_the_old_address_stops_answering() -> None:
    """The plain case: the service is somewhere else afterwards, and only somewhere else.

    Asserting the new address alone would pass against a gateway that put up a second
    listener and left the first one running, which is two endpoints where a person asked
    for one — so the old address is asserted to be free, not merely unused.
    """
    with serving() as (gateway, old_port):
        assert post(old_port, PING) == (200, {"jsonrpc": "2.0", "id": 1, "result": {}})
        new_port = free_port()

        moved = gateway.rebind("127.0.0.1", new_port)

        assert (moved.host, moved.port) == ("127.0.0.1", new_port)
        assert (gateway.config.host, gateway.config.port) == ("127.0.0.1", new_port)
        # What the panel will tell a person to configure their client with (slice 04).
        assert gateway.config.url == f"http://127.0.0.1:{new_port}/mcp"
        assert gateway.is_running

        # The same service, the same token, a different address.
        assert post(new_port, PING) == (200, {"jsonrpc": "2.0", "id": 1, "result": {}})
        called = post(
            new_port,
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": TOOL["name"]}},
        )
        assert called[1]["result"]["content"][0]["text"] == TOOL["name"]

        # And the old one is refused by the TCP stack, because nothing is there any more.
        with pytest.raises(OSError):
            send(old_port, json.dumps(PING).encode(), timeout=2)
        free_again(old_port)


def test_the_new_listener_already_serves_at_the_moment_the_old_one_stops_accepting() -> None:
    """The ordering as an ordering, not as two facts that happen to both be true.

    "The new one is bound" and "the old one is closed", asserted separately after the move,
    are both true of a gateway that closes first and binds second — the arrangement where a
    bind that fails has already cost the endpoint. So the new address is spoken to from
    *inside* the old listener's own "stop accepting", which is the one moment the ordering
    exists to be observed. A close-then-bind gateway reaches this hook with nothing yet
    listening on the new port and the sample is a refused connection.
    """
    with serving() as (gateway, old_port):
        new_port = free_port()
        old_server = gateway._server
        assert old_server is not None
        stop_accepting = old_server.shutdown
        sampled: list[tuple[int, Any]] = []

        def sampling_shutdown() -> None:
            try:
                sampled.append(post(new_port, PING))
            except OSError as error:
                # Recorded rather than raised, so the failure reads as "the new listener
                # was not there yet" instead of as a connection error out of nowhere.
                sampled.append((0, repr(error)))
            stop_accepting()

        old_server.shutdown = sampling_shutdown  # type: ignore[method-assign]

        gateway.rebind("127.0.0.1", new_port)

        # A full JSON-RPC answer, not just an accepted connection: at the moment the old
        # listener was told to stop, the new one already held its socket *and* was serving.
        assert sampled == [(200, {"jsonrpc": "2.0", "id": 1, "result": {}})]
        # And the old address is gone, which is the other half of the move.
        with pytest.raises(OSError):
            send(old_port, json.dumps(PING).encode(), timeout=2)


@pytest.mark.parametrize(
    ("host", "port", "reason"),
    [
        ("localhost", None, "numeric loopback"),  # a name is resolved by something we own
        ("127.0.0.1.nip.io", None, "numeric loopback"),  # a name resolving to loopback is a name
        ("", None, "numeric loopback"),  # nothing at all
        ("0.0.0.0", None, "must be loopback"),  # the wildcard: every interface, LAN included
        ("::", None, "must be loopback"),  # the IPv6 wildcard
        ("192.168.1.2", None, "must be loopback"),  # a LAN address
        ("93.184.216.34", None, "must be loopback"),  # a public address
        ("127.0.0.1", 0, "between 1 and 65535"),  # port 0 is "kernel, you choose"
        ("127.0.0.1", 65536, "between 1 and 65535"),
    ],
)
def test_an_unservable_rebind_is_refused_with_its_reason_and_closes_nothing(
    host: str, port: int | None, reason: str
) -> None:
    """Every address this service may not serve, refused without costing the one it serves.

    Port 0 is in the list on purpose: it is the way a caller asks the kernel to pick a port,
    and a gateway that accepted it would move the endpoint to an address nobody was told
    about — the fallback plan 0007 forbids, arriving through the front door.
    """
    with serving() as (gateway, old_port):
        before = gateway.config
        target = free_port() if port is None else port

        with pytest.raises(GatewayError, match=reason):
            gateway.rebind(host, target)

        # Nothing was closed: the same configuration, the same running listener, and a real
        # exchange on the address that was working before the refusal.
        assert gateway.config is before
        assert gateway.is_running
        assert post(old_port, PING) == (200, {"jsonrpc": "2.0", "id": 1, "result": {}})


def test_a_rebind_onto_a_taken_port_is_refused_and_no_other_port_is_chosen() -> None:
    """The collision a person actually hits, and the fallback they must never get.

    Plan 0007's rule survives the move: the port a client was told about is the port, or
    there is no service. A gateway that answered a busy port by quietly taking a free one
    would leave every configured client reaching nothing while the host reported success.
    """
    with serving() as (gateway, old_port):
        listeners = listener_threads()
        with occupied() as blocked_port:
            with pytest.raises(
                GatewayError, match=f"could not bind .*127\\.0\\.0\\.1:{blocked_port}"
            ):
                gateway.rebind("127.0.0.1", blocked_port)

            # The address is in the reason, because "the port is taken" without saying
            # which port leaves a person nothing to change.
            assert (gateway.config.host, gateway.config.port) == ("127.0.0.1", old_port)
            assert gateway.is_running
            assert post(old_port, PING) == (200, {"jsonrpc": "2.0", "id": 1, "result": {}})
            # No second listener was put up anywhere, on any port.
            assert listener_threads() == listeners

        # And it did not take the contested port the moment the other program let it go.
        free_again(blocked_port)


def test_a_rebind_cannot_move_a_service_that_is_not_running() -> None:
    """There is no listener to move, and inventing one would be a start in disguise.

    Starting is `start`, and it is the host that decides when that happens (`Host.start`).
    A rebind that silently started a service the host had deliberately not started — after
    a port collision, say — would put the endpoint up behind the host's back.
    """
    gateway = McpGateway(GatewayConfig(port=free_port(), bearer_token=TOKEN), lambda: FakeSession())

    with pytest.raises(GatewayError, match="not running"):
        gateway.rebind("127.0.0.1", free_port())

    assert not gateway.is_running


def test_a_request_already_received_finishes_across_the_move() -> None:
    """The move does not cost the request that was in flight when it began.

    Both halves matter and they pull opposite ways: the old listener has to stop accepting
    *immediately* — a connection opened to it after the move must be refused, not accepted
    by a listener that is going away — while the request it had already taken in has to run
    to its answer. Asserting only the refusal would pass against a gateway that dropped
    in-flight work; asserting only the answer would pass against one that kept the old
    address alive.
    """
    session = BlockingSession()
    with serving(lambda: session) as (gateway, old_port):
        new_port = free_port()
        answers: list[tuple[int, Any]] = []
        call = {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": TOOL["name"]},
        }

        def in_flight() -> None:
            status, body = send(old_port, json.dumps(call).encode(), timeout=30.0)
            answers.append((status, json.loads(body)))

        caller = threading.Thread(target=in_flight, name="in-flight-call", daemon=True)
        caller.start()
        assert session.entered.wait(timeout=10.0), "the call never reached the child"

        gateway.rebind("127.0.0.1", new_port)

        # Still inside the child, and the old listener is already refusing everyone else.
        assert caller.is_alive()
        with pytest.raises(OSError):
            send(old_port, json.dumps(PING).encode(), timeout=2)
        # The new address is serving other clients while the old request is still running.
        assert post(new_port, PING) == (200, {"jsonrpc": "2.0", "id": 1, "result": {}})

        session.release.set()
        caller.join(timeout=20.0)

        assert not caller.is_alive()
        assert answers == [
            (
                200,
                {
                    "jsonrpc": "2.0",
                    "id": 7,
                    "result": {"content": [{"type": "text", "text": TOOL["name"]}]},
                },
            )
        ]


def test_neither_a_completed_nor_a_refused_rebind_leaves_anything_behind() -> None:
    """One listener before, one listener after, whichever way the rebind went.

    A move that left the old serving thread running, or a refusal that left a half-built
    listener behind, both look exactly like success from the outside — until the next
    start, or the next rebind, meets a port that is still held.
    """
    outsiders = listener_threads()
    with serving() as (gateway, old_port):
        started = listener_threads() - outsiders
        assert len(started) == 1
        (first,) = started

        gateway.rebind("127.0.0.1", free_port())

        # The old thread is gone rather than merely outnumbered, and exactly one replaced it.
        assert not first.is_alive()
        after_move = listener_threads() - outsiders
        assert len(after_move) == 1 and first not in after_move
        free_again(old_port)

        with occupied() as blocked_port, pytest.raises(GatewayError):
            gateway.rebind("127.0.0.1", blocked_port)

        assert listener_threads() - outsiders == after_move

    assert listener_threads() - outsiders == set()
