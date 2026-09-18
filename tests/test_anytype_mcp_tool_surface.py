"""The pinned server's tool surface: the committed record, and the diff a bump must show.

Plan 0002 says the pair (package version, ``Anytype-Version``) decides which tools exist,
which makes a bump of either pin a dependency upgrade that has to show its evidence. The
evidence is a committed fixture plus a comparison, and both are asserted here.

Everything in this file runs with **no Node, no network and no Anytype**. The refresh path
is the one thing in the repository that talks to the real server, and it is exercised here
through an injected fake child that speaks MCP over stdio in-process — the same dependency
injection the supervisor and the health check already use, for the same reason: a criterion
that only passes because its test was skipped is not satisfied (docs/loop/SKILL.md).
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner

from conftest import FAKE_KEY
from innytypes.anytype_mcp.config import (
    ANYTYPE_VERSION,
    PACKAGE_NAME,
    PACKAGE_VERSION,
    ServerConfig,
)
from innytypes.anytype_mcp.refresh import (
    MCP_PROTOCOL_VERSION,
    RefreshError,
    list_tools_over_stdio,
    refresh_tool_surface,
)
from innytypes.anytype_mcp.tools import (
    FIXTURE_PATH,
    KNOWN_SOURCES,
    SOURCE_BUNDLED_SPEC,
    SOURCE_LIVE,
    ToolSurface,
    ToolSurfaceError,
    compare_surfaces,
    load_tool_surface,
    save_tool_surface,
    tool_signature,
)

REPO = Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------------------
# A fake MCP child. It is a JSON-RPC peer, not a recording: the refresh has to send a real
# handshake to get a real answer out of it, so a refresh that skipped `initialize` would
# fail here rather than quietly pass.
# --------------------------------------------------------------------------------------


# Sentinel: "answer `tools/list` normally", as opposed to a test-supplied malformed result.
_LIST_THE_TOOLS = object()


class _ChildStdin:
    """The write end of the child's stdin, delivering whole lines to the fake child."""

    def __init__(self, deliver: Callable[[bytes], None]) -> None:
        self._deliver = deliver
        self._buffer = b""

    def write(self, data: bytes) -> int:
        self._buffer += data
        while b"\n" in self._buffer:
            line, self._buffer = self._buffer.split(b"\n", 1)
            self._deliver(line)
        return len(data)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None


class _ChildStdout:
    """The read end of the child's stdout: whatever the fake child has replied so far."""

    def __init__(self, pending: list[bytes]) -> None:
        self._pending = pending

    def readline(self) -> bytes:
        # Empty bytes is EOF, which is exactly what a child that answered nothing gives.
        return self._pending.pop(0) if self._pending else b""

    def close(self) -> None:
        return None


class FakeMcpChild:
    """Enough of a ``Popen`` speaking MCP over stdio to drive a refresh without Node."""

    def __init__(
        self,
        tools: list[dict[str, Any]] | None = None,
        *,
        error: str | None = None,
        answer: bool = True,
        noise: Sequence[bytes] = (),
        result: Any = _LIST_THE_TOOLS,
    ) -> None:
        self.tools = [] if tools is None else tools
        self.error = error
        self.answer = answer
        self.result = result
        self.requests: list[dict[str, Any]] = []
        self.terminated = False
        self.returncode: int | None = None
        self._pending: list[bytes] = list(noise)
        self.stdin = _ChildStdin(self._receive)
        self.stdout = _ChildStdout(self._pending)

    def _receive(self, line: bytes) -> None:
        message = json.loads(line)
        self.requests.append(message)
        if "id" not in message or not self.answer:
            # A notification is never answered, and `answer=False` fakes a server that dies.
            return
        self._pending.append(json.dumps(self._reply(message)).encode("utf-8") + b"\n")

    def _reply(self, message: dict[str, Any]) -> dict[str, Any]:
        if message["method"] == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": message["id"],
                "result": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "Anytype API", "version": "1.0.0"},
                },
            }
        if message["method"] == "tools/list":
            if self.error is not None:
                return {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {"code": -32603, "message": self.error},
                }
            result = {"tools": self.tools} if self.result is _LIST_THE_TOOLS else self.result
            return {"jsonrpc": "2.0", "id": message["id"], "result": result}
        return {
            "jsonrpc": "2.0",
            "id": message["id"],
            "error": {"code": -32601, "message": "method not found"},
        }

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode if self.returncode is not None else 0


def spawning(child: FakeMcpChild) -> Callable[..., Any]:
    """A spawn callable that hands out ``child`` and records what it was asked to launch."""

    def spawn(argv: Sequence[str], env: dict[str, str]) -> subprocess.Popen[bytes]:
        spawn.argv = list(argv)  # type: ignore[attr-defined]
        spawn.env = dict(env)  # type: ignore[attr-defined]
        return child  # type: ignore[return-value]

    return spawn


def tool(name: str, **properties: Any) -> dict[str, Any]:
    """A tool entry shaped like the one `tools/list` returns.

    The ``API-`` prefix is on the wire, not added by us: the server groups every operation
    under one tool named "API" and lists each as ``API-<operation>``. The fixture records
    the name an addon will actually call, so it records exactly what arrives.
    """
    return {
        "name": f"API-{name}",
        "description": f"does {name}",
        "inputSchema": {"type": "object", "properties": properties},
    }


def surface(**tools: str) -> ToolSurface:
    """A hand-written surface at the pinned versions."""
    return ToolSurface(
        package_version=PACKAGE_VERSION,
        anytype_version=ANYTYPE_VERSION,
        tools=dict(tools),
        source=SOURCE_LIVE,
        captured_at="2026-01-01",
    )


# --------------------------------------------------------------------------------------
# The committed fixture.
# --------------------------------------------------------------------------------------


def test_the_fixture_records_the_versions_it_was_captured_at() -> None:
    # The whole point of the fixture: bumping a pin without re-recording the surface turns
    # the gate red, so nobody can upgrade the dependency without producing the evidence.
    recorded = load_tool_surface()

    assert recorded.package_version == PACKAGE_VERSION
    assert recorded.anytype_version == ANYTYPE_VERSION


def test_the_fixture_is_tracked_by_git() -> None:
    # A gate that reads a gitignored file is a gate that only passes on one laptop
    # (docs/loop/SKILL.md). This is the check that keeps the fixture committed.
    tracked = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "--error-unmatch", str(FIXTURE_PATH)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert tracked.returncode == 0, f"{FIXTURE_PATH} is not tracked by git"


def test_the_fixture_lists_the_tools_of_the_pinned_pair() -> None:
    recorded = load_tool_surface()

    assert recorded.tools, "the fixture records no tools at all"
    assert all(name.startswith("API-") for name in recorded.names)
    assert all(value.startswith("sha256:") for value in recorded.tools.values())


def test_the_fixture_says_how_it_was_captured() -> None:
    # Provenance is part of the record: a surface derived from the package's bundled spec
    # is weaker evidence than one read off a running server, and a reader must be able to
    # tell which one they are looking at without asking anybody.
    recorded = load_tool_surface()

    assert recorded.source in KNOWN_SOURCES
    assert recorded.note, "the fixture must say in words where its tool names came from"


def test_a_fixture_missing_a_field_is_a_named_error(tmp_path: Path) -> None:
    broken = tmp_path / "tool_surface.json"
    broken.write_text(json.dumps({"package_version": "1.2.10"}), encoding="utf-8")

    with pytest.raises(ToolSurfaceError, match="anytype_version"):
        load_tool_surface(broken)


def test_a_fixture_whose_tools_are_not_an_object_is_a_named_error(tmp_path: Path) -> None:
    broken = tmp_path / "tool_surface.json"
    broken.write_text(
        json.dumps(
            {
                "package_version": PACKAGE_VERSION,
                "anytype_version": ANYTYPE_VERSION,
                "source": SOURCE_LIVE,
                "captured_at": "2026-01-01",
                # A list of names is the shape somebody reaches for by hand, and it loses
                # the input schemas that make `changed` detectable.
                "tools": ["API-get-object"],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ToolSurfaceError, match="not an object"):
        load_tool_surface(broken)


def test_a_fixture_that_is_not_json_is_a_named_error(tmp_path: Path) -> None:
    broken = tmp_path / "tool_surface.json"
    broken.write_text("{ truncated mid-write", encoding="utf-8")

    with pytest.raises(ToolSurfaceError, match="not valid JSON"):
        load_tool_surface(broken)


def test_an_absent_fixture_is_a_named_error(tmp_path: Path) -> None:
    with pytest.raises(ToolSurfaceError, match="could not read"):
        load_tool_surface(tmp_path / "never-written.json")


def test_a_surface_round_trips_through_the_file(tmp_path: Path) -> None:
    path = tmp_path / "tool_surface.json"
    original = surface(**{"API-get-object": "sha256:aa"})

    save_tool_surface(original, path)

    assert load_tool_surface(path) == original


# --------------------------------------------------------------------------------------
# The comparison. Pure: two surfaces in, three lists of names out.
# --------------------------------------------------------------------------------------


def test_compare_reports_added_removed_and_changed_names() -> None:
    before = surface(
        **{
            "API-get-object": "sha256:aa",
            "API-list-spaces": "sha256:bb",
            "API-delete-tag": "sha256:cc",
        }
    )
    after = surface(
        **{
            "API-get-object": "sha256:aa",  # untouched
            "API-list-spaces": "sha256:ff",  # same name, different input schema
            "API-create-space": "sha256:dd",  # new
        }
    )

    diff = compare_surfaces(before, after)

    assert diff.added == ("API-create-space",)
    assert diff.removed == ("API-delete-tag",)
    assert diff.changed == ("API-list-spaces",)
    assert not diff.is_empty


def test_comparing_a_surface_with_itself_reports_nothing() -> None:
    unchanged = surface(**{"API-get-object": "sha256:aa", "API-list-spaces": "sha256:bb"})

    diff = compare_surfaces(unchanged, unchanged)

    assert (diff.added, diff.removed, diff.changed) == ((), (), ())
    assert diff.is_empty


def test_a_signature_ignores_key_order_but_not_content() -> None:
    # Signatures are compared across captures made months apart; if they depended on the
    # order a JSON object happened to arrive in, every refresh would report a false change.
    one = tool_signature({"type": "object", "properties": {"a": 1, "b": 2}})
    reordered = tool_signature({"properties": {"b": 2, "a": 1}, "type": "object"})
    different = tool_signature({"type": "object", "properties": {"a": 1, "b": 3}})

    assert one == reordered
    assert one != different


# --------------------------------------------------------------------------------------
# The refresh path, driven by the fake child.
# --------------------------------------------------------------------------------------


def test_refresh_launches_the_exactly_pinned_package(tmp_path: Path) -> None:
    child = FakeMcpChild([tool("get-object", space_id={"type": "string"})])
    spawn = spawning(child)

    refresh_tool_surface(
        config=ServerConfig(api_key=FAKE_KEY),
        spawn=spawn,
        path=tmp_path / "tool_surface.json",
    )

    assert spawn.argv == ["npx", "-y", f"{PACKAGE_NAME}@{PACKAGE_VERSION}"]  # type: ignore[attr-defined]
    assert spawn.env["OPENAPI_MCP_HEADERS"]  # type: ignore[attr-defined]


def test_refresh_completes_the_mcp_handshake_before_listing_tools() -> None:
    child = FakeMcpChild([tool("get-object")])

    list_tools_over_stdio(["npx"], {}, spawn=spawning(child))

    assert [message["method"] for message in child.requests] == [
        "initialize",
        "notifications/initialized",
        "tools/list",
    ]


def test_refresh_records_what_the_server_listed(tmp_path: Path) -> None:
    path = tmp_path / "tool_surface.json"
    child = FakeMcpChild([tool("get-object", space_id={"type": "string"}), tool("list-spaces")])

    captured, _diff = refresh_tool_surface(
        config=ServerConfig(api_key=FAKE_KEY), spawn=spawning(child), path=path
    )

    assert captured.names == ("API-get-object", "API-list-spaces")
    assert captured.source == SOURCE_LIVE
    assert captured.package_version == PACKAGE_VERSION
    assert captured.anytype_version == ANYTYPE_VERSION
    # Written where the gate will read it next time, not just returned.
    assert load_tool_surface(path) == captured


def test_refresh_diffs_the_new_surface_against_the_recorded_one(tmp_path: Path) -> None:
    path = tmp_path / "tool_surface.json"
    save_tool_surface(surface(**{"API-get-object": "sha256:aa", "API-gone": "sha256:bb"}), path)
    child = FakeMcpChild([tool("get-object", space_id={"type": "string"}), tool("brand-new")])

    _captured, diff = refresh_tool_surface(
        config=ServerConfig(api_key=FAKE_KEY), spawn=spawning(child), path=path
    )

    assert diff.added == ("API-brand-new",)
    assert diff.removed == ("API-gone",)
    assert diff.changed == ("API-get-object",)


def test_refresh_against_a_missing_fixture_reports_every_tool_as_added(tmp_path: Path) -> None:
    child = FakeMcpChild([tool("get-object")])

    _captured, diff = refresh_tool_surface(
        config=ServerConfig(api_key=FAKE_KEY),
        spawn=spawning(child),
        path=tmp_path / "absent.json",
    )

    assert diff.added == ("API-get-object",)


def test_refresh_reports_a_server_error_instead_of_writing_a_surface(tmp_path: Path) -> None:
    path = tmp_path / "tool_surface.json"
    child = FakeMcpChild(error="Can't connect to API")

    with pytest.raises(RefreshError):
        refresh_tool_surface(
            config=ServerConfig(api_key=FAKE_KEY), spawn=spawning(child), path=path
        )

    assert not path.exists(), "a failed refresh must not leave a half-written fixture"


def test_refresh_reports_a_server_that_answers_nothing() -> None:
    child = FakeMcpChild([tool("get-object")], answer=False)

    with pytest.raises(RefreshError):
        list_tools_over_stdio(["npx"], {}, spawn=spawning(child))


def test_refresh_ignores_output_that_is_not_its_answer() -> None:
    # Three things a session really sees on stdout and must read past: a banner printed
    # before the transport starts, a bare JSON value, and a notification with no id.
    child = FakeMcpChild(
        [tool("get-object")],
        noise=(
            b"Initializing Anytype MCP Server...\n",
            b'"not a protocol message"\n',
            b'{"jsonrpc":"2.0","method":"notifications/message","params":{}}\n',
        ),
    )

    listed = list_tools_over_stdio(["npx"], {}, spawn=spawning(child))

    assert [entry["name"] for entry in listed] == ["API-get-object"]


def test_refresh_rejects_an_answer_that_carries_no_tool_list() -> None:
    child = FakeMcpChild(result={"nextCursor": "page-2"})

    with pytest.raises(RefreshError, match="tools/list"):
        list_tools_over_stdio(["npx"], {}, spawn=spawning(child))


def test_refresh_rejects_an_answer_that_is_not_a_result_object() -> None:
    child = FakeMcpChild(result="tools are over there")

    with pytest.raises(RefreshError, match="no result"):
        list_tools_over_stdio(["npx"], {}, spawn=spawning(child))


def test_refresh_always_stops_the_child() -> None:
    child = FakeMcpChild([tool("get-object")])

    list_tools_over_stdio(["npx"], {}, spawn=spawning(child))

    assert child.terminated


def test_refresh_stops_the_child_even_when_it_fails() -> None:
    child = FakeMcpChild([tool("get-object")], answer=False)

    with pytest.raises(RefreshError):
        list_tools_over_stdio(["npx"], {}, spawn=spawning(child))

    assert child.terminated


# --------------------------------------------------------------------------------------
# The command that runs the refresh.
# --------------------------------------------------------------------------------------


def test_the_cli_prints_the_diff_it_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    from innytypes import cli as cli_module

    recorded = surface(**{"API-get-object": "sha256:aa", "API-list-spaces": "sha256:dd"})
    before = surface(**{"API-gone": "sha256:bb", "API-list-spaces": "sha256:cc"})
    diff = compare_surfaces(before, recorded)
    monkeypatch.setattr(cli_module, "load_config", lambda **_: ServerConfig(api_key=FAKE_KEY))
    monkeypatch.setattr(cli_module, "refresh_tool_surface", lambda **_: (recorded, diff))

    result = CliRunner().invoke(cli_module.cli, ["anytype-mcp", "refresh-tool-surface"])

    assert result.exit_code == 0
    # All three categories reach the person reviewing the upgrade, not just the counts.
    assert "added   API-get-object" in result.output
    assert "removed API-gone" in result.output
    assert "changed API-list-spaces" in result.output


def test_the_cli_says_when_the_surface_did_not_move(monkeypatch: pytest.MonkeyPatch) -> None:
    from innytypes import cli as cli_module

    recorded = surface(**{"API-get-object": "sha256:aa"})
    monkeypatch.setattr(cli_module, "load_config", lambda **_: ServerConfig(api_key=FAKE_KEY))
    monkeypatch.setattr(
        cli_module,
        "refresh_tool_surface",
        lambda **_: (recorded, compare_surfaces(recorded, recorded)),
    )

    result = CliRunner().invoke(cli_module.cli, ["anytype-mcp", "refresh-tool-surface"])

    assert result.exit_code == 0
    assert "unchanged" in result.output


def test_the_cli_reports_an_unreachable_server_without_a_traceback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from innytypes import cli as cli_module

    def explode(**_: Any) -> None:
        raise RefreshError("the server did not answer `tools/list`")

    monkeypatch.setattr(cli_module, "load_config", lambda **_: ServerConfig(api_key=FAKE_KEY))
    monkeypatch.setattr(cli_module, "refresh_tool_surface", explode)

    result = CliRunner().invoke(cli_module.cli, ["anytype-mcp", "refresh-tool-surface"])

    assert result.exit_code == 1
    assert "tools/list" in result.output
    assert "Traceback" not in result.output


def test_the_bundled_fixture_is_what_the_cli_would_rewrite() -> None:
    # The command's default output is the file the gate reads; a refresh that wrote
    # somewhere else would leave the gate reading a surface nobody refreshes.
    assert FIXTURE_PATH.name == "tool_surface.json"
    assert FIXTURE_PATH.parent.name == "anytype_mcp"
    assert SOURCE_BUNDLED_SPEC in KNOWN_SOURCES
