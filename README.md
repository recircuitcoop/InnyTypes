# anytype-mcp

A thin Python supervisor around the **official Anytype MCP server**, exposing its tools to
the [`innytypes`](../innytypes) host.

The wrapped thing is a **Node process, not a Python library**: `@anyproto/anytype-mcp`
(official, MIT) converts Anytype's OpenAPI specification into MCP tools. Nothing in this
package imports it — this package starts it, holds its API key, and pins the versions it
speaks.

## Scope

This project owns exactly three things:

1. Supervising the Node process.
2. Holding the Anytype API key safely.
3. Pinning both the npm package version and the `Anytype-Version` API version.

It owns nothing else. Audio, summaries, sources and host contracts belong elsewhere.

## The API version is a dependency

Because the server turns Anytype's OpenAPI spec into tools, the `Anytype-Version` header it
sends **determines which tools exist**. It is pinned in `src/anytype_mcp/config.py` and a
change to it is a dependency upgrade, reviewed like one.

| pin | value | where |
|---|---|---|
| npm package | `1.2.10` | `package.json` + `config.PACKAGE_VERSION` |
| Anytype API | `2025-11-08` | `config.ANYTYPE_VERSION` |
| Python | `==3.13.*` | `pyproject.toml` + `.python-version` |

`tests/test_pinning.py` fails the gate if the two package pins ever disagree.

## The API key

Obtain one from Anytype: **App Settings → API Keys → Create new**, or

```bash
npx -y @anyproto/anytype-mcp@1.2.10 get-key
```

Then make it available *outside this repository*, either way:

```bash
export ANYTYPE_API_KEY='...'
# or
mkdir -p ~/.config/anytype-mcp && printf '%s' '...' > ~/.config/anytype-mcp/api_key
```

The key is passed to the child through `OPENAPI_MCP_HEADERS`, JSON-encoded together with
the pinned `Anytype-Version`. It is never written to the tree, and `ServerConfig` keeps it
out of its own `repr` so a supervisor logging its configuration cannot leak it.
`tests/test_no_secrets.py` scans every tracked file for credential-shaped strings.

## Development

```bash
uv sync --frozen
./docs/loop/verify.sh
```

The gate is hermetic: it needs neither Node nor a running Anytype. Tests that would need
either are marked `needs_node` / `needs_anytype` and skipped when the environment is absent.

Installing the Node server (only needed to actually run against Anytype):

```bash
npm ci
```

This project is loopified — see `docs/loop/SKILL.md` and `docs/plans/`.
