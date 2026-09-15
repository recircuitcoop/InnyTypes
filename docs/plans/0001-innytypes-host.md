---
type: plan
title: The innytypes host — supervision, addons, dependency resolution, event bus
status: APPROVED
created: 2026-09-12
updated: 2026-09-15
---

# 0001 — The innytypes host

## What innytypes is

`innytypes` is a **host application that wraps the Anytype desktop app**. Starting the host
starts Anytype plus a sidecar. Features do not live in the host — they arrive as **addons**.

The host owns exactly five things:

1. **Process supervision.** It starts, health-checks, restarts and stops three kinds of child:
   the Anytype desktop app, a Node MCP server, and each Python addon process.
2. **Addon discovery and lifecycle**, via Python entry points.
3. **Dependency resolution** between addons, and the start order that follows from it.
4. **A cross-process event bus**, plus the stable API contracts addons depend on.
5. **The Anytype MCP server.** It supervises the official `@anyproto/anytype-mcp` Node server,
   holds its API key and pins its versions, in `innytypes.anytype_mcp`. This is core, not an
   addon: plan 0002 has the details.

### The dependency direction is one-way

**The host depends on NO addon.** Addons depend on the host. Addons may depend on each other.
A host release is never held up by an addon, and no host module may import an addon package.
This is the single invariant that makes the rest of the plan coherent; a change that inverts
it is a change to this plan, not an implementation detail.

### The addon manifest

Every addon declares a manifest:

| field | meaning |
|---|---|
| `id` | the addon's namespace — owns the event kinds prefixed with it |
| `version` | the addon's own version |
| `host_api` | the host API version this addon targets |
| `requires` | other addons, **at exact versions** |
| `emits` | the event kinds this addon may publish |
| `subscribes` | the event kinds (exact or prefix) it wants delivered |

### Dependency resolution rules

- Build the graph from every discovered addon's `requires`.
- **Refuse cycles.** A cycle is a configuration error reported by name, not a hang.
- Start addons in dependency order — a publisher before its subscribers.
- **A missing requirement must NOT crash the host.** That addon does not start; the host
  reports what is missing; every other addon keeps running. Degradation is the designed
  behaviour, not an error path that happens to work.
- Installation is **explicit**: `innytypes addons install`. The host never installs an addon
  implicitly at startup. A startup that mutates the environment is a startup nobody can debug.

## Event rules the host must enforce

- **Kinds are namespaced and versioned:** `<addon-id>.<name>.v<N>` — e.g.
  `whodunnit.transcribed.v1`. The version sits in the kind because a payload is a *public API
  between addons*: changing it means a **new kind**, and the old one keeps working. There is no
  such thing as editing a payload in place.
- **The host hands each addon an emitter bound to its own id.** An addon may only emit kinds it
  owns. Otherwise any addon could forge another's events, and a subscriber could never trust
  what it received.
- **Emitting an unregistered kind is refused.** A kind must appear in the emitter's `emits`.
- **Subscription is by exact kind or by prefix** (`whodunnit.*`).
- **Delivery is fire-and-forget with a bounded queue per subscriber.** An emitter must **never**
  block on a subscriber. A subscriber that dies, hangs, or falls behind is dropped, and the host
  emits `innytypes.listener-failed`.
- **Payloads must be JSON-serializable** — every event crosses a process boundary.
- **Subscribing to another addon's kind implies a dependency on it**, so the publisher starts
  first. The resolver derives this edge; the addon author does not have to declare it twice.

## The addons that will exist

Built elsewhere, listed here only so the host's contracts are designed against real consumers:

| addon | role |
|---|---|
| `monty` | watches volumes and folders, produces audio files |
| `whodunnit` | sound file → transcript with speakers → SRT/TXT |
| `summarize` | transcript → summary |

**This plan builds none of them.** The host is done when these three *could* be written against it.

`anytype-mcp` was planned as a fourth addon. It is now part of the host core (plan 0002),
because the host already supervises the Node MCP server as one of its child kinds.

## Anytype integration

`innytypes.anytype_mcp` (plan 0002) already holds the pieces that exist: key discovery from
`$ANYTYPE_API_KEY` or `~/.config/innytypes/anytype_api_key`, a reachability check against the
**local API on port 31009**, and the pinned `Anytype-Version`. Slice 09 builds on them rather
than beside them.

- There is an existing key file at `~/git/cleanup_automation` on this machine. Treat it as a
  *pointer to where authentication is solved*, to be read when slice 09 is worked. Secrets are
  never copied into this repository.

## Pinning — a hard rule

The owner's instruction, verbatim:

> **innytype and the addons MUST pin their dependencies**

Consequences, binding on the host and on every addon:

1. Every **runtime** dependency in `pyproject.toml` uses `==`, never `>=`.
2. Lint and test tools may use ranges, but every range carries an **upper bound**.
3. `requires-python` is pinned to **one minor version**: `==3.13.*`, the family interpreter,
   matched by a committed `.python-version`.
4. `uv.lock` is **committed**.
5. `docs/loop/verify.sh` runs `uv sync --frozen`, so a drifting transitive dependency fails the
   gate instead of being discovered in production.
6. The Node MCP server is pinned exactly in `package.json` with `package-lock.json` committed
   (plan 0002). `tests/test_pinning.py` enforces rules 1–4 and 6.

## The gate is hermetic — a hard rule

Learned from a sibling project, where a fresh worktree failed the gate for reasons unrelated to
any change: a bare `uv run` built a venv missing an optional extra, and tests depended on
gitignored fixture files that existed only in the main checkout.

- `docs/loop/verify.sh` must pass **from a clean clone with no manual steps**.
- No test may depend on a gitignored file. A fixture is either committed or generated by the
  test itself.
- The gate exits non-zero on any failure and prints a final `gate: GREEN` line on success.

## Slices

1. **Addon manifest and the host API contract.** The manifest type, its validation (`id` shape,
   `host_api` compatibility, exact-version `requires`, well-formed `emits`/`subscribes`), and
   the kind grammar `<addon-id>.<name>.v<N>`.
2. **Addon discovery via entry points.** Enumerate installed addons, load each manifest, and
   report a broken one by name without failing the enumeration.
3. **Dependency resolution and start order.** Build the graph, refuse cycles, derive the implied
   edge from `subscribes`, topologically order the starts, and degrade — not crash — on a missing
   or version-mismatched requirement.
4. **Event kinds and the bound emitter.** The kind registry, per-addon emitters that can only
   emit owned-and-registered kinds, and JSON-serializability enforced at emit time.
5. **Subscription and bounded delivery.** Exact and prefix matching, a bounded queue per
   subscriber, non-blocking emit, drop-on-overflow/death, and `innytypes.listener-failed`.
6. **Cross-process transport.** Carry the bus between host and addon processes with the same
   semantics the in-process bus guarantees.
7. **Process supervision.** Start, health-check, restart with backoff, and stop the three child
   kinds; shutdown that leaves no orphan. For the Node MCP child it drives
   `innytypes.anytype_mcp.Supervisor`, which supplies the argv, environment and health check;
   restart policy lives here, once, for every child kind.
8. **Explicit install and the CLI surface.** `innytypes addons install`, `addons list`, and the
   host lifecycle commands.
9. **The Anytype local API client.** Port 31009, built on the key discovery and reachability
   check already in `innytypes.anytype_mcp`. The MCP server's own slices are in plan 0002.
