---
type: plan
title: The Anytype MCP server — a core part of the host
status: APPROVED
created: 2026-09-12
updated: 2026-09-15
---

# 0002 — The Anytype MCP server

## What this is

The host supervises the **official Anytype MCP server** and exposes its tools to addons. It was
first planned as a separate addon repository, `anytype-mcp`; on 2026-09-15 it was absorbed into
the host core as `innytypes.anytype_mcp`, and that repository was deleted. Its history is kept
in this repository's git log.

It is core rather than an addon because plan 0001 already makes the host supervise "a Node MCP
server" as one of its three child kinds. As an addon it would have been a second supervisor for
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

Generic child-process policy (restart with backoff, orphan-free shutdown) belongs to plan 0001
slice 07, which covers all three child kinds. This module supplies what is specific to the MCP
child: its argv, its environment, its health check.

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
| key acquisition | Anytype → App Settings → API Keys → Create new, or `npx -y @anyproto/anytype-mcp@1.2.10 get-key` |

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
`spawn` callable, the health check takes an `httpx.Client`. Tests that genuinely cannot be
written that way are marked `needs_node` / `needs_anytype` and skipped when absent.

`node_modules/` is gitignored, so the gate must never read it. Installing the Node server is
only needed to actually run against Anytype: `npm ci`.

## The API key

Never committed. It is read from `$ANYTYPE_API_KEY`, falling back to
`~/.config/innytypes/anytype_api_key`. Both are outside the repository:

```bash
export ANYTYPE_API_KEY='...'
# or
mkdir -p ~/.config/innytypes && printf '%s' '...' > ~/.config/innytypes/anytype_api_key
```

`ServerConfig` declares the field `repr=False`, because a supervisor logs its own configuration
when a child dies and the default dataclass `repr` would put the credential in that log. `tests/test_no_secrets.py`
scans every **git-tracked** file for credential-shaped strings, and proves the scanner can fail
by planting one.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | foundation | `ServerConfig`, `Supervisor`, `is_api_reachable`, both lockfiles, both pins, pinning + secret tests. **Landed** (in `anytype-mcp`, then moved here). |
| 02 | key acquisition | A first-run path to obtain and store a key: wrap `get-key`, write the key file with `0600`, never echo it. |
| 03 | health-gated start and redaction | Start refuses when Anytype is unreachable; every log record the MCP supervisor emits is redacted. |
| 04 | tool surface | Enumerate the tools the pinned server actually exposes and record them as a fixture, so a version bump shows its diff. |
| 05 | host integration | The host starts the MCP server as a core child, degrades when it cannot, and exposes the tool surface to addons through the host API. |
| 06 | upgrade procedure | A tested, documented path to bump either pin, with the tool-surface diff as the evidence. |

Slices 02–06 are seeded as WorkItems in `docs/loop/inbox/`.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees. This plan is done for MVP when
`innytypes up` starts the MCP server, an addon can obtain the Anytype tool surface through the
host API, and shutdown stops the server cleanly, with both versions pinned and no credential
anywhere in the tree.
