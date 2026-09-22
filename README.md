# InnyTypes

InnyTypes is a host application that wraps the [Anytype](https://anytype.io/) desktop app and
runs extra features as isolated addons. One helper process starts or adopts Anytype, starts the
host, watches the whole application, applies updates, and shuts everything down together.

The project is currently at version **0.1.0**. Its contracts and test gate are mature, but its
distribution is still early: bundles are not code-signed, Windows has not yet been package-tested,
and there is no published installer linked from this repository.

## What it provides

- Explicit addon installation, discovery, dependency resolution, and lifecycle management.
- One isolated, hash-locked Python environment per addon.
- A bounded cross-process event bus: a slow subscriber cannot block a publisher.
- The official `@anyproto/anytype-mcp` server as a supervised core child.
- A separate helper that owns health checks, restart policy, quarantine, verified updates,
  rollback, notifications, and privacy-controlled telemetry.
- Declarative plugin settings, including nested tables, rendered by the application rather than
  by plugin-supplied UI code.

## Requirements

- Python 3.13 (the project deliberately pins one Python minor version)
- [`uv`](https://docs.astral.sh/uv/)
- Anytype Desktop for Anytype-backed features
- Node.js only when obtaining an Anytype MCP key or refreshing the recorded MCP tool surface

Runtime and build dependencies are pinned in `pyproject.toml`, `uv.lock`, `package.json`, and
`package-lock.json`. Do not replace exact runtime pins with floating ranges.

## Run from a checkout

There is not yet a published end-user installer, so the supported path in this repository is a
source checkout:

```console
git clone <repository-url> innytypes
cd innytypes
uv sync --frozen
uv run --no-sync innytypes --version
```

Obtain an Anytype API key once, with Anytype Desktop available to complete its challenge flow:

```console
uv run --no-sync innytypes anytype-mcp get-key
```

The key is stored in the platform configuration directory with owner-only permissions. You may
instead provide `ANYTYPE_API_KEY`; never put a key in this repository.

For the full application lifecycle, start the helper:

```console
uv run --no-sync innytypes-helper
```

For host-only development, `uv run --no-sync innytypes up` starts the host and its children in
the foreground. It does not install or update anything during startup.

## Connect an AI client through MCP

While InnyTypes is running, it exposes its supervised Anytype tools to independent AI clients at:

```text
http://127.0.0.1:31010/mcp
```

The application's **Anytype** panel shows the address this installation is actually configured
with on its **MCP endpoint** row, with `available` or `degraded` beside it; that row is the one to
copy from. Clients connect with MCP Streamable HTTP and a bearer token stored at
`~/.config/innytypes/mcp_proxy_token`; this proxy token is separate from the Anytype API key.
InnyTypes and the AI client keep independent lifecycles—neither launches or stops the other.

The address is a stored setting, and a stored value is what InnyTypes serves. Put another port
in the `[mcp]` section of `~/.config/innytypes/config.toml`, then use it in every client URL;
`host` selects another numeric loopback address, and InnyTypes refuses LAN, public, wildcard, and
hostname binds. `INNYTYPES_MCP_HOST` and `INNYTYPES_MCP_PORT` are the default for a machine that
has never been configured: they select the address only while nothing is stored, and are ignored
once it is. Port `31009` is Anytype's REST API and is not an MCP endpoint.

See [Connect an independent MCP client to InnyTypes](docs/anytype-mcp-connection.md) for Codex
configuration, generic MCP client setup, architecture patterns, security, and troubleshooting.

## Command-line overview

```console
innytypes addons install <name>==<version>  # or a local source/wheel path
innytypes addons list
innytypes addons outdated
innytypes addons update <id>               # or --all
innytypes addons enable <id>
innytypes addons disable <id>
innytypes addons pin <id>
innytypes addons unpin <id>
innytypes addons remove <id>

innytypes helper status
innytypes helper release <id>
innytypes telemetry status
innytypes telemetry show
innytypes telemetry on                     # or off
innytypes quit                             # add --force for a hung application
```

Installation is always explicit. In particular, `innytypes up` never mutates an addon
environment. Use `innytypes <command> --help` for the complete options and platform-specific
default paths.

## Addon architecture

The dependency direction is intentional: **addons depend on InnyTypes; InnyTypes never depends
on an addon**. The host does not import addon code. It reads the manifest recorded at install
time, resolves addon dependencies, and starts each addon in its own process and environment.

An addon declares its identity, host API version, requirements, event kinds, stability and update
policy, and settings schema. Event kinds are public APIs named `<addon-id>.<name>.v<N>`; changing
a payload requires a new versioned kind. Settings are data, not widgets, so the host can validate,
store, and draw the same declaration on every platform.

See [plan 0001](docs/plans/0001-innytypes-host.md) for the host contract and
[the project Loop pack](docs/loop/SKILL.md) for the invariants contributors must preserve.

## Development and verification

Run the canonical gate from the repository root:

```console
./docs/loop/verify.sh
```

The gate creates or synchronizes its environment from the frozen lock, then runs formatting,
linting, strict type checking, the branch-aware test suite and coverage checks, dependency-pin
checks, secret scans, and the documentation/code consistency checks. It must finish with
`gate: GREEN` from a clean checkout; tests must not depend on untracked local fixtures, Node, or a
running Anytype instance.

Useful focused commands after `uv sync --frozen` are:

```console
uv run --no-sync pytest
uv run --no-sync ruff check .
uv run --no-sync ruff format --check .
uv run --no-sync mypy
```

Plans live in `docs/plans/`, executable work-item records in `docs/loop/inbox/`, and implementation
notes in `docs/log.md`. A change is complete only when its plan, tests, and code agree.

## Packaging and current limitations

Briefcase configuration is included for native macOS, Windows, and Linux applications. Build on
the target platform where required; Windows applications in particular must be built on Windows.
A Linux Debian package has been produced in a container, and macOS is the platform exercised end
to end today.

Current release constraints:

- Bundles are unsigned, so operating systems may warn on first launch.
- The Windows implementation is covered by tests, but a Windows package still needs a native
  build and package-level verification.
- Addon installation from a bundled application still needs the bundle to carry a wheel of the
  matching InnyTypes version; source-checkout installation already works.
- Release `0.1.0` is documented in [CHANGELOG.md](CHANGELOG.md), but this repository has not yet
  established automated cross-platform CI or a tagged binary-release process.

## License

InnyTypes is released under the [MIT License](LICENSE).
