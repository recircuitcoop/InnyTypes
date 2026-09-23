"""Bounded MCP requests over the private stdio pipes of the host-owned child."""

from __future__ import annotations

import json
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, BinaryIO, Protocol

from innytypes.anytype_mcp.protocol import MCP_PROTOCOL_VERSION
from innytypes.anytype_mcp.tools import load_tool_surface, tool_signature

MAX_FRAME_BYTES = 1024 * 1024
MAX_PENDING_REQUESTS = 8
REQUEST_TIMEOUT = 60.0


class SessionError(RuntimeError):
    """The child failed MCP framing, lifecycle or request handling."""


class SessionBusyError(SessionError):
    """The bounded pending-request set is full."""


class ToolSurfaceMismatchError(SessionError):
    """The live child differs from the reviewed committed tool surface."""


class ChildWithPipes(Protocol):
    stdin: BinaryIO
    stdout: BinaryIO


@dataclass
class _Pending:
    event: threading.Event = field(default_factory=threading.Event)
    response: dict[str, Any] | None = None
    error: SessionError | None = None


class McpSession:
    """One initialized MCP client session with one reader and serialized writes."""

    def __init__(
        self,
        process: ChildWithPipes,
        *,
        expected_signatures: Mapping[str, str] | None = None,
        max_frame_bytes: int = MAX_FRAME_BYTES,
        max_pending: int = MAX_PENDING_REQUESTS,
        request_timeout: float = REQUEST_TIMEOUT,
    ) -> None:
        self._stdin = process.stdin
        self._stdout = process.stdout
        self._expected = dict(
            load_tool_surface().tools if expected_signatures is None else expected_signatures
        )
        self._max_frame_bytes = max_frame_bytes
        self._max_pending = max_pending
        self._request_timeout = request_timeout
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._pending: dict[int, _Pending] = {}
        self._next_id = 1
        self._closed = False
        self.tools: tuple[dict[str, Any], ...] = ()
        self._reader = threading.Thread(target=self._read, name="anytype-mcp-reader", daemon=True)
        self._reader.start()

    @property
    def closed(self) -> bool:
        with self._state_lock:
            return self._closed

    def initialize(self) -> tuple[dict[str, Any], ...]:
        self.request(
            "initialize",
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "innytypes-host", "version": "1"},
            },
        )
        self.notify("notifications/initialized")
        result = self.request("tools/list")
        listed = result.get("tools")
        if not isinstance(listed, list) or not all(isinstance(tool, dict) for tool in listed):
            raise SessionError("the Anytype MCP child answered tools/list without a tool list")
        tools = tuple(dict(tool) for tool in listed)
        self._validate(tools)
        self.tools = tools
        return tools

    def ping(self) -> dict[str, Any]:
        """Ask the child MCP's own liveness question, and answer with what it replied.

        The cheapest question the protocol defines, over the same pipes a ``tools/call``
        already uses, so a ping that cannot get through is itself the news. Raises
        :class:`SessionError` when the child refuses it, answers nonsense, or says nothing
        within the time :meth:`request` already allows — and the caller's whole rule is
        that only a return from here counts as evidence the child is working (plan 0002,
        *The child promises a heartbeat, and the host keeps it*).

        **No timeout of its own**, deliberately. :meth:`request` already bounds every call
        at this session's ``request_timeout``, and a second number here would be a second
        answer to how long the child has to reply — with the two free to disagree on the
        day somebody changed one of them.
        """
        return self.request("ping")

    def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        with self._state_lock:
            if self._closed:
                raise SessionError("the Anytype MCP child session is closed")
            if len(self._pending) >= self._max_pending:
                raise SessionBusyError("the Anytype MCP child request bound is full")
            request_id = self._next_id
            self._next_id += 1
            pending = _Pending()
            self._pending[request_id] = pending

        message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = dict(params)
        try:
            self._write(message)
        except Exception:
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise

        wait_for = self._request_timeout if timeout is None else timeout
        if not pending.event.wait(wait_for):
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise SessionError(f"the Anytype MCP child timed out answering {method}")
        if pending.error is not None:
            raise pending.error
        response = pending.response or {}
        if "error" in response:
            error = response["error"]
            detail = error.get("message", "request refused") if isinstance(error, dict) else error
            raise SessionError(f"the Anytype MCP child refused {method}: {detail}")
        result = response.get("result")
        if not isinstance(result, dict):
            raise SessionError(f"the Anytype MCP child answered {method} without an object result")
        return result

    def notify(self, method: str, params: Mapping[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = dict(params)
        self._write(message)

    def close(self) -> None:
        self._fail(SessionError("the Anytype MCP child session closed"))

    def _write(self, message: Mapping[str, Any]) -> None:
        frame = json.dumps(message, separators=(",", ":")).encode() + b"\n"
        if len(frame) > self._max_frame_bytes:
            raise SessionError("an MCP request exceeds the child frame limit")
        with self._write_lock:
            with self._state_lock:
                if self._closed:
                    raise SessionError("the Anytype MCP child session is closed")
            try:
                self._stdin.write(frame)
                self._stdin.flush()
            except (OSError, ValueError) as error:
                failure = SessionError(f"could not write to the Anytype MCP child: {error}")
                self._fail(failure)
                raise failure from error

    def _read(self) -> None:
        while True:
            try:
                frame = self._stdout.readline(self._max_frame_bytes + 1)
            except (OSError, ValueError) as error:
                self._fail(SessionError(f"could not read from the Anytype MCP child: {error}"))
                return
            if not frame:
                self._fail(SessionError("the Anytype MCP child closed its output"))
                return
            if len(frame) > self._max_frame_bytes or not frame.endswith(b"\n"):
                self._fail(SessionError("the Anytype MCP child sent an oversized frame"))
                return
            try:
                message = json.loads(frame)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._fail(SessionError("the Anytype MCP child sent malformed JSON"))
                return
            if not isinstance(message, dict) or "id" not in message:
                continue
            request_id = message["id"]
            if not isinstance(request_id, int):
                self._fail(SessionError("the Anytype MCP child sent an invalid response id"))
                return
            with self._state_lock:
                pending = self._pending.pop(request_id, None)
            if pending is None:
                self._fail(SessionError("the Anytype MCP child answered an unknown request id"))
                return
            pending.response = message
            pending.event.set()

    def _fail(self, error: SessionError) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            pending = tuple(self._pending.values())
            self._pending.clear()
        for request in pending:
            request.error = error
            request.event.set()

    def _validate(self, tools: tuple[dict[str, Any], ...]) -> None:
        live: dict[str, str] = {}
        for tool in tools:
            name, schema = tool.get("name"), tool.get("inputSchema")
            if not isinstance(name, str) or not isinstance(schema, dict):
                raise SessionError("the Anytype MCP child returned an invalid tool definition")
            if name in live:
                raise SessionError(f"the Anytype MCP child returned duplicate tool {name}")
            live[name] = tool_signature(schema)
        if live == self._expected:
            return
        added = sorted(live.keys() - self._expected.keys())
        removed = sorted(self._expected.keys() - live.keys())
        changed = sorted(
            name
            for name in live.keys() & self._expected.keys()
            if live[name] != self._expected[name]
        )
        raise ToolSurfaceMismatchError(
            "live Anytype MCP tools differ from the committed surface: "
            f"added={added}, removed={removed}, changed={changed}"
        )
