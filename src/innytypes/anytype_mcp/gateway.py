"""Authenticated Streamable HTTP MCP on a numeric loopback TCP endpoint."""

from __future__ import annotations

import contextlib
import hmac
import ipaddress
import json
import os
import secrets
import socket
import threading
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from innytypes.addons.secrets import CREDENTIALS_DIRECTORY, SECRET_DIRECTORY_MODE, SECRET_FILE_MODE
from innytypes.anytype_mcp.endpoint import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    MCP_PATH,
    GatewayError,
    checked_address,
    endpoint_url,
)
from innytypes.anytype_mcp.protocol import MCP_PROTOCOL_VERSION
from innytypes.anytype_mcp.session import McpSession, SessionError
from innytypes.helper.config import HelperSettings, McpEndpoint
from innytypes.logs import redact

# The two variables plan 0007 introduced. Named rather than spelled at each use, because a
# person now has to be *told* when one of them is being disregarded (plan 0008), and the
# panel that tells them must not invent its own spelling of the name it is reporting.
MCP_HOST_VARIABLE = "INNYTYPES_MCP_HOST"
MCP_PORT_VARIABLE = "INNYTYPES_MCP_PORT"
# What an unauthenticated GET to the endpoint is answered with. Named rather than written
# at the one call site because it is the service's only *identifying* answer to a request
# carrying no credential at all, and the helper's window recognises this installation's own
# endpoint by it (`innytypes.helper.launcher.observe_endpoint`). Change the sentence and the
# window would call its own service somebody else's program.
GET_REFUSAL = "GET not supported"
MAX_BODY_BYTES = 1024 * 1024
MAX_CONCURRENT_REQUESTS = 8
# Two time bounds, because one socket operation is not a request.
#
# REQUEST_TIMEOUT_SECONDS is `BaseHTTPRequestHandler.timeout`: how long a single socket read
# or write may take. It answers the client that announces a Content-Length and then says
# nothing at all, and nothing else — a client that sends one byte every fraction of a second
# keeps every individual read fast while its announced body never arrives, so eight such
# connections would hold every MAX_CONCURRENT_REQUESTS slot for as long as they kept
# dribbling.
#
# MAX_RECEIVE_SECONDS is the bound on the request itself: the request line, the headers and
# the body together, however the bytes are spaced out. It is what makes the time a client can
# occupy a slot finite. Neither bound applies to the child: the deadline is cancelled once the
# request has been read, so a tool call that legitimately takes longer inside the child is
# unaffected.
REQUEST_TIMEOUT_SECONDS = 15.0
MAX_RECEIVE_SECONDS = 30.0
TOKEN_FILE = CREDENTIALS_DIRECTORY / "mcp_proxy_token"


@dataclass(frozen=True)
class ConfiguredEndpoint:
    """The address this installation serves, and what it disregarded in order to say so.

    ``stored`` is true when any part of the address came from `[mcp]` in the helper's
    `config.toml`, and ``ignored_variables`` names every environment variable that was set
    and lost to it. Those two facts are here because the stored value **wins** (plan 0008):
    a setting that silently beats the environment is as confusing as one that silently loses
    to it, so the panel has to be able to say "``INNYTYPES_MCP_PORT`` is set and is not being
    used". They are carried on the answer rather than recomputed by whoever displays it,
    because a second reading of the same two sources is a second chance to disagree.
    """

    host: str
    port: int
    stored: bool = False
    ignored_variables: tuple[str, ...] = ()

    @property
    def url(self) -> str:
        return endpoint_url(self.host, self.port)


def configured_endpoint(
    env: Mapping[str, str] | None = None,
    *,
    settings: HelperSettings | None = None,
) -> ConfiguredEndpoint:
    """The address this installation is configured to serve: stored first, environment after.

    **One function, two processes.** The host binds what this returns
    (:func:`load_gateway_config`) and the helper's window shows what this returns
    (:func:`innytypes.helper.launcher.observe_endpoint`). They are separate processes, so the
    only way they can agree is to ask the same question of the same two sources through the
    same code — which is what this is, and why neither of them re-derives any part of it.

    **Why stored wins.** Plan 0007 read the address from ``INNYTYPES_MCP_HOST`` and
    ``INNYTYPES_MCP_PORT`` alone, which cannot be given to the application this project
    ships: a Briefcase bundle is started by clicking an icon. Plan 0008 makes the address a
    stored setting and puts it in front of the environment, because a person whose port is
    taken has to be able to move the endpoint from the application they are holding.

    **Key by key, not all or nothing.** A stored host beats ``INNYTYPES_MCP_HOST`` and a
    stored port beats ``INNYTYPES_MCP_PORT``, each on its own. Anything not stored falls back
    to its variable, and then to the documented default — so a machine that has never been
    configured behaves exactly as it did before this existed, variables and all.

    ``settings`` is the helper's live settings, and ``None`` means **consult no stored
    value**. It is not defaulted to this user's real `config.toml`: a function that reads the
    developer's own file when nobody asked it to is a function the test suite cannot be
    hermetic around. Production passes one — :func:`innytypes.host.build_host` and
    :func:`innytypes.helper.launcher.build_window` each hand over the one they already hold.
    """
    source = os.environ if env is None else env
    stored = McpEndpoint() if settings is None else settings.mcp
    ignored: list[str] = []

    if stored.host is not None:
        host = stored.host
        if MCP_HOST_VARIABLE in source:
            ignored.append(MCP_HOST_VARIABLE)
    else:
        host = source.get(MCP_HOST_VARIABLE, DEFAULT_HOST).strip() or DEFAULT_HOST

    if stored.port is not None:
        port = stored.port
        if MCP_PORT_VARIABLE in source:
            ignored.append(MCP_PORT_VARIABLE)
    else:
        raw_port = source.get(MCP_PORT_VARIABLE, str(DEFAULT_PORT)).strip()
        try:
            port = int(raw_port)
        except ValueError as error:
            raise GatewayError(f"{MCP_PORT_VARIABLE} must be a whole number") from error

    # Judged again even though a stored value was judged as it was written: the rule has one
    # gate, and a `config.toml` edited by hand between two runs never reaches the listener
    # unchecked.
    host, port = checked_address(host, port)
    return ConfiguredEndpoint(
        host=host,
        port=port,
        stored=stored.host is not None or stored.port is not None,
        ignored_variables=tuple(ignored),
    )


def configured_address(
    env: Mapping[str, str] | None = None,
    *,
    settings: HelperSettings | None = None,
) -> tuple[str, int]:
    """Just the address from :func:`configured_endpoint`, for callers with nothing to say."""
    endpoint = configured_endpoint(env, settings=settings)
    return endpoint.host, endpoint.port


@dataclass(frozen=True)
class GatewayConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    bearer_token: str = field(repr=False, default="")

    def __post_init__(self) -> None:
        checked_address(self.host, self.port)
        if not self.bearer_token:
            raise GatewayError("the MCP proxy bearer token is empty")

    @property
    def url(self) -> str:
        return endpoint_url(self.host, self.port)


def load_or_create_proxy_token(path: Path = TOKEN_FILE) -> str:
    """Read the persistent proxy token, creating it owner-only exactly once."""
    if path.is_file():
        try:
            token = path.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise GatewayError(
                f"could not read the MCP proxy token file {path}: {error}"
            ) from error
        if not token:
            raise GatewayError(f"the MCP proxy token file is empty: {path}")
        return token
    try:
        path.parent.mkdir(mode=SECRET_DIRECTORY_MODE, parents=True, exist_ok=True)
        os.chmod(path.parent, SECRET_DIRECTORY_MODE)
    except OSError as error:
        raise GatewayError(f"could not prepare the MCP proxy token directory: {error}") from error
    token = secrets.token_urlsafe(32)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, SECRET_FILE_MODE)
    except FileExistsError:
        return load_or_create_proxy_token(path)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            os.fchmod(descriptor, SECRET_FILE_MODE)
            handle.write(token)
    except OSError as error:
        raise GatewayError(f"could not store the MCP proxy token: {error}") from error
    return token


def load_gateway_config(
    env: Mapping[str, str] | None = None,
    *,
    token_file: Path = TOKEN_FILE,
    settings: HelperSettings | None = None,
) -> GatewayConfig:
    host, port = configured_address(env, settings=settings)
    return GatewayConfig(host=host, port=port, bearer_token=load_or_create_proxy_token(token_file))


SessionSource = Callable[[], McpSession | None]


def _redacted(value: Any) -> Any:
    """``value`` with every protected credential removed from every string inside it."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {_redacted(key): _redacted(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redacted(item) for item in value]
    return value


@contextlib.contextmanager
def _tolerating_a_client_that_left(handler: BaseHTTPRequestHandler) -> Iterator[None]:
    """Let a client that disconnected mid-answer end the request instead of raising.

    A client leaving before it reads its answer is an ordinary end to a request on a
    network surface, not a fault anyone can act on. Unguarded, the write reaches
    `socketserver.handle_error`, which prints a stack trace per dropped connection.
    """
    try:
        yield
    except (BrokenPipeError, ConnectionResetError):
        handler.close_connection = True


class _BoundedRequestHandler(BaseHTTPRequestHandler):
    """A handler whose whole request must arrive inside one finite deadline.

    The deadline covers the request line, the headers and the body together, and
    :meth:`receiving_complete` ends it as soon as the body has been read. What is bounded
    is how long a client may take to deliver a request, never how long the child may take
    to answer one.

    Expiry half-closes the connection rather than closing it: ending the read side alone
    finishes a read that is blocked or is being dribbled into, and leaves the write side
    able to carry the refusal back to the client.
    """

    # Set on the subclass `McpGateway.start` builds, from the module constant.
    receive_deadline: float = MAX_RECEIVE_SECONDS

    def handle_one_request(self) -> None:
        self._receiving = threading.Timer(self.receive_deadline, self._stop_receiving)
        self._receiving.daemon = True
        self._receiving.start()
        try:
            super().handle_one_request()
        finally:
            self.receiving_complete()

    def receiving_complete(self) -> None:
        """Stop applying the receive deadline to this request."""
        receiving = getattr(self, "_receiving", None)
        if receiving is not None:
            receiving.cancel()

    def _stop_receiving(self) -> None:
        # Where the half-close is unavailable the platform resets the connection instead,
        # which ends the read the harder way: the request fails rather than being answered
        # 408. The slot it was holding comes back either way, which is the bound this is
        # here for.
        with contextlib.suppress(OSError):
            self.connection.shutdown(socket.SHUT_RD)


class McpGateway:
    """One bounded HTTP listener whose tool backend follows the supervisor's live session."""

    def __init__(self, config: GatewayConfig, session: SessionSource) -> None:
        self.config = config
        self._session = session
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._slots = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)

    @property
    def is_running(self) -> bool:
        return self._server is not None

    def start(self) -> None:
        if self._server is not None:
            raise GatewayError("the MCP HTTP service is already running")
        gateway = self

        # Defined here rather than at module level, and deliberately. Both bounds below
        # are read from the module when a listener starts, which is what lets a test set
        # a workable value for them before `start()` and get a service that honours it —
        # a test that waited out 15 or 30 real seconds is a test nobody runs. Hoisting this
        # class would freeze both at import time and take that with it.
        class Handler(_BoundedRequestHandler):
            protocol_version = "HTTP/1.1"
            timeout = REQUEST_TIMEOUT_SECONDS
            receive_deadline = MAX_RECEIVE_SECONDS

            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
                gateway._post(self)

            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
                gateway._send_http(self, HTTPStatus.METHOD_NOT_ALLOWED, {"error": GET_REFUSAL})

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return

        # The family follows the configured address. `ThreadingHTTPServer` is IPv4 only, so
        # a numeric IPv6 loopback address — which `GatewayConfig` accepts — could otherwise be
        # configured and then never bind.
        class Server(ThreadingHTTPServer):
            address_family = socket.AF_INET6 if ":" in self.config.host else socket.AF_INET

        try:
            self._server = Server((self.config.host, self.config.port), Handler)
        except OSError as error:
            raise GatewayError(
                f"could not bind the MCP service at {self.config.host}:{self.config.port}: {error}"
            ) from error
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="innytypes-mcp-http",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        server, self._server = self._server, None
        if server is None:
            return
        server.shutdown()
        server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._thread = None

    def _post(self, handler: _BoundedRequestHandler) -> None:
        if handler.path != MCP_PATH:
            self._send_http(handler, HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if not self._trusted_host(handler.headers.get("Host", "")) or not self._trusted_origin(
            handler.headers.get("Origin")
        ):
            self._send_http(handler, HTTPStatus.FORBIDDEN, {"error": "loopback origin required"})
            return
        authorization = handler.headers.get("Authorization", "")
        expected = f"Bearer {self.config.bearer_token}"
        if not hmac.compare_digest(authorization, expected):
            self._send_http(
                handler,
                HTTPStatus.UNAUTHORIZED,
                {"error": "bearer authentication required"},
            )
            return
        raw_length = handler.headers.get("Content-Length", "")
        try:
            length = int(raw_length)
        except ValueError:
            self._send_http(
                handler, HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length required"}
            )
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self._send_http(
                handler, HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request too large"}
            )
            return
        if not self._slots.acquire(blocking=False):
            self._send_http(
                handler, HTTPStatus.TOO_MANY_REQUESTS, {"error": "request bound is full"}
            )
            return
        try:
            try:
                body = handler.rfile.read(length)
            except (OSError, ValueError):
                # The per-operation bound expired, or the receive deadline ended the read.
                body = b""
            finally:
                # The request is in, or is about to be refused. Either way the client has
                # stopped being the thing that decides how long this takes.
                handler.receiving_complete()
            if len(body) != length:
                # The announced body never arrived in full: nothing came, or it was dribbled
                # in past MAX_RECEIVE_SECONDS. Answered rather than dropped, and the
                # connection is finished with, so the slot released below is not held by a
                # client that has stopped talking.
                handler.close_connection = True
                self._send_http(handler, HTTPStatus.REQUEST_TIMEOUT, {"error": "request timed out"})
                return
            try:
                request = json.loads(body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_rpc(handler, None, error=(-32700, "invalid JSON"))
                return
            if not isinstance(request, dict):
                self._send_rpc(handler, None, error=(-32600, "invalid request"))
                return
            response = self._dispatch(request)
            if response is None:
                # A notification is answered with a status and no body at all. It does
                # not go through `_send_http`, so it carries its own copy of the guard —
                # `end_headers` writes straight to the socket and is where a departed
                # client's BrokenPipeError lands on this path.
                with _tolerating_a_client_that_left(handler):
                    handler.send_response(HTTPStatus.ACCEPTED)
                    handler.send_header("Content-Length", "0")
                    handler.end_headers()
            else:
                self._send_http(handler, HTTPStatus.OK, response, content_type="application/json")
        finally:
            self._slots.release()

    def _dispatch(self, request: dict[str, Any]) -> dict[str, Any] | None:
        request_id, method = request.get("id"), request.get("method")
        if method == "notifications/initialized":
            return None
        if method == "initialize":
            return self._rpc_result(
                request_id,
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "innytypes-anytype", "version": "1"},
                },
            )
        if method == "ping":
            return self._rpc_result(request_id, {})
        session = self._session()
        if session is None or session.closed:
            return self._rpc_error(request_id, -32000, "the Anytype MCP child is unavailable")
        if method == "tools/list":
            return self._rpc_result(request_id, {"tools": list(session.tools)})
        if method == "tools/call":
            params = request.get("params")
            if not isinstance(params, dict) or not isinstance(params.get("name"), str):
                return self._rpc_error(request_id, -32602, "tools/call requires a tool name")
            if params["name"] not in {tool.get("name") for tool in session.tools}:
                return self._rpc_error(request_id, -32602, "unknown Anytype tool")
            try:
                result = session.request("tools/call", params)
            except SessionError as error:
                return self._rpc_error(request_id, -32000, str(error))
            return self._rpc_result(request_id, result)
        return self._rpc_error(request_id, -32601, "method not found")

    def _trusted_host(self, value: str) -> bool:
        return value in {
            f"{self.config.host}:{self.config.port}",
            f"[{self.config.host}]:{self.config.port}",
        }

    def _trusted_origin(self, value: str | None) -> bool:
        # No `Origin` header is not a refusal. The header is something a browser attaches;
        # an ordinary MCP client sends none, and refusing those would refuse every intended
        # caller. So this allow-list constrains browsers, and what constrains everyone —
        # including a browser — is the bearer token above and `_trusted_host` beside it.
        if value is None:
            return True
        parsed = urlsplit(value)
        try:
            address = ipaddress.ip_address(parsed.hostname or "")
        except ValueError:
            return False
        return address.is_loopback and parsed.port == self.config.port

    @staticmethod
    def _rpc_result(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def _rpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    def _send_rpc(
        self,
        handler: BaseHTTPRequestHandler,
        request_id: Any,
        *,
        error: tuple[int, str],
    ) -> None:
        self._send_http(handler, HTTPStatus.OK, self._rpc_error(request_id, *error))

    @staticmethod
    def _send_http(
        handler: BaseHTTPRequestHandler,
        status: HTTPStatus,
        payload: dict[str, Any],
        *,
        content_type: str = "application/json",
    ) -> None:
        # The one place a credential can be removed from everything this service says.
        # Most of a response is composed by the child, which is the one process holding the
        # Anytype API key: a tool result, a live tool description and a refusal the child
        # quoted from its own upstream all reach the client through here. Redacting at each
        # of those call sites would leave the next one added as the one that forgets
        # (plan 0007, key-path).
        body = json.dumps(_redacted(payload), separators=(",", ":")).encode()
        with _tolerating_a_client_that_left(handler):
            handler.send_response(status)
            handler.send_header("Content-Type", content_type)
            handler.send_header("Content-Length", str(len(body)))
            handler.send_header("Cache-Control", "no-store")
            handler.end_headers()
            handler.wfile.write(body)
