"""The private child session, exercised over real duplex pipes without Node.

Plan 0007 puts every one of its guarantees on a *failure* path: a child that answers late,
answers twice, answers nothing, or dies mid-call. So the fake here is a protocol fake
rather than a stub — it records the exact frames the host wrote, in order, and leaves the
replies to the test, which is the only way to assert correlation, bounds and teardown.

Nothing here runs ``npx``, opens a socket to Anytype or reads a real credential. The pipes
are a ``socketpair``, and the one key in play is ``conftest.FAKE_KEY``.
"""

from __future__ import annotations

import json
import logging
import re
import socket
import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import suppress
from typing import Any

import pytest

from conftest import FAKE_KEY, SupervisorHarness
from innytypes.anytype_mcp.protocol import MCP_PROTOCOL_VERSION
from innytypes.anytype_mcp.session import (
    McpSession,
    SessionBusyError,
    SessionError,
    ToolSurfaceMismatchError,
)
from innytypes.anytype_mcp.supervisor import SupervisorError
from innytypes.anytype_mcp.tools import load_tool_surface, tool_signature
from innytypes.host import anytype_tools
from test_anytype_mcp_keys import leaks

SCHEMA = {"type": "object", "properties": {"id": {"type": "string"}}}
TOOL = {"name": "get_object", "description": "Gets one object", "inputSchema": SCHEMA}
OTHER_SCHEMA = {"type": "object", "properties": {"query": {"type": "string"}}}
OTHER_TOOL = {"name": "search_objects", "description": "Finds objects", "inputSchema": OTHER_SCHEMA}

# The committed surface the live child is judged against, in the shape `load_tool_surface`
# would hand over.
SURFACE = {"get_object": tool_signature(SCHEMA)}
CALL_RESULT = {"content": [{"type": "text", "text": "called"}]}

# The three ways a live child can disagree with the committed record: a tool too many, one
# too few, one reshaped. Shared, because two separate things must hold for each of them —
# the child is refused, and the catalogue an addon reads is left alone.
MISMATCHES = [
    ([TOOL, OTHER_TOOL], SURFACE, r"added=\['search_objects'\]"),
    ([TOOL], {**SURFACE, "search_objects": tool_signature(OTHER_SCHEMA)}, r"removed="),
    ([TOOL], {"get_object": tool_signature({"type": "object"})}, r"changed="),
]
MISMATCH_IDS = ["added", "removed", "changed"]

Answer = Callable[[dict[str, Any]], dict[str, Any] | None]
MakeChild = Callable[..., "FakeChild"]
MakeSupervisor = Callable[..., SupervisorHarness]


def answering(tools: list[dict[str, Any]]) -> Answer:
    """What the pinned child replies: a handshake, a tool list, then a call result."""

    def answer(request: dict[str, Any]) -> dict[str, Any]:
        method = request["method"]
        result = (
            {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}}
            if method == "initialize"
            else {"tools": tools}
            if method == "tools/list"
            else CALL_RESULT
        )
        return {"jsonrpc": "2.0", "id": request["id"], "result": result}

    return answer


class FakeChild:
    """The Node child, replaced by a protocol fake speaking over a real socket pair.

    It is two things at once, deliberately: the object the session reads and writes
    (``stdin``/``stdout``), and the handle the supervisor terminates (``poll``/
    ``terminate``/``wait``). One object means a supervisor test can assert both the
    conversation and the lifecycle without correlating two fakes.

    A background thread records every frame the host wrote into :attr:`received`, in
    order. Replies are the test's business: pass ``answer`` for an automatic one, or call
    :meth:`send` to answer by hand — which is what the ordering, bounds and teardown tests
    need, because none of them is expressible as a well-behaved child.
    """

    def __init__(self, answer: Answer | None = None) -> None:
        self._host_socket, self._child_socket = socket.socketpair()
        self.stdin = self._host_socket.makefile("wb")
        self.stdout = self._host_socket.makefile("rb")
        self.received: list[dict[str, Any]] = []
        self.raw_received: list[bytes] = []
        self.returncode: int | None = None
        self.terminated = False
        self.killed = False
        # Called from ``terminate``, so a test can observe what was already true at the
        # moment the child was signalled — the only way to assert an ordering between the
        # supervisor closing the session and killing the process.
        self.on_terminate: Callable[[], None] | None = None
        self._answer = answer
        self._stream = self._child_socket.makefile("rwb")
        self._arrived = threading.Condition()
        self._thread = threading.Thread(target=self._serve, name="fake-child", daemon=True)
        self._thread.start()

    # --- the child side of the pipe -------------------------------------------------

    def _serve(self) -> None:
        try:
            while line := self._stream.readline():
                with self._arrived:
                    self.raw_received.append(line)
                    self.received.append(self._decode(line))
                    message = self.received[-1]
                    self._arrived.notify_all()
                if self._answer is not None and "id" in message:
                    reply = self._answer(message)
                    if reply is not None:
                        self.send(reply)
        except (OSError, ValueError):
            # The host or the test closed the pipe. Nothing left to serve.
            return

    @staticmethod
    def _decode(line: bytes) -> dict[str, Any]:
        try:
            decoded = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}
        return decoded if isinstance(decoded, dict) else {}

    def send(self, message: Mapping[str, Any]) -> None:
        self.send_raw(json.dumps(message, separators=(",", ":")).encode() + b"\n")

    def send_raw(self, frame: bytes) -> None:
        self._stream.write(frame)
        self._stream.flush()

    def wait_for(self, count: int, timeout: float = 5.0) -> None:
        """Block until the host has written ``count`` frames, so ids are deterministic."""
        with self._arrived:
            arrived = self._arrived.wait_for(lambda: len(self.received) >= count, timeout)
        assert arrived, f"the fake child never received {count} frames: {self.received}"

    @property
    def methods(self) -> list[str | None]:
        return [message.get("method") for message in self.received]

    def close_output(self) -> None:
        """End the child's stdout only — EOF for the reader, with stdin still writable."""
        self._child_socket.shutdown(socket.SHUT_WR)

    def die(self, returncode: int = 3) -> None:
        """The child process is gone: both pipe directions severed, an exit code waiting."""
        self.returncode = returncode
        self._sever()

    def _sever(self) -> None:
        """What the end of a process does to its pipes: both directions, at once.

        A shutdown rather than a close, because the socket is still referenced by the
        buffered files over it — closing it would leave a blocked reader parked on a
        descriptor that is not actually gone, which no dead child ever does.
        """
        with suppress(OSError, ValueError):
            self._child_socket.shutdown(socket.SHUT_RDWR)

    def close(self) -> None:
        """End both directions so every reader sees EOF, then release the sockets.

        Only the raw sockets are touched, never the buffered files over them: closing a
        ``BufferedReader`` takes the same lock a blocked ``readline`` is holding, so a
        teardown that closed the file while a reader was still parked would hang the
        suite instead of failing it.
        """
        self._sever()
        with suppress(OSError, ValueError):
            self._host_socket.shutdown(socket.SHUT_RDWR)
        self._thread.join(timeout=5)
        for released in (self._child_socket, self._host_socket):
            with suppress(OSError, ValueError):
                released.close()

    # --- the process side, for the supervisor ---------------------------------------

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        if self.on_terminate is not None:
            self.on_terminate()
        if self.returncode is None:
            self.returncode = 0
        self._sever()

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9
        self._sever()

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode if self.returncode is not None else 0


class Caller(threading.Thread):
    """One ``request`` call held open on its own thread.

    Correlation and the pending bound are only observable with several calls in flight at
    once, and ``request`` blocks. So each call gets a thread that keeps whatever came
    back — a result or the failure — for the test to read afterwards.
    """

    def __init__(
        self,
        session: McpSession,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(name=f"caller-{method}", daemon=True)
        self.session = session
        self.method = method
        self.params = params
        self.result: dict[str, Any] | None = None
        self.error: Exception | None = None

    def run(self) -> None:
        try:
            self.result = self.session.request(self.method, self.params)
        except Exception as error:  # noqa: BLE001 - the failure is the assertion
            self.error = error

    def settle(self, timeout: float = 5.0) -> None:
        self.join(timeout)
        assert not self.is_alive(), f"{self.method} never returned"


def reply(request_id: int, result: Mapping[str, Any] | None = None) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": dict(result or CALL_RESULT)}


def padded_reply_frame(request_id: int, size: int) -> bytes:
    """A well-formed reply frame of exactly ``size`` bytes, trailing newline included."""

    def frame(pad: str) -> bytes:
        message = {"jsonrpc": "2.0", "id": request_id, "result": {"pad": pad}}
        return json.dumps(message, separators=(",", ":")).encode() + b"\n"

    padding = size - len(frame(""))
    assert padding >= 0, f"a reply frame cannot be as short as {size} bytes"
    return frame("x" * padding)


def request_frame(request_id: int, method: str, params: Mapping[str, Any]) -> bytes:
    """The bytes ``McpSession.request`` writes for this call, built the same way it does."""
    message = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)}
    return json.dumps(message, separators=(",", ":")).encode() + b"\n"


def left_behind(session: McpSession, settle: float = 5.0) -> tuple[bool, int]:
    """Whether the reader thread is still alive, and how many futures remain registered.

    Both are private attributes, read on purpose. The criterion is about what a failed
    session *leaves behind*, and a thread that should no longer exist has no public
    accessor — asserting on a proxy for it would be asserting on something else.

    ``settle`` is how long to give a reader that is expected to end. A caller asserting
    that the reader is still running passes ``0``, so the check costs nothing.
    """
    session._reader.join(timeout=settle)
    return session._reader.is_alive(), len(session._pending)


def assert_torn_down(session: McpSession, child: FakeChild, callers: Sequence[Caller]) -> None:
    """Every pending call failed, the session closed, nothing was left running or retried."""
    sent = len(child.received)
    for caller in callers:
        caller.settle()
        assert isinstance(caller.error, SessionError), f"{caller.method} was not failed"
        assert caller.result is None

    assert session.closed
    assert left_behind(session) == (False, 0)

    # A tool call may mutate Anytype, so a silent second attempt is a correctness bug.
    # After teardown the session refuses rather than resends, and the child hears nothing.
    with pytest.raises(SessionError, match="session is closed"):
        session.request("tools/call", {"name": "get_object"})
    assert len(child.received) == sent


@pytest.fixture
def make_child() -> Iterator[MakeChild]:
    """Build protocol fakes and take their sockets and threads down afterwards."""
    children: list[FakeChild] = []

    def _make(answer: Answer | None = None) -> FakeChild:
        child = FakeChild(answer)
        children.append(child)
        return child

    yield _make

    for child in children:
        child.close()


@pytest.fixture
def make_session(make_child: MakeChild) -> Iterator[Callable[..., McpSession]]:
    """Build sessions over a fake child and close them, so no reader outlives its test."""
    sessions: list[McpSession] = []

    def _make(child: FakeChild, **bounds: Any) -> McpSession:
        session = McpSession(child, expected_signatures={}, **bounds)
        sessions.append(session)
        return session

    yield _make

    for session in sessions:
        session.close()


def supervised(
    harness: SupervisorHarness,
    child: FakeChild,
    expected: Mapping[str, str],
) -> list[McpSession]:
    """Point ``harness``'s supervisor at ``child`` and give it a real session over its pipes.

    The conftest harness already injects the health client and the credential; only the
    spawn and the session factory change, because this file is about what happens on the
    pipes that spawn returns.
    """
    sessions: list[McpSession] = []

    def spawn(argv: Sequence[str], env: dict[str, str]) -> FakeChild:
        harness.spawns.append((list(argv), dict(env)))
        return child

    def session_factory(process: Any) -> McpSession:
        session = McpSession(process, expected_signatures=expected)
        sessions.append(session)
        return session

    harness.supervisor.spawn = spawn  # type: ignore[assignment]
    harness.supervisor.session_factory = session_factory
    return sessions


# --- the handshake ----------------------------------------------------------------------


def test_session_initializes_validates_and_calls_the_existing_child(
    make_child: MakeChild,
) -> None:
    child = make_child(answering([TOOL]))
    session = McpSession(child, expected_signatures=SURFACE)

    assert session.initialize() == (TOOL,)
    assert session.request("tools/call", {"name": "get_object", "arguments": {"id": "x"}}) == (
        CALL_RESULT
    )

    session.close()


def test_starting_the_supervisor_spawns_one_child_and_hands_it_the_handshake_in_order(
    make_supervisor: MakeSupervisor,
    make_child: MakeChild,
) -> None:
    harness = make_supervisor()
    child = make_child(answering([TOOL]))
    sessions = supervised(harness, child, SURFACE)

    harness.supervisor.start()

    assert len(harness.spawns) == 1
    assert harness.spawns[0][0] == ["npx", "-y", harness.config.package_spec]
    assert child.methods == ["initialize", "notifications/initialized", "tools/list"]
    # The middle message is a notification, so it carries no id and expects no reply; the
    # two requests do, and they are distinct.
    assert "id" not in child.received[1]
    assert child.received[0]["id"] != child.received[2]["id"]
    assert {message["jsonrpc"] for message in child.received} == {"2.0"}
    assert child.received[0]["params"]["protocolVersion"] == MCP_PROTOCOL_VERSION
    assert sessions[0].tools == (TOOL,)
    assert harness.supervisor.session is sessions[0]


# --- the committed surface --------------------------------------------------------------


def test_session_refuses_a_live_schema_that_differs_from_the_record(
    make_child: MakeChild,
) -> None:
    child = make_child(answering([TOOL]))
    expected = tool_signature({"type": "object", "properties": {}})
    session = McpSession(child, expected_signatures={"get_object": expected})

    with pytest.raises(ToolSurfaceMismatchError, match=r"changed=\['get_object'\]"):
        session.initialize()

    session.close()


@pytest.mark.parametrize(("live", "expected", "detail"), MISMATCHES, ids=MISMATCH_IDS)
def test_a_live_tool_surface_that_differs_is_named_and_stops_the_child(
    make_supervisor: MakeSupervisor,
    make_child: MakeChild,
    live: list[dict[str, Any]],
    expected: Mapping[str, str],
    detail: str,
) -> None:
    harness = make_supervisor()
    child = make_child(answering(live))
    sessions = supervised(harness, child, expected)

    with pytest.raises(SupervisorError) as raised:
        harness.supervisor.start()

    cause = raised.value.__cause__
    assert isinstance(cause, ToolSurfaceMismatchError)
    assert re.search(detail, str(cause)), str(cause)
    # The child is not left running behind a session that was never allowed to exist.
    assert child.terminated
    assert not harness.supervisor.is_running
    assert harness.supervisor.session is None
    assert sessions[0].tools == ()


@pytest.mark.parametrize(("live", "expected", "detail"), MISMATCHES, ids=MISMATCH_IDS)
def test_a_live_tool_surface_that_differs_does_not_change_the_committed_catalogue(
    make_supervisor: MakeSupervisor,
    make_child: MakeChild,
    live: list[dict[str, Any]],
    expected: Mapping[str, str],
    detail: str,
) -> None:
    """A disagreeing child is evidence for a refresh, never a better answer for an addon.

    Plan 0002 states it as an invariant — "a live server's surface never supersedes the
    committed one" — and plan 0007 restates it as the second half of its surface-validation
    acceptance. It is the half nothing else asserts: the mismatch tests above prove the
    child is refused, and this one proves the refusal did not also quietly rewrite what
    ``innytypes.host.anytype_tools()`` tells every addon the tools are.
    """
    before = anytype_tools()
    harness = make_supervisor()
    child = make_child(answering(live))
    supervised(harness, child, expected)

    with pytest.raises(SupervisorError) as raised:
        harness.supervisor.start()
    assert isinstance(raised.value.__cause__, ToolSurfaceMismatchError)

    after = anytype_tools()
    committed = load_tool_surface()
    assert dict(after.signatures) == dict(committed.tools)
    assert after.names == before.names
    assert after.names, "an empty catalogue would satisfy every comparison above"
    assert (after.package_version, after.anytype_version) == (
        before.package_version,
        before.anytype_version,
    )
    assert (after.source, after.captured_at) == (before.source, before.captured_at)
    # Neither of this file's invented tools is in the committed record, so however the live
    # child disagreed — a tool too many, one too few, one reshaped — none of it got through.
    assert {TOOL["name"], OTHER_TOOL["name"]}.isdisjoint(after.names)


def test_a_tools_list_that_is_not_a_list_of_tools_is_refused(make_child: MakeChild) -> None:
    def answer(request: dict[str, Any]) -> dict[str, Any]:
        result = (
            {"protocolVersion": MCP_PROTOCOL_VERSION}
            if request["method"] == "initialize"
            else {"tools": "all of them"}
        )
        return {"jsonrpc": "2.0", "id": request["id"], "result": result}

    child = make_child(answer)
    session = McpSession(child, expected_signatures=SURFACE)

    with pytest.raises(SessionError, match="without a tool list"):
        session.initialize()

    session.close()


def test_a_tool_without_a_name_and_a_schema_is_refused(make_child: MakeChild) -> None:
    child = make_child(answering([{"description": "a tool that says nothing about itself"}]))
    session = McpSession(child, expected_signatures=SURFACE)

    with pytest.raises(SessionError, match="invalid tool definition"):
        session.initialize()

    session.close()


def test_two_live_tools_sharing_one_name_are_refused(make_child: MakeChild) -> None:
    # A surface is a mapping, so a duplicate would silently overwrite its twin and the
    # comparison against the committed record would pass on half the truth.
    child = make_child(answering([TOOL, TOOL]))
    session = McpSession(child, expected_signatures=SURFACE)

    with pytest.raises(SessionError, match="duplicate tool get_object"):
        session.initialize()

    session.close()


# --- what one call can be told ----------------------------------------------------------


def test_a_refusal_from_the_child_is_raised_with_its_message(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)
    caller = Caller(session, "tools/call")
    caller.start()
    child.wait_for(1)

    child.send(
        {
            "jsonrpc": "2.0",
            "id": child.received[0]["id"],
            "error": {"code": -32602, "message": "no such object"},
        }
    )

    caller.settle()
    assert isinstance(caller.error, SessionError)
    assert "refused tools/call: no such object" in str(caller.error)
    # One refused call is not a broken connection.
    assert not session.closed


def test_a_result_that_is_not_an_object_is_refused(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)
    caller = Caller(session, "tools/call")
    caller.start()
    child.wait_for(1)

    child.send({"jsonrpc": "2.0", "id": child.received[0]["id"], "result": ["not", "an", "object"]})

    caller.settle()
    assert isinstance(caller.error, SessionError)
    assert "without an object result" in str(caller.error)


def test_a_frame_carrying_no_id_is_ignored_rather_than_fatal(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)
    caller = Caller(session, "tools/call")
    caller.start()
    child.wait_for(1)

    # A server-initiated notification, and a frame that is not even an object. Neither
    # answers anything, and neither is a reason to tear a working session down.
    child.send({"jsonrpc": "2.0", "method": "notifications/progress"})
    child.send_raw(b'"a bare string"\n')
    child.send(reply(child.received[0]["id"]))

    caller.settle()
    assert caller.result == CALL_RESULT
    assert not session.closed


# --- correlation ------------------------------------------------------------------------


def test_concurrent_calls_receive_the_reply_matching_their_own_id(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)

    first = Caller(session, "tools/call", {"name": "first"})
    first.start()
    child.wait_for(1)
    second = Caller(session, "tools/call", {"name": "second"})
    second.start()
    child.wait_for(2)

    assert child.received[0]["params"]["name"] == "first"
    assert child.received[1]["params"]["name"] == "second"

    # Answered in the opposite order: last asked, first told.
    child.send(reply(child.received[1]["id"], {"for": "second"}))
    child.send(reply(child.received[0]["id"], {"for": "first"}))
    first.settle()
    second.settle()

    assert first.result == {"for": "first"}
    assert second.result == {"for": "second"}
    assert first.error is None and second.error is None


def test_a_notification_carries_its_parameters_and_stops_with_the_session(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)

    session.notify("notifications/cancelled", {"requestId": 7})
    child.wait_for(1)

    assert child.received[0] == {
        "jsonrpc": "2.0",
        "method": "notifications/cancelled",
        "params": {"requestId": 7},
    }
    assert "id" not in child.received[0]

    session.close()
    # Writes stop with the session too — a notification is not a way around a closed one.
    with pytest.raises(SessionError, match="session is closed"):
        session.notify("notifications/cancelled", {"requestId": 8})
    assert len(child.received) == 1


# --- the bounds -------------------------------------------------------------------------


def test_a_request_frame_at_the_size_bound_is_sent(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child(answering([TOOL]))
    params = {"pad": "x" * 200}
    frame = request_frame(1, "tools/call", params)
    session = make_session(child, max_frame_bytes=len(frame))

    assert session.request("tools/call", params) == CALL_RESULT
    assert child.raw_received[0] == frame


def test_a_request_frame_over_the_size_bound_is_refused_without_closing_the_session(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child(answering([TOOL]))
    params = {"pad": "x" * 200}
    session = make_session(child, max_frame_bytes=len(request_frame(1, "tools/call", params)) - 1)

    with pytest.raises(SessionError, match="exceeds the child frame limit"):
        session.request("tools/call", params)

    assert child.received == [], "an over-long frame must never reach the child"
    # The refusal belongs to the one call, not to the connection: a smaller call still works.
    assert not session.closed
    assert session.request("tools/call", {"name": "get_object"}) == CALL_RESULT
    assert left_behind(session, settle=0) == (True, 0)


def test_a_reply_frame_at_the_size_bound_is_delivered(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child, max_frame_bytes=200)
    caller = Caller(session, "tools/call")
    caller.start()
    child.wait_for(1)

    child.send_raw(padded_reply_frame(child.received[0]["id"], 200))
    caller.settle()

    assert caller.error is None
    assert caller.result is not None and caller.result["pad"].startswith("x")
    assert not session.closed


def test_a_reply_frame_over_the_size_bound_tears_the_session_down(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child, max_frame_bytes=200)
    caller = Caller(session, "tools/call")
    caller.start()
    child.wait_for(1)

    child.send_raw(padded_reply_frame(child.received[0]["id"], 201))

    caller.settle()
    assert isinstance(caller.error, SessionError)
    assert "oversized frame" in str(caller.error)
    assert_torn_down(session, child, [caller])


def test_the_pending_bound_admits_its_limit_and_refuses_the_next(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child, max_pending=2)
    admitted = [Caller(session, "tools/call", {"n": index}) for index in range(2)]
    for caller in admitted:
        caller.start()
    child.wait_for(2)

    with pytest.raises(SessionBusyError, match="request bound is full"):
        session.request("tools/call", {"n": 2})

    # Refused, not queued and not retried: the third call never reached the child.
    assert len(child.received) == 2
    # And the bound is a bound, not a break — both admitted calls still get their answers.
    for message in child.received:
        child.send(reply(message["id"], {"n": message["params"]["n"]}))
    for index, caller in enumerate(admitted):
        caller.settle()
        assert caller.result == {"n": index}


def test_a_reply_inside_the_request_timeout_is_returned(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child(answering([TOOL]))
    session = make_session(child, request_timeout=5.0)

    assert session.request("tools/call", {"name": "get_object"}) == CALL_RESULT


def test_a_request_the_child_never_answers_times_out_and_is_not_retried(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    """A retried tools/call can mutate Anytype twice, so this guard may not be a race.

    Counting the frames the child has recorded *at the moment the timeout returns* proves
    nothing: the recorder is a thread, and a resend written a microsecond earlier may not
    have been decoded yet. So a marker is written after the call and waited for. One
    socket delivers in order, so a child that has recorded the marker has already recorded
    every frame written before it — including a resend, if there was one.
    """
    child = make_child()
    session = make_session(child, request_timeout=0.05)

    with pytest.raises(SessionError, match="timed out answering tools/call"):
        session.request("tools/call", {"name": "get_object"})

    session.notify("notifications/marker")
    child.wait_for(2)

    assert child.methods == ["tools/call", "notifications/marker"], (
        "a timed-out call must not be sent a second time"
    )
    # The expired future is dropped rather than left waiting for a reply nobody will read.
    assert left_behind(session, settle=0) == (True, 0)


# --- failure teardown -------------------------------------------------------------------


def test_malformed_json_from_the_child_fails_every_pending_call(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)
    callers = [Caller(session, "tools/call", {"n": index}) for index in range(2)]
    for caller in callers:
        caller.start()
    child.wait_for(2)

    child.send_raw(b"this is not json\n")

    for caller in callers:
        caller.settle()
        assert "malformed JSON" in str(caller.error)
    assert_torn_down(session, child, callers)


def test_a_duplicated_reply_id_fails_the_calls_still_waiting(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)
    answered = Caller(session, "tools/call", {"n": 0})
    answered.start()
    child.wait_for(1)
    waiting = Caller(session, "tools/call", {"n": 1})
    waiting.start()
    child.wait_for(2)

    first_id = child.received[0]["id"]
    child.send(reply(first_id, {"n": 0}))
    answered.settle()
    assert answered.result == {"n": 0}

    # The same id a second time: there is no longer a call it can belong to.
    child.send(reply(first_id, {"n": 0}))

    waiting.settle()
    assert "unknown request id" in str(waiting.error)
    assert_torn_down(session, child, [waiting])


def test_a_reply_to_an_id_nobody_asked_for_fails_every_pending_call(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)
    caller = Caller(session, "tools/call")
    caller.start()
    child.wait_for(1)

    child.send(reply(999))

    caller.settle()
    assert "unknown request id" in str(caller.error)
    assert_torn_down(session, child, [caller])


def test_the_child_ending_its_output_fails_every_pending_call(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)
    callers = [Caller(session, "tools/call", {"n": index}) for index in range(2)]
    for caller in callers:
        caller.start()
    child.wait_for(2)

    child.close_output()

    for caller in callers:
        caller.settle()
        assert "closed its output" in str(caller.error)
    assert_torn_down(session, child, callers)


def test_a_dead_child_fails_every_pending_call(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)
    callers = [Caller(session, "tools/call", {"n": index}) for index in range(2)]
    for caller in callers:
        caller.start()
    child.wait_for(2)

    child.die(returncode=3)

    for caller in callers:
        caller.settle()
    assert child.poll() == 3
    assert_torn_down(session, child, callers)


def test_a_reply_id_that_is_not_a_number_fails_every_pending_call(
    make_child: MakeChild,
    make_session: Callable[..., McpSession],
) -> None:
    child = make_child()
    session = make_session(child)
    caller = Caller(session, "tools/call")
    caller.start()
    child.wait_for(1)

    child.send({"jsonrpc": "2.0", "id": str(child.received[0]["id"]), "result": {}})

    caller.settle()
    assert "invalid response id" in str(caller.error)
    assert_torn_down(session, child, [caller])


def test_a_child_that_cannot_be_written_to_fails_the_session(make_child: MakeChild) -> None:
    child = make_child()

    class RefusingStdin:
        """A pipe whose far end has gone, which is what a write to a dead child meets."""

        def write(self, frame: bytes) -> int:
            raise OSError("broken pipe")

        def flush(self) -> None:
            return None

    child.stdin = RefusingStdin()  # type: ignore[assignment]
    session = McpSession(child, expected_signatures={})

    with pytest.raises(SessionError, match="could not write to the Anytype MCP child"):
        session.request("tools/call", {"name": "get_object"})

    assert session.closed
    assert child.received == []
    # And the failure sticks: the caller is told once, not resent on a session that is gone.
    with pytest.raises(SessionError, match="session is closed"):
        session.request("tools/call", {"name": "get_object"})


def test_a_child_whose_output_cannot_be_read_fails_every_pending_call(
    make_child: MakeChild,
) -> None:
    child = make_child()
    broken = threading.Event()

    class BreakingStdout:
        """Output that stops being readable mid-session rather than reaching EOF."""

        def readline(self, limit: int = -1) -> bytes:
            broken.wait(5)
            raise OSError("device not configured")

    child.stdout = BreakingStdout()  # type: ignore[assignment]
    session = McpSession(child, expected_signatures={})
    caller = Caller(session, "tools/call")
    caller.start()
    child.wait_for(1)

    broken.set()

    caller.settle()
    assert "could not read from the Anytype MCP child" in str(caller.error)
    assert session.closed
    assert left_behind(session) == (False, 0)


# --- shutdown ---------------------------------------------------------------------------


def test_stopping_the_supervisor_closes_the_session_before_terminating_the_child(
    make_supervisor: MakeSupervisor,
    make_child: MakeChild,
) -> None:
    harness = make_supervisor()
    child = make_child(answering([TOOL]))
    sessions = supervised(harness, child, SURFACE)
    harness.supervisor.start()
    closed_when_signalled: list[bool] = []
    child.on_terminate = lambda: closed_when_signalled.append(sessions[0].closed)

    assert harness.supervisor.stop() == 0

    assert child.terminated
    assert closed_when_signalled == [True], "the child was signalled with the session still open"
    assert harness.supervisor.session is None
    assert left_behind(sessions[0]) == (False, 0)


def test_stopping_twice_is_safe(
    make_supervisor: MakeSupervisor,
    make_child: MakeChild,
) -> None:
    harness = make_supervisor()
    child = make_child(answering([TOOL]))
    sessions = supervised(harness, child, SURFACE)
    harness.supervisor.start()

    assert harness.supervisor.stop() == 0
    assert harness.supervisor.stop() is None
    # The session itself is idempotent too — the supervisor is not the only caller of it.
    sessions[0].close()
    sessions[0].close()

    assert sessions[0].closed


# --- the credential ---------------------------------------------------------------------


def test_no_frame_exception_or_repr_carries_the_api_key(
    make_supervisor: MakeSupervisor,
    make_child: MakeChild,
) -> None:
    harness = make_supervisor()
    child = make_child(answering([TOOL, OTHER_TOOL]))
    sessions = supervised(harness, child, SURFACE)

    with pytest.raises(SupervisorError) as raised:
        harness.supervisor.start()

    _argv, env = harness.spawns[0]
    assert FAKE_KEY in env["OPENAPI_MCP_HEADERS"], "the key was never in play to begin with"
    assert FAKE_KEY not in b"".join(child.raw_received).decode()
    assert FAKE_KEY not in str(raised.value)
    assert FAKE_KEY not in repr(raised.value)
    assert FAKE_KEY not in str(raised.value.__cause__)
    assert FAKE_KEY not in repr(sessions[0])


def test_no_log_carries_the_api_key_when_the_child_dies_on_its_own(
    make_supervisor: MakeSupervisor,
    make_child: MakeChild,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    # A child that died on its own is the one case the supervisor reports the launch
    # environment for — and that environment is exactly where the credential lives.
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()
    child = make_child(answering([TOOL]))
    supervised(harness, child, SURFACE)
    harness.supervisor.start()

    child.die(returncode=3)
    harness.supervisor.stop()

    assert any("exited on its own" in record.getMessage() for record in caplog.records)
    assert leaks(FAKE_KEY, capsys, caplog) == []
