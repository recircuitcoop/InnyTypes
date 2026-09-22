# Connect an independent MCP client to InnyTypes

InnyTypes makes the official Anytype MCP tools available to any local client that supports
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/latest/basic/transports#streamable-http).
The client and InnyTypes remain independent processes: either may start, stop, or restart without
managing the other's lifecycle.

## Find the endpoint and token

The default endpoint is:

```text
http://127.0.0.1:31010/mcp
```

The InnyTypes application shows the address **this installation is configured with** in its
**Anytype** panel, on the **MCP endpoint** row, together with the word `available` or `degraded`
and — when it is degraded — the reason. Copy the URL from that row rather than from this page:
if the address has been configured at all, the row shows the configured one and this page's
default is not yours. When the configuration itself is unserveable (a port that is not a number,
a non-loopback address), there is no endpoint row at all, only the refusal.

The row never shows either credential. It is produced from the address alone, and the check
behind `available` is an unauthenticated request that carries no token.

Every request requires the proxy bearer token stored at:

```text
~/.config/innytypes/mcp_proxy_token
```

InnyTypes creates this file on first use with owner-only permissions and reuses the token across
restarts. This is not the Anytype API key: the Anytype key stays on the private side of the proxy
and is never sent by an MCP client.

Do not use `http://127.0.0.1:31009`. Port `31009` is Anytype's REST API, not an MCP transport, and
using it would bypass the InnyTypes-owned MCP child.

## What is public and what is not

There are two transports here and only one of them is yours.

The **public contract** is the loopback Streamable HTTP endpoint above: a URL and a bearer token,
nothing else. It is the only supported way for any client to reach the Anytype tools, and it is
stable.

The **child's stdio pipes are private internal transport**. InnyTypes starts exactly one
`@anyproto/anytype-mcp` process and speaks MCP to it over its own stdin and stdout; those pipes
belong to the InnyTypes host and no other process can attach to them. They are an implementation
detail, they are not addressable, and they may change without notice. Do not configure any client
with a `command` that launches that child: a second child would compete with the first for the
same Anytype state, and it would not be the one InnyTypes supervises.

## Configure the address

The address is a **stored setting**, and a stored value is what InnyTypes serves. It lives in the
`[mcp]` section of `~/.config/innytypes/config.toml`:

```toml
[mcp]
host = "127.0.0.1"
port = 32010
```

- `port` is the TCP port. The default is `31010`; valid values are `1` through `65535`.
- `host` is the bind address. The default is `127.0.0.1`; only numeric loopback addresses such as
  `127.0.0.1` or `::1` are accepted. Hostnames, wildcard addresses, LAN addresses, and public
  addresses are refused, and a refused value is never stored — the address already saved keeps
  being served.

Either key may be left out. They stand alone, so storing a port leaves the address unconfigured.

Restart InnyTypes after changing the address, then change every client URL to match. The port is
deliberately stable: if another process already owns it, InnyTypes reports a degraded MCP service
instead of choosing a random fallback port.

For IPv6 loopback, enclose the host in brackets in client URLs:

```text
http://[::1]:31010/mcp
```

### The environment variables, and when they still apply

`INNYTYPES_MCP_HOST` and `INNYTYPES_MCP_PORT` are the **default for a machine that has never been
configured**, and nothing more. They select the address only while nothing is stored for that key;
once `[mcp]` holds one, the stored value is served and the variable is ignored. Deleting the
stored key hands the choice back to the variable.

They remain useful when running the host from a checkout, where there is a command line to set
them on:

```console
INNYTYPES_MCP_PORT=32010 uv run --no-sync innytypes up
```

The application this project ships is started by clicking an icon and cannot be given a variable
at all, which is why the stored setting — not the variable — is the way to choose the endpoint.

## Configure Codex

Load the proxy token into the environment that starts Codex:

```bash
export INNYTYPES_MCP_PROXY_TOKEN="$(< ~/.config/innytypes/mcp_proxy_token)"
```

Then add this URL-based server to `~/.codex/config.toml`:

```toml
[mcp_servers.innytypes_anytype]
url = "http://127.0.0.1:31010/mcp"
bearer_token_env_var = "INNYTYPES_MCP_PROXY_TOKEN"
required = false
```

Use your configured host or port in `url` if you changed either one. Do not add `command` or
`args`: those fields configure a client-managed stdio child, while InnyTypes exposes an
independently running TCP service.

With `required = false`, Codex may start while InnyTypes is stopped. The server will be unavailable
until InnyTypes starts; reconnect or start a later Codex session to initialize the connection.

## Configure another MCP client

Use an MCP SDK or a client with Streamable HTTP support and provide:

| Setting | Value |
| --- | --- |
| Transport | MCP Streamable HTTP |
| URL | `http://127.0.0.1:31010/mcp` or the configured loopback URL |
| Authentication | `Authorization: Bearer <proxy-token>` |
| Secret source | `~/.config/innytypes/mcp_proxy_token` |

The client must perform the normal MCP initialization before listing or calling tools. InnyTypes
supports the MCP `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`
flow on this endpoint. Treat the endpoint as MCP, rather than constructing application-specific
JSON requests around it.

Keep the token in the backend or native process that owns the MCP client. A browser frontend
should call your backend, not read the token or call InnyTypes directly. InnyTypes rejects foreign
browser origins as part of its loopback boundary.

## Fit it into an AI architecture

The same endpoint works in several local arrangements:

- A desktop agent can connect directly as a Streamable HTTP MCP client.
- A local orchestration service can hold one authenticated MCP client and make the discovered
  Anytype tools available to its agents according to its own policy.
- A multi-agent system can centralize the connection in its coordinator instead of copying the
  bearer token into every worker.

In all cases, the architecture owns its clients, retries, and reconnect policy. InnyTypes owns the
single `@anyproto/anytype-mcp` child and its Anytype connection. Do not configure an agent to
launch that stdio child itself, and do not make InnyTypes launch the agent. This separation lets
either side restart independently and prevents multiple children from competing for the same
Anytype state.

## Security boundary

- The service is loopback-only and cannot be configured to listen on a LAN or public interface.
- The proxy token authorizes Anytype tool calls, including mutations. Any local process that can
  read it should be treated as trusted.
- Keep the token out of URLs, source control, shell history, logs, prompts, and frontend code.
- The proxy token and Anytype API key serve different trust boundaries. Never substitute one for
  the other.

To rotate the proxy token, stop InnyTypes, deliberately remove the
`~/.config/innytypes/mcp_proxy_token` file, and start InnyTypes to create a new one. Then update or
restart every client that reads the token. There is currently no separate token-rotation command.

## Verify it by hand (manual smoke)

This is the one part of plan 0007's acceptance that the automated gate cannot settle. The gate is
hermetic by construction — no Node, no Anytype, no Codex, no real credential, no fixed user port —
so it can prove everything about the endpoint **except** that a real client, on a real machine,
accepts it. Run this once per release on a machine that has Anytype, Node and Codex installed.

> **Known risk this smoke exists to settle.** The endpoint is a JSON-only Streamable HTTP MCP
> server. It emits **no `Mcp-Session-Id` header**, it does **not** negotiate
> `Accept: text/event-stream` (it never answers with SSE), and it **requires `Content-Length`**
> on every request (it does not accept a chunked body). All three are permitted by the MCP
> Streamable HTTP specification for a server that only ever returns JSON. Whether **Codex**
> accepts all three is **untested**: no automated test in this repository exercises a real Codex
> client, and this procedure is the only thing that settles it. If step 5 fails, capture the exact
> Codex error before changing anything — it tells you which of the three assumptions is wrong.

### 1. Start InnyTypes on its own

In one terminal, with nothing else running:

```console
uv run --no-sync innytypes-helper
```

Leave it running. Do not start Codex from it, and do not pass it any client configuration.

### 2. Confirm exactly one Anytype MCP child exists, owned by InnyTypes

In a second terminal:

```console
pgrep -af "anytype-mcp"
```

Expect **exactly one** line, naming `@anyproto/anytype-mcp` at the pinned version. Then confirm
InnyTypes owns it — take the PID from the line above as `<CHILD_PID>`:

```console
ps -o pid,ppid,command -p <CHILD_PID>
ps -o pid,ppid,command -p $(ps -o ppid= -p <CHILD_PID> | tr -d ' ')
```

The child's parent must be the InnyTypes **host** process (an `innytypes` / `--innytypes-host`
command line), and that host's parent must be the InnyTypes **helper**. On Linux the whole tree is
easier to read at once:

```console
pstree -ap $(pgrep -f innytypes-helper | head -1)
```

### 3. Confirm the application agrees

Open the InnyTypes window, go to the **Anytype** panel, and read the **MCP endpoint** row. It must
show an address and the word `available`. Note the address — it is the one to configure, whatever
this document's default says. Confirm neither credential appears anywhere in the window.

### 4. Confirm the endpoint answers before Codex is involved

Still in the second terminal, with `<URL>` set to the address the window showed:

```console
export INNYTYPES_MCP_PROXY_TOKEN="$(< ~/.config/innytypes/mcp_proxy_token)"
curl -sS -X POST "<URL>" \
  -H "Authorization: Bearer $INNYTYPES_MCP_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expect a JSON-RPC result listing the Anytype tools. If this fails, the problem is InnyTypes, not
Codex, and there is no point continuing.

### 5. Start Codex separately and call a tool through the endpoint

In a **third** terminal — a separate process, started by you, with no relationship to InnyTypes:

```console
export INNYTYPES_MCP_PROXY_TOKEN="$(< ~/.config/innytypes/mcp_proxy_token)"
codex mcp list
codex
```

`codex mcp list` must show `innytypes_anytype` as configured and reachable. Then, inside the Codex
session, ask it to list the Anytype tools and to call one read-only tool (for example, search for
an object). Both must succeed.

### 6. Confirm nothing was launched by anything

With Codex still running, repeat step 2:

```console
pgrep -af "anytype-mcp"
```

There must still be **exactly one** `@anyproto/anytype-mcp` process, still parented to the
InnyTypes host. A second one means a client launched its own child, which this plan forbids.
Then confirm the separation in both directions:

```console
pgrep -af codex          # no codex process may be a child of innytypes
pgrep -af innytypes      # no innytypes process may be a child of codex
```

### 7. Confirm either side can stop without the other

Quit Codex. The InnyTypes window must still show the endpoint as `available`, and the child must
still be the same single process. Then quit InnyTypes (`innytypes quit`), start Codex again, and
confirm it reports the server as unavailable rather than hanging or crashing. Start InnyTypes
again and open a **new** Codex session: it must initialize against the endpoint with no
intervention.

### What to record

Write down, for the release: the InnyTypes version, the Codex version, the address used, whether
step 5 succeeded, and — if it did not — the verbatim Codex error. The three assumptions in the box
above are what that error is read against.

## Requirement-to-test map

Every acceptance bullet of plan 0007, across all four slices, and the named test that proves it.
`manual smoke` means there is no automated proof and the procedure above is the only one.

### Plan 0007, *Acceptance*

| Acceptance bullet | Proof |
| --- | --- |
| Starting InnyTypes with a fake reachable Anytype and a fake MCP child spawns exactly one pinned child, completes the stdio handshake, validates the surface, and opens the configured loopback endpoint | `tests/test_mcp_host_integration.py::test_a_key_and_a_reachable_api_spawn_exactly_one_mcp_child`, `tests/test_anytype_mcp_session.py::test_starting_the_supervisor_spawns_one_child_and_hands_it_the_handshake_in_order`, `tests/test_mcp_host_integration.py::test_no_listener_exists_before_child_validation_can_succeed` |
| An independently created Streamable HTTP MCP client initializes, lists tools and calls one through the already-running child; neither side launches or supervises the other | `tests/test_anytype_mcp_gateway.py::test_independent_http_client_lists_and_calls_tools`, `tests/test_independent_client_connection.py::test_a_host_that_starts_later_serves_a_fresh_client_with_no_handoff`, `tests/test_independent_client_connection.py::test_no_source_file_launches_configures_or_supervises_a_client` |
| The service binds only the configured loopback address and port, refuses wildcard/non-loopback binds, and degrades cleanly on a port collision | `tests/test_anytype_mcp_gateway.py::test_gateway_refuses_every_non_numeric_non_loopback_bind`, `::test_each_accepted_loopback_address_actually_serves_the_endpoint`, `::test_port_collision_is_named_and_never_moves_to_another_port`, `tests/test_mcp_host_integration.py::test_a_configured_port_collision_degrades_only_the_mcp_service` |
| Missing or incorrect bearer authentication is refused before request parsing; the Anytype API key is absent from HTTP requests, responses, URLs, errors and logs | `tests/test_anytype_mcp_gateway.py::test_authentication_is_checked_before_the_body`, `::test_rotating_the_proxy_token_refuses_the_value_it_replaced`, `::test_the_anytype_api_key_reaches_no_request_response_url_error_or_log` |
| Added, removed or schema-changed live tools prevent availability and produce a named host degradation; `anytype_tools()` still returns the committed catalogue | `tests/test_anytype_mcp_session.py::test_a_live_tool_surface_that_differs_is_named_and_stops_the_child`, `::test_a_live_tool_surface_that_differs_does_not_change_the_committed_catalogue`, `tests/test_mcp_host_integration.py::test_a_running_server_does_not_supersede_the_committed_surface` |
| Missing key, unreachable Anytype, dead child, malformed or oversized HTTP/MCP request, timeout and a full concurrency bound each have a refusal or degradation test | `tests/test_mcp_host_integration.py::test_a_missing_key_is_reported_and_the_host_still_runs`, `::test_an_unreachable_anytype_is_reported_and_the_host_still_runs`, `tests/test_anytype_mcp_gateway.py::test_unavailable_child_is_an_mcp_error_not_a_second_child`, `::test_a_body_that_is_not_an_mcp_request_is_refused_as_json_rpc`, `::test_a_body_at_the_bound_is_served_and_one_byte_over_it_is_refused`, `::test_a_body_that_never_arrives_times_out_and_gives_its_slot_back`, `::test_the_concurrency_bound_admits_its_full_count_and_refuses_the_next`, `tests/test_anytype_mcp_session.py::test_a_dead_child_fails_every_pending_call` |
| Host shutdown closes the port and the child without an orphan; a helper-requested restart exposes tools again only after a fresh handshake and validation | `tests/test_mcp_host_integration.py::test_shutdown_closes_the_listener_before_it_stops_the_child`, `::test_a_helper_requested_restart_restores_tools_only_after_a_fresh_validation`, `tests/test_anytype_mcp_gateway.py::test_shutdown_closes_the_listener_and_leaves_no_thread_or_bound_port_behind` |
| Documentation provides a Codex URL configuration using Streamable HTTP and bearer-token authentication, with no stdio command and no direct port 31009 access | `tests/test_independent_client_connection.py::test_the_documented_client_configuration_launches_nothing`, `::test_the_documentation_never_configures_a_client_for_the_anytype_rest_port` |
| A manual smoke test starts InnyTypes and Codex separately, confirms Codex reaches the endpoint, and confirms the process tree contains one Anytype MCP child | **manual smoke** — *Verify it by hand*, steps 1, 2, 5 and 6. Nothing automated covers it: it needs a real Codex, a real Node and a running Anytype, none of which the gate may require. |
| `docs/loop/verify.sh` exits zero and prints `gate: GREEN` without Node, Anytype, a real credential or a real user port | the gate itself; every listener in the suite binds a kernel-assigned port (`tests/test_anytype_mcp_gateway.py::free_port`) and every credential in it is a literal marked `fake` (`tests/test_no_secrets.py`) |

### WI-0007-04, *Acceptance*

| Acceptance bullet | Proof |
| --- | --- |
| The Anytype section shows the configured MCP URL and available/degraded state, including port-collision and unavailable-child reasons, without either credential | `tests/test_independent_client_connection.py::test_the_window_shows_the_configured_address_and_not_the_default_port`, `::test_a_served_address_reads_available`, `::test_an_address_nothing_is_serving_reads_degraded_and_names_it`, `::test_an_address_another_program_holds_reads_as_a_collision`, `::test_a_stopped_child_is_the_reason_the_endpoint_is_degraded`, `::test_a_running_child_behind_a_taken_address_is_still_degraded`, `::test_a_configuration_the_host_would_refuse_shows_no_address_and_the_refusal`, `::test_the_window_never_shows_either_credential`, `tests/test_toolkit_desktop.py::test_the_endpoint_row_names_the_configured_address_and_calls_it_available`, `::test_the_endpoint_row_says_degraded_and_prints_the_reason`, `::test_no_endpoint_row_is_drawn_when_there_is_no_configured_address` |
| Documentation configures Codex with an `mcp_servers` entry containing the loopback URL and `bearer_token_env_var`, matching official Codex Streamable HTTP configuration; no `command` or `args` | `tests/test_independent_client_connection.py::test_the_documented_client_configuration_launches_nothing` |
| Starting either program is not required to start the other; source tests assert neither package contains process launch or supervision logic for the other | `tests/test_independent_client_connection.py::test_no_source_file_launches_configures_or_supervises_a_client`, `::test_no_source_file_reaches_for_a_client_configuration_file`, `::test_the_documented_client_configuration_launches_nothing`; **manual smoke** for the running pair, steps 1, 5 and 7 |
| When InnyTypes is absent the client sees an ordinary unavailable HTTP MCP server; when it starts later, a new connection initializes with no process handoff, inherited descriptor or connector command | `tests/test_independent_client_connection.py::test_an_absent_host_is_an_ordinary_refused_connection`, `::test_a_host_that_starts_later_serves_a_fresh_client_with_no_handoff`, `::test_the_service_answers_a_second_client_on_a_connection_of_its_own`; **manual smoke** for Codex itself, step 7 |
| Documentation never recommends direct Anytype port 31009 and explains that child stdio is private internal transport while the public contract is loopback Streamable HTTP | `tests/test_independent_client_connection.py::test_the_documentation_never_configures_a_client_for_the_anytype_rest_port`; the explanation is *Fit it into an AI architecture* and *Security boundary* above |
| An optional manual smoke starts both separately, lists and calls an Anytype tool through the endpoint, and proves exactly one `@anyproto/anytype-mcp` child owned by InnyTypes | **manual smoke** — *Verify it by hand*, all seven steps |
| Plan 0007 acceptance is mapped to named tests or the smoke procedure; plans 0002 and 0007 and code docstrings agree; `docs/loop/verify.sh` exits zero without Node, Anytype or Codex | this section; the gate |

## Troubleshooting

| Symptom | Likely cause and action |
| --- | --- |
| Connection refused | InnyTypes is stopped, or the client URL has the wrong host or port. Start InnyTypes and compare the URL with the **MCP endpoint** row in its **Anytype** panel. |
| `401 Unauthorized` | The bearer token is missing or stale. Reload `~/.config/innytypes/mcp_proxy_token` into the client environment. |
| `403 Forbidden` | The HTTP `Host` or browser `Origin` does not match the configured loopback endpoint. Connect to the exact URL from a native or backend MCP client. |
| MCP service is degraded at startup | The configured port may already be occupied or the address is invalid. Free the port or store another one in `[mcp]`, then restart InnyTypes. |
| MCP error says the child is unavailable | Check that Anytype is running, the Anytype API key is configured, and the Anytype MCP child reports as running in the application. |
| Port `31009` answers but MCP does not work | That is Anytype's REST API. Change the client to the InnyTypes endpoint, normally port `31010` with path `/mcp`. |
