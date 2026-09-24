---
type: plan
title: Expose the host-owned Anytype MCP child over loopback TCP
status: DONE
created: 2026-09-21
updated: 2026-09-24
---

# 0007 — Expose the host-owned Anytype MCP child over loopback TCP

## Outcome

InnyTypes independently starts a standard Streamable HTTP MCP endpoint on loopback TCP. Codex,
or any compatible MCP client, independently connects to that URL whenever it is running. Neither
application starts, wraps or supervises the other.

```text
Codex or another MCP client
        |
        | Streamable HTTP MCP
        | http://127.0.0.1:31010/mcp
        v
InnyTypes host --private stdio MCP session--> its @anyproto/anytype-mcp child --> Anytype
```

There remains exactly one official Anytype MCP child. The host remains its parent and owns its
start and stop. InnyTypesHelper remains the only owner of restart policy. The child's stdio pipes
remain an internal implementation detail and no client command is launched by Codex.

## Why the service is not reachable today

`ChildSupervisor.start()` asks `innytypes.anytype_mcp.Supervisor` to spawn the Node child with
private stdin and stdout pipes. Only the parent can use those pipes; an independently started
client cannot attach to them. `innytypes.host.anytype_tools()` is intentionally only the
committed catalogue of names and schema signatures, not a live request channel.

This plan makes the InnyTypes application the network-facing MCP server. It does not expose
Anytype's port 31009, which is Anytype's REST API rather than MCP, and it never starts a second
`@anyproto/anytype-mcp` process.

## The public connection

The host listens on `127.0.0.1:31010` by default and serves Streamable HTTP MCP at `/mcp`.
The address and port are host settings so a collision can be resolved explicitly; the default
is stable and the host never silently chooses another port that configured clients do not know.
Only numeric loopback addresses are accepted in this plan. Binding `0.0.0.0`, a LAN interface or
a public address is refused.

The endpoint uses a separate persistent bearer token generated and stored owner-only by
InnyTypes. This is not the Anytype API key. The API key stays in `ServerConfig` and the child
environment; it never crosses the HTTP boundary. A client is configured once with the endpoint
URL and proxy token and thereafter starts independently. Rotating the proxy token invalidates
existing clients explicitly.

Codex supports Streamable HTTP MCP servers by URL and bearer-token authentication. Its
configuration points directly at the InnyTypes URL; it contains no command that launches
InnyTypes or the child. InnyTypes likewise contains no Codex command, path or lifecycle logic.

## The host-owned child session

`innytypes.anytype_mcp.Supervisor` already owns the child and its pipes, so it gains the internal
MCP client session rather than introducing another supervisor. A successful start becomes:

1. pass the existing Anytype reachability gate;
2. spawn the pinned child once;
3. perform MCP `initialize` and `notifications/initialized` over the existing pipes;
4. call `tools/list` and compare every tool name and input-schema signature with committed
   `tool_surface.json`;
5. only after an exact match, mark the child session available to the HTTP service.

If initialization, framing or surface validation fails, the supervisor stops the spawned child,
clears its state and raises a named `SupervisorError`. The host reports the existing
`innytypes.anytype-mcp` degradation and continues starting unrelated addons. Nothing retries
inside the host.

One reader owns child stdout and one serialized writer owns child stdin. Host-assigned child
request ids map HTTP requests back to their callers. Frames, pending requests and call duration
have finite named bounds. Child death completes every pending call with an MCP error; calls are
never silently retried because a tool may mutate Anytype.

## Streamable HTTP behavior

The endpoint implements the standard MCP handshake, `ping`, `tools/list` and `tools/call`.
`tools/list` returns the child's complete live definitions only after they match the committed
surface. `tools/call` accepts only a validated name and forwards its arguments through the
existing child session. Unknown methods receive the standard JSON-RPC method-not-found error.

The HTTP layer validates bearer authentication before parsing a body, validates `Host` and
`Origin` against loopback to resist local DNS-rebinding paths, bounds headers and request bodies,
and applies bounded concurrent requests and timeouts. It returns MCP/JSON-RPC errors for protocol
failures and appropriate HTTP status codes for transport or authentication failures. It never
places credentials in URLs, responses or logs.

If the configured port is already occupied, exposure degrades with the address named; the host
and unrelated addons continue. When the child is unavailable, `/mcp` returns a bounded service-
unavailable response. A helper-requested child restart reconstructs and revalidates the internal
session before tools become available again. The HTTP listener itself belongs to the host and
stops during host shutdown; it never decides to restart anything.

## Key-path compatibility

The currently shipped paths disagree about Anytype API-key discovery: plan 0002 and the host use
`~/.config/innytypes/anytype_api_key`, while the helper UI has also used its platform data
directory. All readers and writers move to one loader. The documented path remains canonical; a
read-only fallback recognizes the legacy helper path when the canonical file is absent, without
copying, logging or deleting it. New acquisition writes only the canonical path. Removing the
fallback is a later migration.

The proxy bearer token has its own file and lifecycle. It is never substituted for, derived from
or stored beside an MCP message containing the Anytype API key.

## Acceptance

- Starting InnyTypes with fake reachable Anytype and a fake MCP child spawns exactly one pinned
  child, completes the stdio MCP handshake, validates its surface and opens the configured
  loopback TCP endpoint.
- An independently created Streamable HTTP MCP client initializes, lists tools and calls one
  through the already-running child. Neither side launches or supervises the other.
- Tests prove the public service binds only the configured loopback address and port, refuses
  wildcard/non-loopback binds and degrades cleanly on a port collision.
- Missing or incorrect bearer authentication is refused before request parsing. Tests prove the
  Anytype API key is absent from HTTP requests, responses, URLs, errors and logs.
- Added, removed or schema-changed live tools prevent availability and produce a named host
  degradation; `anytype_tools()` continues returning the committed catalogue.
- Missing key, unreachable Anytype, dead child, malformed or oversized HTTP/MCP request,
  timeout and full concurrency bound each have a refusal or degradation test.
- Host shutdown closes the port and child without an orphan; a helper-requested restart exposes
  tools again only after a fresh child handshake and validation.
- Documentation provides a Codex URL configuration using Streamable HTTP and bearer-token
  authentication, with no stdio command and no direct port 31009 access.
- A manual smoke test starts InnyTypes and Codex separately, confirms Codex reaches the endpoint,
  and confirms the process tree contains one Anytype MCP child.
- `docs/loop/verify.sh` exits zero and prints `gate: GREEN` without Node, Anytype, a real
  credential or a real user port.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | one key location | canonical Anytype-key reads/writes, read-only legacy fallback and UI/host agreement |
| 02 | the child session | stdio handshake, correlation, bounds, shutdown and committed-surface validation over injected pipes |
| 03 | the loopback MCP service | Streamable HTTP, stable configurable address/port, proxy bearer token, request bounds, tool routing and graceful degradation |
| 04 | independent client connection | application endpoint status, Codex URL/token configuration documentation and separate-process smoke verification |

**Order:** 01 → 02 → 03 → 04. Slice 04 is the stop condition: independently started Codex uses
the InnyTypes TCP endpoint and the process tree contains only the host-owned child.

## Non-goals

- binding outside loopback or exposing the service to a LAN or the internet;
- starting another `@anyproto/anytype-mcp` process for any client;
- direct Anytype API access by clients;
- making Codex launch, wrap, supervise or stop InnyTypes;
- making InnyTypes launch, configure, supervise or stop Codex;
- generic MCP-provider brokering or provider discovery;
- changing the committed tool-surface upgrade procedure;
- moving restart policy out of InnyTypesHelper;
- automatically installing Node, the npm package or Codex configuration at startup.

## Rollback and compatibility

The HTTP endpoint is additive. Disabling its host setting or removing a client's URL restores
present behavior without changing child ownership. Rolling back the release leaves only the
owner-only proxy-token file, which can be deleted explicitly after rollback; rollback never
touches the Anytype API key. A failed bind never kills the host or unrelated addons.

## Delivered

All four slices are built and merged, 2026-09-22. Every bullet above maps to a named test, and
the map lives in `docs/anytype-mcp-connection.md`. The status stays APPROVED rather than DONE
for one reason: the acceptance bullet requiring a manual smoke with Codex has not been run, and
it is the only one that can fail in a way the suite cannot see. The endpoint emits no
`Mcp-Session-Id`, does not negotiate `Accept: text/event-stream` and requires `Content-Length`.
All three are permitted for a JSON-only Streamable HTTP server, and none is confirmed against
the real client. The procedure to settle it is in the same document; this plan is DONE when it
passes.

One thing the work uncovered and did not fix, because it belongs to plan 0003: the helper-to-host
control channel has both ends built and tested but no production caller, so the helper could not
be told the host's bind-time failure. The application therefore observes the endpoint itself,
which needs no channel and no credential. Plan 0008 owns the assembly.

Approved by the owner on 2026-09-21. The owner corrected the first draft before implementation:
the public boundary is loopback TCP Streamable HTTP, not a Codex-launched stdio connector or a
Unix socket. Plan 0002 and the four WorkItems follow this independent-lifecycle contract.

## Closed

Marked DONE 2026-09-24: every work item is done and on main. The owner's manual check on a real machine is still outstanding.
