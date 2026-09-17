---
type: plan
title: InnyTypesHelper — a separate process that keeps the host stable, updated and reporting
status: DRAFT
created: 2026-09-17
updated: 2026-09-17
---

# 0003 — InnyTypesHelper

## What this is

`InnyTypesHelper` is **another process, separate from the innytypes host**. The host (plan 0001)
runs Anytype, the MCP server (plan 0002) and the addons. The helper sits outside all of them and
does five jobs:

1. **Health watching.** It checks the health of the innytypes runtime, the Anytype MCP server,
   and every addon that publishes data on how it wants to be managed and stabilized.
2. **Stabilization.** It relaunches processes that go **stale** or **phantom**, and kills
   processes that **use too many resources**.
3. **Core auto-update.** It downloads new innytypes releases, controlled by the **auto-check
   versions** switch in the application config.
4. **Plugin updates.** It checks the versions of the **external plugins** (addons) and updates
   them **automatically or manually**.
5. **Telemetry.** It sends usage and error reports to the owner's own servers, controlled by the
   **telemetry** switch in the application.

The owner's request, verbatim:

> It is ANOTHER PROCESS that checks the healts of the InnyTypes runtime, the mcp server and the
> other plugins if they publish data on how they are managed and stabilized. The helper
> stabilizes the application and is in charge of relaunching processes if they go stale,
> phantom, or kill them if they consume too many resources. The helper is also in charge of auto
> downloading the new versions of the InnyTypes releases as well as telemetry to my own servers
> for usage and errors. There is a "telemetry" switch in the application in the application to
> stop sending info. There is a auto-check versions switch in the application config.

And, added the same day:

> the Helper also checks for the external plugins versions and auto or manual update.

### Why it must be a separate process

A watchdog inside the process it watches dies with it. The host can restart a child that exits,
but it cannot restart **itself** after a crash or a hang. It also cannot reliably notice that it
is **leaking memory** or **stuck in a loop**. The helper can do all three because it does not share
the host's fate.

The same reasoning puts updates and telemetry here. Replacing the host's own files or its
plugins while the host is running is fragile. And a crash report must be sent by something that
survived the crash.

## Words this plan uses

| word | meaning |
|---|---|
| **managed process** | any process the helper watches: the host, the MCP server, an addon, the Anytype desktop app |
| **plugin** | the owner's word for an **addon** (plan 0001): an external package built outside this repository (`monty`, `whodunnit`, `summarize`, or a third party's) |
| **heartbeat** | a small message a managed process sends every few seconds: "I am alive, and here is my state" |
| **alive** | the OS reports the process as running |
| **stale** | alive, but it has **stopped making progress**: it missed its heartbeats for longer than its allowed window, or its own health check keeps failing. Typical cause: a hang or a deadlock. |
| **phantom** | a process that **exists but has no valid owner**, in one of two forms: (a) an **orphan**, a child still running after the host that started it died; (b) a **stale record**, a recorded process ID that now belongs to a **different, unrelated** program because the OS reused the number. |
| **resource breach** | a process staying above its memory, CPU, open-file or child-process limit for longer than its grace window |
| **stability profile** | what an addon publishes about how it wants to be watched: heartbeat interval, stale window, resource limits, whether it may be restarted |
| **plugin set** | every installed plugin at its exact version, together with the host version. An update moves the whole set from one consistent state to another. |

## How it fits with plans 0001 and 0002

### Who restarts what: one policy, two layers

Plan 0001 slice 07 says restart policy lives **once**, in the host, for every child kind. The
helper must not become a second, competing restart loop for the same child. Two loops restarting
the same process race each other and double-spawn it.

This plan proposes a **two-layer split** (decision D1):

| situation | who acts |
|---|---|
| a child **exits** while the host is healthy | the **host** restarts it, with its existing backoff (plan 0001 slice 07) |
| a child is **stale** or in **resource breach** while the host is healthy | the **helper decides** and **asks the host** to restart or kill it over the control channel; the host carries it out with its one restart policy |
| the **host itself** is dead, stale or in breach | the **helper** kills it if needed, cleans up its orphans, and relaunches the host. The host then restarts its own children normally. |
| **phantom** processes | the **helper** kills orphans; it only **forgets** stale records and never kills them, because that process number now belongs to someone else |
| the **host does not answer** the helper's request | the helper escalates: it treats the host as stale |

The helper therefore **relaunches exactly one thing directly: the host.** Everything else still
goes through the host's single restart policy.

### Who starts the helper, and who watches it

The helper has to outlive the host, so the host cannot be its parent. Proposal (decision D2):

- On macOS the helper is a per-user **launchd LaunchAgent** with `KeepAlive`. The OS restarts
  the helper, the helper starts the host, and the host starts everything else.
- `innytypes helper install` / `helper uninstall` write and remove that agent **explicitly**, in
  keeping with plan 0001's rule that installation is never implicit.
- Linux uses a systemd user unit with the same shape. It lands in a later slice, not in the MVP.

### The dependency direction is unchanged

The helper lives in this repository as `innytypes.helper`, with its own console script
`innytypes-helper`. Like every host module, it **imports no addon**. It learns about addons only
through their manifests, the stability profiles and heartbeats they publish, and the plugin
index. Updating a plugin is done by the package installer, never by importing the plugin.

### Conflicts this plan creates with approved plans

The owner has to resolve these before 0003 can be approved:

1. **Plan 0001, invariant 6 ("installation is explicit; a startup that mutates the environment
   is a startup nobody can debug").** Auto-downloading core releases, and **auto-updating
   plugins**, change the environment without a command. This plan keeps the invariant's intent:
   **download and verification** happen in the background, and **applying** is a separate,
   logged, reversible step that never happens **during host startup** (decisions D11, D19). The
   invariant's text still needs amending to name the helper as the one sanctioned exception.
   **Manual** plugin updates satisfy the invariant as written, because they are explicit
   commands.
2. **Plan 0001, the shared interpreter environment.** `pyproject.toml` says the host and its
   addons share one interpreter environment. Updating one plugin therefore re-locks the
   environment the **host itself** runs in. Decision D17 is whether to accept that (with
   rollback) or to give each plugin its own environment, which changes plan 0001.
3. **Plan 0001, exact-version `requires`.** Addons require each other **at exact versions**, so
   updating one plugin can break every plugin that requires its old version. Plugin updates must
   move the whole plugin set consistently or not at all (see *Plugin updates*).
4. **Plan 0001 slice 07.** The host's supervisor needs a **control channel** the helper can call
   ("restart child X", "kill child X", "stop and start these addons", "report your children").
   It also has to record each child's identity in a run-state file (see *Phantom detection*).
   Both belong to slice 07's acceptance, or to a new 0001 slice.
5. **Plan 0001, the addon manifest (slice 01).** It gains two optional sections: `stability` (how
   to watch the addon) and `update` (where its new versions come from). Optional fields do not
   break existing manifests, but they are changes to the host API contract and must be versioned
   as such.

## Health watching

### What each managed process publishes

A **heartbeat**, sent every `heartbeat_interval` seconds:

| field | meaning |
|---|---|
| `id` | `innytypes`, `innytypes.anytype_mcp`, or the addon id |
| `kind` | `host` \| `mcp` \| `addon` \| `anytype-app` |
| `pid` + `started_at` | the process identity (see *Phantom detection*) |
| `version` | what is running |
| `state` | `starting` \| `ready` \| `degraded` \| `stopping` |
| `progress_at` | when it last did real work. A loop that is spinning without progress must not keep refreshing this field. |
| `detail` | optional, small, JSON: queue depths, last error class. **Never content.** |

The host sends its own heartbeat and forwards heartbeats **on behalf of** children that cannot
send their own. The Node MCP server and the Anytype app are in that group. For the MCP server,
the host's heartbeat comes from `innytypes.anytype_mcp.health.is_api_reachable` plus the child's
liveness.

### The stability profile (addons opt in)

An addon adds an optional `stability` section to its manifest:

| field | default when absent | meaning |
|---|---|---|
| `heartbeat_interval` | none: watched for liveness and resources only | seconds between heartbeats |
| `stale_after` | 3 × `heartbeat_interval` | no progress for this long means **stale** |
| `max_rss_mb` | helper-wide default | memory limit |
| `max_cpu_percent` + `cpu_window` | helper-wide default | sustained CPU limit and the window it is measured over |
| `max_open_files`, `max_children` | helper-wide default | other resource limits |
| `breach_grace` | helper-wide default | how long a breach may last before the helper acts |
| `restartable` | `true` | `false` means the helper may kill the addon but never relaunches it |

An addon **without** a profile is still watched for **liveness** (it is running), **phantoms**
and **resources** under the helper-wide defaults. It is simply **never judged stale**, because
it never promised to send heartbeats.

### Transport

The helper must work **while the host is dead**, so heartbeats cannot depend only on the host's
event bus (plan 0001 slice 06). Proposal (decision D3): the helper listens on a **local Unix
domain socket** in the per-user runtime directory, readable by that user only. Managed processes
send heartbeats to it directly. The helper also reads the **OS process table** independently, so
a process that stops sending heartbeats is still visible.

## Stabilization

### Stale

When a process is judged stale, the helper asks the host to restart it (or restarts the host,
when the host is the stale one), following the D1 table. A process that goes stale repeatedly is
handed to the **restart breaker** below.

### Phantom detection: never kill the wrong process

The single most dangerous thing this helper can do is **kill an unrelated program** whose process
ID happens to match an old record. So a process ID alone is **never** enough to act on.

- Every record the host writes to its **run-state file** holds **process ID + start time +
  executable path** (plus the host's own identity as the parent).
- Before the helper signals any process, it re-reads all three from the OS. **All three must
  match** the record. If any differs, the record is **stale** (the ID was reused): the helper
  deletes the record and signals **nothing**.
- An **orphan** is a process whose record matches but whose recorded host is no longer alive. The
  helper terminates it (polite stop first, forced kill after a timeout) **before** relaunching
  the host, so the new host never starts next to a leftover MCP server or addon.

### Resource breaches

- The helper samples every managed process on a fixed tick: memory in use, CPU over the window,
  open files, and the number of child processes.
- A breach must last longer than `breach_grace` before the helper acts. A short spike is not a
  breach.
- On a breach it **asks for a polite stop, waits, then force-kills**. The kill is reported through
  telemetry (when telemetry is on) and written to the local log with the numbers that triggered
  it.
- A process killed for resources is relaunched only if `restartable` is true, and it counts
  toward the restart breaker.
- The **Anytype desktop app** is the user's own application and may hold unsaved work. Whether
  the helper may ever kill it is decision D5.

### The restart breaker

A process that keeps crashing, going stale or breaching limits must not be relaunched forever.
After **N interventions within a window** (both configurable, never literals), the helper stops
relaunching it, marks it **`quarantined`**, and reports that. `innytypes helper release <id>`
clears the quarantine. If the host itself is quarantined, the helper stays running so it can still
report the problem, but it stops relaunching the host.

## Core auto-update

### The switch

`auto_check_versions` lives in the **application config file**
(`~/.config/innytypes/config.toml`, resolved with `platformdirs`).

- **Off:** the helper makes **no** version-check network request at all. Manual
  `innytypes update check` still works.
- **On:** the helper checks on a schedule (configurable interval, with jitter so installs do not
  all check at the same moment).
- The helper re-reads the switch **before every check**, so turning it off takes effect without a
  restart.
- Whether this same switch also governs **plugin** checks is decision D14.

### What "a release" is

Proposal (decisions D9, D10): the owner's release server publishes a small **release index**
(JSON) per channel (`stable` first). Each entry names the version, the download URL, a **SHA-256
checksum** and a **detached signature**.

### The update flow

1. **Check.** Fetch the index over HTTPS. Compare against the running version. Only move
   **forward**, and never across a **host API major version** without owner action, because
   addons pin the host API they target (decision D13).
2. **Download** to a staging directory. **Verify the checksum and the signature** against a
   public key **shipped inside the currently installed release**. Anything that fails
   verification is deleted and reported. **It is never run and never kept.**
3. **Stage.** A verified release sits in staging, marked ready.
4. **Apply** (decision D11). Never during host startup, never while the host is mid-work. The
   helper stops the host cleanly, swaps the installed release **atomically** (the old one is kept
   as `previous`), and starts the host.
5. **Confirm or roll back.** If the new host does not reach a healthy heartbeat within a
   window, the helper swaps `previous` back, starts that, **blocks that version** from being
   applied again, and reports the rollback.

A release is a complete, **pinned** bundle: its own `uv.lock` and `package-lock.json`. An update
replaces one pinned set with another pinned set. It **never** re-resolves dependencies on the
user's machine. Plan 0001's pinning rule holds across updates.

Before applying a host update, the helper checks that every installed plugin still supports the
new host's `host_api`. If one does not, the host update waits, or goes together with a plugin
update that restores compatibility (see *Plugin updates*). An update that would stop an
installed plugin from starting is never applied silently.

**The helper updates itself** as part of the same bundle. After the swap, the OS service manager
restarts the helper on the new version.

## Plugin updates

### Where plugin versions come from

An addon's manifest gains an optional `update` section naming its **source** (decision D15):

| field | meaning |
|---|---|
| `source` | where new versions are published: the owner's **plugin index**, or a package index such as PyPI (with the project name) |
| `channel` | `stable` by default |

A plugin with no `update` section is never checked. The helper reports it as **not updatable**
instead of guessing a source.

For each candidate version, the helper needs the same facts the manifest carries: `version`,
`host_api`, `requires` (exact versions) and `emits` / `subscribes`. It also needs a **checksum**
for the artifact. For the owner's plugin index, it additionally needs a **signature**
(decision D16).

### Update modes: auto or manual

Each plugin has an update **mode**, set globally with a per-plugin override (decision D18):

| mode | what the helper does |
|---|---|
| `auto` | checks, downloads, verifies, and **applies** when the plugin set stays consistent (see below) |
| `manual` | checks and **reports** available updates; nothing is installed until the user runs a command |
| `off` | never checks this plugin |

Config:

```toml
[plugins]
update_mode = "manual"          # the default for every plugin

[plugins.whodunnit]
update_mode = "auto"            # a per-plugin override
```

Commands (all explicit, so they satisfy plan 0001 invariant 6 as written):

- `innytypes addons outdated`: lists the installed version, the newest compatible version, and
  **why** a newer version is not compatible when that is the case
- `innytypes addons update <id>` / `innytypes addons update --all`: applies updates now
- `innytypes addons pin <id>` / `unpin <id>`: holds a plugin at its current version whatever its
  mode is

### Consistency: the plugin set moves as a whole

Because `requires` are **exact versions**, the helper never updates one plugin in isolation. For
each update it computes the **target plugin set** and accepts it only if **every** rule holds:

1. Every plugin in the target set declares a `host_api` the **running host** supports.
2. Every plugin's `requires` names a plugin **present in the target set at exactly that
   version**.
3. Every event kind a plugin **subscribes** to is still **emitted** by some plugin in the target
   set. A kind that disappears breaks its subscribers (plan 0001: a kind is a public API).
4. No plugin that is **pinned**, or in `off` or `manual` mode, has to change for the others to
   update.
5. The target set resolves to a **fully pinned lock** (every transitive dependency at an exact
   version, with hashes). It never contains a floating range.

If updating plugin A would require updating plugin B too, then:

- if both are `auto`, they update **together**;
- if either is `manual`, `off` or pinned, **nothing** updates automatically, and `outdated` shows
  the blocked group and what blocks it.

A set that fails any rule is **not applied**, in any mode. The helper reports it by name, the same
way plan 0001 reports a missing requirement.

### Applying a plugin update

1. **Resolve and lock** the target set in a staging environment. Verify every artifact's
   checksum, and the signature where the source requires one.
2. **Stop only what is affected.** The helper asks the host (control channel) to stop the updated
   plugins **and every plugin that depends on them**, in reverse start order. Unaffected plugins,
   the MCP server and Anytype keep running when the environment layout allows it (decision D17).
3. **Swap** the environment or the per-plugin install **atomically**, keeping `previous`.
4. **Start** the affected plugins again in start order, and wait for each one's healthy
   heartbeat, or its liveness when it has no stability profile.
5. **Confirm or roll back.** Any affected plugin that fails to become healthy rolls back **the
   whole update group**, not just that plugin. The rolled-back versions are blocked, and the
   rollback is reported.

**When** an `auto` update applies (right away, when idle, or at the next restart) is decision D19.

### Trust

Installing a plugin runs its code in the user's session, and in the shared-environment design,
inside the **same interpreter as the host**. An automatic plugin update is automatic execution of
new third-party code, so trust rules (decision D16) apply **before** `auto` mode is allowed for a
plugin. The proposal is that `auto` is only allowed for plugins whose artifacts are signed by a
key the user has accepted. Everything else can be updated only in `manual` mode.

## Telemetry

### The switch

`telemetry` is a switch **in the application**: `innytypes telemetry on|off|status` from the CLI,
and in any UI the host later grows. It is stored in the same config file, and the helper
re-reads it before every send.

- **Off** means **nothing leaves the machine**. Anything already queued is **deleted, not sent
  later**. Switching telemetry back on starts from an empty queue.
- The switch takes effect **immediately**: a send that is waiting in the queue is dropped.
- Turning telemetry off never affects stabilization or updates. The helper keeps protecting and
  updating the application either way.

### Default and consent

The owner is in the EU, and error reports can contain personal data (paths, user names, text
from exceptions). The default is decision D20.

### What is sent

| kind | contents |
|---|---|
| **usage** | install id (decision D23), innytypes version, OS + version, which plugins are installed with their versions and update modes, start/stop counts, counts of helper interventions by type, update and rollback outcomes |
| **errors** | exception type, stack trace with **file paths redacted** to package-relative form, the version set, the intervention that followed |

### What is never sent

Anytype content, object or space names, the Anytype API key or any other credential, file
contents, audio or transcripts, environment variable values, full home-directory paths, user
names. Every payload passes through **one redaction function** before it is queued, and
`tests/test_no_secrets.py`-style tests prove that function removes each forbidden kind. The key
rule from plan 0002 carries over: nothing that holds the key may appear in a `repr` or a log.

### Delivery

- Reports go into a **bounded on-disk queue**. When it is full, the oldest reports are dropped.
  Telemetry must never fill a disk.
- Sends run in the background, with timeouts and backoff. A slow or unreachable server never
  delays any stabilization action.
- Backends are decisions D21 and D22. Any client library is pinned exactly.

## Telling the user

Several events need the user's attention: a quarantined process, a rolled-back update, a
`manual` plugin update waiting, a plugin set blocked by an incompatibility. How the helper tells
the user is decision D6. Whatever the answer, `innytypes helper status` always shows the current
state of each of these events.

## Configuration

Everything the helper reads, in `~/.config/innytypes/config.toml`:

| key | default | set from |
|---|---|---|
| `telemetry` | D20 | the application: `innytypes telemetry on\|off` |
| `auto_check_versions` | D12 | the config file |
| `update.channel` | `stable` | the config file |
| `update.check_interval` | 24 h (D8) | the config file |
| `plugins.update_mode` | D18 | the config file |
| `plugins.<id>.update_mode` | inherits `plugins.update_mode` | the config file |
| `plugins.<id>.pinned` | `false` | `innytypes addons pin\|unpin` |
| `helper.tick` | 5 s (D8) | the config file |
| `helper.defaults.*` | D8 | the config file |
| `helper.breaker.max_interventions` / `window` | 5 in 10 min (D8) | the config file |

Endpoints (the release index, the plugin index, telemetry servers) are **build-time settings of a
release**, not user config. A user cannot point the updater at a different server by editing a
file. A plugin's own `update.source` comes from its manifest, which is covered by the trust rules.

## Security-sensitive parts

These go to the security executor, never to general implementation, and each gets an
independent security review:

- update signature verification, key handling and the atomic swap (core **and** plugins)
- plugin trust: accepted keys, the rule that allows `auto` mode, and lock hashes
- killing processes (the identity check that prevents killing an unrelated program)
- the local socket's permissions
- telemetry redaction

## The gate stays hermetic

Nothing in `docs/loop/verify.sh` may make a network call, sign with a real key, install a real
package, spawn a real long-running process, or sleep for real time.

- The **process table** is injected (a fake list of processes with IDs, start times, memory and
  CPU), so stale, phantom, reused-ID and breach cases are plain data in a test.
- The **clock** is injected, as in plan 0001 slice 07.
- The **HTTP transport** is injected (`httpx.MockTransport`) for the release index, the plugin
  index, downloads and telemetry.
- The **installer** is injected, so plugin-set resolution, locking and swap are tested against
  fake plugin manifests with no real `uv` or `pip` run.
- Signature tests use a **throwaway key pair generated inside the test**, never a committed
  private key.
- A new runtime dependency (for example `psutil` to read the process table) is pinned with `==`,
  as plan 0001 requires.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | config and switches | `config.toml` loading, `telemetry`, `auto_check_versions`, plugin update modes and pins, `innytypes telemetry on\|off\|status`, live re-read |
| 02 | heartbeat protocol | the heartbeat shape, the local socket, the `stability` manifest section and its defaults |
| 03 | process identity and phantoms | ID + start time + executable identity, the run-state file, orphan cleanup, reused-ID records forgotten and never signalled |
| 04 | stale and resource detection | the sampling tick, stale judgement, breach grace windows, polite-stop-then-kill |
| 05 | host control channel | the host-side endpoints the helper calls (restart / kill / stop-and-start a group / list children), wired into plan 0001 slice 07's single restart policy |
| 06 | restart breaker and quarantine | N-in-window, the quarantine state, `innytypes helper release`, `innytypes helper status` |
| 07 | helper lifecycle | `innytypes-helper` entry point, launchd agent `helper install/uninstall`, helper starts and relaunches the host |
| 08 | telemetry pipeline | redaction, the bounded on-disk queue, background sending, switch-off purges the queue, the consent default |
| 09 | core update check and verified download | the release index, forward-only and host-API-major guard, checksum + signature verification, staging |
| 10 | core apply and roll back | the atomic swap, the health-confirmed start, rollback, blocked versions, the plugin-compatibility check before a host update, self-update of the helper |
| 11 | plugin version check | the `update` manifest section, the plugin index and PyPI sources, the five consistency rules, `innytypes addons outdated` with blocking reasons |
| 12 | plugin update apply | trust rules, staged lock with hashes, stop the affected group, swap, start in order, group rollback, `addons update` / `pin` / `unpin`, `auto` mode |
| 13 | user notification | the channel chosen in D6, for quarantine, rollback, pending manual updates and blocked sets |
| 14 | Linux | systemd user unit, and a Linux process-table reader |

**Order.** 01 → 02 → 03 → 04 → 06 can be built against fakes now. 05 and 07 wait for plan 0001
slice 07 (process supervision). 08 needs only 01. 09 → 10 need 01, and 10 needs 07. 11 needs 01
and plan 0001 slices 01–03 (manifest, discovery, resolution). 12 needs 11, 05, and the answer to
D17. 13 needs 06.

No WorkItems are seeded until this plan is **APPROVED**.

## Decisions for the owner

Every decision below is open. Each lists what is at stake, the options, and the proposal this
draft is written against. When one is answered differently, the sections that cite it change
with it.

### Stabilization

**D1 — Who restarts child processes.**
*At stake:* plan 0001 slice 07 already restarts children. Two independent restart loops race and
start the same process twice.
*Options:* (a) two layers: the host restarts children that exit; the helper decides on stale or
breach, asks the host to act, and directly relaunches only the host. (b) The helper owns all
restarts, and plan 0001 slice 07 shrinks to start and stop only. (c) The host owns all restarts,
and the helper only watches and reports, except for relaunching a dead host.
*Proposal:* (a). It keeps plan 0001's "one restart policy" and still covers a dead host.

**D2 — What starts and watches the helper.**
*At stake:* the helper must outlive the host, and something must restart the helper itself.
*Options:* (a) a per-user launchd LaunchAgent with `KeepAlive`, installed by `innytypes helper
install`. (b) The host spawns the helper detached at startup. (c) A macOS Login Item, with no
automatic restart.
*Proposal:* (a). With (b), nothing restarts the helper if it dies before the host is started
again; with (c), a crashed helper stays down.

**D3 — How heartbeats reach the helper.**
*At stake:* the helper must keep working while the host is dead.
*Options:* (a) a per-user Unix domain socket owned by the helper, plus an independent read of the
OS process table. (b) The host's event bus (plan 0001 slice 06). (c) Each process writes a status
file that the helper polls. (d) A localhost HTTP endpoint.
*Proposal:* (a). (b) goes silent exactly when the host dies. (c) is slower and leaves files
behind. (d) is reachable by any local user unless it is also locked down.

**D4 — The definition of "stale".**
*At stake:* a threshold that is too tight restarts healthy but busy processes; one that is too
loose leaves hangs in place.
*Options:* (a) no heartbeat, or no change in `progress_at`, for `stale_after` (default 3 ×
interval). (b) Heartbeats only (a process that answers but has made no progress is not stale).
(c) An addon-supplied health check the helper calls.
*Proposal:* (a), with (c) as an optional addition for addons that want it.

**D5 — May the helper kill the Anytype desktop app?**
*At stake:* Anytype is the user's application and may hold unsaved work. A forced kill can lose
it.
*Options:* (a) never kill it; only report stale or breach states for it. (b) Polite quit only,
never a forced kill. (c) Treat it like any other managed process.
*Proposal:* (a).

**D6 — How the helper tells the user something needs attention.**
*At stake:* quarantines, rollbacks, pending manual updates and blocked plugin sets are useless if
nobody sees them.
*Options:* (a) macOS Notification Center, plus `innytypes helper status`. (b) The status command
and the local log only. (c) An event on the host bus that a UI addon can show.
*Proposal:* (a), with (c) added once a UI exists.

**D7 — Linux and Windows scope.**
*Options:* (a) macOS for MVP, Linux as a later slice, Windows out of scope. (b) macOS and Linux
both in the MVP. (c) All three.
*Proposal:* (a).

**D8 — Default numbers.**
*At stake:* these are policy, not implementation details.
*Values proposed:* sampling tick 5 s; `stale_after` 3 × heartbeat interval; memory limit per addon
1 GB; CPU above 90 % sustained for 2 min; open files 1 024; breach grace 60 s; polite-stop timeout
10 s; breaker 5 interventions in 10 min; core update check every 24 h with up to 1 h of jitter;
health confirmation window after an update 2 min.
*Proposal:* accept these as starting defaults, all overridable in config.

### Core updates

**D9 — Release format and signing tool.**
*Options for signing:* (a) minisign (small, single key file, simple to verify from Python). (b)
Sigstore (keyless, tied to an identity provider and a public transparency log). (c) GPG.
*Proposal:* a JSON release index with a SHA-256 checksum per artifact, signed with (a), minisign.
Sigstore adds external services for a single-owner project, and GPG is hard to use correctly.

**D10 — Where releases are hosted.**
*Options:* (a) Hetzner Object Storage. (b) Scaleway Object Storage. (c) Releases on a self-hosted
Forgejo. (d) One of those behind Bunny.net CDN.
*Proposal:* (a) or (c), with (d) added only if download volume ever needs it. This one is the
owner's call on infrastructure.

**D11 — When a downloaded core update is applied.**
*Options:* (a) automatically when the host is idle. (b) At the next restart the user starts. (c)
Only after the user confirms. (d) Immediately after download.
*Proposal:* (b) by default. (a) can be added once "idle" has a tested definition. (d) interrupts
work.

**D12 — Default of `auto_check_versions`.**
*Options:* (a) on. (b) off.
*Proposal:* (a), on. A check sends only the running version and channel. Nothing is applied
without the rules above.

**D13 — Host API major version updates.**
*At stake:* addons target a host API version, so a major bump can stop plugins from starting.
*Options:* (a) never applied automatically; always a manual command. (b) Applied automatically
when every installed plugin already has a compatible version available.
*Proposal:* (a).

### Plugin updates

**D14 — Does `auto_check_versions` also govern plugin checks?**
*Options:* (a) yes: turning it off stops every version check, core and plugins. (b) No: plugins
are controlled only by `plugins.update_mode`.
*Proposal:* (a). One switch that means "make no version requests" is easier to trust. When it is
on, `plugins.update_mode` decides what happens per plugin.

**D15 — Where plugin versions come from.**
*Options:* (a) only the owner's own plugin index. (b) The owner's plugin index, plus PyPI for
plugins that declare it. (c) Any source a plugin declares, including git URLs.
*Proposal:* (b). (c) turns every plugin manifest into a way to install code from anywhere.

**D16 — Plugin trust.**
*At stake:* an automatic plugin update runs new code, possibly inside the host's interpreter.
*Options:* (a) `auto` only for plugins signed by a key the user has accepted; unsigned plugins are
`manual` only. (b) `auto` for any plugin from an allowed source, with lock hashes as the only
check. (c) `auto` only for the owner's own plugins.
*Proposal:* (a).

**D17 — The plugin environment layout.**
*At stake:* plan 0001 says the host and its addons share one interpreter environment. Updating a
plugin then re-locks the host's own environment, and a bad plugin dependency can break the host.
*Options:* (a) keep one shared environment; every plugin update re-locks it and restarts the host
with rollback. (b) Give each plugin its own `uv` environment, with the same pinned Python, so a
plugin update touches only that plugin. This changes plan 0001. (c) Shared environment for the
owner's plugins, separate environments for third-party plugins.
*Proposal:* (b). Addons already run as separate processes (plan 0001), so nothing requires them to
share the host's interpreter. It also makes rollback of one plugin group safe while everything
else keeps running.

**D18 — Default plugin update mode.**
*Options:* (a) `manual`. (b) `auto`. (c) `off`.
*Proposal:* (a), `manual`, with per-plugin `auto` opted into one plugin at a time, within D16's
trust rule.

**D19 — When an `auto` plugin update is applied.**
*Options:* (a) right away, restarting only the affected plugin group. (b) When the affected
plugins are idle. (c) At the next host restart.
*Proposal:* (a) once D17 is (b), because only the affected group stops. With a shared environment,
(c) instead, because the host has to restart.

### Telemetry

**D20 — Telemetry default.**
*At stake:* error reports can contain personal data, and the owner is in the EU (GDPR).
*Options:* (a) off until the user answers a one-time question on first run. (b) On, with an
opt-out switch. (c) Off, with an opt-in switch only.
*Proposal:* (a). (b) needs its own legal basis before it is chosen.

**D21 — Error-report backend.**
*Options:* (a) self-hosted GlitchTip (open source, speaks the Sentry protocol). (b) Self-hosted
Sentry. (c) A plain endpoint on the owner's server.
*Proposal:* (a). Much lighter to run than self-hosted Sentry, and existing Sentry client libraries
work with it.

**D22 — Usage backend.**
*Options:* (a) self-hosted PostHog. (b) A plain endpoint on the owner's server storing into
PostgreSQL or ClickHouse. (c) Umami or Plausible (built for websites, a poor fit for app events).
*Proposal:* (b) for the MVP, since the usage payload is small and fixed. (a) if product analytics
(funnels, cohorts) are wanted later.

**D23 — The install id.**
*At stake:* an id lets usage be counted per install, and it is also personal data under GDPR.
*Options:* (a) a random id generated at install time, reset when telemetry is turned off. (b) A
random id that survives telemetry being toggled. (c) No id at all.
*Proposal:* (a).

**D24 — Letting the user see what is sent.**
*Options:* (a) `innytypes telemetry show` prints the queued reports exactly as they would be sent.
(b) No viewer.
*Proposal:* (a). It also makes the redaction testable by hand.

**D25 — Server-side retention and a privacy notice.**
*At stake:* collecting telemetry from other people's machines creates obligations for the owner.
*Options:* (a) a fixed retention period (for example 90 days for errors, 13 months for usage) and
a privacy notice shown with the D20 question. (b) Decide once real users exist.
*Proposal:* (a), before telemetry is turned on for anyone other than the owner.

### Plan housekeeping

**D26 — Amending plan 0001.**
*Needed if this plan is approved as proposed:* invariant 6 names the helper as the one sanctioned
exception for background downloads and `auto` updates; slice 07 gains the control channel and
the run-state file; slice 01 gains the optional `stability` and `update` manifest sections; and,
if D17 is (b), the shared-environment statement is replaced by per-plugin environments.
*Proposal:* amend plan 0001 in the same change that approves this plan, so the two never disagree.

**D27 — Names.**
*Proposal:* Python package `innytypes.helper`, console script `innytypes-helper`, launchd label
`it.l1nx.innytypes.helper`, and "InnyTypesHelper" as the user-facing name.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees. For the security-sensitive slices,
an independent security review must agree as well.

This plan is done for MVP (slices 01–13, macOS) when:

- `innytypes helper install` makes the helper start at login, and the helper brings up the host
- killing the host with `kill -9` leaves no orphans, and the host is back within the configured
  window
- a stale addon and a memory-breaching addon are each handled as the D1 table says, and a
  crash-looping one ends quarantined
- a record whose process ID was reused by another program is never signalled
- `innytypes telemetry off` stops all sends at once and empties the queue
- with `auto_check_versions` on, a signed newer release is downloaded, verified, applied and
  confirmed healthy, and a deliberately broken release is rolled back
- `innytypes addons outdated` shows a newer plugin version and, for a blocked one, the exact
  reason it is blocked
- an `auto` plugin update that requires a second plugin to update updates both together, and a
  group that fails its health check rolls back as a whole
- a plugin update that would break another plugin's exact `requires` or remove a subscribed event
  kind is never applied
- no report contains anything from the *never sent* list
