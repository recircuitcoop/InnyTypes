---
type: plan
title: anytype-mcp — supervising the official Anytype MCP server for innytypes
status: APPROVED
created: 2026-09-12
updated: 2026-09-12
---

# 0001 — anytype-mcp

## What this project is

A thin **wrapper around the official Anytype MCP server**, exposing its tools to the
`innytypes` host (built in parallel at `~/git/innytypes`).

The wrapped thing is **a Node package, not a Python library**: `@anyproto/anytype-mcp`
(official, MIT, [anyproto/anytype-mcp](https://github.com/anyproto/anytype-mcp)) converts
Anytype's OpenAPI specification into MCP tools. This project therefore **supervises an npm
process** — it does not import anything from it, and it never will. The seam between the
two ecosystems is a child process with an environment, and that is the whole interface.

## Scope

This project owns exactly three things:

1. **Supervising the Node process** — start, health, stop, restart policy.
2. **Holding the Anytype API key safely** — never in the tree, never in a `repr`, never in
   a log.
3. **Pinning both versions** — the npm package, and the Anytype API version.

It owns nothing else. Audio, transcription, summaries, source watching and the host's own
contracts belong to `whodunnit`, `monty`, `summarize` and `innytypes` respectively. A
WorkItem in this repo that touches any of those is mis-filed.

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

`anytype-cli` listens on port `31012` instead of `31009`, which is the reason the base URL
is configurable rather than constant.

## The API version is a dependency

Because the server turns Anytype's OpenAPI spec into tools, the `Anytype-Version` it speaks
**determines which tools exist**. A changed header value can add, remove or reshape tools
the host depends on. It is therefore pinned in configuration and **treated as a dependency
upgrade**: proposed in a WorkItem, reviewed, and landed with the evidence of what changed
in the tool surface.

## Pinning — the rule, across two ecosystems

The owner's instruction, verbatim:

> innytype and the addons MUST pin their dependencies

Here that crosses a language boundary, so it is checked on both sides and at the one place
they must agree:

1. **Python**: every runtime dependency uses `==`, never `>=`. Lint and test tooling may use
   a range, but never an unbounded one — an upper bound is mandatory.
2. **`requires-python` pinned to ONE minor version**: `==3.13.*`, matched by a committed
   `.python-version`. Five sibling repos on five interpreters is drift by construction.
   The family version is **3.13, not 3.14**: the sibling `whodunnit` depends on torch,
   speechbrain and pyannote, which trail a new interpreter by months, and 3.13 is the
   newest version whose toolchain has final releases. Moving it is a family-wide decision,
   never a per-repo one.
3. **`uv.lock` committed**, and `verify.sh` runs `uv sync --frozen`.
4. **Node**: `@anyproto/anytype-mcp` at an **exact** version (`1.2.10`, no caret, no tilde,
   no tag) with **`package-lock.json` committed**.
5. **The `Anytype-Version` header pinned in configuration** (`2025-11-08`).
6. **Enforced, not documented**: `tests/test_pinning.py` parses `pyproject.toml` and
   `package.json` and fails the gate on any specifier that is not exact, on a missing
   lockfile, and on the Python pin and the npm pin disagreeing.

## The gate is hermetic

The lesson from a sibling project, where a fresh clone failed the gate for reasons unrelated
to any change: **`docs/loop/verify.sh` must pass from a clean clone with no manual steps.**

Specifically, it must **not** require the Node server to be installed, nor Anytype to be
running. Every test that would need either injects its dependency — the supervisor takes a
`spawn` callable, the health check takes an `httpx.Client`. Tests that genuinely cannot be
written that way are marked `needs_node` / `needs_anytype` and skipped when absent.

**Never depend on a gitignored file.** `node_modules/` is gitignored; the gate must never
read it.

## The API key

Never committed. It is read from `$ANYTYPE_API_KEY`, falling back to
`~/.config/anytype-mcp/api_key` — both outside the repository. `ServerConfig` declares the
field `repr=False`, because a supervisor logs its own configuration when a child dies and
the default dataclass `repr` would put the credential in that log.
`tests/test_no_secrets.py` scans every **git-tracked** file for credential-shaped strings,
and proves the scanner can fail by planting one.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | foundation | Python package, both lockfiles, both pins, hermetic gate, pinning + secret tests. **Landed with this plan.** |
| 02 | key acquisition | A first-run path to obtain and store a key: wrap `get-key`, write the key file with `0600`, never echo it. |
| 03 | supervised lifecycle | Health-gated start, restart-on-exit policy with backoff, clean shutdown, structured logs that redact. |
| 04 | tool surface | Enumerate the tools the pinned server actually exposes and record them as a fixture, so a version bump shows its diff. |
| 05 | host contract | Expose the supervised server to `innytypes` through the host's addon contract, with the `host_api` version declared. |
| 06 | upgrade procedure | A tested, documented path to bump either pin, with the tool-surface diff as the evidence. |

Slices 02–06 are seeded as WorkItems in `docs/loop/inbox/`.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees. The project as a whole is done
for MVP when `innytypes` can start this addon, obtain the Anytype tool surface through it,
and stop it cleanly — with both versions pinned and no credential anywhere in the tree.
