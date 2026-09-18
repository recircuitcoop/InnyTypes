"""Re-recording the tool surface by asking the real server what it exposes.

This is the **only** thing in the repository that needs Node, and it is deliberately not
part of the gate: `docs/loop/verify.sh` must pass from a clean clone with ``node_modules/``
absent and Anytype not running (docs/loop/SKILL.md). The gate reads the committed fixture;
this module is what a person runs, by hand, when a pin moves — `innytypes anytype-mcp
refresh-tool-surface`.

It speaks MCP over stdio to the same child the supervisor launches: newline-delimited
JSON-RPC 2.0, ``initialize`` → ``notifications/initialized`` → ``tools/list``. That is a
few dozen lines of framing, which is cheaper than adding an MCP client library to a host
that already pins every runtime dependency and installs itself into every addon's
environment. The host imports nothing from the Node package and never will; the seam stays
a child process with an environment.

The spawn is injected, exactly as :class:`~innytypes.anytype_mcp.supervisor.Supervisor`
injects its own, so every line here except the default spawn is exercised by the gate
against a fake child that answers JSON-RPC in-process. A refresh path that could only be
tested by installing Node would be a refresh path nobody ever ran.
"""

from __future__ import annotations

import contextlib
import json
import subprocess
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from innytypes.anytype_mcp.config import ServerConfig, load_config
from innytypes.anytype_mcp.logs import get_logger
from innytypes.anytype_mcp.supervisor import Spawn, Supervisor
from innytypes.anytype_mcp.tools import (
    SOURCE_LIVE,
    ToolSurface,
    ToolSurfaceDiff,
    ToolSurfaceError,
    compare_surfaces,
    load_tool_surface,
    save_tool_surface,
    tool_signature,
)

log = get_logger(__name__)

# The MCP revision this client announces. Pinned like everything else that crosses the
# boundary: the server negotiates down to what it supports, and a client that sent
# "whatever is newest" would change behaviour when the npm pin moves, which is precisely
# the change this module exists to measure.
MCP_PROTOCOL_VERSION = "2025-06-18"

# How the server identifies us in its own logs.
CLIENT_NAME = "innytypes-tool-surface-refresh"
CLIENT_VERSION = "1"

# Request ids for the two calls this session makes. Fixed rather than generated: there are
# exactly two, they are issued in order, and a counter would be state to get wrong.
_INITIALIZE_ID = 1
_TOOLS_LIST_ID = 2


class RefreshError(RuntimeError):
    """The real server could not be asked what tools it has.

    Covers every way the conversation can fail — npx missing, the child dying, a JSON-RPC
    error, an answer that is not a tool list. The caller's response is the same in all of
    them: fix the environment and run the command again, and do not touch the fixture.
    """


def _default_spawn(argv: Sequence[str], env: dict[str, str]) -> subprocess.Popen[bytes]:
    """Launch the server with its stdio wired for MCP, and its stderr left alone.

    stdout and stdin are the transport. stderr is **inherited** rather than piped: the
    server narrates itself there ("Initializing Anytype MCP Server...", the base URL it
    chose), which is what a person running this by hand needs to see when it hangs — and a
    pipe nobody drains is a child that blocks once that pipe fills.
    """
    return subprocess.Popen(
        list(argv),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
    )


def _send(process: Any, message: Mapping[str, Any]) -> None:
    """Write one JSON-RPC message to the child, newline-framed."""
    process.stdin.write(json.dumps(message).encode("utf-8") + b"\n")
    process.stdin.flush()


def _await_response(process: Any, request_id: int, method: str) -> dict[str, Any]:
    """Read the child's stdout until the response to ``request_id`` arrives.

    Lines that are not JSON, and JSON that is not this response, are skipped: the transport
    carries notifications as well as responses, and servers have been known to print a
    banner before the protocol starts. Only end-of-stream is fatal — a child that closed
    its stdout has died, and waiting longer will not help.
    """
    while True:
        line = process.stdout.readline()
        if not line:
            raise RefreshError(
                f"the Anytype MCP server closed its output without answering `{method}`; "
                "check that the Anytype desktop app is running and that the API key is valid"
            )

        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue

        if not isinstance(message, dict) or message.get("id") != request_id:
            continue

        if "error" in message:
            # The server's own words. They describe a protocol failure, never the
            # credential — which in any case goes through this package's redactor.
            detail = message["error"].get("message", message["error"])
            raise RefreshError(f"the Anytype MCP server refused `{method}`: {detail}")

        result = message.get("result")
        if not isinstance(result, dict):
            raise RefreshError(f"the Anytype MCP server answered `{method}` with no result")
        return result


def list_tools_over_stdio(
    argv: Sequence[str],
    env: Mapping[str, str],
    *,
    spawn: Spawn = _default_spawn,
) -> list[dict[str, Any]]:
    """Run one MCP session against ``argv`` and return the raw entries of ``tools/list``.

    There is no timeout. The command is interactive by nature — a person runs it, watches
    the server's stderr, and interrupts it if it hangs — and a timeout here would only add
    a second way for the refresh to fail while the server was still thinking.
    """
    process = spawn(list(argv), dict(env))
    try:
        _send(
            process,
            {
                "jsonrpc": "2.0",
                "id": _INITIALIZE_ID,
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": CLIENT_NAME, "version": CLIENT_VERSION},
                },
            },
        )
        _await_response(process, _INITIALIZE_ID, "initialize")

        # The handshake is only complete once the client acknowledges it; a server is
        # entitled to reject requests that arrive before this notification.
        _send(process, {"jsonrpc": "2.0", "method": "notifications/initialized"})

        _send(process, {"jsonrpc": "2.0", "id": _TOOLS_LIST_ID, "method": "tools/list"})
        result = _await_response(process, _TOOLS_LIST_ID, "tools/list")

        listed = result.get("tools")
        if not isinstance(listed, list):
            raise RefreshError("the Anytype MCP server answered `tools/list` without a tool list")
        return listed
    finally:
        # In a finally, because the failure paths above are the ones that would otherwise
        # leave a Node process attached to the terminal for the rest of the session.
        _stop(process)


def _stop(process: Any) -> None:
    """Close the transport and end the child, whatever happened to the conversation."""
    for stream in (process.stdin, process.stdout):
        # A pipe whose other end has already gone raises on close, and a child that died
        # by itself is one of the cases this function exists to clean up after.
        with contextlib.suppress(OSError):
            stream.close()

    process.terminate()
    process.wait()


def _capture_tool_surface(config: ServerConfig, listed: Sequence[Mapping[str, Any]]) -> ToolSurface:
    """Turn one ``tools/list`` answer into a surface recorded at the pinned versions."""
    tools = {str(entry["name"]): tool_signature(entry.get("inputSchema", {})) for entry in listed}
    return ToolSurface(
        package_version=config.package_version,
        anytype_version=config.anytype_version,
        tools=tools,
        source=SOURCE_LIVE,
        captured_at=datetime.now(UTC).date().isoformat(),
        note=(
            "Captured over MCP stdio from a running "
            f"@anyproto/anytype-mcp@{config.package_version} against a live Anytype."
        ),
    )


def refresh_tool_surface(
    config: ServerConfig | None = None,
    *,
    spawn: Spawn = _default_spawn,
    path: Path | None = None,
) -> tuple[ToolSurface, ToolSurfaceDiff]:
    """Ask the real server what it exposes, record it, and return it with what changed.

    The diff is against whatever was recorded before, which is the point of the exercise:
    running this after a pin moves is how an upgrade produces the evidence plan 0002 asks
    for. A fixture that is not there yet reads as an empty surface, so a first capture
    reports every tool as added rather than failing.
    """
    server_config = load_config() if config is None else config

    # The same argv the supervisor uses in production, taken from the supervisor rather
    # than rebuilt here: a refresh that talked to a different build than the host launches
    # would record a surface the host never sees.
    argv = Supervisor(config=server_config).command()

    log.info("asking %s for its tool list", server_config.package_spec)
    listed = list_tools_over_stdio(argv, server_config.environment(), spawn=spawn)
    captured = _capture_tool_surface(server_config, listed)

    try:
        previous = load_tool_surface(path)
    except ToolSurfaceError:
        # No fixture yet, or one nobody can read. Either way the useful report is "here is
        # everything this server has", not a refusal to record anything at all.
        previous = ToolSurface(
            package_version=captured.package_version,
            anytype_version=captured.anytype_version,
            tools={},
            source=SOURCE_LIVE,
            captured_at="",
        )

    diff = compare_surfaces(previous, captured)
    save_tool_surface(captured, path)
    log.info("recorded %d tools", len(captured.tools))
    return captured, diff
