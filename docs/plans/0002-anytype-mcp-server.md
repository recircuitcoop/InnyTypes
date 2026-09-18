---
type: plan
title: The Anytype MCP server — a core part of the host
status: APPROVED
created: 2026-09-12
updated: 2026-09-18
---

# 0002 — The Anytype MCP server

## What this is

The host supervises the **official Anytype MCP server** and exposes its tools to addons. It was
first planned as a separate addon repository, `anytype-mcp`; on 2026-09-15 it was absorbed into
the host core as `innytypes.anytype_mcp`, and that repository was deleted. Its history is kept
in this repository's git log.

It is core rather than an addon because plan 0001 already makes the host supervise "a Node MCP
server" as one of its child kinds. As an addon it would have been a second supervisor for
a child the host supervises anyway.

The thing supervised is **a Node package, not a Python library**: `@anyproto/anytype-mcp`
(official, MIT, [anyproto/anytype-mcp](https://github.com/anyproto/anytype-mcp)) converts
Anytype's OpenAPI specification into MCP tools. The host **supervises an npm process**. It
imports nothing from it, and it never will. The seam between the two ecosystems is a child
process with an environment, and that is the whole interface.

## Scope

`innytypes.anytype_mcp` owns exactly three things:

1. **Supervising the Node process**: start, health, stop.
2. **Holding the Anytype API key safely**: never in the tree, never in a `repr`, never in a log.
3. **Pinning both versions**: the npm package, and the Anytype API version.

Restart policy (backoff, maximum attempts, quarantine) belongs to InnyTypesHelper (plan 0003),
which owns every restart in the application. Spawning the child and orphan-free shutdown belong to
plan 0001 slice 07: the host stays the MCP server's parent because it holds its stdio pipes. This
module supplies what is specific to the MCP child: its argv, its environment, its health check.

Being core does not weaken plan 0001's invariant: **`innytypes.anytype_mcp` imports no addon.**

## How the server is configured

Verified against `@anyproto/anytype-mcp@1.2.10` (the published tarball and its README) on
2026-09-12:

| thing | value |
|---|---|
| launch | `npx -y @anyproto/anytype-mcp@1.2.10` (bin: `anytype-mcp` → `bin/cli.mjs`) |
| credential + version | `OPENAPI_MCP_HEADERS`, a **JSON-encoded string** |
| header contents | `{"Authorization":"Bearer <key>","Anytype-Version":"2025-11-08"}` |
| API base URL | `ANYTYPE_API_BASE_URL`, default `http://127.0.0.1:31009` |
| key acquisition | `innytypes anytype-mcp get-key`, which wraps `npx -y @anyproto/anytype-mcp@1.2.10 get-key`; or Anytype → App Settings → API Keys → Create new |

Note the shape: the server parses **one** environment variable containing JSON, rather than
reading discrete header variables. The encoding is part of the contract.

`anytype-cli` listens on port `31012` instead of `31009`, which is the reason the base URL is
configurable rather than constant.

## The API version is a dependency

Because the server turns Anytype's OpenAPI spec into tools, the `Anytype-Version` it speaks
**determines which tools exist**. A changed header value can add, remove or reshape tools that
addons depend on. It is therefore pinned in configuration and **treated as a dependency
upgrade**: proposed in a WorkItem, reviewed, and landed with the evidence of what changed in the
tool surface.

| pin | value | where |
|---|---|---|
| npm package | `1.2.10` | `package.json` + `innytypes.anytype_mcp.config.PACKAGE_VERSION` |
| Anytype API | `2025-11-08` | `innytypes.anytype_mcp.config.ANYTYPE_VERSION` |

## The tool surface is recorded, so a bump has something to diff against

"Landed with the evidence of what changed" needs a *before*. That before is
`src/innytypes/anytype_mcp/tool_surface.json`: a committed record of which tools the pinned
pair exposes, carrying both version values it was captured at. It maps each tool name to a
SHA-256 signature of that tool's input schema rather than just listing names, because the
failure plan 0002 actually fears is not a tool disappearing — that breaks loudly — but a
tool keeping its name and changing its arguments, which breaks quietly and much later.

Three pieces, and the split between them is what keeps the gate hermetic:

| piece | where | needs Node? |
|---|---|---|
| the record | `src/innytypes/anytype_mcp/tool_surface.json` | no — committed |
| reading it and comparing two of them | `innytypes.anytype_mcp.tools` | no — pure |
| re-recording it from the real server | `innytypes.anytype_mcp.refresh` | **yes** |

`compare_surfaces(before, after)` returns added / removed / **changed** tool names and does
nothing else: no file, no process, no network. It deliberately ignores the version pins the
two surfaces carry, because comparing across versions is the entire point during an upgrade.

### Refreshing the record

```bash
npm ci                                      # the one command that needs Node
innytypes anytype-mcp refresh-tool-surface  # with Anytype running and a key in place
```

That command launches the pinned server — the same argv the supervisor uses — speaks MCP
over stdio to it (`initialize` → `notifications/initialized` → `tools/list`), rewrites the
fixture, and prints the diff against what was recorded before. It is the only thing in this
repository that needs Node, it is never run by the gate or by the host, and a person types
it. `--output` writes elsewhere; `--key-file` reads the key from somewhere other than the
default.

### What this means for an upgrade

Bumping either pin without re-recording turns the gate **red**: a test asserts the fixture's
recorded versions equal `config.PACKAGE_VERSION` and `config.ANYTYPE_VERSION`. So the
procedure is forced rather than remembered — bump the pin, refresh against a real Anytype,
and land the fixture's diff alongside it as the evidence. That diff is what slice 06 turns
into a documented upgrade procedure.

### How the committed record was obtained, and how far it goes

The fixture says so itself, in its `source` and `note` fields, because the two ways of
capturing it are not equally strong evidence:

* `live-server` — read off a running server against a real Anytype. Only
  `refresh-tool-surface` writes this, and only it proves what the **pair** exposes.
* `bundled-spec` — what is committed today. `@anyproto/anytype-mcp` fetches its OpenAPI
  document from the running app at `/docs/openapi.json`, and the pinned tarball also ships
  the document it was built against (`scripts/openapi.json`, `info.version` **2025-11-08** —
  the pinned `ANYTYPE_VERSION` exactly). The record was produced by running the real pinned
  server over MCP stdio with its spec URL pointed at that bundled document, so the 34 names
  and signatures are the server's own `tools/list` answer, not something this repository
  computed. What is *not* proven is that a running Anytype serves the same document. Anyone
  with Anytype installed can settle that by running the refresh; if the surface moves, the
  command will say exactly how.

## Pinning across two ecosystems

Plan 0001's pinning rule applies unchanged to the Python side. The Node side adds:

1. `@anyproto/anytype-mcp` at an **exact** version (`1.2.10`: no caret, no tilde, no tag), with
   **`package-lock.json` committed** at the repository root.
2. The `Anytype-Version` header pinned in configuration (`2025-11-08`).
3. **Enforced, not documented**: `tests/test_pinning.py` fails the gate on a non-exact npm
   version, on a missing lockfile, and on `package.json` and `config.PACKAGE_VERSION`
   disagreeing.

## The gate stays hermetic

`docs/loop/verify.sh` must **not** require the Node server to be installed, nor Anytype to be
running. Every test that would need either injects its dependency: the supervisor takes a
`spawn` callable, the health check takes an `httpx.Client`, the supervisor takes one too
(`Supervisor.health_client`) because its start gate runs that check, and key acquisition takes the
runner that would invoke `npx`. Tests that genuinely cannot be written that way are marked
`needs_node` / `needs_anytype` and skipped when absent.

`Supervisor.start()` runs the health check before it spawns, and raises `ApiUnreachableError` —
a `SupervisorError` — when Anytype does not answer. The error names the base URL it tried, so the
user knows whether to start the app or fix `ANYTYPE_API_BASE_URL`. It never restarts anything:
restart policy is InnyTypesHelper's, in plan 0003.

`node_modules/` is gitignored, so the gate must never read it. Installing the Node server is
only needed to actually run against Anytype: `npm ci`. The one module that talks to the real
server, `innytypes.anytype_mcp.refresh`, injects its spawn for the same reason everything
else here does, so the gate exercises the whole MCP conversation against a fake child that
answers JSON-RPC in-process. Only the default spawn itself needs Node, and nothing in the
gate reaches it.

## The API key

Never committed. It is read from `$ANYTYPE_API_KEY`, falling back to
`~/.config/innytypes/anytype_api_key`. Both are outside the repository:

```bash
export ANYTYPE_API_KEY='...'
# or
mkdir -p ~/.config/innytypes && printf '%s' '...' > ~/.config/innytypes/anytype_api_key
```

Doing that by hand is how a credential ends up in a shell history, so the host offers the same
thing as one command: **`innytypes anytype-mcp get-key`** (`innytypes.anytype_mcp.keys`). It runs
the pinned `get-key`, which walks Anytype's challenge flow — the desktop app shows a four-digit
code, the user types it — and writes the key it produces to `~/.config/innytypes/anytype_api_key`.

What that path guarantees, each of it enforced by a test that fails when the check is deleted:

* The child's **stdout and stderr are captured, its stdin is not**. The user answers the prompt;
  the key the child prints — twice, once as `Your API KEY:` and once inside an example `Bearer`
  header — goes into the key file and onto no terminal.
* The file is created **0600 by `os.open`**, never by a later `chmod`: a file that is briefly
  world-readable is a file that was readable. `--force` re-applies the mode, because truncating an
  existing file keeps the old one. The directory the host creates for it is `0700`; a directory
  that already exists is left as its owner made it. The open is `O_NOFOLLOW`, so the key is never
  written *through* a symlink.
* An existing key file is **never replaced without `--force`**, and the refusal is the `O_EXCL` in
  the open rather than a prior `exists()` check.
* Every failure — npx absent, a non-zero exit, empty or unparseable output — is a named
  `KeyAcquisitionError` (a `ConfigError`) whose message names the exit code, the command or the
  file, and **never repeats a byte the child printed**. The key is registered with the redactor the
  moment it is read, so anything that later renders it through this package prints `[redacted]`.

Acquisition is explicit, like installation (plan 0001, invariant 6): nothing obtains a key at
startup. The command is one the user types.

`ServerConfig` declares the field `repr=False`, because a supervisor logs its own configuration
when a child dies and the default dataclass `repr` would put the credential in that log. `tests/test_no_secrets.py`
scans every **git-tracked** file for credential-shaped strings, and proves the scanner can fail
by planting one.

`repr=False` only covers the repr, and the key also travels to the child inside
`OPENAPI_MCP_HEADERS` — a plain string any log line can render. So there is a second mechanism:
`innytypes.anytype_mcp.logs`. Building a `ServerConfig` registers its key with that module's
redactor, and every logger in the package carries a filter that removes registered credentials
from a record before any handler sees it. The exit report the supervisor writes when a child dies
*on its own* therefore prints the configuration the child actually received — base URL, header version — with
the credential replaced by `[redacted]`, and prints only the variables this package sets, never
the inherited environment. Redaction is exact-match on the registered key rather than pattern
matching, because a pattern fails open on the credentials it did not anticipate.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | foundation | `ServerConfig`, `Supervisor`, `is_api_reachable`, both lockfiles, both pins, pinning + secret tests. **Landed** (in `anytype-mcp`, then moved here). |
| 02 | key acquisition | A first-run path to obtain and store a key: wrap `get-key`, write the key file with `0600`, never echo it. |
| 03 | health-gated start and redaction | Start refuses when Anytype is unreachable; every log record the MCP supervisor emits is redacted. |
| 04 | tool surface | Enumerate the tools the pinned server actually exposes and record them as a fixture, so a version bump shows its diff. **Landed.** |
| 05 | host integration | The host starts the MCP server as a core child, degrades when it cannot, and exposes the tool surface to addons through the host API. |
| 06 | upgrade procedure | A tested, documented path to bump either pin, with the tool-surface diff as the evidence. |

Slices 02–06 are seeded as WorkItems in `docs/loop/inbox/`.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees. This plan is done for MVP when
`innytypes up` starts the MCP server, an addon can obtain the Anytype tool surface through the
host API, and shutdown stops the server cleanly, with both versions pinned and no credential
anywhere in the tree.
