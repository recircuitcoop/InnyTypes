---
type: plan
title: InnyTypesHelper — a separate process that keeps the application stable, updated and reporting
status: APPROVED
created: 2026-09-17
updated: 2026-09-18
---

# 0003 — InnyTypesHelper

## What this is

`InnyTypesHelper` is **another process, separate from the innytypes host**. The host (plan 0001)
runs the MCP server (plan 0002) and the addons. The helper sits outside all of them and does five
jobs:

1. **Health watching.** It checks the health of the innytypes runtime, the Anytype MCP server,
   the Anytype desktop app, and every addon that publishes data on how it wants to be managed and
   stabilized.
2. **Stabilization.** It **owns every restart**. It relaunches processes that exit, go **stale** or
   go **phantom**, and kills processes that **use too many resources**.
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

> the Helper also checks for the external plugins versions and auto or manual update.

The decisions the owner took on this plan, including seven follow-ups, are recorded under
*Decisions* at the end.

### Why it must be a separate process

A watchdog inside the process it watches dies with it. The host cannot restart **itself** after
a crash or a hang. It also cannot reliably notice that it is **leaking memory** or **stuck in a
loop**. The helper can do all three because it does not share the host's fate.

The same reasoning puts updates and telemetry here. Replacing the host's own files or its plugins
while the host is running is fragile. And a crash report must be sent by something that survived
the crash.

## Words this plan uses

| word | meaning |
|---|---|
| **the application** | everything the app icon starts: the helper, the Anytype desktop app, the host, the MCP server and the plugins |
| **managed process** | any process the helper watches: the host, the MCP server, a plugin, the Anytype desktop app |
| **plugin** | the owner's word for an **addon** (plan 0001): an external package built outside this repository (`monty`, `whodunnit`, `summarize`, or any third party's) |
| **heartbeat** | a small message a managed process sends every few seconds: "I am alive, and here is my state" |
| **alive** | the OS reports the process as running |
| **stale** | alive, but it has **stopped making progress**: no heartbeat, or no change in its progress marker, for longer than its allowed window. Typical cause: a hang or a deadlock. |
| **phantom** | a process that **exists but has no valid owner**, in one of two forms: (a) an **orphan**, a child still running after the host that started it died; (b) a **stale record**, a recorded process ID that now belongs to a **different, unrelated** program because the OS reused the number. |
| **resource breach** | a process staying above its memory, CPU, open-file or child-process limit for longer than its grace window |
| **stability profile** | what a plugin publishes about how it wants to be watched: heartbeat interval, stale window, resource limits, whether it may be restarted |
| **plugin set** | every installed plugin at its exact version, together with the host version. An update moves the whole set from one consistent state to another. |
| **plugin environment** | the separate Python environment each plugin is installed into (D17) |

## How the application starts

**One clickable application icon starts everything** (D2). The bundles are built with **BeeWare
Briefcase** (F5): an app bundle on macOS, an installer with a Start-menu and desktop shortcut on
Windows, and a package with a `.desktop` entry on Linux.

The icon launches **the helper**, and the helper brings up the rest:

1. **The helper starts** and takes a **single-instance lock**. If a helper is already running,
   the second launch only brings the running application's window forward, and exits.
2. The helper starts **the Anytype desktop app**, or **adopts** it when it is already running
   (F6). The helper remembers which of the two happened.
3. The helper starts **the host**.
4. The host starts **the MCP server** and **the plugins**, in the resolver's start order
   (plan 0001), and reports each child's identity to the helper.

**Quitting the application** stops everything in reverse order: plugins, MCP server, host,
Anytype (only if the application started it, F6), and the helper last. A staged core update is
applied at this point (see *Core auto-update*).

The application can also **start at login**, through a `launch_at_login` switch that is **off by
default** (F7).

### The helper and the host watch each other

The helper restarts the host (D1). The **host relaunches the helper** when the helper
**crashes** (F1). That is the only thing the host ever restarts, and it uses the same backoff and
breaker settings as the helper's policy, read from the same config.

The host treats the helper as **crashed** only when it exits abnormally: a non-zero exit code, or
a crash signal (segmentation fault, abort, bus error). A helper that is **stopped from outside**
is **not** relaunched. That means a helper that receives a terminate, interrupt or kill signal, or
is ended from Activity Monitor or Task Manager. The host takes that as "the user wants
InnyTypes off", and shuts itself and its children down. Without this rule, the two processes would
keep bringing each other back, and the application could not be turned off.

### Turning InnyTypes off

Owner requirement (F1): **"there has to be a clear and easy way of turning the whole InnyTypes
application off!"**

Every one of these turns off **the whole application**: the plugins, the MCP server, the host,
Anytype if the application started it, and the helper. Nothing is relaunched afterwards.

| way | how |
|---|---|
| **Quit** in the application | the **Quit InnyTypes** item in the application's own menu, and the standard shortcut (⌘Q on macOS, Alt+F4 on the main window on Windows and Linux) |
| **The Dock or taskbar** | **Quit** from the application icon's menu |
| **The command line** | `innytypes quit` |
| **Stopping the helper from outside** | ending `InnyTypesHelper` in Activity Monitor or Task Manager, or `kill <pid>`; the host sees an external stop and shuts down too (see above) |
| **Logging out or shutting down the computer** | treated as Quit |
| **When something is hung** | `innytypes quit --force`: stops every process in the run-state file by its verified identity, politely first and then forcibly, without waiting on the helper or the host |

A quit is **intentional**: the helper records it before it stops anything. So no process that
exits during a quit is treated as a crash, and nothing is restarted, quarantined or reported as an
error.

After a quit, **the next start is always a deliberate click** on the application icon, or a login
when `launch_at_login` is on.

## How it fits with plans 0001 and 0002

### The helper owns every restart

Owner decision D1: **the helper restarts the process.** There is exactly one restart policy in
the application, and it lives in the helper: backoff, maximum attempts, and quarantine.

Who **spawns** a process is a separate question from who **decides** to restart it. The host
must remain the parent of the MCP server and the plugins, because it talks to them through their
pipes and the event bus. The MCP server speaks MCP **over stdio**, and a process spawned by the
helper would leave the host with no pipe to it. So:

| process | who decides to (re)start it | who spawns it |
|---|---|---|
| Anytype desktop app | helper | helper |
| host | helper | helper |
| MCP server | helper | host, on the helper's command |
| a plugin | helper | host, on the helper's command |

What happens in each situation:

| situation | what happens |
|---|---|
| a child of the host **exits** | the host reports the exit to the helper and **does not restart it**. The helper applies the restart policy and, when it decides to restart, sends a restart command. |
| a child is **stale** or in **resource breach** | the helper decides, and sends a restart or kill command to the host |
| the **host itself** exits, is stale, or is in breach | the helper kills it if needed, cleans up its orphans, and relaunches it. The new host starts its children normally. |
| the **Anytype app** exits, is stale, or is in breach | the helper handles it directly, like any other managed process (D5) |
| **phantom** processes | the helper kills orphans; it only **forgets** stale records and never signals them, because that process number now belongs to someone else |
| the **host does not answer** a command | the helper treats the host as stale |

Plan 0001 slice 07 changes to match: the host starts and stops its children, reports exits and
identities, and carries out the helper's commands. It has **no restart loop of its own** (D26).

**The control channel, as plan 0001 slice 07 landed it.** It has two halves and neither is a
socket: the transport is injected, so the host's side is proved without one and slice 05 below
is free to choose how the two processes are actually connected.

| direction | shape |
|---|---|
| helper → host | `ChildSupervisor.execute(Command) -> CommandResult`. A `Command` is a `name` (`start`, `stop`, `restart`, `kill`, `restart-group`, `list`), the `child_id` it acts on, and a `group` of ids for `restart-group`. A `CommandResult` carries the children the command left running: the new record for a start or a restart, every live child for a list, none for a stop or a kill. |
| host → helper | the `ExitReporter` callable the host is built with — one call per child exit, carrying the child's id, kind, process ID, exit code, and whether the host itself asked for the stop. |

A command naming a child this host does not have is **refused by name**, rather than answered
with silence: a helper and a host that disagree about what is installed is a fact worth an
error. A `restart-group` is refused whole if any member is unknown, because half a group
restarted is worse than none of it.

### The dependency direction is unchanged

The helper lives in this repository as `innytypes.helper`, with its own console script
`innytypes-helper` (D27). Like every host module, it **imports no plugin**. It learns about
plugins only through their manifests, the stability profiles and heartbeats they publish, and the
sources they declare. Plugins are installed into their own environments (D17), so neither the
host nor the helper ever imports plugin code.

### Changes to approved plans

Made together with the approval of this plan (D26):

- **Plan 0001:**
  - The app icon and the helper start the application.
  - The host no longer restarts anything (slice 07).
  - The Anytype desktop app is started by the helper, not the host.
  - Each plugin gets its own environment (D17), and discovery reads plugin manifests from those
    environments (slice 02).
  - The manifest gains the optional `stability` and `update` sections (slice 01).
  - Invariant 6 names the helper as the one sanctioned exception for background downloads and
    `auto` plugin updates.
- **Plan 0002:** restart policy for the MCP child now lives in this plan, not in plan 0001
  slice 07.

## Health watching

### What each managed process publishes

A **heartbeat**, sent every `heartbeat_interval` seconds:

| field | meaning |
|---|---|
| `id` | `innytypes`, `innytypes.anytype_mcp`, or the plugin id |
| `kind` | `host` \| `mcp` \| `plugin` \| `anytype-app` |
| `pid` + `started_at` | the process identity (see *Phantom detection*) |
| `version` | what is running |
| `state` | `starting` \| `ready` \| `degraded` \| `stopping` |
| `progress_at` | when it last did real work. A loop that is spinning without progress must not keep refreshing this field. |
| `detail` | optional, small, JSON: queue depths, last error class. **Never content.** |

The host sends its own heartbeat and forwards heartbeats **on behalf of** its children that
cannot send their own, such as the Node MCP server. For the MCP server, the host's heartbeat
comes from `innytypes.anytype_mcp.health.is_api_reachable` plus the child's liveness. The Anytype
desktop app sends no heartbeat. The helper watches it for liveness and resources, and for
reachability of its local API.

### The stability profile (plugins opt in)

A plugin adds an optional `stability` section to its manifest:

| field | default when absent | meaning |
|---|---|---|
| `heartbeat_interval` | none: watched for liveness and resources only | seconds between heartbeats |
| `stale_after` | 3 × `heartbeat_interval` | no progress for this long means **stale** |
| `max_rss_mb` | 1 024 | memory limit |
| `max_cpu_percent` + `cpu_window` | 90 % over 2 min | sustained CPU limit and the window it is measured over |
| `max_open_files` | 1 024 | open-file limit |
| `max_children` | helper-wide default | child-process limit |
| `breach_grace` | 60 s | how long a breach may last before the helper acts |
| `restartable` | `true` | `false` means the helper may kill the plugin but never relaunches it |

A plugin **without** a profile is still watched for **liveness**, **phantoms** and **resources**
under the helper-wide defaults. It is simply **never judged stale**, because it never promised to
send heartbeats. A plugin may additionally expose its own **health check**, which the helper
calls (D4).

### Transport

The helper must work **while the host is dead**, so heartbeats cannot depend only on the host's
event bus. Managed processes send heartbeats **directly to the helper** over a **local socket**
in the per-user runtime directory, readable by that user only (D3). This is a Unix domain socket
on macOS and Linux, and also on Windows 10 and later, which support them. The helper also reads
the **OS process table** independently, so a process that stops sending heartbeats is still
visible.

## Stabilization

### The restart policy

When a managed process exits unexpectedly, goes stale, or is killed for a breach while
`restartable`:

- The helper restarts it **at most N times with increasing backoff**. N and the delays are
  configuration, never literals.
- When the attempts are exhausted, the process ends in a **terminal state** that reports its
  last exit code, and it counts toward the breaker below.
- **Stale:** the helper restarts the process, or the host when the host is the stale one,
  according to the table above.

### Phantom detection: never kill the wrong process

The single most dangerous thing this helper can do is **kill an unrelated program** whose process
ID happens to match an old record. So a process ID alone is **never** enough to act on.

- Every record in the **run-state file** holds **process ID + start time + executable path**,
  plus the identity of the process that spawned it. The host writes the records for its
  children, and the helper writes the records for the processes it spawns.
- Before the helper signals any process, it re-reads all three from the OS. **All three must
  match** the record. If any differs, the record is **stale** (the ID was reused): the helper
  deletes the record and signals **nothing**.
- An **orphan** is a process whose record matches but whose recorded parent is no longer alive.
  The helper terminates it (polite stop first, forced kill after a timeout) **before**
  relaunching the host, so the new host never starts next to a leftover MCP server or plugin.

**The run-state file** (written by the host in `innytypes.children`, plan 0001 slice 07; read
here). It lives at `<per-user runtime dir>/innytypes/run-state.json`, resolved by
`platformdirs` — the *runtime* directory rather than a config or data one, because the system
is entitled to clear it on a reboot, which is exactly the right thing to do to a list of
processes that no longer exist.

```json
{
  "version": 1,
  "records": [
    {
      "id": "innytypes.anytype_mcp",
      "kind": "mcp",
      "pid": 4321,
      "started_at": 1758150000.0,
      "executable": "/opt/homebrew/bin/npx",
      "parent_pid": 4200
    }
  ]
}
```

- `id` is what a command names and what a heartbeat carries: `innytypes` for the host,
  `innytypes.anytype_mcp` for the MCP server, the plugin's id for a plugin. It is unique, so a
  record is replaced rather than duplicated.
- `kind` is `host` | `mcp` | `addon` | `anytype-app`. The word for a plugin is **`addon`**,
  which is what plan 0001, the code and every manifest say; this plan's prose uses the two
  interchangeably and the file does not get to.
- `started_at` is **wall-clock seconds** (`time.time`), the same clock a process start time is
  read from the OS in, because the whole point of the field is that the two are compared.
- `executable` is the path the launcher resolved, never a bare command name: `npx` would never
  match what the process table reports, so `PATH` is resolved when the record is written.
- `parent_pid` is the spawning process. The parent's own **full** identity is its own record in
  this same file, written by whoever spawned *it* — the helper writes the host's — so the
  orphan check above is a lookup rather than a second copy of three fields that could disagree.
- **Every writer owns only its own records.** The host and the helper both write this file, so
  a change is always a read-modify-write of the one record it names, and the file is replaced
  atomically (`os.replace`) because a half-written run-state file is a list of processes nobody
  dares act on.
- A record this process cannot parse is a **refusal that names the field**, not a record
  silently skipped: the one thing worse than a phantom is a phantom nobody was told about.

### Resource breaches

- The helper samples every managed process on a fixed tick: memory in use, CPU over the window,
  open files, and the number of child processes.
- A breach must last longer than `breach_grace` before the helper acts. A short spike is not a
  breach.
- On a breach it **asks for a polite stop, waits, then force-kills**. The kill is reported through
  telemetry (when telemetry is on) and written to the local log with the numbers that triggered
  it.
- This applies to the **Anytype desktop app too** (D5). A forced kill of Anytype can lose unsaved
  work. The owner accepted that, and the polite stop always comes first.
- A process killed for resources is relaunched only if `restartable` is true, and it counts
  toward the restart breaker.

### The restart breaker

A process that keeps crashing, going stale or breaching limits must not be relaunched forever.
After **N interventions within a window** (5 in 10 minutes by default, configurable), the helper
stops relaunching it, marks it **`quarantined`**, and tells the user. `innytypes helper release
<id>` clears the quarantine. If the host itself is quarantined, the helper stays running so it can
still report the problem, but it stops relaunching the host.

## Core auto-update

### The switch

`auto_check_versions` lives in the **application config file** (`config.toml` in the per-user
config directory resolved by `platformdirs`). It is **on** by default (D12).

- **Off:** the helper makes **no** version-check network request at all, for the core **or for
  any plugin** (D14). Manual `innytypes update check` and `innytypes addons outdated` still work.
- **On:** the helper checks on a schedule: every 24 h, with up to 1 h of random delay so installs
  do not all check at the same moment.
- The helper re-reads the switch **before every check**, so turning it off takes effect without a
  restart.

### What "a release" is

A **release index** (JSON) per channel (`stable` first). Each entry names the version, a download
URL per OS, a **SHA-256 checksum**, and a detached **minisign signature** (D9).

**Where releases are hosted does not matter to their safety** (D10): Hetzner or Scaleway object
storage, a self-hosted Forgejo, GitHub Releases, or any of these behind a CDN. The helper trusts
the **signature**, never the server. The index URL is a build-time setting of each release.

### The update flow

1. **Check.** Fetch the index over HTTPS. Compare against the running version. Only move
   **forward**. A new **host API major version** is **never applied automatically**; it waits for
   an explicit `innytypes update apply` (D13), because plugins target the host API.
2. **Download** to a staging directory. **Verify the checksum and the minisign signature** against
   the public key **shipped inside the currently installed release**. Anything that fails
   verification is deleted and reported. **It is never run and never kept.**
3. **Stage.** A verified release sits in staging, marked ready, and the user is told an update is
   waiting.
4. **Apply at the next restart the user starts** (D11). When the user quits the application, the
   helper stops everything, swaps the installed application **atomically** (the old one is kept as
   `previous`), and exits. On Windows, where a running program's files are locked, a small
   updater step started at quit performs the swap after the helper has exited. The next launch runs
   the new version. **Nothing is ever applied during startup.**
5. **Confirm or roll back.** If the new host does not reach a healthy heartbeat within 2 minutes
   of launch, the helper swaps `previous` back, restarts the application on it, **blocks that
   version**, and reports the rollback.

A release is a complete, **pinned** application bundle for its OS, with its own `uv.lock` and
`package-lock.json`. An update replaces one pinned set with another pinned set. It **never**
re-resolves the host's dependencies on the user's machine. Plan 0001's pinning rule holds across
updates.

Before applying a host update, the helper checks that every installed plugin still supports the
new host's `host_api`. If one does not, the host update waits, or goes together with a plugin
update that restores compatibility. An update that would stop an installed plugin from starting
is never applied silently.

A host update also moves the `innytypes` version installed inside every **plugin environment**
to the new host version (see *Plugin environments*). **The helper updates itself** as part of the
same bundle.

## Plugin updates

### Plugin environments

Each plugin is installed into **its own `uv` environment**, on the same pinned Python as the host
(D17). A plugin environment contains:

- the plugin, at an exact version;
- its dependencies, locked with hashes;
- `innytypes` itself, at **exactly** the version the host is running, so the plugin sees the same
  host API contracts the host enforces.

Because plugins already run as separate processes (plan 0001), nothing requires them to share the
host's interpreter. A plugin update touches only that plugin's environment. A bad dependency in a
plugin can no longer break the host or another plugin.

`innytypes addons install` creates the environment and records the plugin's manifest next to it.
Discovery reads those recorded manifests, so the host finds plugins without importing any of
their code (plan 0001 slice 02).

That install is built on an **injected installer** (`innytypes.addons.install.AddonInstaller`:
create the environment, install into it, read its manifest through the plugin's own
interpreter), and `install_addon` takes the addons root it writes into. Slice 11 builds its
**staged** environments through that same seam rather than a second installer of its own — a
staging root and an installer that locks with hashes — so a staged environment and an
explicitly installed one are the same thing in two places, and what the helper swaps in is
exactly what discovery already knows how to read.

### Where plugin versions come from

A plugin's manifest gains an optional `update` section naming its **source** (D15):

| field | meaning |
|---|---|
| `source` | any source the plugin declares: the owner's plugin index, a package index such as PyPI (with the project name), or a **git URL** |
| `channel` | `stable` by default |

A plugin with no `update` section is never checked. The helper reports it as **not updatable**
instead of guessing a source.

For a **git** source, a new version is a new **release tag**. The helper resolves each tag to its
**commit hash** and locks that hash, **never** a branch or a tag name, because a tag can be moved
to different code later.

For each candidate version, the helper reads the same facts the manifest carries: `version`,
`host_api`, `requires` (exact versions) and `emits` / `subscribes`.

### Update modes: auto or manual

Each plugin has an update **mode**. The global default is **`manual`** (D18), and each plugin can
override it:

| mode | what the helper does |
|---|---|
| `auto` | checks, downloads, locks, and **applies** when the plugin set stays consistent (see below) |
| `manual` | checks and **reports** available updates; nothing is installed until the user runs a command |
| `off` | never checks this plugin |

Config:

```toml
[plugins]
update_mode = "manual"          # the default for every plugin

[plugins.whodunnit]
update_mode = "auto"            # a per-plugin override
```

Commands, all explicit, so they satisfy plan 0001 invariant 6 as written:

- `innytypes addons outdated`: lists the installed version, the newest compatible version, and
  **why** a newer version is not compatible when that is the case
- `innytypes addons update <id>` / `innytypes addons update --all`: applies updates now
- `innytypes addons pin <id>` / `unpin <id>`: holds a plugin at its current version whatever its
  mode is

### Trust

Owner decision D16: **`auto` mode is allowed for any plugin, from any publisher**, including any
third party that decides to publish one. The only check is the **lock**: every artifact is
recorded with its hash, and git sources with their commit hash. So what gets installed is exactly
what was resolved, and it cannot change afterwards.

What this means, stated plainly: the lock proves an installed update is the one that was resolved.
It **does not prove who published it.** An `auto` update installs whatever the plugin's source
publishes next. The protection is that the default mode is `manual` (D18), so `auto` is a choice
made one plugin at a time. Since D17, a bad update can damage only that plugin's own environment,
and it still runs with the user's permissions.

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
5. Every changed plugin environment resolves to a **fully pinned lock** (every transitive
   dependency at an exact version, with hashes). It never contains a floating range.

If updating plugin A would require updating plugin B too, then:

- if both are `auto`, they update **together**;
- if either is `manual`, `off` or pinned, **nothing** updates automatically, and `outdated` shows
  the blocked group and what blocks it.

A set that fails any rule is **not applied**, in any mode. The helper reports it by name, the same
way plan 0001 reports a missing requirement.

### Applying a plugin update

An `auto` update is applied **right away** (D19), because only the affected plugins stop:

1. **Build the new environments** for the changed plugins in staging, and lock them with hashes.
2. **Stop only what is affected.** The helper tells the host to stop the updated plugins **and
   every plugin that depends on them**, in reverse start order. The host, the MCP server, Anytype
   and every unaffected plugin keep running.
3. **Swap** each changed plugin environment **atomically**, keeping `previous`.
4. **Start** the affected plugins again in start order, and wait for each one's healthy
   heartbeat, or for liveness when it has no stability profile.
5. **Confirm or roll back.** Any affected plugin that fails to become healthy rolls back **the
   whole update group**, not just that plugin. The rolled-back versions are blocked, and the
   rollback is reported.

A `manual` update follows the same steps when the user runs `innytypes addons update`.

## Telemetry

### The switch

`telemetry` is a switch **in the application**: in the application's own window and menus (F4),
and `innytypes telemetry on|off|status|show` from the CLI. It is stored in the same config file,
and the helper re-reads it before every send.

- **Off** means **nothing leaves the machine**. Anything already queued is **deleted, not sent
  later**.
- The switch takes effect **immediately**: a send that is waiting in the queue is dropped.
- Turning telemetry off never affects stabilization or updates. The helper keeps protecting and
  updating the application either way.
- `innytypes telemetry show` prints the queued reports **exactly as they would be sent** (D24).

**Before the user has chosen, nothing is sent or queued** (F2). The first launch asks once, with
the privacy notice, and stores the answer.

### The machine id

Owner decision D20: **a deterministic hash for each machine, completely detached from the user's
personal information.**

- **Input:** the operating system's own machine identifier, and nothing else. That is
  `IOPlatformUUID` on macOS, `/etc/machine-id` on Linux, and the `MachineGuid` registry value on
  Windows. **Never** the user name, host name, network hardware address, serial number, or
  anything from the user's account.
- **Hash:** HMAC-SHA256 of that identifier with a fixed key specific to innytypes. The raw
  identifier **never leaves the machine**. The key also means the hash cannot be matched to the
  same machine's identifier in other software.
- **Result:** the same id on every launch, across reinstalls and across telemetry being toggled.
  One machine is counted once.

One legal fact to keep in view: under GDPR, a stable identifier like this is still
**pseudonymous personal data**, even though it carries no name. That is why D25's retention
periods and privacy notice still apply.

### What is sent

| kind | contents |
|---|---|
| **usage** | machine id, innytypes version, OS + version, which plugins are installed with their versions and update modes, start/stop counts, counts of helper interventions by type, update and rollback outcomes |
| **errors** | machine id, exception type, stack trace with **file paths redacted** to package-relative form, the version set, the intervention that followed |

### What is never sent

Anytype content, object or space names, the Anytype API key or any other credential, file
contents, audio or transcripts, environment variable values, full home-directory paths, user
names, host names, and the raw OS machine identifier. Every payload passes through **one
redaction function** before it is queued, and `tests/test_no_secrets.py`-style tests prove that
function removes each forbidden kind. The key rule from plan 0002 carries over: nothing that holds
the key may appear in a `repr` or a log.

### Delivery

- **Errors** go to a self-hosted **GlitchTip** (D21), which speaks the Sentry protocol.
- **Usage** goes to a self-hosted **Umami** (D22, F3), sent as custom events with JSON event data
  through its event API.
- Reports go into a **bounded on-disk queue**. When it is full, the oldest reports are dropped.
  Telemetry must never fill a disk.
- Sends run in the background, with timeouts and backoff. A slow or unreachable server never
  delays any stabilization action.
- Any client library is pinned exactly.
- **Retention on the servers** is fixed at **90 days for errors** and **13 months for usage**. A
  **privacy notice** is shown with the telemetry choice (D25).

## Telling the user

Quarantined processes, rolled-back updates, a staged core update, pending `manual` plugin updates
and blocked plugin sets are shown as **system notifications** (Notification Center on macOS, toast
notifications on Windows, desktop notifications on Linux). `innytypes helper status` always shows
the current state of each (D6). Clicking a notification opens the application's window.

### The application's own controls

Owner decision F4: the controls live **only inside the application**, never in the system tray.

- The application has a **window**, and an entry in the **Dock** (macOS) or **taskbar** (Windows,
  Linux), like any normal application. It adds **no** icon to the macOS menu bar extras, the
  Windows notification area, or the Linux system tray.
- The window shows the **status** of every managed process (running, restarting, quarantined),
  **pending updates** (core and plugins) with an apply button for `manual` ones, the
  **telemetry** switch, the **launch at login** switch, and **Quit InnyTypes**.
- Closing the window **does not quit** the application; it keeps running. Quit is always the
  explicit **Quit InnyTypes** item, and it is never hidden (see *Turning InnyTypes off*).
- Clicking the application icon while the application runs **reopens the window** (the
  single-instance rule).

### Security warnings, for now

Owner decision F5: **no OS code signing for the time being.** The consequences users will see:

- **macOS:** the first open shows a warning that the app is from an unidentified developer. The
  user allows it once in System Settings → Privacy & Security → *Open Anyway*.
- **Windows:** SmartScreen shows *Windows protected your PC*. The user chooses *More info* → *Run
  anyway*.
- **Linux:** no warning of this kind.

Whether the warning appears **again after an automatic update** depends on whether the operating
system marks the swapped bundle as downloaded from the internet. Slice 10 must check this on a real
macOS and Windows machine and record the result in this plan. The install instructions must show
these steps with screenshots, so the warning does not look like malware.

Adding an Apple Developer ID with notarization, and Windows Authenticode signing, later is a change
to slices 07, 10 and 16. It does not change the minisign verification of updates.

## Configuration

Everything the helper reads, in `config.toml`:

| key | default | set from |
|---|---|---|
| `telemetry` | unset: nothing sent or queued until the first-launch question is answered (F2) | the application's window (F4), and `innytypes telemetry on\|off` |
| `launch_at_login` | `false` (F7) | the application's window, and the config file |
| `auto_check_versions` | `true` | the config file |
| `update.channel` | `stable` | the config file |
| `update.check_interval` | 24 h | the config file |
| `update.check_jitter` | up to 1 h | the config file |
| `plugins.update_mode` | `manual` | the config file |
| `plugins.<id>.update_mode` | inherits `plugins.update_mode` | the config file |
| `plugins.<id>.pinned` | `false` | `innytypes addons pin\|unpin` |
| `helper.tick` | 5 s | the config file |
| `helper.restart.max_attempts` / `backoff` | 5 attempts; 1, 2, 4, 8, 16 s | the config file |
| `helper.defaults.*` | the stability profile defaults | the config file |
| `helper.stop_timeout` | 10 s | the config file |
| `helper.breaker.max_interventions` / `window` | 5 in 10 min | the config file |
| `helper.update_health_window` | 2 min | the config file |

### The file, and what reading it refuses (slice 01)

```toml
telemetry = false               # absent entirely = the question has not been answered
launch_at_login = false
auto_check_versions = true

[update]
channel = "stable"
check_interval = 86400
check_jitter = 3600

[plugins]
update_mode = "manual"

[plugins.whodunnit]             # one table per plugin, named by its addon id
update_mode = "auto"
pinned = true

[helper]
tick = 5
stop_timeout = 10
update_health_window = 120

[helper.restart]
max_attempts = 5
backoff = [1, 2, 4, 8, 16]      # the delay before each attempt; the last one repeats

[helper.breaker]
max_interventions = 5
window = 600

[helper.defaults]               # the stability profile defaults, for every managed process
max_rss_mb = 1024
max_cpu_percent = 90
cpu_window = 120
max_open_files = 1024
max_children = 32
breach_grace = 60
```

Three things the slice settled, which the table above states loosely:

- **`check_interval` and `check_jitter` are two keys**, because "every 24 h with up to 1 h of
  delay" is two numbers: a schedule, and the spread that keeps every install from checking at
  the same moment.
- **`helper.defaults.*` is the stability profile minus its heartbeat fields.**
  `heartbeat_interval` and `stale_after` are a plugin's own promise about how often it reports
  progress; a helper-wide value would judge a plugin stale for missing heartbeats it never
  agreed to send. `max_children`, the one limit a manifest leaves to the helper, defaults to
  **32**. The other numbers are the same objects a manifest falls back to, so the two cannot
  drift apart.
- **The telemetry switch is a boolean whose absence is the third state.** `true` is on,
  `false` is off, and no key at all means the first-launch question is unanswered — which
  behaves like off for sending *and* queueing (F2) while staying distinguishable from it, so
  the application knows it still has to ask.

Reading the file **refuses rather than warns**, in line with the manifest (plan 0001), because
this file decides which processes get killed and what leaves the machine:

| situation | what happens |
|---|---|
| **no file** | every documented default, `telemetry` unanswered. The first launch, not an error. Reading creates nothing. |
| **file cannot be read** | refused. Defaulting would answer "did the user turn telemetry off?" with a guess, and the guess would be "no". |
| **invalid TOML, unknown key, wrong type, impossible value** | refused, naming the file, the section, the key and what was expected, so the fix is one line and the CLI prints it instead of a traceback |
| **a write to a file that cannot be read or validated** | refused, and the file is left exactly as it was: rewriting it would silently discard what the user wrote |

`innytypes telemetry on|off` and `innytypes addons pin|unpin` write the file back by
re-serializing the document they read, so every other setting survives — values, not comments.
The helper re-reads the file on **every** access to a switch, so nothing is cached and no
change needs a restart.

Endpoints (the release index and the telemetry servers) are **build-time settings of a release**,
not user config. A user cannot point the core updater at a different server by editing a file. A
plugin's `update.source` comes from its own manifest.

## Security-sensitive parts

These go to the security executor, never to general implementation, and each gets an independent
security review:

- core update signature verification, the shipped public key, and the atomic swap
- plugin environment locking with hashes, and git commit pinning
- killing processes (the identity check that prevents killing an unrelated program)
- the local socket's permissions
- the machine id derivation and telemetry redaction

## The gate stays hermetic

Nothing in `docs/loop/verify.sh` may make a network call, sign with a real key, install a real
package, spawn a real long-running process, read the real machine identifier, or sleep for real
time.

- The **process table** is injected (a fake list of processes with IDs, start times, memory and
  CPU), so stale, phantom, reused-ID and breach cases are plain data in a test.
- The **clock** is injected, so no test sleeps for real backoff.
- The **HTTP transport** is injected (`httpx.MockTransport`) for the release index, plugin
  sources, downloads and telemetry.
- The **installer** is injected, so plugin-set resolution, locking and swap are tested against
  fake plugin manifests with no real `uv` or `git` run.
- The **machine identifier source** is injected.
- Signature tests use a **throwaway key pair generated inside the test**, never a committed
  private key.
- A new runtime dependency (for example `psutil` to read the process table) is pinned with `==`,
  as plan 0001 requires.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | config and switches | `config.toml` loading, `telemetry`, `auto_check_versions`, plugin update modes and pins, `innytypes telemetry on\|off\|status\|show`, live re-read |
| 02 | heartbeat protocol | the heartbeat shape, the local socket, the `stability` manifest section and its defaults, optional plugin health checks |
| 03 | process identity and phantoms | ID + start time + executable identity, the run-state file, orphan cleanup, reused-ID records forgotten and never signalled |
| 04 | stale and resource detection | the sampling tick, stale judgement, breach grace windows, polite-stop-then-kill, Anytype included |
| 05 | restart policy and control channel | N attempts with increasing backoff, the terminal state, the helper's commands to the host (start / stop / restart / kill / list), host exits reported to the helper |
| 06 | restart breaker and quarantine | N-in-window, the quarantine state, `innytypes helper release`, `innytypes helper status` |
| 07 | application launcher and quit | the Briefcase bundle and icon, single-instance lock, helper starts or adopts Anytype and starts the host, the host relaunches a crashed helper but not an externally stopped one, every way of *Turning InnyTypes off* including `innytypes quit --force`, `launch_at_login` |
| 07b | the application's own window | status, pending updates, telemetry and launch-at-login switches, Quit InnyTypes; Dock/taskbar entry and no system-tray icon; first-launch telemetry question with the privacy notice |
| 08 | telemetry pipeline | machine id, redaction, the bounded on-disk queue, background sending to GlitchTip and the usage backend, switch-off purges the queue, the privacy notice |
| 09 | core update check and verified download | the release index, forward-only and host-API-major guard, checksum + minisign verification, staging |
| 10 | core apply and roll back | the swap at quit, the health-confirmed launch, rollback, blocked versions, plugin compatibility check, plugin environments moved to the new host version, self-update |
| 11 | plugin environments | one `uv` environment per plugin, `addons install` into it, recorded manifests for discovery |
| 12 | plugin version check | the `update` manifest section, index / PyPI / git sources, tag → commit pinning, the five consistency rules, `innytypes addons outdated` with blocking reasons |
| 13 | plugin update apply | staged locked environments, stop the affected group, swap, start in order, group rollback, `addons update` / `pin` / `unpin`, `auto` mode |
| 14 | user notification | system notifications for quarantine, rollback, staged updates, pending manual updates and blocked sets |
| 15 | Linux | `.desktop` launcher, Linux process table and machine id, desktop notifications |
| 16 | Windows | Start-menu launcher, Windows process table and `MachineGuid`, the quit-time updater step, toast notifications |

**Order.**

- 01 → 02 → 03 → 04 → 05 → 06 can be built against fakes now. The host side of 05 is plan 0001
  slice 07.
- 07 needs 05, and plan 0001 slice 07. 07b needs 07 and 01.
- 08 needs only 01.
- 09 → 10 need 01, and 10 needs 07 and 11.
- 11 comes together with plan 0001 slices 02 and 08, because discovery and install change with
  it.
- 12 needs 11 and plan 0001 slices 01–03. 13 needs 12 and 05.
- 14 needs 06 and 07b.
- 15 and 16 come after the macOS MVP.

WorkItems for these slices are seeded from this plan when the owner asks for them.

## Decisions

Answered by the owner on 2026-09-17. Each entry gives the question, the answer, and what it
changed in this plan.

### Stabilization

**D1 — Who restarts child processes.** *Answer:* "the helper restarts the process." The helper
owns the single restart policy for every managed process. The host keeps spawning its own
children, because it holds their pipes, but it restarts nothing on its own. Plan 0001 slice 07
changes accordingly.

**D2 — What starts the helper.** *Answer:* "Everything will be started with a clickable
application icon that launches together AnyTypes, InnyTypes, the helper, the mcp, etc..." The
icon launches the helper, and the helper starts Anytype and the host. No login service is
installed. See *How the application starts*.

**D3 — How heartbeats reach the helper.** *Answer:* (a), a per-user local socket owned by the
helper, plus an independent read of the OS process table.

**D4 — What counts as "stale".** *Answer:* as proposed. No heartbeat, or no progress, for
`stale_after` (3 × the heartbeat interval), with an optional plugin-supplied health check.

**D5 — May the helper kill the Anytype desktop app?** *Answer:* (c), treat it like any other
managed process. Polite stop first, forced kill if needed. Unsaved work can be lost on a forced
kill.

**D6 — How the helper tells the user.** *Answer:* as proposed. System notifications plus
`innytypes helper status`.

**D7 — Operating systems.** *Answer:* "C but linux and windows later." macOS, Linux and Windows
are all in scope. The MVP is macOS, and Linux and Windows are slices 15 and 16.

**D8 — Default numbers.** *Answer:* as proposed. Tick 5 s; stale after 3 × heartbeat interval;
1 GB memory; CPU above 90 % for 2 min; 1 024 open files; 60 s breach grace; 10 s polite-stop
timeout; breaker 5 in 10 min; core check every 24 h with up to 1 h jitter; 2 min health window
after an update. All are configurable.

### Core updates

**D9 — Signing tool.** *Answer:* (a), minisign, with a SHA-256 checksum per artifact in a JSON
release index.

**D10 — Where releases are hosted.** *Answer:* "any of these including github (because it is
still the standard)." Hetzner, Scaleway, a self-hosted Forgejo, GitHub Releases, optionally
behind a CDN. The signature makes the host interchangeable.

**D11 — When a core update is applied.** *Answer:* as proposed, at the next restart the user
starts. The swap happens when the user quits the application.

**D12 — Default of `auto_check_versions`.** *Answer:* (a), on.

**D13 — Host API major-version updates.** *Answer:* (a), never automatic; always an explicit
command.

### Plugin updates

**D14 — Does `auto_check_versions` cover plugins?** *Answer:* (a), yes. Off stops every version
check.

**D15 — Where plugin versions come from.** *Answer:* (c), any source a plugin declares, including
git URLs. Git sources are locked to commit hashes.

**D16 — Plugin trust.** *Answer:* "b and any 3d party who decides to publish a plugin." `auto` is
allowed for any plugin from any publisher, and the lock hashes are the only check. What that does
and does not protect is stated under *Trust*.

**D17 — Plugin environment layout.** *Answer:* (b), one `uv` environment per plugin. Plan 0001
changes accordingly.

**D18 — Default plugin update mode.** *Answer:* as proposed, `manual`, with `auto` per plugin.

**D19 — When an `auto` plugin update is applied.** *Answer:* as proposed. With D17 (b), right
away, restarting only the affected plugin group.

### Telemetry

**D20 — Telemetry identity.** *Answer:* "make a deterministic hash for each machine, completely
detached from the user personal information." See *The machine id*.

**D21 — Error-report backend.** *Answer:* (a), self-hosted GlitchTip.

**D22 — Usage backend.** *Answer:* (c), Umami or Plausible (narrowed to Umami by F3), self-hosted, used through their
custom event APIs.

**D23 — The install id.** *Answer:* "see D20." There is no separate install id; the machine id
replaces it.

**D24 — Letting the user see what is sent.** *Answer:* (a), `innytypes telemetry show`.

**D25 — Retention and privacy notice.** *Answer:* (a). 90 days for errors, 13 months for usage,
and a privacy notice shown with the telemetry choice.

### Plan housekeeping

**D26 — Amending plan 0001.** *Answer:* "change plan 0001." Done in the same change as this
approval, together with the one line in plan 0002 that pointed restart policy at plan 0001.

**D27 — Names.** *Answer:* OK. Python package `innytypes.helper`, console script
`innytypes-helper`, launchd-style bundle identifier `it.l1nx.innytypes.helper`, user-facing name
"InnyTypesHelper".

### Follow-up decisions

The answers above raised seven more questions. The owner answered them on 2026-09-17.

**F1 — What restarts the helper if it crashes?** *Answer:* "as proposed but then there has to be a
clear and easy way of turning the whole InnyTypes application off!" The host relaunches the helper
when the helper **crashes**. That is the host's single restart duty. Because the helper and the
host now watch each other, stopping one of them no longer stops the application. A dedicated,
easy **Quit** is added. See *Turning InnyTypes off*.

**F2 — Telemetry before the user has chosen.** *Answer:* as proposed. Nothing is sent **or
queued** until the user answers a one-time question on first launch, shown with the privacy
notice.

**F3 — Umami or Plausible.** *Answer:* Umami, self-hosted, through its event API.

**F4 — Where the switches live in the user interface.** *Answer:* "as proposed but only inside
application tray, not system tray!" Status, pending updates, the telemetry switch and Quit live
**inside the application's own window and menus**. The application puts **no icon in the
operating system's status area**: not the macOS menu bar extras, the Windows notification area, or
the Linux system tray. See *The application's own controls*.

**F5 — How the application bundle is built.** *Answer:* "beeware briefcases with user security
warnings for the time being." BeeWare Briefcase builds the macOS, Windows and Linux bundles.
**No OS code signing for now**, so users see the operating system's warning for an app from an
unidentified developer (see *Security warnings, for now*). Minisign verification of core updates
is unaffected and stays mandatory.

**F6 — Anytype that is already running, and quitting.** *Answer:* as proposed. An Anytype that is
already running is adopted and watched. On quit, Anytype is stopped only if the application
started it.

**F7 — Launch at login.** *Answer:* as proposed. A `launch_at_login` switch, off by default.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees. For the security-sensitive slices, an
independent security review must agree as well.

This plan is done for MVP (slices 01–14 including 07b, macOS) when:

- clicking the app icon starts the helper, Anytype, the host, the MCP server and the plugins, and
  **Quit InnyTypes** stops all of them, with nothing relaunched afterwards
- `innytypes quit`, ending the helper from Activity Monitor, and `innytypes quit --force` on a hung
  application each leave no InnyTypes process running
- a helper that crashes is relaunched by the host
- the application shows no icon in the macOS menu bar extras, and closing its window does not quit
  it
- killing the host with `kill -9` leaves no orphans, and the helper brings the host back within
  the configured window
- a child that exits is restarted by the helper with increasing backoff, and the host never
  restarts it on its own
- a stale plugin and a memory-breaching plugin are each restarted or killed by the helper, and a
  crash-looping one ends quarantined with a notification
- a record whose process ID was reused by another program is never signalled
- `innytypes telemetry off` stops all sends at once and empties the queue, and no report contains
  anything from the *never sent* list
- the machine id is identical across launches and reinstalls, and the raw OS identifier appears in
  no report
- with `auto_check_versions` on, a signed newer release is downloaded, verified, applied at quit
  and confirmed healthy on the next launch, and a deliberately broken release is rolled back
- with `auto_check_versions` off, no version request of any kind is made
- `innytypes addons outdated` shows a newer plugin version and, for a blocked one, the exact
  reason it is blocked
- an `auto` plugin update that requires a second plugin to update updates both together without
  stopping the host, and a group that fails its health check rolls back as a whole
- a plugin update that would break another plugin's exact `requires` or remove a subscribed event
  kind is never applied
