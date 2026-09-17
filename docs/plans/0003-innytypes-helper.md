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
does four jobs:

1. **Health watching.** It checks the health of the innytypes runtime, the Anytype MCP server,
   and every addon that publishes data on how it wants to be managed and stabilized.
2. **Stabilization.** It relaunches processes that go **stale** or **phantom**, and kills
   processes that **use too many resources**.
3. **Auto-update.** It downloads new innytypes releases, controlled by the **auto-check versions**
   switch in the application config.
4. **Telemetry.** It sends usage and error reports to the owner's own servers, controlled by the
   **telemetry** switch in the application.

The owner's request, verbatim:

> It is ANOTHER PROCESS that checks the healts of the InnyTypes runtime, the mcp server and the
> other plugins if they publish data on how they are managed and stabilized. The helper
> stabilizes the application and is in charge of relaunching processes if they go stale,
> phantom, or kill them if they consume too many resources. The helper is also in charge of auto
> downloading the new versions of the InnyTypes releases as well as telemetry to my own servers
> for usage and errors. There is a "telemetry" switch in the application in the application to
> stop sending info. There is a auto-check versions switch in the application config.

### Why it must be a separate process

A watchdog inside the process it watches dies with it. The host can restart a child that exits,
but it cannot restart **itself** after a crash or a hang. It also cannot reliably notice that it
is **leaking memory** or **stuck in a loop**. The helper can do all three because it does not share
the host's fate.

The same reasoning puts updates and telemetry here. Replacing the host's own files while the host
is running is fragile. And a crash report must be sent by something that survived the crash.

## Words this plan uses

| word | meaning |
|---|---|
| **managed process** | any process the helper watches: the host, the MCP server, an addon, the Anytype desktop app |
| **heartbeat** | a small message a managed process sends every few seconds: "I am alive, and here is my state" |
| **alive** | the OS reports the process as running |
| **stale** | alive, but it has **stopped making progress**: it missed its heartbeats for longer than its allowed window, or its own health check keeps failing. Typical cause: a hang or a deadlock. |
| **phantom** | a process that **exists but has no valid owner**, in one of two forms: (a) an **orphan**, a child still running after the host that started it died; (b) a **stale record**, a recorded process ID that now belongs to a **different, unrelated** program because the OS reused the number. |
| **resource breach** | a process staying above its memory, CPU, open-file or child-process limit for longer than its grace window |
| **stability profile** | what an addon publishes about how it wants to be watched: heartbeat interval, stale window, resource limits, whether it may be restarted |

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
through the stability profiles and heartbeats they publish.

### Conflicts this plan creates with approved plans

The owner has to resolve these before 0003 can be approved:

1. **Plan 0001, invariant 6 ("installation is explicit; a startup that mutates the environment
   is a startup nobody can debug").** Auto-downloading releases changes the environment without
   a command. This plan keeps the invariant's intent: **download and verification** happen in
   the background, and **applying** an update is a separate, logged, reversible step that never
   happens **during host startup** (decision D4). The invariant's text still needs amending to
   name the helper as the one sanctioned exception.
2. **Plan 0001 slice 07.** The host's supervisor needs a **control channel** the helper can call
   ("restart child X", "kill child X", "report your children"). It also has to record each
   child's identity in a run-state file (see *Phantom detection*). Both belong to slice 07's
   acceptance, or to a new 0001 slice.
3. **Plan 0001, the addon manifest (slice 01).** It gains an optional `stability` section. An
   optional field does not break existing manifests, but it is a change to the host API
   contract and must be versioned as one.

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

### The restart breaker

A process that keeps crashing, going stale or breaching limits must not be relaunched forever.
After **N interventions within a window** (both configurable, never literals), the helper stops
relaunching it, marks it **`quarantined`**, and reports that. `innytypes helper release <id>`
clears the quarantine. If the host itself is quarantined, the helper stays running so it can still
report the problem, but it stops relaunching the host.

## Auto-update

### The switch

`auto_check_versions` lives in the **application config file**
(`~/.config/innytypes/config.toml`, resolved with `platformdirs`).

- **Off:** the helper makes **no** version-check network request at all. Manual
  `innytypes update check` still works.
- **On:** the helper checks on a schedule (configurable interval, with jitter so installs do not
  all check at the same moment).
- The helper re-reads the switch **before every check**, so turning it off takes effect without a
  restart.

### What "a release" is

Proposal (decision D5): the owner's release server publishes a small **release index** (JSON) per
channel (`stable` first). Each entry names the version, the download URL, a **SHA-256 checksum**
and a **detached signature**.

### The update flow

1. **Check.** Fetch the index over HTTPS. Compare against the running version. Only move
   **forward**, and never across a **host API major version** without owner action, because
   addons pin the host API they target.
2. **Download** to a staging directory. **Verify the checksum and the signature** against a
   public key **shipped inside the currently installed release**. Anything that fails
   verification is deleted and reported. **It is never run and never kept.**
3. **Stage.** A verified release sits in staging, marked ready.
4. **Apply** (decision D4). Never during host startup, never while the host is mid-work. The
   helper stops the host cleanly, swaps the installed release **atomically** (the old one is kept
   as `previous`), and starts the host.
5. **Confirm or roll back.** If the new host does not reach a healthy heartbeat within a
   window, the helper swaps `previous` back, starts that, **blocks that version** from being
   applied again, and reports the rollback.

A release is a complete, **pinned** bundle: its own `uv.lock` and `package-lock.json`. An update
replaces one pinned set with another pinned set. It **never** re-resolves dependencies on the
user's machine. Plan 0001's pinning rule holds across updates.

**The helper updates itself** as part of the same bundle. After the swap, the OS service manager
restarts the helper on the new version.

## Telemetry

### The switch

`telemetry` is a switch **in the application**: `innytypes telemetry on|off|status` from the CLI,
and in any UI the host later grows. It is stored in the same config file, and the helper
re-reads it before every send.

- **Off** means **nothing leaves the machine**. Anything already queued is **deleted, not sent
  later**. Switching telemetry back on starts from an empty queue.
- The switch takes effect **immediately**: a send that is waiting in the queue is dropped.
- Turning telemetry off never affects stabilization. The helper keeps protecting the application
  either way.

### Default and consent

The owner is in the EU, and error reports can contain personal data (paths, user names, text
from exceptions). The proposal (decision D6) is **off until the user chooses**: the first
`innytypes up` asks once, and the answer is stored. The alternative is on by default with an
opt-out, and it needs its own legal justification before it is chosen.

### What is sent

| kind | contents |
|---|---|
| **usage** | install id (random, not derived from hardware or account), innytypes version, OS + version, which addons are installed and their versions, start/stop counts, counts of helper interventions by type |
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
- Proposal (decision D7): errors go to a self-hosted **GlitchTip** (open source, speaks the Sentry
  protocol), and usage goes to a self-hosted **PostHog** or a plain endpoint on the owner's
  server. Both run on EU hosting. Any client library is pinned exactly.

## Configuration

Everything the helper reads, in `~/.config/innytypes/config.toml`:

| key | default | set from |
|---|---|---|
| `telemetry` | unset (asked on first run) | the application: `innytypes telemetry on\|off` |
| `auto_check_versions` | `true` (to confirm, D8) | the config file |
| `update.channel` | `stable` | the config file |
| `update.check_interval` | 24 h | the config file |
| `helper.tick` | 5 s | the config file |
| `helper.defaults.*` | see the stability profile table | the config file |
| `helper.breaker.max_interventions` / `window` | 5 in 10 min | the config file |

Endpoints (release index, telemetry servers) are **build-time settings of a release**, not user
config. A user cannot point the updater at a different server by editing a file.

## Security-sensitive parts

These go to the security executor, never to general implementation, and each gets an
independent security review:

- update signature verification, key handling and the atomic swap
- killing processes (the identity check that prevents killing an unrelated program)
- the local socket's permissions
- telemetry redaction

## The gate stays hermetic

Nothing in `docs/loop/verify.sh` may make a network call, sign with a real key, spawn a real
long-running process, or sleep for real time.

- The **process table** is injected (a fake list of processes with IDs, start times, memory and
  CPU), so stale, phantom, reused-ID and breach cases are plain data in a test.
- The **clock** is injected, as in plan 0001 slice 07.
- The **HTTP transport** is injected (`httpx.MockTransport`) for the release index, downloads and
  telemetry.
- Signature tests use a **throwaway key pair generated inside the test**, never a committed
  private key.
- A new runtime dependency (for example `psutil` to read the process table) is pinned with `==`,
  as plan 0001 requires.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | config and switches | `config.toml` loading, `telemetry` and `auto_check_versions`, `innytypes telemetry on\|off\|status`, live re-read |
| 02 | heartbeat protocol | the heartbeat shape, the local socket, the `stability` manifest section and its defaults |
| 03 | process identity and phantoms | ID + start time + executable identity, the run-state file, orphan cleanup, reused-ID records forgotten and never signalled |
| 04 | stale and resource detection | the sampling tick, stale judgement, breach grace windows, polite-stop-then-kill |
| 05 | host control channel | the host-side endpoints the helper calls (restart / kill / list children), wired into plan 0001 slice 07's single restart policy |
| 06 | restart breaker and quarantine | N-in-window, the quarantine state, `innytypes helper release` |
| 07 | helper lifecycle | `innytypes-helper` entry point, launchd agent `helper install/uninstall`, helper starts and relaunches the host |
| 08 | telemetry pipeline | redaction, the bounded on-disk queue, background sending, switch-off purges the queue, first-run consent |
| 09 | update check and verified download | the release index, forward-only and host-API-major guard, checksum + signature verification, staging |
| 10 | apply and roll back | the atomic swap, the health-confirmed start, rollback, blocked versions, self-update of the helper |
| 11 | Linux | systemd user unit, and a Linux process-table reader |

**Order.** 01 → 02 → 03 → 04 → 06 can be built against fakes now. 05 and 07 wait for plan 0001
slice 07 (process supervision). 08 needs only 01. 09 → 10 need 01, and 10 needs 07.

No WorkItems are seeded until this plan is **APPROVED**.

## Decisions for the owner

| # | decision | proposal |
|---|---|---|
| D1 | who restarts children | two layers: the host restarts children; the helper decides on stale/breach, asks the host, and relaunches only the host |
| D2 | who starts the helper | the OS service manager (launchd on macOS), installed by an explicit command |
| D3 | heartbeat transport | a per-user Unix domain socket owned by the helper, plus an independent read of the OS process table |
| D4 | when updates apply | download + verify in the background; apply only when the host is idle or at the next user-initiated restart, never during startup |
| D5 | release format and hosting | a signed JSON release index on the owner's own server; signing tool (minisign or Sigstore) and EU host still to choose |
| D6 | telemetry default | off until the user answers a one-time first-run question |
| D7 | telemetry backends | self-hosted GlitchTip for errors; self-hosted PostHog or a plain endpoint for usage |
| D8 | `auto_check_versions` default | on (a check sends only the version and channel); downloads are still verified before anything is kept |
| D9 | amending plan 0001 | invariant 6 names the helper as the one sanctioned exception; slice 07 gains the control channel and run-state file; slice 01 gains the optional `stability` section |

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees. For the security-sensitive slices,
an independent security review must agree as well.

This plan is done for MVP (slices 01–10, macOS) when:

- `innytypes helper install` makes the helper start at login, and the helper brings up the host
- killing the host with `kill -9` leaves no orphans, and the host is back within the configured
  window
- a stale addon and a memory-breaching addon are each handled as the D1 table says, and a
  crash-looping one ends quarantined
- a record whose process ID was reused by another program is never signalled
- `innytypes telemetry off` stops all sends at once and empties the queue
- with `auto_check_versions` on, a signed newer release is downloaded, verified, applied and
  confirmed healthy, and a deliberately broken release is rolled back
- no report contains anything from the *never sent* list
