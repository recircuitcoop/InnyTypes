"""Two programs that never touch each other, and a window that tells the truth about it.

Plan 0007 slice 04. The other three slices built the endpoint; this one is about what the
two *independent* sides are allowed to know about each other, and there are only two
answers: a URL, and a bearer token. Everything asserted here is a **separation** —

* the application shows the address it was **configured** with, never a remembered default;
* the application says whether that address is being served, and why it is not, without
  either credential appearing anywhere;
* no source file in this package launches, configures or supervises a client, and the
  documented client configuration launches nothing either;
* an absent InnyTypes is an ordinary refused TCP connection, and one that starts later
  serves a brand-new client with no process spawned on either side and no descriptor
  passed between them.

Nothing here needs Node, Anytype, Codex, a real credential or a fixed user port. Every
listener binds a kernel-assigned loopback port, every child session is a fake, every
credential is an obviously-fake literal, and the one test that proves no process is
handed over does it by making every way of starting a process raise.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import logging
import os
import re
import socket
import subprocess
import tomllib
from collections.abc import Iterator
from dataclasses import fields
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from innytypes.anytype_mcp.config import API_KEY_ENV_VAR
from innytypes.anytype_mcp.gateway import (
    DEFAULT_PORT,
    GatewayConfig,
    McpGateway,
    configured_address,
    endpoint_url,
)
from innytypes.anytype_mcp.protocol import MCP_PROTOCOL_VERSION
from innytypes.children import MCP_CHILD_ID, ChildKind
from innytypes.helper.launcher import EndpointReport, observe_endpoint
from innytypes.helper.processes import ProcessFacts
from innytypes.helper.window import ApplicationTab, Element
from test_anytype_mcp_gateway import TOKEN, FakeSession, free_port, post
from test_anytype_mcp_keys import leak_sources
from test_window_wiring import Machine, wire

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "src" / "innytypes"
CONNECTION_DOC = REPO / "docs" / "anytype-mcp-connection.md"
README = REPO / "README.md"

# The Anytype REST port. A client sent here reaches Anytype directly and bypasses the one
# host-owned MCP child, which is the thing this plan exists to keep single.
ANYTYPE_REST_PORT = "31009"

# The proxy token as this file spells it. The word "fake" is on the line for
# tests/test_no_secrets.py, which scans every tracked file.
FAKE_PROXY_TOKEN = "fake-proxy-token-for-the-window-0123456789"
# And the other credential, which must never cross the HTTP boundary at all.
FAKE_ANYTYPE_KEY = "fake-anytype-key-for-the-window-0123456789"


@pytest.fixture
def machine(tmp_path: Path) -> Machine:
    return Machine(root=tmp_path)


@contextlib.contextmanager
def serving_on(port: int, *, host: str = "127.0.0.1") -> Iterator[McpGateway]:
    """This installation's own MCP service, on a port the caller chose."""
    gateway = McpGateway(
        GatewayConfig(host=host, port=port, bearer_token=TOKEN), lambda: FakeSession()
    )
    gateway.start()
    try:
        yield gateway
    finally:
        gateway.stop()


@contextlib.contextmanager
def an_address_answering(
    port: int,
    *,
    status: int = 200,
    body: bytes = b"<html>some other local service</html>",
    content_type: str = "text/html",
) -> Iterator[None]:
    """Something that is not InnyTypes, holding the address InnyTypes was configured with.

    This is what a port collision looks like from outside the host: the bind the gateway
    wanted failed, the host degraded, and the address answers — to somebody else.
    """

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    import threading

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)


def a_running_child(machine: Machine, pid: int = 4242) -> dict[int, ProcessFacts]:
    """A run-state file and a process table that agree the MCP child is up."""
    record = machine.record(MCP_CHILD_ID, kind=ChildKind.MCP, pid=pid)
    return {pid: ProcessFacts(pid=pid, started_at=record.started_at, executable=record.executable)}


def anytype_group(machine: Machine, **kwargs: Any) -> Any:
    """Open the assembled window and hand back the Anytype group it drew."""
    wiring = wire(machine, **kwargs)
    wiring.window.open()
    application = wiring.desktop.tabbed.application
    assert isinstance(application, ApplicationTab)
    return application.anytype


# --- the address the window shows is the configured one ---------------------------------------


def test_the_window_shows_the_configured_address_and_not_the_default_port(
    machine: Machine,
) -> None:
    """The defect this slice opened on, asserted end to end through the built window.

    `AnytypeGroup.mcp_url` used to default to ``http://127.0.0.1:31010/mcp`` and nothing ever
    overwrote it, so an installation configured with `INNYTYPES_MCP_PORT` told a person, in
    the one place they would look, to point their client at a port nothing was listening on.
    The address is now read from the same environment the host reads it from — the helper
    spawns the host with its own, unmodified — so the two cannot disagree.
    """
    port = free_port()
    assert port != DEFAULT_PORT
    environment = {"INNYTYPES_MCP_PORT": str(port)}

    with serving_on(port):
        group = anytype_group(
            machine,
            alive=a_running_child(machine),
            endpoint=lambda: observe_endpoint(environment),
        )

    assert group.mcp_url == f"http://127.0.0.1:{port}/mcp"
    assert str(DEFAULT_PORT) not in group.mcp_url
    assert group.mcp_available
    assert group.mcp_endpoint_reason is None


def configured_url(environment: dict[str, str]) -> str:
    """The address the window shows, built the way the window builds it."""
    return endpoint_url(*configured_address(environment))


def test_the_configured_url_is_built_from_the_same_reading_the_host_binds_from() -> None:
    """One reader for the address, so the window and the listener cannot drift apart.

    `configured_address` is what the window reads and what `load_gateway_config` binds
    from, and `endpoint_url` is what formats both the window's row and
    `GatewayConfig.url`. This pins that pair for configurations neither of them defaults
    to, including the one an unbracketed formatter would get wrong.
    """
    assert (
        configured_url({"INNYTYPES_MCP_HOST": "127.0.0.2", "INNYTYPES_MCP_PORT": "32010"})
        == "http://127.0.0.2:32010/mcp"
    )
    assert configured_url({}) == f"http://127.0.0.1:{DEFAULT_PORT}/mcp"
    # An IPv6 loopback address is bracketed, because an unbracketed one is not a URL.
    assert configured_url({"INNYTYPES_MCP_HOST": "::1"}) == f"http://[::1]:{DEFAULT_PORT}/mcp"
    # And what the host binds says the same thing about the same environment.
    assert (
        GatewayConfig(host="::1", port=DEFAULT_PORT, bearer_token=TOKEN).url
        == f"http://[::1]:{DEFAULT_PORT}/mcp"
    )


# --- available, or degraded with the reason ---------------------------------------------------


def test_a_served_address_reads_available() -> None:
    port = free_port()

    with serving_on(port):
        report = observe_endpoint({"INNYTYPES_MCP_PORT": str(port)})

    assert report == EndpointReport(url=f"http://127.0.0.1:{port}/mcp", available=True)


def test_an_address_nothing_is_serving_reads_degraded_and_names_it() -> None:
    port = free_port()

    report = observe_endpoint({"INNYTYPES_MCP_PORT": str(port)})

    assert not report.available
    assert report.reason == f"Nothing is serving http://127.0.0.1:{port}/mcp."


def test_an_address_another_program_holds_reads_as_a_collision() -> None:
    """The port-collision reason, staged from the collision itself.

    The host degrades with `could not bind the MCP service at ...` and the helper is a
    different process that never hears it. What the helper can do is look, and an address
    answering something that is not this service's own credential-less refusal is another
    program holding it.
    """
    port = free_port()

    with an_address_answering(port):
        report = observe_endpoint({"INNYTYPES_MCP_PORT": str(port)})

    assert not report.available
    assert report.reason == (
        f"Another program is answering at http://127.0.0.1:{port}/mcp, "
        "so InnyTypes could not open its MCP endpoint there."
    )


@pytest.mark.parametrize(
    "answer",
    [
        (405, b"Method Not Allowed", "text/plain"),
        (405, b'"a json string, which is not an object"', "application/json"),
        (405, b'{"error": 42}', "application/json"),
        (405, b"{}", "application/json"),
    ],
)
def test_an_address_that_refuses_a_get_in_its_own_words_is_still_another_program(
    answer: tuple[int, bytes, str],
) -> None:
    """A 405 is not an identification. Only this service's own sentence is.

    Plenty of things refuse a GET. Reading the status alone would let any of them be
    mistaken for the InnyTypes endpoint, and a person would be told their client should
    work when it will not.
    """
    status, body, content_type = answer
    port = free_port()

    with an_address_answering(port, status=status, body=body, content_type=content_type):
        report = observe_endpoint({"INNYTYPES_MCP_PORT": str(port)})

    assert not report.available
    assert "Another program is answering" in (report.reason or "")


@pytest.mark.parametrize(
    ("environment", "reason"),
    [
        (
            {"INNYTYPES_MCP_PORT": "thirty-one-thousand"},
            "INNYTYPES_MCP_PORT must be a whole number",
        ),
        ({"INNYTYPES_MCP_PORT": "0"}, "the MCP port must be between 1 and 65535"),
        (
            {"INNYTYPES_MCP_HOST": "0.0.0.0"},
            "the MCP address must be loopback; wildcard and network binds are refused",
        ),
        (
            {"INNYTYPES_MCP_HOST": "localhost"},
            "the MCP address must be a numeric loopback address",
        ),
    ],
)
def test_a_configuration_the_host_would_refuse_shows_no_address_and_the_refusal(
    environment: dict[str, str], reason: str
) -> None:
    """No URL is invented for a configuration that will never be served."""
    report = observe_endpoint(environment)

    assert report == EndpointReport(url="", available=False, reason=reason)


def test_a_stopped_child_is_the_reason_the_endpoint_is_degraded(machine: Machine) -> None:
    """The unavailable-child reason, which outranks "nothing is serving it".

    Both are true when the child is down, and only one of them tells a person what to do.
    """
    machine.quarantine(**{MCP_CHILD_ID: "the MCP server crashed repeatedly"})
    port = free_port()

    group = anytype_group(
        machine,
        alive=a_running_child(machine),
        endpoint=lambda: observe_endpoint({"INNYTYPES_MCP_PORT": str(port)}),
    )

    assert not group.mcp_running
    assert not group.mcp_available
    assert group.mcp_url == f"http://127.0.0.1:{port}/mcp"
    assert group.mcp_endpoint_reason == "the MCP server crashed repeatedly"


def test_a_running_child_behind_a_taken_address_is_still_degraded(machine: Machine) -> None:
    """The case a single flag would have to lie about: child up, endpoint not ours."""
    port = free_port()

    with an_address_answering(port):
        group = anytype_group(
            machine,
            alive=a_running_child(machine),
            endpoint=lambda: observe_endpoint({"INNYTYPES_MCP_PORT": str(port)}),
        )

    assert group.mcp_running
    assert not group.mcp_available
    assert "Another program is answering" in (group.mcp_endpoint_reason or "")


def test_the_window_never_shows_either_credential(
    machine: Machine,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Neither the Anytype API key nor the proxy bearer token reaches the window.

    Two credentials, two trust boundaries, and the window is entitled to neither. The
    endpoint is really served, with a real token, while a real key sits in this machine's
    config — so both are present in the process that draws the window, which is the only
    condition under which their absence from it means anything.
    """
    caplog.set_level(logging.DEBUG)
    # Through the environment, which `load_api_key` reads before any file: it is the one
    # source no real key on the machine running the gate can win against.
    monkeypatch.setenv(API_KEY_ENV_VAR, FAKE_ANYTYPE_KEY)
    port = free_port()

    with serving_on(port):
        group = anytype_group(
            machine,
            alive=a_running_child(machine),
            endpoint=lambda: observe_endpoint({"INNYTYPES_MCP_PORT": str(port)}),
        )

    shown = "\n".join(
        str(getattr(group, field.name))
        for field in fields(group)
        if field.name not in {"start_pairing", "complete_pairing"}
    )
    captured = capsys.readouterr()
    for credential in (FAKE_ANYTYPE_KEY, TOKEN, FAKE_PROXY_TOKEN):
        assert credential not in shown
        assert leak_sources(credential, captured.out, captured.err, caplog.records) == [], (
            f"{credential!r} escaped the process that draws the window"
        )
    # The key's *presence* is what the window is for, and it is not the key.
    assert group.api_key_set


# --- neither package launches or supervises the other -----------------------------------------


def source_files() -> list[Path]:
    return sorted(SOURCE.rglob("*.py"))


def test_no_source_file_launches_configures_or_supervises_a_client() -> None:
    """The InnyTypes half of the non-goal, asserted over the source tree rather than behaviour.

    Plan 0007 non-goals: *making InnyTypes launch, configure, supervise or stop Codex* and
    *automatically installing Node, the npm package or Codex configuration at startup*. A
    behaviour test cannot show the absence of a feature; this can. The package may not so
    much as name the client — a path to its binary or its `config.toml` is the first line
    of the code that would later start it.
    """
    named = [
        f"{path.relative_to(REPO)}"
        for path in source_files()
        if re.search(r"codex", path.read_text(encoding="utf-8"), re.IGNORECASE)
    ]

    assert named == [], f"the package names the MCP client in {named}"


def test_no_source_file_reaches_for_a_client_configuration_file() -> None:
    """Nor writes the configuration a client would be started from (the same non-goal)."""
    reaching = [
        f"{path.relative_to(REPO)}"
        for path in source_files()
        if ".codex" in path.read_text(encoding="utf-8")
    ]

    assert reaching == []


def flattened(document: Path) -> str:
    """One document as one line, with Markdown emphasis and backticks taken out.

    Prose about a boundary gets bolded, wrapped and re-wrapped; an assertion that a
    sentence is present must not also be an assertion about where the line breaks fell.
    """
    text = document.read_text(encoding="utf-8")
    return re.sub(r"\s+", " ", text.replace("**", "").replace("`", ""))


def toml_blocks(document: Path) -> list[str]:
    """Every fenced ```toml block in one document."""
    return re.findall(r"```toml\n(.*?)```", document.read_text(encoding="utf-8"), re.DOTALL)


def test_the_documented_client_configuration_launches_nothing() -> None:
    """The client half of the non-goal: its configuration is a URL and a token, and no command.

    *making Codex launch, wrap, supervise or stop InnyTypes* is prevented by what the
    documentation tells a person to write. A `command`/`args` pair is precisely the stdio
    connector this plan replaced, and one left in an example is one that gets copied.
    """
    servers = [
        (block, name, table)
        for document in (CONNECTION_DOC, README)
        for block in toml_blocks(document)
        for name, table in tomllib.loads(block).get("mcp_servers", {}).items()
    ]

    assert servers, "the documentation shows no MCP client configuration at all"
    for block, name, table in servers:
        assert "url" in table, f"{name} is configured without a URL: {block}"
        assert "bearer_token_env_var" in table, f"{name} carries no bearer token: {block}"
        assert "command" not in table, f"{name} launches a process: {block}"
        assert "args" not in table, f"{name} launches a process: {block}"
        assert table["url"].endswith("/mcp"), f"{name} is not pointed at the MCP path: {block}"


def test_the_documentation_never_configures_a_client_for_the_anytype_rest_port() -> None:
    """Port 31009 is Anytype's REST API, and no example may hand it to a client.

    Prose may — and does — warn about it. A code block is the part a person copies, so
    that is where its absence is asserted.
    """
    blocks = [
        block
        for document in (CONNECTION_DOC, README)
        for block in re.findall(
            r"```[a-z]*\n(.*?)```", document.read_text(encoding="utf-8"), re.DOTALL
        )
    ]

    assert blocks
    for block in blocks:
        assert ANYTYPE_REST_PORT not in block, f"a copyable example names it:\n{block}"

    # And the prose steers a person away from it in as many words. A proximity heuristic
    # over the whole document was tried first and is worthless: any nearby "never" rescues
    # a sentence that recommends the port. This looks for the steer itself.
    prose = flattened(CONNECTION_DOC)
    assert re.search(rf"do not use .{{0,60}}{ANYTYPE_REST_PORT}", prose, re.IGNORECASE), (
        "the documentation never tells a person not to use Anytype's REST port"
    )
    assert re.search(rf"{ANYTYPE_REST_PORT}.{{0,40}}is Anytype's REST API", prose, re.IGNORECASE), (
        "the documentation never says what port 31009 actually is"
    )


def test_the_documentation_says_which_transport_is_public_and_which_is_private() -> None:
    """The child's pipes are an implementation detail and the HTTP endpoint is the contract.

    A person who reads only this page must not come away thinking the stdio child is
    something they may attach to, because attaching to it is the second child this plan
    exists to prevent.
    """
    prose = flattened(CONNECTION_DOC)

    assert re.search(r"stdio pipes are private internal transport", prose, re.IGNORECASE)
    assert re.search(r"public contract is the loopback Streamable HTTP", prose, re.IGNORECASE)


# --- an absent host, and one that starts later ------------------------------------------------


def test_an_absent_host_is_an_ordinary_refused_connection() -> None:
    """What a client sees when InnyTypes is not running: TCP said no, and nothing else.

    No half-open socket left by a departed process, no stale unix path, no orphaned
    connector — the failure mode of an HTTP MCP server that is not up.
    """
    port = free_port()

    with pytest.raises(ConnectionRefusedError):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5.0)
        try:
            connection.request("POST", "/mcp", body=b"{}")
        finally:
            connection.close()

    report = observe_endpoint({"INNYTYPES_MCP_PORT": str(port)})
    assert not report.available


def test_a_host_that_starts_later_serves_a_fresh_client_with_no_handoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The stop condition, minus the part only a real client can settle.

    A client that found the address refused a moment ago initializes, lists and calls over a
    connection it opens itself, from nothing but the URL and the token. Three separations
    are asserted while it does:

    * **no process handoff** — every way this interpreter can start a process raises for the
      whole exchange, so a spawn anywhere in it fails the test rather than passing quietly;
    * **no inherited descriptor** — the listening socket is not inheritable, so no child of
      either side could be handed it;
    * **no connector command** — the client is constructed from an address and a token, and
      there is nothing else to construct it from.
    """
    port = free_port()
    with pytest.raises(ConnectionRefusedError):
        socket.create_connection(("127.0.0.1", port), timeout=5.0).close()

    with serving_on(port) as gateway:
        assert gateway._server is not None
        assert gateway._server.socket.get_inheritable() is False

        def never(*args: object, **kwargs: object) -> Any:
            raise AssertionError("a process was started while the two sides were talking")

        monkeypatch.setattr(subprocess, "Popen", never)
        monkeypatch.setattr(os, "posix_spawn", never)
        monkeypatch.setattr(os, "fork", never, raising=False)

        status, handshake = post(
            port,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "a client that started on its own", "version": "1"},
                },
            },
        )
        assert status == 200
        assert handshake["result"]["protocolVersion"] == MCP_PROTOCOL_VERSION

        listed_status, listed = post(port, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        called_status, called = post(
            port,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "get_object", "arguments": {}},
            },
        )

    assert listed_status == 200
    assert [tool["name"] for tool in listed["result"]["tools"]] == ["get_object"]
    assert called_status == 200
    assert called["result"]["content"][0]["text"] == "get_object"


def test_the_service_answers_a_second_client_on_a_connection_of_its_own() -> None:
    """Two independent clients, two sockets, and no state passed between them.

    A client that connects later gets a complete session of its own; nothing about the
    first one is needed to start the second, which is what "starts independently" means
    for the side that is already up.
    """
    port = free_port()

    with serving_on(port):
        first = post(port, {"jsonrpc": "2.0", "id": 1, "method": "ping"})
        second = post(port, {"jsonrpc": "2.0", "id": 1, "method": "ping"})

    assert first == second == (200, {"jsonrpc": "2.0", "id": 1, "result": {}})
    # No session identity is issued, so there is nothing for a second client to inherit.
    assert "Mcp-Session-Id" not in json.dumps(first[1])


def test_a_window_whose_endpoint_reading_fails_still_draws_and_still_quits(
    machine: Machine,
) -> None:
    """F1 outranks the endpoint. A seam that raises is a sentence, not a missing window."""

    def refuses() -> EndpointReport:
        raise OSError("this machine would not say")

    wiring = wire(machine, endpoint=refuses)

    contents = wiring.window.open()

    assert Element.QUIT in contents.elements
    application = wiring.desktop.tabbed.application
    assert isinstance(application, ApplicationTab)
    assert application.anytype.mcp_url == ""
    assert not application.anytype.mcp_available
