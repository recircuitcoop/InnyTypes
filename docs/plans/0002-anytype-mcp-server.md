---
type: plan
title: The Anytype MCP server — a core part of the host
status: APPROVED
created: 2026-09-12
updated: 2026-09-21
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
and land the fixture's diff alongside it as the evidence. The procedure that does all of
that in one commit is **[Bumping a pin](#bumping-a-pin--the-procedure)**, below.

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

## What an addon is told the tools are

An addon reads the tool surface through **one host API function**, `innytypes.host.anytype_tools()`,
and it imports `innytypes.host` and nothing else. The answer is plain strings and mappings — never
`ToolSurface`, which lives in `innytypes.anytype_mcp` — because an addon that had to name that
package to read its own return value would be importing the host's private business by the back
door. `innytypes` is installed in every addon environment at the host's exact version, so the
committed record is shipped data an addon already has.

**A live server's surface never supersedes the committed one.** `anytype_tools()` answers from
`tool_surface.json` whether or not the MCP child is running, and it would still do so if asking the
running child were free:

1. **A deviation is evidence, not a better answer.** A running server that answers differently has
   found a disagreement — the running Anytype serves a different OpenAPI document than the pin
   claims — and the whole procedure above exists to make that visible as a diff a person reads.
   Serving the live answer instead would swallow exactly the failure the record was created to
   catch: a tool that keeps its name and changes its arguments.
   `innytypes anytype-mcp refresh-tool-surface` is where a live surface belongs, because it
   *prints the difference* rather than quietly winning.
2. **The answer must not depend on the machine.** An addon asks what tools exist in order to decide
   what it can do; an answer that came from a running child would differ between two machines on
   the same version, and would be unavailable on precisely the degraded host that has to keep
   working.
3. **Addons are separate processes.** Reaching the host's child needs a request channel that is
   bounded and has explicit failure behaviour. Reading shipped data needs none of it. Plan 0007
   adds that channel for live MCP invocation, separately from this catalogue function.

So `anytype_tools()` answers what the pinned pair exposes, **not** whether a server is up right
now. Those are different questions, and the second one is the child supervisor's.

## Live calls through the host-owned child

Plan 0007 adds the live path this plan originally left absent. The independently running host
serves Streamable HTTP MCP on an authenticated loopback TCP endpoint, and external MCP clients
connect to its URL without launching or supervising InnyTypes. The host forwards validated
`tools/call` requests over the private pipes of the one child it already owns. The endpoint never
calls Anytype's port 31009 and never receives or exposes the Anytype API key.

This does not weaken the rule above. The host first compares the child's live `tools/list` with
the committed names and input-schema signatures. A deviation prevents exposure and is reported
as degradation; it never replaces the catalogue returned by `anytype_tools()`.

## Pinning across two ecosystems

Plan 0001's pinning rule applies unchanged to the Python side. The Node side adds:

1. `@anyproto/anytype-mcp` at an **exact** version (`1.2.10`: no caret, no tilde, no tag), with
   **`package-lock.json` committed** at the repository root.
2. The `Anytype-Version` header pinned in configuration (`2025-11-08`).
3. **Enforced, not documented**: `tests/test_pinning.py` fails the gate on a non-exact npm
   version, on a missing lockfile, and on `package.json` and `config.PACKAGE_VERSION`
   disagreeing.

## Bumping a pin — the procedure

Both pins will move: npm publishes, and Anytype dates its API. Either move is a dependency
upgrade (loop invariant 8), and an upgrade is **one commit that touches every place the old
version was named**, landing the tool-surface diff as its evidence. A half-done bump — the
package moved, the fixture not re-recorded — is red at the gate rather than merged, which is
what makes this a procedure rather than a habit.

### Where a version lives

Four files, and nothing else outside `docs/` and `tests/`:

| location | pin | how it moves |
|---|---|---|
| `package.json` | npm package | edited by hand: `dependencies["@anyproto/anytype-mcp"]` |
| `package-lock.json` | npm package | regenerated by `npm install`, never hand-edited |
| `src/innytypes/anytype_mcp/config.py` | both | the constants `PACKAGE_VERSION` and `ANYTYPE_VERSION` |
| `src/innytypes/anytype_mcp/tool_surface.json` | both | rewritten by `innytypes anytype-mcp refresh-tool-surface` |

That table is checked rather than trusted. `tests/test_pinning.py` searches every git-tracked
file outside `docs/` and `tests/` for the literal pinned versions and fails when the set it
finds is not exactly the set named above. Spell a version in a fifth place and the gate says
so — whether the answer is to add the row, or to stop spelling it there.

Documentation and tests are outside that search because they *talk about* the pins rather
than hold them, and a stale literal in either cannot hide: bump a pin and every test that
spells the old value fails, by name, at the gate. Updating those is a step of the procedure
below, not an accident of it.

### The steps

```bash
# 1. Move the npm pin. Skip 1–2 when only the Anytype-Version moves.
#    Edit package.json by hand, then regenerate the lockfile from it:
npm install                                 # rewrites package-lock.json; needs Node

# 2. Move the same value in src/innytypes/anytype_mcp/config.py -> PACKAGE_VERSION.
# 3. Move the header, if that is what is being bumped: config.py -> ANYTYPE_VERSION.

# 4. Re-record the tool surface against the new pair.
#    Needs Node and a running Anytype — the only step in this procedure that does.
innytypes anytype-mcp refresh-tool-surface  # prints the diff; rewrites the fixture

# 5. Run the gate, which needs neither.
bash docs/loop/verify.sh
```

Step 5 is where a skipped step is caught, and the message names the step:

| what the gate says | what was skipped |
|---|---|
| `package.json pins X but config.PACKAGE_VERSION is Y` | step 2 |
| `package-lock.json locks X but package.json pins Y` | step 1's `npm install` |
| `tool_surface.json was captured at package X, but config.PACKAGE_VERSION is now Y` | step 4 |
| `tool_surface.json was captured at Anytype-Version X, but config.ANYTYPE_VERSION is now Y` | step 4 |
| an assertion in `tests/` naming the old value | the last paragraph of *Where a version lives* |

The gate's own first step, `uv sync --frozen`, is what keeps the Python side coherent across
a bump: neither pin is a Python dependency, so the committed `uv.lock` must still match
`pyproject.toml` afterwards. If a bump ever does require a Python dependency to move, `uv
lock` regenerates the lockfile and `--frozen` is what catches forgetting to.

### The evidence a reviewer reads

Step 4 prints it, and the same three facts land in the commit as the fixture's diff:

```text
Recorded 34 tools for @anyproto/anytype-mcp@1.2.11 / Anytype-Version 2025-11-08.
  added   API-create-bookmark
  removed API-delete-tag
  changed API-list-spaces
```

Read `changed` first. An added tool is a possibility and a removed tool breaks loudly, but a
tool that kept its name and changed its arguments is the one an addon goes on calling and
starts failing on — which is why the fixture records a signature per tool instead of a list
of names. `git diff -- src/innytypes/anytype_mcp/tool_surface.json` shows the same three
facts as signatures that moved, and is what a reviewer reads next to the command's output.

A bump whose diff is empty is still an upgrade, and "The tool surface is unchanged" is the
strongest sentence a review of one can be given. Say it in the commit message.

### When the bump is rejected

`git revert` the one bump commit. That is the whole rollback, and it works **because** the
bump moved every location in the table together: the revert restores the old package, the old
lockfile, the old constants and the old tool surface as one consistent set — the state the
rest of the code was written against. Then `npm ci`, to bring `node_modules/` back in line
with the restored lockfile.

Do not re-run the refresh afterwards. The reverted fixture already *is* the record of the
restored pair; re-recording would overwrite it with a capture stamped today, quietly replacing
evidence with a re-derivation.

Reverting only *part* of a bump is the failure to avoid — restoring `package.json` and the
lockfile while leaving `config.py` at the new version leaves the host launching a build the
lockfile never locked. The gate refuses that state, and `tests/test_pinning.py` proves it by
simulating exactly that partial revert.

## The host starts it, and degrades when it cannot

`innytypes.host` brings the server up as a **core child**, through the child supervisor that
already owns spawning and stopping (plan 0001 slice 07). Two things stop that child from
starting, and plan 0001's degradation rule says neither may take the host down with it:

| what is missing | what the host has | what it reports |
|---|---|---|
| the API key | **no MCP child at all** — the id is absent from the child supervisor's start order | the key is missing, and where to put one |
| a running Anytype | an MCP child that did not start | the base URL that did not answer |

The two are deliberately different sentences. With no key there is no `ServerConfig` to build a
supervisor from, so `ChildSupervisor` is built with `mcp=None` and a command naming the MCP child
is refused like any other child this host does not have — which is the truthful answer to give the
helper, and the fix is `innytypes anytype-mcp get-key`, not a restart. With Anytype absent the
child exists and is startable the moment the desktop app is up.

Either way `Host.start()` returns rather than raises: a `HostReport` carrying what started and a
`Degradation` per missing piece, every addon that does not need Anytype runs, and nothing is
retried here — a host that retried the MCP child would be the second restart policy in the
application, and plan 0003 owns the first one. `Host.shutdown()` stops the child through the same
child supervisor; there is no second stop path.

**`innytypes up` is that host, and the only caller there is.** The command builds it with
`build_host()`, starts it with `Host.start()` and prints the report: a `started` line per child, a
line per `Degradation` naming the component and the reason in full, and exit code 0. There is no
second assembly in `innytypes.cli` and therefore no second answer to what a missing key does —
the CLI once built its own child supervisor and refused with nothing started, which contradicted
this section for as long as both existed.

## The child promises a heartbeat, and the host keeps it

A plugin declares how it should be watched and the helper honours it: `heartbeat_interval`,
`stale_after`, and the resource limits beside them. The one field with no default is the
interval, because *an addon that never promised heartbeats is watched for liveness, phantoms and
resources, and is never judged stale*.

The MCP child promised nothing, so it could only ever be noticed **gone**. That is the weakest of
the three mechanisms the helper has, and it is the wrong one for this child: a Node process that
holds its pipes open and answers nothing is alive by every test the process table can apply, and
useless. The failure this server actually has is not dying - it is ceasing to answer.

**The child cannot send the beat, and does not have to.** `@anyproto/anytype-mcp` knows nothing
of InnyTypes and never will; the seam between the two ecosystems is a child process with an
environment, and adding a heartbeat protocol to it would put InnyTypes inside somebody else's
package. What already exists is better: the host holds the **only** MCP session to that child,
and MCP defines `ping`. So the host beats on the child's behalf.

The rule that makes this honest: **the host records a beat only for a `ping` the child answered.**
Not for a process that exists, not for a session object that was constructed, not for a request
that was sent. A beat means *the child answered MCP at that moment*, which is strictly more than
liveness proves and is exactly what staleness is for. A ping that fails, times out or raises
records nothing, and the child goes stale on its own declared window.

Three consequences worth stating, because each is a decision rather than an accident:

* **A wedged host stops the beats**, and the child is then judged stale though it may be
  answering. That is the right direction to fail: the helper watches the host as well, so a host
  that stopped pinging is itself a condition somebody sees, and a supervisor that assumed
  liveness because it could not check is the failure this whole plan exists to avoid.
* **The interval must be longer than the pass that reads it.** The supervision tick samples on
  its own cadence (plan 0010 slice 03 makes that a setting, defaulting to ten seconds); a promise
  shorter than the observation window would be judged missed before it could be kept.
* **The ping is bounded by the session's existing request timeout**, and costs the child one
  round trip. It is the cheapest question MCP defines, and it is the same channel a `tools/call`
  already uses, so a ping that cannot get through is itself the news.

`stale_after` follows the manifest's own rule - three missed beats unless the profile names its
own window - so a child that has not answered three pings running is stale, and the helper's
restart policy takes it from there. Nothing about restart changes here: plan 0003 still owns
every restart in the application, and this plan only makes the child's silence visible.

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
`innytypes.logs`. Building a `ServerConfig` registers its key with that module's
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
| 05 | host integration | The host starts the MCP server as a core child, degrades when it cannot, and exposes the tool surface to addons through the host API. **Landed** — *[The host starts it, and degrades when it cannot](#the-host-starts-it-and-degrades-when-it-cannot)*, *[What an addon is told the tools are](#what-an-addon-is-told-the-tools-are)*. |
| 06 | upgrade procedure | A tested, documented path to bump either pin, with the tool-surface diff as the evidence. **Landed** — *[Bumping a pin](#bumping-a-pin--the-procedure)*. |

Slices 02–06 are seeded as WorkItems in `docs/loop/inbox/`.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees. This plan is done for MVP when
`innytypes up` starts the MCP server, an addon can obtain the Anytype tool surface through the
host API, and shutdown stops the server cleanly, with both versions pinned and no credential
anywhere in the tree.

All six slices have landed, and so has the clause that was not this plan's to finish: **the
`innytypes up` command itself is plan 0001 slice 08**, which builds the CLI surface. What slice 05
landed is the behaviour that command invokes — `innytypes.host.build_host()` and `Host.start()`
start the MCP server as a core child and degrade when they cannot, `Host.shutdown()` stops it, and
`innytypes.host.anytype_tools()` is the host API function an addon reads the tool surface through.
`up` is now wired to `build_host` and has no host assembly of its own, so the sentence above is
true end to end with nothing left for this plan to add.
