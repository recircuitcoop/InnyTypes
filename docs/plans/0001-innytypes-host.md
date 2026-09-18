---
type: plan
title: The innytypes host — supervision, addons, dependency resolution, event bus
status: APPROVED
created: 2026-09-12
updated: 2026-09-18
---

# 0001 — The innytypes host

## What innytypes is

`innytypes` is a **host application that wraps the Anytype desktop app**. Features do not live
in the host — they arrive as **addons**.

**One clickable application icon starts everything.** The icon launches **InnyTypesHelper**, a
separate process (plan 0003). The helper starts the Anytype desktop app and the host, and the host
starts the Node MCP server and the addons. The helper watches all of them, **owns every restart**,
updates the application and its addons, and sends telemetry.

The host owns exactly five things:

1. **Starting and stopping its children.** It spawns and stops two kinds of child, the Node MCP
   server and each Python addon process, because it talks to them through their pipes and the
   event bus. It reports each child's identity and every exit to the helper, and it carries out
   the helper's commands. **It restarts none of its children**: restart policy belongs to the
   helper (plan 0003). Its one restart duty is the reverse: it relaunches **the helper** when the
   helper crashes, and shuts the application down when the helper is stopped from outside.
2. **Addon discovery and lifecycle.** Each addon lives in **its own environment**, and discovery
   reads the manifests recorded there.
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
| `stability` | *optional* — how the helper should watch it: heartbeat interval, stale window, resource limits, whether it may be restarted (plan 0003) |
| `update` | *optional* — where its new versions are published: an index, PyPI, or a git URL (plan 0003) |

**How the manifest is written down** (slice 01, `innytypes.addons.manifest`):

- An `id`, and every segment of an event kind, is **lowercase** letters and digits joined by
  single hyphens (`anytype-mcp`). One identity has one spelling: if `Whodunnit` and `whodunnit`
  were both legal, two addons could claim the same namespace and neither would be wrong.
- A `requires` entry is the string `<addon-id>==<version>`. There is no syntax for a range —
  that is how "at exact versions" is enforced rather than merely asked for.
- The `v<N>` in a kind starts at **1** and carries no leading zero, so `v1` and `v01` cannot be
  two spellings of one public API.
- A `subscribes` prefix is one or more segments followed by `.*`, so an addon can follow
  everything a publisher emits (`monty.*`) or every version of one kind (`monty.recorded.*`).
  A prefix in `emits` is refused: a publisher declares exactly what it publishes.
- **An unknown field is refused, not ignored.** A field that is silently dropped is a setting
  its author believes is in force. Every rule here refuses by raising and naming the offending
  value; nothing is accepted with complaints.

### Dependency resolution rules

- Build the graph from every discovered addon's `requires`.
- **Refuse cycles.** A cycle is a configuration error reported by name, not a hang.
- Start addons in dependency order — a publisher before its subscribers.
- **A missing requirement must NOT crash the host.** That addon does not start; the host
  reports what is missing; every other addon keeps running. Degradation is the designed
  behaviour, not an error path that happens to work.
- Installation is **explicit**: `innytypes addons install`. The host never installs an addon
  implicitly at startup. A startup that mutates the environment is a startup nobody can debug.
  **The one sanctioned exception is the helper (plan 0003):** it downloads core releases in the
  background and applies them only when the user quits, and it updates an already installed addon
  whose update mode is `auto`. A first install is always explicit, and nothing is ever installed
  or applied during startup.

**How resolution is written down** (slice 03, `innytypes.addons.resolution`). It is handed the
parsed manifests discovery read, and returns a `StartPlan`: an `order` of addon ids to start
front-to-back, and the `held_back` ones with a reason each.

- **`subscribes` implies an edge; it does not imply a requirement.** The owning addon of a
  subscribed kind is the leading segment of the kind or the prefix, so `monty.recorded.v1`,
  `monty.recorded.*` and `monty.*` all order the subscriber after `monty` — derived, so the
  author never declares the same relationship twice in `requires`. But a subscription that
  cannot be served is a quiet inbox: a subscriber whose publisher is **missing or held back
  still starts**. Only `requires` is a hard dependency, because only `requires` pins a version.
- **An addon pointing at itself is not a cycle.** Subscribing to your own kinds, or pinning your
  own id at your own version, is one process started once. Pinning your own id at a *different*
  version is unsatisfied, like any other mismatch.
- **A version mismatch is unsatisfied, and reports both versions** — the one required and the one
  installed. The first unsatisfied requirement is the one reported, as everywhere else in the host.
- **Whatever `requires` a held-back addon is held back too**, carrying a reason that names the
  root cause: the reader has to learn which addon to go and install, not which one gave up.
  Unaffected addons — including unrelated siblings of a held-back dependent — start regardless.
- **A cycle refuses the whole plan**, even when unrelated addons could have started, and unlike a
  missing requirement it never degrades. The difference is what fixes it: a missing requirement is
  a fact about this machine, a cycle is a fact about the addons and no install repairs it.
- **The order is deterministic**: ties between addons nothing separates are broken by id, so two
  runs over one set of addons cannot disagree. Cycle detection and ordering are **iterative** —
  a cycle a thousand addons long comes back as a sentence naming them, never a `RecursionError`.

### Each addon has its own environment

Every addon is installed into **its own `uv` environment**, on the same pinned Python as the host.
That environment holds the addon at an exact version, its dependencies locked with hashes, and
`innytypes` itself at exactly the version the host is running, so the addon sees the host API
contracts the host enforces.

Addons already run as separate processes, so nothing requires them to share the host's
interpreter. Separate environments mean an addon's dependencies can never break the host or
another addon, and one addon can be updated while everything else keeps running.
`innytypes addons install` creates the environment and records the addon's manifest beside it;
the host reads those recorded manifests and **never imports addon code**.

**The on-disk layout** (slice 02, `innytypes.addons.discovery`) is the contract between the
install side and the read side — slice 08 writes exactly what discovery reads:

```
<addons root>/            <user data dir>/innytypes/addons, resolved by platformdirs
    <addon-id>/           one addon environment, named by the addon's id
        manifest.json     the manifest recorded at install time, UTF-8 JSON
        env/              the addon's own uv environment
```

- **The directory name is the addon's identity.** It is the only id available before the
  manifest has been read, so it is the name a broken addon is reported under, and a recorded
  manifest claiming a *different* id is refused: one addon answering to two names could be
  started, namespaced and reported inconsistently.
- The root is **injectable** — every test passes its own, so no test reads or writes the real
  user directory.
- A stray file in the root is ignored rather than reported: an addon environment is a
  directory, and a `.DS_Store` is not a half-installed addon.

## Event rules the host must enforce

- **Kinds are namespaced and versioned:** `<addon-id>.<name>.v<N>` — e.g.
  `whodunnit.transcribed.v1`. The version sits in the kind because a payload is a *public API
  between addons*: changing it means a **new kind**, and the old one keeps working. There is no
  such thing as editing a payload in place.
- **The host hands each addon an emitter bound to its own id.** An addon may only emit kinds it
  owns. Otherwise any addon could forge another's events, and a subscriber could never trust
  what it received.
- **Emitting an unregistered kind is refused** — and not registered on the way out. A kind must
  appear in the emitter's `emits`. Auto-registering the first emit would turn a typo into a
  public API nobody declared, which the rule above then obliges the host to keep working.
- **Subscription is by exact kind or by prefix** (`whodunnit.*`). A prefix matches on whole
  segments, so `monty.recorded.*` covers every version of that kind — `monty.recorded.v1` and
  `monty.recorded.v2` — and does not cover `monty.recorded-final.v1`, which is a different name
  rather than a longer spelling of the same one.
- **Delivery is fire-and-forget with a bounded queue per subscriber.** An emitter must **never**
  block on a subscriber. A subscriber that dies, hangs, or falls behind is dropped, and the host
  emits `innytypes.listener-failed`. In detail:
  - **Publishing only fills queues.** It never calls a handler, so there is no handler it can be
    delayed by. Handlers run on the subscriber's own delivery thread, one per subscriber — a
    shared pump would put every subscriber behind the slowest of them and would let one hung
    handler stop the others, which is the design this rule exists to forbid.
  - **A hang is detected as falling behind, not by a timer.** There is no watchdog on a handler,
    because a watchdog has to guess how long a legitimate handler may take. A handler that never
    returns stops draining its queue, the queue fills, and that subscriber is dropped by the same
    rule as one that is merely slow.
  - **A handler that raises is dropped, not merely logged.** It lost the event it was given and
    the host cannot tell what else went with it; a visible drop beats a subscriber that quietly
    misses one event in twenty.
  - **The announcement is `innytypes.listener-failed.v1`.** The host's own events obey the host's
    own grammar — a kind without a version could not be subscribed to by name. Its payload names
    the dropped subscriber, the reason (`overflow` or `raised`), the kind being delivered, and a
    human-readable detail.
  - **A subscriber reads a copy.** The payload is encoded once at publish and decoded by each
    subscriber as it reads its queue, so a publisher that keeps editing its dict after `emit`
    cannot change what was already published and two subscribers cannot edit each other's copy.
    In-process delivery therefore behaves exactly as the process boundary does, instead of being
    the one path where a bug appears or vanishes depending on where a subscriber runs.
- **Crossing a process boundary changes nothing about the rules above.** An addon process
  reaches the bus through a **transport** (slice 06), and the guarantee it must not weaken is
  the one an addon author would never see weakening: that where a subscriber runs has no
  bearing on what it is promised. So the transport does not re-implement any of it —
  **a remote subscriber is a subscription whose handler writes to the pipe.** The bound is the
  same bound, the matching is the same matching, and the two ways a subscriber dies stay the
  two the bus already knows: a far end that stops reading fills the pipe, blocks that write,
  fills that subscriber's queue behind it and is dropped at its bound like any handler that
  never returns; a far end that is gone makes the write raise, which is a handler raising, so
  it is dropped and announced as `innytypes.listener-failed.v1` naming the addon.
  - **The wire is newline-delimited JSON**, one frame per line, `{"kind": …, "payload": …}`.
    The payload is spliced in as the text the bus already encoded at publish rather than
    serialised a second time, so there is exactly one encoding in the host and a subscriber
    across the pipe reads the bytes an in-process subscriber reads. A newline terminates a
    frame safely because an encoded payload never contains one, and a readable pipe is worth
    more than a length prefix on the day a child process misbehaves.
  - **The channel is one `AF_UNIX`, `SOCK_STREAM` socketpair per child process**, opened when
    the host spawns it. That happens with the addon runner (slice 08), not with slice 07: the
    child end has to be inherited by the process that builds the addon side of the transport,
    so the socketpair and the runner that reads it arrive together rather than one waiting on
    the other. A datagram socket would give message boundaries for free
    and take back the thing that is not for sale: its buffer drops in the kernel, silently.
    A stream turns a slow reader into backpressure, and backpressure into a **visible** drop
    with an announcement. This is not the helper's heartbeat socket (plan 0003 slice 02),
    which is a per-user socket in the runtime directory, owned by the helper, and exists so
    that heartbeats survive a dead host.
  - **The host re-checks ownership at the boundary.** Inside the host an addon cannot emit
    another addon's kind because its emitter is bound to its id; a frame is bytes and carries
    no such binding, so the host end refuses a frame whose kind the peer on that connection
    does not own, by name, rather than publishing it on that addon's behalf.
- **A payload is a JSON object, checked at emit time** — every event crosses a process
  boundary, and the emit is the last place the call site that built the payload is still in
  front of you. "JSON" means what arrives is what was published, so the check is stricter than
  `json.dumps` succeeding: a `set`, an open file and a `datetime` are refused for being
  unserializable, and a tuple, a non-string key and a non-finite number are refused for
  changing shape or meaning in transit. The refusal names the field it stopped at.
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

The client slice 09 built is **`innytypes.anytype_api`**, a sibling module rather than a member
of `innytypes.anytype_mcp`. Plan 0002 locks that package's scope to three things — supervising
the Node process, holding the key, pinning the two versions — so request-making would have been
mis-filed inside it. What the sibling does instead is depend on it:

- `AnytypeClient` is built from a `ServerConfig`, or from `load_config` via
  `AnytypeClient.from_environment`. There is no second code path in it that reads
  `$ANYTYPE_API_KEY` or the key file, and every request sends `ServerConfig.headers()` whole, so
  the bearer token and the pinned `Anytype-Version` cannot drift from what the MCP child gets.
- Connectivity stays decided in one place. Every call asks `is_api_reachable` first — on every
  call rather than once per client, because a desktop app the user can quit at any moment has no
  "still up" worth remembering — and refuses with `AnytypeUnreachableError` when the answer is
  no. A transport failure *after* a passing probe raises the same error: same cause, same fix.
- A non-2xx is never a result. It raises `AnytypeStatusError` carrying the status code, or one of
  `AnytypeUnauthorizedError` (401), `AnytypeNotFoundError` (404), `AnytypeServerError` (5xx). All
  of them, plus `AnytypeUnreachableError`, descend from `AnytypeApiError`.
- The credential is in none of it: not the client's `repr`, not an error message, not a log
  record. Error messages and the `repr` are passed through the package redactor on the way in,
  because `ANYTYPE_API_BASE_URL` is user-supplied and a key embedded in *that* would otherwise
  ride out in an exception every caller is free to log.
- One endpoint is wrapped by name, `GET /v1/spaces` as `list_spaces()`, because it is the one the
  reachability check already probes and therefore the only one this repository has verified
  against the pinned API version. Anything else goes through the generic `get_json()` until a
  slice with a real caller gives it a name.

## Pinning — a hard rule

The owner's instruction, verbatim:

> **innytype and the addons MUST pin their dependencies**

Consequences, binding on the host and on every addon:

1. Every **runtime** dependency in `pyproject.toml` uses `==`, never `>=`.
2. Lint and test tools may use ranges, but every range carries an **upper bound**.
3. `requires-python` is pinned to **one minor version**: `==3.13.*`, the family interpreter,
   matched by a committed `.python-version`.
4. `uv.lock` is **committed**.
5. Every **addon environment** is locked the same way: exact versions with hashes, and a git
   source locked to a **commit hash**, never a branch or a tag (plan 0003).
6. `docs/loop/verify.sh` runs `uv sync --frozen`, so a drifting transitive dependency fails the
   gate instead of being discovered in production.
7. The Node MCP server is pinned exactly in `package.json` with `package-lock.json` committed
   (plan 0002). `tests/test_pinning.py` enforces rules 1–4 and 7.

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
2. **Addon discovery.** Enumerate the installed addon environments, read each recorded manifest
   (exported from the addon's `innytypes.addons` entry point at install time, inside the addon's
   own environment), and report a broken one by name without failing the enumeration. No addon
   code is imported by the host. The layout it reads is *Each addon has its own environment*
   above; discovery is the **read side only** — it creates no environment, records no manifest
   and invokes no installer. One call returns both the validated addons and the broken ones,
   each with its id and the reason, so a caller can print the two together.
3. **Dependency resolution and start order.** Build the graph, refuse cycles, derive the implied
   edge from `subscribes`, topologically order the starts, and degrade — not crash — on a missing
   or version-mismatched requirement.
4. **Event kinds and the bound emitter.** The kind registry, per-addon emitters that can only
   emit owned-and-registered kinds, and JSON enforced at emit time. A checked event leaves the
   emitter through an injected sink, which is the seam slice 05 fills with delivery — the
   emitter hands the event on and returns, so it can never block on a subscriber.
5. **Subscription and bounded delivery.** Exact and prefix matching, a bounded queue per
   subscriber, non-blocking emit, drop-on-overflow/death, and `innytypes.listener-failed`.
6. **Cross-process transport** (`innytypes.events.transport`). Carry the bus between host and
   addon processes with the same semantics the in-process bus guarantees, by reusing them
   rather than restating them: `EventTransport` subscribes on the bus like anything else and
   hands it a handler that frames the event onto a `Connection`. The connection is the injected
   seam — `StreamConnection` over the child's socketpair in production, both ends in one test
   otherwise — which is how this slice is proved without a process, a socket or a sleep. The
   host end forwards what the addon's `subscribes` asked for and accepts only kinds the addon
   owns; the addon end is a client of the host's one bus, emitting through a spool the transport
   drains and receiving onto its own local bus, which is also what stops an addon subscribed to
   its own kinds from bouncing events between the processes. Its acceptance: the matching and
   the bound are asserted through **both** paths and must answer identically; a far end that is
   never drained stops at the bound instead of buffering, while the publisher returns; a closed
   pipe drops the peer and announces `innytypes.listener-failed.v1` exactly once; a payload JSON
   cannot write is refused at the framer.
7. **Child processes, under the helper** (`innytypes.children`). Spawn and stop the two child
   kinds: the Node MCP server and the addon processes. For the Node MCP child it drives
   `innytypes.anytype_mcp.Supervisor`, which supplies the argv, environment and health check.
   The host **restarts none of its children** (plan 0003 owns restart policy; the host's single
   restart duty, relaunching a crashed helper, is plan 0003 slice 07). Instead it:
   reports every child exit, with its exit code, to the helper; writes each child's identity
   (process ID, start time, executable path) to the run-state file; and carries out the helper's
   commands over the control channel: start, stop, restart, kill, stop-and-start a group, list.
   Addon children start in the resolver's order. Shutdown leaves no orphan. Its acceptance: a
   child that exits is reported and **not** respawned by the host (a fake spawn that exits yields
   exactly one spawn call until a restart command arrives); a restart command yields exactly one
   new spawn; the MCP child's pinned argv reaches the injected spawn; a child that ignores
   terminate on shutdown is killed; no test spawns a real process.

   What this slice settled, beyond the sentence above:

   - **The MCP child starts first**, then the addons in the resolver's order. No addon can
     declare a dependency on it — a `requires` entry names an addon, and the MCP server is
     core — so the order is stated here instead of derived. An addon the resolver holds back is
     never spawned, and the rest of the host starts without it.
   - **An addon is launched by its own environment's interpreter**, running a host module with
     the addon's id as its argument: `<environment>/bin/python -m innytypes.addons.run <id>`.
     The host still imports no addon code — the import happens on the far side of a process
     boundary, in the environment that addon was installed into, by a runner that is host code
     and is present there because `innytypes` is installed in every addon environment at
     exactly the host's version. The runner itself lands with slice 08, which is also what
     opens the per-child socketpair slice 06 describes: the child end has to be inherited by
     the process that builds the addon side of the transport, so the two arrive together.
   - **Both halves of the control channel are injected callables**, not a socket. The shape
     they leave for plan 0003 slice 05 is in that plan, under *The helper owns every restart*.
   - **The run-state file is shared with the helper**, which writes the records for the
     processes it spawns. Its format, its location and the rule that each writer touches only
     its own records are in plan 0003, under *Phantom detection*.
8. **Explicit install and the CLI surface.** `innytypes addons install` (creating the addon's own
   environment and recording its manifest), `addons list`, and the host lifecycle commands.
9. **The Anytype local API client.** Port 31009, built on the key discovery and reachability
   check already in `innytypes.anytype_mcp`, and landing as the sibling module
   `innytypes.anytype_api` — see "Anytype integration" above for what it owns and where its
   endpoint list stops. The MCP server's own slices are in plan 0002.
