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

The InnyTypes application also shows this default in its **Anytype** panel on the **MCP endpoint**
row. If you configure an override, construct the URL from the configured host and port and keep
the `/mcp` path.

Every request requires the proxy bearer token stored at:

```text
~/.config/innytypes/mcp_proxy_token
```

InnyTypes creates this file on first use with owner-only permissions and reuses the token across
restarts. This is not the Anytype API key: the Anytype key stays on the private side of the proxy
and is never sent by an MCP client.

Do not use `http://127.0.0.1:31009`. Port `31009` is Anytype's REST API, not an MCP transport, and
using it would bypass the InnyTypes-owned MCP child.

## Configure the address

Set these variables in the environment that starts InnyTypes:

- `INNYTYPES_MCP_PORT` selects the TCP port. The default is `31010`; valid values are `1` through
  `65535`.
- `INNYTYPES_MCP_HOST` selects the bind address. The default is `127.0.0.1`; only numeric loopback
  addresses such as `127.0.0.1` or `::1` are accepted. Hostnames, wildcard addresses, LAN
  addresses, and public addresses are refused.

For example, when running the host from a checkout:

```console
INNYTYPES_MCP_PORT=32010 uv run --no-sync innytypes up
```

Or export the variables before starting the full helper application:

```console
export INNYTYPES_MCP_PORT=32010
uv run --no-sync innytypes-helper
```

Restart InnyTypes after changing the address, then change every client URL to match. The port is
deliberately stable: if another process already owns it, InnyTypes reports a degraded MCP service
instead of choosing a random fallback port.

For IPv6 loopback, enclose the host in brackets in client URLs:

```text
http://[::1]:31010/mcp
```

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

## Troubleshooting

| Symptom | Likely cause and action |
| --- | --- |
| Connection refused | InnyTypes is stopped, or the client URL has the wrong host or port. Start InnyTypes and compare the URL with its environment. |
| `401 Unauthorized` | The bearer token is missing or stale. Reload `~/.config/innytypes/mcp_proxy_token` into the client environment. |
| `403 Forbidden` | The HTTP `Host` or browser `Origin` does not match the configured loopback endpoint. Connect to the exact URL from a native or backend MCP client. |
| MCP service is degraded at startup | The configured port may already be occupied or the address is invalid. Free the port or set `INNYTYPES_MCP_PORT`, then restart InnyTypes. |
| MCP error says the child is unavailable | Check that Anytype is running, the Anytype API key is configured, and the Anytype MCP child reports as running in the application. |
| Port `31009` answers but MCP does not work | That is Anytype's REST API. Change the client to the InnyTypes endpoint, normally port `31010` with path `/mcp`. |
