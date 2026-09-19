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
Windows, and a package with a `.desktop` entry on Linux. How they are configured and built is
*Building the bundles* below.

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

**The lock, as slice 07 landed it** (`innytypes.helper.launcher`). The lock file is
`<per-user runtime dir>/innytypes/helper.lock`, beside the run-state file, and it holds **one
run-state record** — the helper's own — rather than a bare process ID. Two consequences follow
from that, and both are the point of it:

- A lock is only obeyed when its holder passes the **same three-fact identity check** as
  everything else this application signals (*Phantom detection*). A lock left behind by a helper
  that was killed, or by a machine that went down, names a process ID that now means nothing or
  means something else, so it is **taken over** rather than obeyed. A stale file must never lock
  a user out of their own application.
- It is created with `O_CREAT | O_EXCL`, so two launches racing cannot both win, and the loser
  is the one that brings the window forward.

**What the helper starts the host with.** `python -m innytypes up`, through
`innytypes/__main__.py`, rather than the `innytypes` console script. The run-state record has to
carry the executable **the operating system will report**, and for a console script that is the
interpreter, not the script — a record naming the script could never be verified, and an
unverifiable record is one nothing will ever signal.

**An Anytype that is not installed degrades, it does not refuse.** The helper records that it
found none, and the host and every plugin still start (plan 0001, *A missing requirement
degrades*).

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

**Three more rules, as slice 07 landed them** (`innytypes.helper.launcher.HelperWatch`), each of
them pointing the same way — when it is not clear, InnyTypes goes **off**:

- An ending **nobody can classify** — no exit code and no signal, because whatever noticed the
  helper had gone could not say how — is treated as *stopped from outside*, not as a crash. Being
  wrong that way costs the user one click on the icon; being wrong the other way costs them an
  application that relaunches itself after they have tried to end it.
- A **recorded quit overrides everything**: during a quit, even a non-zero exit is part of the
  quit, and relaunching then would be the application refusing to close.
- A relaunch is **scheduled on the restart policy's backoff**, not slept through, and it is the
  same policy object the helper uses — same delays, same attempt count, read from the same
  config. When those attempts are exhausted the host **shuts down** rather than running on
  without a helper: an application nothing watches is also an application nothing can quit.

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

**How the quit is recorded, as slice 07 landed it.** In
`<per-user runtime dir>/innytypes/quit.json`, beside the run-state file, because three separate
processes have to agree about it: the helper writes it before it stops anything, the host reads
it before deciding whether a dead helper crashed, and `innytypes quit` writes it from a third
process entirely. An in-memory flag would be invisible to the other two, and that invisibility
*is* the bug it prevents — a deliberate shutdown read as a pile of crashes. Two details follow:

- A quit record that **cannot be parsed still counts as a quit**. Something wrote one, and the
  only safe reading of "a quit was recorded, contents unclear" is that the user wants InnyTypes
  off.
- The record is cleared by the **next start**, not by the quit that wrote it, so it outlives the
  processes it stopped — which is what lets anything noticing their exits read it.

**What the two command-line forms actually do**, and how they differ:

- `innytypes quit` **asks the helper**: it stops the helper politely, waits out `stop_timeout` —
  the helper's chance to run the orderly shutdown itself — and then stops whatever is still
  recorded. On a healthy machine that second pass finds only records the helper has already
  cleaned up, and signals nobody.
- `innytypes quit --force` **asks nobody**: straight down the run-state file, politely first and
  forcibly after, waiting on neither the helper nor the host, because the reason a person types
  it is that one of them is hung.

**No quit, forced or not, stops an Anytype the application only adopted** (F6). The run-state
record says which it is: a process this application started records the helper as its parent,
and an **adopted** one is recorded as its own parent — it had no parent here, it was running
before the helper, and it must outlive it.

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

**The control channel.** It has two halves, and `innytypes.helper.control` is the wire between
them — the one way the helper process and the host process talk to each other.

| direction | shape |
|---|---|
| helper → host | `ChildSupervisor.execute(Command) -> CommandResult`. A `Command` is a `name` (`start`, `stop`, `restart`, `kill`, `restart-group`, `list`), the `child_id` it acts on, and a `group` of ids for `restart-group`. A `CommandResult` carries the children the command left running: the new record for a start or a restart, every live child for a list, none for a stop or a kill. |
| host → helper | the `ExitReporter` callable the host is built with — one call per child exit, carrying the child's id, kind, process ID, exit code, and whether the host itself asked for the stop. |

Both halves are still those two objects, and both are still injected, so the host's side and
the policy above it are proved without a socket. What this channel adds is the crossing, and it
guarantees five things:

- **The helper listens and the host connects**, over one `AF_UNIX` socket in the per-user
  runtime directory (`control.sock`), beside the heartbeat socket and owned by the helper for
  the same reason: the helper outlives every host it starts.
- **Owner-only**, `0o600` inside a `0o700` directory, and the first frame on a connection is a
  `hello` naming the sender's process ID. A peer that is not the host **this helper started** —
  the process in the run-state record the helper wrote — is closed and counted, not obeyed.
- **One duplex connection carries both directions.** Commands go out on it and child exits come
  back on it, in order, so an exit the host reports while carrying out a stop reaches the
  restart policy *before* that stop's answer reaches the caller, and a crash is noticed without
  anything polling the run-state file.
- **Every failure is named and none of them hangs.** No host connected (nothing was sent), a
  connection that dropped (the command may still have been carried out), and a command that was
  not answered inside its deadline — which is the **stale** verdict above, and is the helper's
  to act on. Every command carries a request number so that an answer arriving after the helper
  gave up is dropped rather than handed back as the answer to the next one.
- **The frames are the ones this application already uses**: newline-delimited JSON, as on the
  heartbeat socket and the event transport.

A command naming a child this host does not have is **refused by name**, rather than answered
with silence: a helper and a host that disagree about what is installed is a fact worth an
error, and a refusal crosses the wire as a refusal rather than as silence. A `restart-group` is
refused whole if any member is unknown, because half a group restarted is worse than none of it.

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
| `kind` | `host` \| `mcp` \| `addon` \| `anytype-app` \| `helper` — the run-state file's vocabulary, not a second one (slice 02) |
| `pid` + `started_at` | the process identity (see *Phantom detection*) |
| `version` | what is running |
| `state` | `starting` \| `ready` \| `degraded` \| `stopping` |
| `progress_at` | when it last did real work. A loop that is spinning without progress must not keep refreshing this field. |
| `detail` | optional, small, JSON: queue depths, last error class. **Never content.** "Small" is 1 KiB of encoded JSON, and a `detail` JSON cannot write is refused rather than sent as something else (slice 02). |

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

Slice 02 lands that as a resolved profile per process: the helper fills `max_children` — the one
limit a manifest may leave open — from `[helper.defaults]`, and leaves `heartbeat_interval` and
`stale_after` unset when the plugin promised nothing, so there is **no deadline to miss** however
long the silence runs. A process that has not beaten **yet** has no deadline either; a process
that never starts at all is caught by the process table, not by this. The health check is a
callable the helper asks on each observation, and a check that **raises** is answered *not
healthy*: an addon whose own health check blows up has answered the question.

The same is true of a profile that publishes **limits but no heartbeat promise**: a `stability`
section with neither `heartbeat_interval` nor `stale_after` sets resource limits and nothing else,
and the plugin is never judged stale. There is exactly one rule — *a process has a stale window
only when its profile named one, or named an interval to derive one from* — and the Anytype
desktop app, which publishes nothing at all, falls under it like everything else.

`max_children` is the **only** limit resolved against a helper-wide default at watch time, because
it is the only one a manifest may leave unset. Every other limit in the table above carries the
same default in a manifest as in `[helper.defaults]`, so a profile's value is simply the value in
force. Raising a limit in `[helper.defaults]` therefore changes what processes **without** a
profile are watched against, and does not move a profile that already named that limit.

**How staleness is judged, and on whose clock.** `progress_at` is written against the *sending*
process's clock, so the helper never compares it to its own; it watches the marker for a
**change**. A heartbeat that never arrived and a heartbeat whose marker has not moved are
therefore one condition, measured on the helper's monotonic clock: stale means *this helper has
seen no new progress marker for `stale_after`*. A process is given its full window from the first
tick that sees it, so a slow start is not a hang.

### Transport

The helper must work **while the host is dead**, so heartbeats cannot depend only on the host's
event bus. Managed processes send heartbeats **directly to the helper** over a **local socket**
in the per-user runtime directory, readable by that user only (D3). This is a Unix domain socket
on macOS and Linux, and also on Windows 10 and later, which support them. The helper also reads
the **OS process table** independently, so a process that stops sending heartbeats is still
visible.

The socket is `<per-user runtime dir>/innytypes/heartbeat.sock`, beside the run-state file, and
the helper owns it: it is bound with mode `0600` inside a directory it sets to `0700`, with the
umask tightened around the bind so the socket never exists world-readable even for an instant.
Frames are **newline-delimited JSON**, the encoding the event transport already uses, one
connection per managed process, and the connection carries heartbeats in one direction only.

An existing path is not assumed to be rubbish. A socket **another helper is listening on** is
refused — only one helper owns this channel — a socket **nobody answers** is the leftover of a
helper that died and is replaced, and a path that is **not a socket** is refused untouched,
because deleting a file the helper did not create is not a repair. A frame that is not a
heartbeat is refused by name and counted; the peer keeps its connection, because one bad beat
from a process that is otherwise reporting is a bug to fix in that process, not a reason to stop
hearing from it. A peer that sends 8 KiB with no end of frame in sight is dropped.

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

**How the three facts are compared** (`innytypes.helper.processes` is the reader, the check and
the only way a signal leaves this application).

- The **process ID** is compared exactly, and a record whose ID is below 1 is never even looked
  up: `os.kill(0, …)` signals the sender's own process group — the helper, the host and every
  child at once — and a negative ID signals a group by number. Neither number is ever carried
  to the OS.
- The **start time** is compared **within a tolerance of a couple of seconds**, because the two
  values are not produced by the same act: the OS notes when the process began, and the writer
  of the record reads the wall clock a moment later, once the spawn call has returned. Exact
  equality would match nothing in production, and a check that never matches is a check that
  has quietly stopped existing. The window is safe because a match also requires the executable
  path to be identical.
- **What a writer puts in `started_at` is the start time the OS will report**, as closely as it
  can know it. A spawn reads the wall clock the moment the spawn call returns, which is within
  milliseconds of it. A process the helper **adopts** rather than starts (F6, an Anytype that
  was already running) records the start time the **process table** reports for it, never the
  moment of adoption: a record written "now" for a process that started this morning is a
  record nothing will ever be able to verify.
- The **executable path** is compared **exactly**. The failure mode of a strict comparison here
  is that a record is *forgotten* rather than acted on, never that the wrong process is
  signalled, so strictness costs a missed restart at worst. **The writer is what has to be
  right**: a launcher whose recorded path is not the path the OS reports — a wrapper script such
  as `npx`, whose process image is the Node binary — would write records this check could never
  verify, and an unverifiable record is one nothing will ever signal. So the host records **what
  the OS reports for the process it just spawned**, falling back to the path it launched only
  when the process table will not answer. The comparison is never loosened to accommodate a
  child kind; the record is made true instead.
- A process the OS **will not describe** — another user's, or one that has become a zombie — is
  unverifiable, and unverifiable is treated exactly like gone: the record is forgotten and
  nothing is signalled.
- The **orphan check is a lookup of the parent's own record** whenever the parent has one, so
  the parent's identity is verified in full by the same three comparisons rather than by asking
  whether *something* still holds its number. A parent with no record at all — whoever launched
  the helper — is settled by bare liveness, and that fallback errs towards "not an orphan",
  because being wrong the other way means signalling a process nothing here has verified.

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
  `innytypes.anytype_mcp` for the MCP server, `innytypes.helper` for the helper itself,
  `innytypes.anytype-app` for the Anytype desktop app, and the plugin's id for a plugin. It is
  unique, so a record is replaced rather than duplicated.
- `kind` is `host` | `mcp` | `addon` | `anytype-app` | `helper`. The word for a plugin is
  **`addon`**, which is what plan 0001, the code and every manifest say; this plan's prose uses
  the two interchangeably and the file does not get to.
- **The helper records itself** (slice 07). It is the one process that is neither spawned by the
  host nor by another InnyTypes process, and it is in the file for one reason: `innytypes quit
  --force` has to reach **every** InnyTypes process by its verified identity from a process that
  is neither the helper nor the host, and a helper missing from the file would be the one
  process a forced quit could not reach.
- `parent_pid` also says **who started this process**. A process this application spawned
  records its spawner; a process it **adopted** (the Anytype desktop app, F6) records **itself**,
  because it had no parent here. That convention is what tells a quit which Anytype it may stop,
  and it also makes an adopted application impossible to mistake for one of our orphans.
- `started_at` is **wall-clock seconds** (`time.time`), the same clock a process start time is
  read from the OS in, because the whole point of the field is that the two are compared.
- `executable` is **the image the OS reports for that process**, read once at spawn time, never
  a bare command name. For a direct launch that is the resolved path; for a wrapper such as
  `npx` it is the Node binary the process actually became. When the process table cannot answer,
  the resolved launch path is recorded instead, and such a record simply stays unverifiable —
  which the helper treats as a phantom and never signals.
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

**CPU over the window is computed by the helper, from two totals.** The OS knows only how much CPU
time a process has used in total; a percentage is a rate, and a rate needs two moments. So the tick
samples **cumulative CPU seconds**, and "CPU over `cpu_window`" is the difference between the
newest sample and the oldest one still inside the window, over the time between them. The window in
the profile is therefore measured by the code that owns the window rather than being a number
handed to the process table and hoped for, and `90 % for 2 min` means what it says. Until a second
sample exists, a process's CPU is **unknown** and cannot breach — one tick of blindness at startup,
which is the safe direction.

**The tick stops; it never starts.** A sustained breach is acted on here, in full, through the
identity-checked stop. **Staleness is judged and reported, and nothing is signalled for it** — what
comes back, after how long, and whether the breaker has had enough is the restart policy's single
decision (slices 05 and 06), and a second place that stopped a stale process would be a second
restart policy by another name.

### The restart breaker

A process that keeps crashing, going stale or breaching limits must not be relaunched forever.
After **N interventions within a window** (5 in 10 minutes by default, configurable), the helper
stops relaunching it, marks it **`quarantined`**, and tells the user. `innytypes helper release
<id>` clears the quarantine. If the host itself is quarantined, the helper stays running so it can
still report the problem, but it stops relaunching the host.

### The tick, and the two loops that run it (slice 19)

Everything above decides one thing each, and until this slice **nothing called any of it in the
running application**: the helper took its lock, started Anytype and the host, and then sat in
`while True: time.sleep(tick)` — or, in the windowed path, in the toolkit's loop with nothing
attached to it. `innytypes.helper.supervision` is the pass that runs the policy, and it adds no
policy of its own.

**One pass, in this order**, every `helper.tick` (5 s):

1. **Listen.** Poll the heartbeat socket and the control socket. Beats land in the registry; the
   child exits the host reports come back on the control connection and go straight to
   `Application.child_exited` — the one place an exit is judged, and the one a recorded quit
   already silences.
2. **Sample and judge.** `HealthWatch.tick` re-checks every run-state record's three facts,
   forgets the phantoms without signalling them, samples what is left, and judges staleness and
   resource breaches. A sustained breach is stopped there, politely then forcibly, through the
   identity-checked path: **the tick stops and never starts**.
3. **Act.** A stale process, and a process this pass stopped for a breach, are each an
   **intervention**: the breaker counts it, and when the breaker still allows it the restart
   policy decides when the process comes back. A profile that says `restartable = false` is
   stopped and left stopped. Nothing is counted or decided while a quit is on record.
4. **Issue what is due.** `RestartPolicy.tick` sends the restarts whose backoff has run out.
   Nothing sleeps through a delay, because a helper that is asleep is watching nothing.
5. **Check for an update**, on its schedule — `update.check_interval` apart, the first one
   spread over `update.check_jitter` so every installation does not ask at the same second.
   The switch is read by `update.check_for_update` immediately before the request and nowhere
   else, so `auto_check_versions = false` means the transport is asked for nothing at all.
6. **Tell the user.** The **whole** set of conditions that are true now — every quarantine in
   the quarantine file, and a release waiting in staging — goes to the `Announcer`, which
   records all of them for `innytypes helper status` and posts only what is new.

**The host is the one process the helper both decides about and starts.** Every other restart is
a command the host carries out, and a command telling the host to start itself would have to
reach the process that has gone. So a due restart of `innytypes` is routed to the helper's own
hands (`supervision.HostRestarts`): stop the host if it is still there, stop the orphans it left,
and only then start it — which is the row of the table under *The helper owns every restart*,
assembled from calls that already existed rather than written again. The **helper's own record is
never one of those orphans**: its recorded parent is whoever launched it, a shell or a Finder
that may well have exited, and the one process this must never signal is the one doing the
signalling.

**A pass that goes wrong is a pass, not the end of the helper.** Every step is attempted on its
own, and acting is attempted per process: an unreadable run-state file, a process that vanishes
between the identity check and the sample, a host nothing is connected to, a notifier that
refuses and a release server that is down are each logged, named in what the pass reports, and
followed by the next pass. A supervisor that dies of the first surprise is worse than none,
because the user believes they have one.

**It runs in the windowed application too.** `run_supervision` is the loop an installation with
no toolkit runs; `TogaDesktop.every` schedules the same pass on the toolkit's own event loop,
each run scheduled after the one before it returns. The loop rather than a thread, for the same
reason the signal handlers are the loop's: an application sitting in the operating system's event
loop is running that and nothing else. Drawing does not block a pass and a pass does not block
drawing.

**Where the plugins' profiles come from.** `supervision.PublishedProfiles` reads the `stability`
section of the manifest discovery recorded at install time — no addon code is imported — so a
plugin that promised heartbeats is actually judged against that promise. The host, the MCP server
and the Anytype desktop app publish nothing and are watched under `[helper.defaults]`, which is
what a process with no profile has always meant here.

**What is still a seam, named rather than implied.** The assembled helper **checks** for a core
update and stages a verified one, and it does that only in a build that ships a release signing
key — an unsigned development checkout checks for nothing, which is the same rule as *a build
that ships no public key installs no update*. What a quit does with a staged release, and the
health-confirmed launch that follows it, are still wired to nothing: both hang off
`Application`'s `apply_update` and `confirm_release` seams, and both wait on the real installer
that `UvCoreInstaller` stands in for (slice 10). Until then nothing is swapped in, so there is
never a pending release for a launch to confirm.

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

The split is in the API rather than in a caller's discipline: `update.fetch_release_index` is the
unconditional fetch the manual commands use, and `update.check_for_update` is the **scheduled**
check — it reads the switch itself, immediately before the request, and when the switch is off it
returns having made no request of any kind.

### What "a release" is

A **release index** (JSON) per channel (`stable` first). Each entry names the version, a download
URL per OS, a **SHA-256 checksum**, and a detached **minisign signature** (D9).

**Where releases are hosted does not matter to their safety** (D10): Hetzner or Scaleway object
storage, a self-hosted Forgejo, GitHub Releases, or any of these behind a CDN. The helper trusts
the **signature**, never the server. The index URL is a build-time setting of each release.

**The shape of the index**, as slice 09 landed it (`innytypes.helper.update`):

```json
{
  "channel": "stable",
  "releases": [
    {
      "version": "1.3.0",
      "host_api": 1,
      "artifacts": {
        "macos": {
          "url": "https://releases.example/innytypes-1.3.0-macos.tar.gz",
          "sha256": "<64 lowercase hexadecimal characters>",
          "size": 48234901,
          "signature": "untrusted comment: ...\n<base64>\ntrusted comment: ...\n<base64>\n"
        }
      }
    }
  ]
}
```

- The OS names are `macos`, `windows` and `linux`. A release that ships no artifact for the
  running OS is simply not a candidate on it.
- `host_api` is the host API version (plan 0001) that release was built against.
- `size` is optional; when it is present a download that does not match it exactly is rejected,
  and when it is absent a fixed ceiling applies, so a server that streams forever fills a log
  line rather than a disk.
- The **detached minisign signature is carried inline**, as the four-line text minisign writes.
  It is one fetch fewer, and it costs nothing in safety: the signature covers the **artifact**,
  so an index that has been tampered with cannot produce a valid one.
- The index itself is **not signed**, and nothing in it is trusted. The checksum is an early
  stop for a corrupt download; the *signature* is the trust anchor.
- The parser is strict: an index it cannot account for is refused whole and reported, never
  mined for the entries it happened to understand.
- A **version is `MAJOR.MINOR.PATCH`** and nothing else, so two versions always compare and a
  version can safely be a directory name.

**Everything is fetched over HTTPS, including every redirect hop.** Redirects are followed —
GitHub Releases needs them — but each hop's scheme is checked *before* that request is sent, so
a `Location` dropping to plain HTTP is refused rather than merely distrusted afterwards.

**A build that ships no public key installs no update.** The trusted key is a file inside the
installed release (`innytypes/helper/release-key.pub`). When it is absent, every update is
refused: the alternative to "refuse every update" is "accept an update nobody signed", and a
placeholder key would be worse still, because it would look like a trust anchor while anchoring
nothing.

**Signature verification uses `PyNaCl`** (pinned, like every runtime dependency), which binds
libsodium — the same library minisign itself is built on. The four-line signature *format* is
parsed in `innytypes.helper.minisign`; the Ed25519 verification is not hand-rolled. Both of
minisign's forms are accepted, the legacy `Ed` and the prehashed `ED`, and the **global
signature over the trusted comment is checked** exactly as `minisign -V` checks it.

### The update flow

1. **Check.** Fetch the index over HTTPS. Compare against the running version. Only move
   **forward**. Forward-only is a safety rule and not a convenience: because the index is
   unsigned, the attack it defeats is a *genuine, correctly signed* older release with a known
   hole in it being offered as an update. A release whose `host_api` **differs from the running
   host API** is **never applied automatically**; it waits for an explicit `innytypes update
   apply` (D13), because plugins target the host API. Any difference counts, not only an
   increase — a release that went *back* an API version would break a plugin just as
   thoroughly.
2. **Download** to a staging directory. **Verify the checksum and the minisign signature** against
   the public key **shipped inside the currently installed release**. Anything that fails
   verification is deleted and reported. **It is never run and never kept.** The deletion takes
   the whole staging directory for that version, and it happens for *every* failure, including a
   dropped connection or a disk error — not only for the two verification failures.
3. **Stage.** A verified release sits in staging, marked ready, and the user is told an update is
   waiting. Staging holds `<staging>/<version>/` with the artifact and a `ready.json` marker
   written **last**, after both checks pass, so the marker's presence is the only thing slice 10
   may act on. The marker carries the version, `host_api`, platform, artifact name, checksum,
   **the detached signature**, the time it was staged, and the `automatic` flag from step 1 —
   which is what stops a host API change from applying itself. A successful staging leaves
   **exactly one** release on disk: a staging directory holding two candidates cannot say what
   is waiting.
4. **Apply at the next restart the user starts** (D11). When the user quits the application, the
   helper stops everything, swaps the installed application **atomically** (the old one is kept as
   `previous`), and exits. On Windows, where a running program's files are locked, a small
   updater process started at quit performs the swap after the helper has exited (see *The
   quit-time updater step*). The next launch runs the new version. **Nothing is ever applied
   during startup.**
5. **Confirm or roll back.** If the new host does not reach a healthy heartbeat within
   `helper.update_health_window` (2 minutes) of launch, the helper swaps `previous` back,
   restarts the application on it, **blocks that version**, and reports the rollback.

**Why the marker carries the signature** (slice 10). The verification in step 2 answers "did the
bytes that arrived match the release that was published". What step 4 needs to answer is a
different question — "are the bytes about to become the running application still that release" —
and between the two lie a disk, a reboot and however long the user took to quit. So the apply
re-reads the marker, **re-hashes the artifact and verifies the signature again** against the key
shipped inside the running release, and deletes anything that fails. The checksum alone would not
do: it sits in the marker, which is a local file, and whatever could rewrite the artifact could
rewrite a number beside it. Forging the signature needs the release private key.

**How the swap is laid out** (slice 10, `innytypes.helper.swap`). Three siblings under the
per-user data directory, so every rename stays on one filesystem where `os.replace` is atomic:
`release/current` is the installed application, `release/previous` is the one it replaced, and
`release/.incoming` is where the verified archive is unpacked before it is anything. The swap is
two renames — live to `previous`, incoming to live — and a second rename that fails puts the first
one back. Exactly one `previous` is kept; a chain of them would be a disk leak nobody empties.

An unpacked release must carry a **`release.json`** at its root naming its `version` and
`host_api`, and both must agree with the marker that was just verified, or it is not swapped in.
The signature proves the *archive* is the published one; this proves the archive unpacked into
what that release says it is, rather than into a directory a half-finished extraction left behind.
It is the same rule a plugin environment is held to: a tree that cannot say what it is does not
become the thing that runs.

The quit writes a **`pending-release.json`** note, and its presence is the only reason a launch
does anything but launch. Step 5 reads it, waits for the new host's first healthy beat, and
clears it. "Healthy" is three facts together: the beat comes from the process **this launch**
started, it carries the **new version**, and it says `ready` — so neither a beat left over from
the run before nor an old host that somehow survived the swap can confirm the update that
replaced it.

The confirmation is an **injected seam on the launch**, not a call inside it, because it waits:
up to `helper.update_health_window`, on an injected clock. Whoever wires it must run it off the
path that installs the quit handlers — a helper that spent two minutes inside `start()` would be
two minutes a user could not quit, which is F1 exactly. The supervision loop it belongs beside
has landed (*The tick, and the two loops that run it*), and the seam is still **unwired**, along
with the quit's `apply_update`: both wait on the real core installer, and until something is
swapped in there is no pending release for a launch to confirm.

A rolled-back version is recorded in **`blocked-core-versions.json`**, in the same shape and with
the same refusals as the plugin record (*Applying a plugin update*): an unreadable file stops the
update rather than being read as empty. `update.choose_candidate` consults it, and drops blocked
entries **before** it picks the newest, so one bad release does not hide the good one underneath
it. The block is written **before** anything is renamed back, because of all the steps in a
rollback it is the one whose loss would bring the failed version straight back at the next check.

A release is a complete, **pinned** application bundle for its OS, with its own `uv.lock` and
`package-lock.json`. An update replaces one pinned set with another pinned set. It **never**
re-resolves the host's dependencies on the user's machine. Plan 0001's pinning rule holds across
updates.

Before applying a host update, the helper checks that every installed plugin still supports the
new host's `host_api`. If one does not, the host update waits, or goes together with a plugin
update that restores compatibility. An update that would stop an installed plugin from starting
is never applied silently.

The number compared is the one each plugin **recorded at install time**, read from its recorded
manifest as JSON rather than through `addons.discovery`: that parser refuses a manifest targeting
an API *this* host does not support, and a plugin the running host cannot load is exactly the one
whose number this check has to be able to see. A plugin whose recorded manifest cannot be read at
all does **not** block the update — it cannot start today either, so the update does not stop it
from starting, and one corrupt directory must not hold every future update on the machine. It is
reported as broken by `addons list`, which is where a person goes to fix it.

A host update also moves the `innytypes` version installed inside every **plugin environment**
to the new host version (see *Plugin environments*). **The helper updates itself** as part of the
same bundle.

Both halves are the same operation, because both are environments with the host pinned inside
them: every plugin environment, and then the helper's own (`sys.prefix` — the project's virtual
environment unpackaged, the bundle's environment when packaged). The version is installed from
the `innytypes` wheel **inside the release that was just swapped in** (`set_host_version`), with
`--no-deps`, never from an index: a release is a complete pinned set, and resolving here would
re-resolve a plugin's dependencies on the user's machine. That is the same rule the install obeys
one step earlier — an addon environment's `innytypes` is always a **wheel of the host**, built by
the running host at install time and taken from the release at update time, and never a name an
index was asked to answer (plan 0001, *Where an addon environment's `innytypes` comes from*). An environment that cannot be moved **undoes the whole swap**
and blocks nothing — what failed is an environment on this machine, not the release, and blocking
a good version over a local failure would take it away from the user for good.

The swap runs inside the quit (`launcher.Application.quit`), after the last child has been stopped
and before the helper ends: the files being replaced are the ones the host, the MCP server and the
plugins were running out of a moment ago, and the helper is the last process left to replace them.
An update that fails there is reported and never raised — turning the application off is the one
thing that must always work (F1). `innytypes quit --force` applies nothing at all, which is
correct rather than an omission: a forced quit is what a person types when something is hung.

### The quit-time updater step (Windows, slice 16)

Everything above is true on Windows too, except **who** performs the two renames and **when**.
A running program's files are locked there, so the helper cannot rename the directory it is
executing out of — and the helper does execute out of it, because a host update moves the
helper's own environment as part of the same bundle. So on Windows the quit does everything up
to the renames and then hands them over:

- The helper **checks everything first**: the blocked record, the `automatic` flag, the
  checksum, the signature, and plugin compatibility. A release that should not be installed
  never causes a process to be started at all.
- It then writes a **plan file** naming the staging directory, the release roots, the addons
  root, the helper's environment, the public key, the platform, whether this was a requested
  apply, and the helper's own **three identity facts**. The plan is read out of the applier
  rather than re-derived, so the updater cannot swap something other than what this quit
  decided to swap.
- It **starts the updater detached** — its own process group, breaking away from the console —
  so the updater outlives the quit that started it, and the helper exits.
- The updater **waits until the helper is confirmed gone**, comparing the same process ID,
  start time and executable path that *Phantom detection* compares, with the same tolerance. It
  is not bare liveness: Windows may hand the helper's process ID to another program the moment
  it exits, and reading that as "still running" is how an update quietly stops arriving on a
  busy machine. A process ID that now describes a different program means our helper has gone.
- **Only then** does it perform the swap — the same `apply_at_quit`, in a process with no
  handoff, so there is one implementation of the swap and not two. A helper that never goes
  gets no swap at all: the release stays staged, marked ready, and the next quit offers it
  again. That is a delay; swapping under a running process is a half-updated installation.
- An updater that cannot be written a plan, or cannot be started, leaves the release staged and
  **fails no quit** (F1).

The one piece that belongs to packaging rather than to this module: the updater must run from
an interpreter **outside** the release tree, because a process running out of `release\current`
holds open the very files the swap renames. The command is therefore a required argument with
no default — there must be no way to reach a wrong one by forgetting it — and the staged copy
it points at is installed beside the application by the Briefcase bundle (F5).

## Plugin updates

### Plugin environments

Each plugin is installed into **its own `uv` environment**, on the same pinned Python as the host
(D17). A plugin environment contains:

- the plugin, at an exact version;
- its dependencies, locked with hashes;
- `innytypes` itself, at **exactly** the version the host is running, so the plugin sees the same
  host API contracts the host enforces — and **nothing else of ours**: `innytypes` declares no
  mandatory dependency, so a plugin environment carries none of the host's libraries and a
  plugin pins whatever it likes. See plan 0001, *What an addon environment contains*, for the
  install that failed before that was true.

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

**How the lock is represented and enforced.** There is **one** installer, not two:
`UvInstaller` locks with hashes, so an environment built by `innytypes addons install` and one
staged by the helper are locked the same way. It runs two `uv` commands, and the order is the
contract:

1. `uv pip compile --generate-hashes` resolves the plugin's pin and this host's own
   `innytypes` to every transitive dependency, pinned, with hashes. The host is named as the
   **wheel it built of itself** — `innytypes @ file://<wheel>` — never as `innytypes==<version>`
   for an index to answer: nothing publishes this project, and an index that did would serve an
   `innytypes` other than the one running. Where that wheel comes from, what happens when the
   host cannot build one, and why it is not cached are in plan 0001, *Where an addon
   environment's `innytypes` comes from*.
2. That output is **judged** by `innytypes.addons.lock` before anything is installed: every
   entry an exact `name==version` or a `file://` artifact, every entry carrying at least one
   `sha256:` hash, no entry named twice, the plugin present at exactly the version asked for and
   `innytypes` taken from exactly the wheel the host built. A lock breaking any rule refuses the
   install. The "named twice" rule is also what stops a plugin that declares `innytypes` among
   its own dependencies from ending up with two of them.
3. The judged lock is **re-emitted** and recorded as `lock.txt`, beside the `manifest.json`
   discovery reads, and `uv pip install --require-hashes --no-deps --requirement lock.txt`
   installs from that file and nothing else. `--require-hashes` is what makes an artifact whose
   digest is not the locked one a refused install rather than a silent substitution — the only
   check D16 leaves standing. `--no-deps` is what stops anything outside the lock arriving
   beside it.

Every plugin directory therefore records two files: the manifest the host reads to start the
plugin, and the lock the environment was built from.

**Staging, the swap and the way back** (`innytypes.helper.environments`). Three roots sit side
by side under the per-user data directory — `addons/` (live, the one discovery reads),
`staging/` and `previous/` — so a swap is a rename within one filesystem, and so a half-built
environment is never inside the directory discovery enumerates. `swap_in` renames the live
environment into `previous/` and the staged one into its place, refusing first any staged
directory that does not record both a manifest and a lock; `roll_back` is the same two renames
reversed, and refuses when nothing was kept. Only one `previous` is kept per plugin: the
environment the last swap replaced.

These are **primitives for one plugin**. Deciding which plugins form an update group, stopping
them, starting them again and judging their health is slices 12 and 13; nothing in this module
starts or stops a process.

### Where plugin versions come from

A plugin's manifest gains an optional `update` section naming its **source** (D15):

| field | meaning |
|---|---|
| `source` | any source the plugin declares: the owner's plugin index, a package index such as PyPI (with the project name), or a **git URL** |
| `channel` | `stable` by default |

A plugin with no `update` section is never checked. The helper reports it as **not updatable**
instead of guessing a source.

The source **names its kind with a prefix** rather than leaving the helper to infer one from
the shape of a URL — "that looks like a git URL" is a guess, and the helper downloading code on
a guess is what this whole section exists to prevent:

| `source` | kind | where candidates come from |
|---|---|---|
| `index` | the owner's plugin index, entry named after the plugin | `<index>/<name>.json` |
| `index:<name>` | the same index, under another entry name | `<index>/<name>.json` |
| `pypi:<project>` | a package index, by project name | `<index>/pypi/<project>/json` |
| `git+<url>` | a git repository | `git ls-remote --tags <url>` |

Each kind has to end at a **manifest**, because the five rules below are decided from manifest
facts and a check downloads nothing:

- The **plugin index** serves one JSON document per plugin — `{"versions": [{"channel": …,
  "manifest": {…}}, …]}` — so a whole check of one plugin is one request. `channel` defaults to
  `stable`, and an entry in another channel than the plugin asked for is skipped.
- A **package index** serves distributions, not addon manifests, so the release points at its
  own manifest through the `project_urls` label **`innytypes-addon-manifest`**. A release that
  names no manifest, whose files are all gone, or whose every file is yanked, is not a
  candidate. On the `stable` channel a pre-release version is skipped.
- A **git** repository keeps its manifest at **`innytypes-addon.json`** in the repository root,
  read at the release tag from a shallow clone.

A version whose manifest **disagrees with the version the source filed it under** is not
offered at all: neither number can then be trusted to name what would be installed.

For a **git** source, a new version is a new **release tag**. The helper resolves each tag to its
**commit hash** and locks that hash, **never** a branch or a tag name, because a tag can be moved
to different code later. Two details make that safe rather than merely intended:

1. For an **annotated** tag, `ls-remote` prints the tag object first and the commit it points at
   on a second, *peeled* line. The peeled commit is what is taken; the tag object is a name.
2. The clone the manifest is read from has its own `HEAD` checked against the commit the listing
   gave. A tag moved **between the two commands** is refused, not quietly taken.

The commit is then what the lock records, as a direct reference — `<name> @ git+<url>@<40 hex
characters>` — and `innytypes.addons.lock` refuses anything weaker there: a branch, a tag, a
short hash or a bare URL all mean "whatever that name points at when the install runs".

For each candidate version, the helper reads the same facts the manifest carries: `version`,
`host_api`, `requires` (exact versions) and `emits` / `subscribes`.

A source that cannot be read — an index that is down, a document that is not JSON, a manifest
that is refused, a `git` command that fails — fails **that plugin only**. Its line says so and
every other plugin is still checked.

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

- `innytypes addons outdated`: lists, per plugin, the **installed** version, the **newest
  compatible** version — what the judged set would leave it running — and, whenever the newest
  version the source *published* is not the one being taken, that version and the **numbered
  rule** that stands in the way. Three numbers rather than two, because "nothing newer exists"
  and "something newer exists that no rule will let through" are opposite facts. With
  `auto_check_versions` off it says so in one line instead of printing versions nothing asked
  about.
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

Rule 4 asks two questions, and only one of them a user can answer. When the user runs `innytypes
addons update <id>` or `--all`, the plugins **named in that request** are past the question about
their update *mode* — `manual` means "nothing updates this on its own" (D18), and a person typing
the command is the opposite of on its own. They are never past the **pin**: a pin holds a plugin
at its installed version whatever its mode says, `--all` leaves a pinned plugin out of the request
entirely, and naming one is refused until it is unpinned.

**How the newest *compatible* version is found.** The helper proposes every checkable plugin at
its newest candidate and judges the whole set. When a rule breaks, **one** plugin steps down to
its next-oldest candidate and the set is judged again, until a set holds or the plugin is back
at its installed version. One at a time on purpose: a rule-2 violation names two plugins and
moving *either* of them can satisfy it, so stepping both at once walks past the set that would
have held. Each violation lists the plugin most likely to resolve it first — for rule 2 that is
the plugin the requirement names, because the requirement names a version of it. The reason a
plugin is **first** pushed off its newest version is the reason reported: later rounds are
consequences of that one.

If a broken rule names nothing that can step back — an installed plugin this host no longer
supports, which only a host downgrade produces — then **nothing moves at all**, rather than a
set nobody judged acceptable being applied in part.

**Rule 1 is decided when a source answers**, before any set is proposed, because a manifest
declaring an unsupported `host_api` is refused outright by the manifest parser and a refusal
carries no rule with it. A version refused that way is still **reported**, with the rule: a
plugin whose publisher has released a version needing a newer host must not read as "up to
date". The same rule is asked again over a whole set, so a set arriving from anywhere — slice
13 re-judging what it is about to install — is judged against all five.

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

**What slice 13 settled, beyond the five steps above** (`innytypes.helper.rollout`):

- **The stop and the start are two commands, not `restart-group`.** The swap goes between them,
  and a command that stops and starts in one step leaves nowhere to put it. `restart-group` stays
  the right command for restarting a group whose environments do **not** change.
- **"Affected" is whatever starts after a changed plugin**, read from the one definition of that
  this project has — `innytypes.addons.resolution.dependency_edges`, the edges the start order is
  built from. That is what a plugin `requires`, and what **subscribes** to the kinds it publishes:
  a subscriber is started after its publisher for a reason, and the reason does not stop applying
  when the publisher is replaced mid-session. Nothing else is named in a command.
- **The group is what the host is currently running.** A changed plugin that is installed but not
  started has its environment swapped like any other, and is neither stopped nor confirmed —
  there is no process to ask.
- **"Healthy" is whatever the plugin promised** (the same rule the health watch uses). Liveness
  for every plugin: the host started it and still lists it at that same process ID. A plugin whose
  `stability` section names a `heartbeat_interval` additionally needs a `ready` beat **from that
  same process** — a beat left over from the process the update just stopped confirms nothing. The
  whole group shares one deadline, `helper.update_health_window` (2 minutes by default).
- **Blocked versions are a file**, `blocked-plugin-versions.json` beside the addons root, read
  **before anything is built**: a rolled-back version costs one rollback, not one rollback per
  check. A record that cannot be read refuses the update by name rather than reading as empty.
- **Everything before the first stop is free.** A build that fails, a staged environment that
  records no lock, a blocked version, or a set that breaks a rule stops the update with nothing
  stopped and nothing swapped. A failure the helper meets after the swap rolls the group back; a
  failure that is the *channel* rather than the release — a host that will not stop the group —
  starts what it stopped again and blocks no version.
- **The set is judged again here, against all five rules**, before anything is built. That is what
  makes rule 4 true of applying as well as of checking: a group in which one plugin is `manual`,
  `off` or pinned is not applied automatically, however the set was assembled.
- **Naming a plugin is what `manual` waits for.** `innytypes addons update <id>` and `--all` pass
  the plugins the user asked for to the check and to the apply, and rule 4 stops asking those
  about their update *mode*. It never relaxes the **pin**: `--all` leaves a pinned plugin out of
  the request, and naming a pinned plugin is refused with the `unpin` command to run first.
- **`addons update` needs the running application.** It stops and starts plugins, and only the
  host owns its children (plan 0001, invariant 9). The control channel is the helper's own
  socket and a `uv` command in a terminal is not the helper, so `innytypes addons update` still
  says that in one line and applies nothing; the window's plugin page, which runs *in* the
  helper, holds the channel and applies through it.
- **A git-sourced plugin is installed from its commit.** `install_addon` takes the requirement
  *text* the installer is handed when it differs from the requirement — the direct reference
  `<name> @ git+<url>@<commit>` that `Candidate.requirement_text` produces — while the requirement
  still names the version the staged manifest must report. `EnvironmentLock.must_contain` accepts
  that spelling and checks the **commit** through `must_pin`, so a git update is locked to code
  rather than to a tag.

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

### What slice 08 sharpened

Building the pipeline settled a set of questions the section above left open. Each one is
narrower than what it replaces, never wider:

- **An exception's *message* is never sent.** *What is sent* lists an error report as the
  exception type, the redacted stack trace, the version set and the intervention — and a
  message is none of those. It is also the one part of an exception that routinely carries a
  file name, an object title or a credential a caller formatted into it, so the Sentry event's
  `value` field is deliberately empty.
- **A file path that cannot be attributed to a package is removed, not shortened**, and a
  stack frame in such a file is dropped whole. "Package-relative" is recognised from
  `site-packages/`, `dist-packages/`, the interpreter's own library directory, and
  `/src/innytypes/` for a source checkout — a bare `/src/` is not enough, because
  `/Users/someone/src/private-notes/` matches it too. The source line of a frame is never
  included: a source line is file contents.
- **The HMAC key is not a secret.** It ships in every copy, and its job is domain separation
  only: our hash of a machine's identifier cannot be matched against another program's hash of
  the same identifier. It is spelled as a label rather than as random bytes so that is obvious.
- **The machine id is derived lazily, inside the switch check.** While the first-launch
  question is unanswered the identifier source is never called at all, so F2 covers reading the
  machine identifier and not only sending it.
- **`unset` purges the queue too.** The switch section says `off` deletes what is queued; F2
  says nothing may be queued before the question is answered, so both non-`on` states empty the
  queue the moment they are read — including anything an earlier `on` left behind.
- **The queue is bounded twice**, by report count and by total bytes, and both limits drop the
  **oldest**. The newest report is never the one dropped. The queue directory is `0o700`: a
  queued report carries the machine id, which is pseudonymous personal data.
- **A telemetry endpoint must be `https`, and a build with no endpoint queues nothing.** There
  is nowhere for such a report to go and no later moment when there will be, so queueing it
  would only rotate files on the user's disk.
- **Umami is told a fixed, reserved host name** (`helper.innytypes.invalid`). Its event API
  wants one and the machine's own is on the *never sent* list, so every install sends the same
  value and the field carries no information.
- **The machine identifier source covers macOS and Linux.** `IOPlatformUUID` and
  `/etc/machine-id`; Windows (`MachineGuid`) lands with slice 16, and until then the source
  refuses by name rather than falling back to a host name or a hardware address, which is what
  D20 forbids.
- **The machine identifier source is macOS and Windows; Linux lands with slice 15.** macOS's
  `IOPlatformUUID` comes out of `ioreg` and Windows's `MachineGuid` out of the registry, each
  through its own injected seam — a command runner and a registry reader — because they are
  different acts and the gate must be able to prove both on a machine that is neither. The
  registry value is read from `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography` with
  `KEY_WOW64_64KEY`, which is not optional: a 32-bit process is otherwise redirected to the
  `WOW6432Node` copy of the key, which holds a **different** GUID, and the same machine would
  then count as two. An **empty** value is a miss rather than an answer, on both platforms.
  Where a platform has no source yet the code refuses by name rather than falling back to a
  host name or a hardware address, which is what D20 forbids.

## Telling the user

Quarantined processes, rolled-back updates, a staged core update, pending `manual` plugin updates
and blocked plugin sets are shown as **system notifications** (Notification Center on macOS, toast
notifications on Windows, desktop notifications on Linux). `innytypes helper status` always shows
the current state of each (D6). Clicking a notification opens the application's window.

Slice 14 landed this as `innytypes.helper.notification`, and settled five things the sentence
above leaves open.

- **A notice is a condition, not an event.** The five kinds — `process-quarantined`,
  `update-rolled-back`, `update-staged`, `plugin-update-pending`, `plugin-set-blocked` — each say
  what is true right now, and carry the sentence saying why from whichever module made the
  decision. One function, `compose`, turns a notice into the title and body a person reads, and
  it is the only place any of those words are written: the notification and the `status` line
  are the same sentence by construction rather than by care.
- **The deduplication rule is a notification per change of state, never per tick.** The helper
  ticks for as long as the machine is on, so `Announcer` is handed the **whole** set of
  conditions that are true now and posts only what was not true last time. A condition that goes
  away and comes back is told again; a condition whose wording changes is told again, because a
  different sentence is a different thing to say. A quarantined plugin is announced once.
- **`status` never depends on a notification having been shown.** `Announcer` writes the whole
  current set to a notices file in the per-user runtime directory on every tick — whether or not
  anything was posted — and `innytypes helper status` reads that file. A notification that was
  missed, dismissed, or never posted because this platform has no notifier yet changes nothing
  about what `status` says. The file is runtime state, beside the run-state and quarantine files,
  so a reboot clearing it is correct: the next helper re-derives every condition.
- **On macOS the text is passed to `osascript` as data, never built into the script.** The
  obvious spelling — `osascript -e f'display notification "{reason}"'` — compiles a program out
  of a string holding a quarantine reason, a plugin id and a version, any of which can carry a
  quote that closes the string and starts AppleScript. Instead the script is a **constant** with
  `on run argv`, fed on standard input, and the title and body are arguments after it. There is
  no shell and no command line for anything to be quoted into. The cost is that a notification
  posted this way belongs to `osascript`, so macOS reports nothing back when it is clicked:
  delivering a real click needs the bundled application's own `UNUserNotificationCenter`
  delegate, which arrives with packaging (F5). The click seam is an injected callable held by
  the notifier, so that path has somewhere to arrive without changing the module's shape.
- **Windows raises a toast through PowerShell, and its text is also never in the script.** The
  same argument as macOS's, answered differently because PowerShell has no `argv` for a script
  read from standard input. The script is a **constant**; the title, the body and the
  application id travel in the **environment**, where `$env:NAME` is a variable read and never
  source text; and they are put into the toast's XML with `CreateTextNode`, a DOM call that
  escapes what it is given, rather than by building the document out of strings. The toast is
  raised under this application's **AppUserModelID**, which is the same reverse-DNS identifier
  that names the macOS bundle and the Linux `.desktop` entry, and which the Start-menu shortcut
  carries — Windows resolves an id by finding a shortcut for it, and a toast raised under an id
  no shortcut carries is silently dropped. Clicks have the same honest gap macOS has: the toast
  belongs to PowerShell's invocation, so the click seam waits for the bundled application (F5).
- **Linux is a named seam that refuses.** `notifier_for` raises for it, naming slice 15. A
  notifier that accepted a message and dropped it would let every acceptance criterion in that
  slice pass on a machine that shows the user nothing.

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

### What slice 07b sharpened

Building the window settled a set of questions the section above left open. Each one is
narrower than what it replaces, never wider.

**What landed, and what did not.** The slice landed the window's **contents and behaviour** —
`innytypes.helper.window`: what is shown, what each control does, and the rules above as
testable objects. It did **not** land the drawing. `Desktop` is the seam through which the
window reaches the operating system, and the only implementation is `HeadlessDesktop`, which
records what it was asked to show and renders nothing. A toolkit-backed one belongs with the
BeeWare Briefcase bundle (F5) that slice 07 also left unbuilt, because a Dock entry and a
window are things an *installed application* has. So the window model is real and proved; the
pixels are not built.

- **The rule against a system tray is built as a capability that is declined.** `Desktop`
  offers `add_status_item` — the macOS menu bar extra, the Windows notification-area icon, the
  Linux tray item — precisely so that never calling it is something a test asserts rather than
  something a reader takes on trust. Nothing in `innytypes` calls it, and the gate proves that
  twice: against a recording desktop, and by reading the whole source tree for the names a
  real tray implementation would have to use (`NSStatusBar`, `Shell_NotifyIcon`,
  `StatusNotifierItem`, and the rest). The second check is what makes the rule hold for slices
  that have not been written yet.
- **A dismissed question is not a "no".** Closing the first-launch dialog without answering
  leaves the switch **unanswered**, so it is asked again on the next launch. Reading a
  dismissal as a refusal would invent a decision the user did not make, and F2's rule already
  covers the interval: nothing is sent or queued while the question stands.
- **The telemetry switch in the window answers the same question the dialog does.** There is
  one stored answer and one way to write it, so a user who dismissed the dialog and then used
  the switch has answered it just as properly.
- **The launch-at-login switch refuses visibly.** On an installation with no bundle the
  operating system cannot be asked for a login item (F7, `UnpackagedLoginItem`), so the switch
  **stays where it was** and the window prints the reason underneath it. A switch that moved on
  screen while the machine did nothing is the one outcome worse than refusing, because the user
  would have no way to tell.
- **The window lists what is waiting, not everything installed.** `innytypes addons outdated`
  is the one that prints a line per plugin. A plugin with nothing pending has no row. A
  **blocked** update does have one — with the consistency rule that stands in the way and no
  Apply — because a version that is being held back is something the user needs told.
- **An Apply control means "this only happens if you press it".** A `manual`-mode plugin and a
  core release that may not apply itself (D13) get one. An `auto` plugin update and an
  automatic core release are shown **without** one and say what will happen instead, and asking
  the window to apply one of those is refused rather than obeyed: the mode is the user's
  setting, and the window does not overrule it.
- **Quit InnyTypes is in every set of contents the window can produce**, including the emptiest
  one. F1 asks for a clear and easy way of turning the application off, and a control that
  disappears when there is nothing else to show is not that.

### Building the bundles (slice 17)

The bundles are **Briefcase's** (F5), configured in `[tool.briefcase]` in `pyproject.toml`.
Briefcase is a development dependency with an upper bound; nothing at runtime imports it.

```
uv sync --frozen                       # once, to get the tooling
uv run briefcase dev                   # run it unpackaged, from a clean checkout
uv run briefcase create <platform>     # scaffold the bundle (once per platform)
uv run briefcase update <platform>     # push code changes into an existing bundle
uv run briefcase build <platform>      # build the clickable application
uv run briefcase run   <platform>      # start the built application, streaming its log
uv run briefcase package <platform>    # the installer: .dmg, .msi, a Linux package
```

`<platform>` is `macOS`, `windows` or `linux`. `build/`, `dist/` and `logs/` are its output and
`.briefcase/` its cache; none of the four is committed, and the gate never builds a bundle.

**Which platforms can be built from where** — this was measured, and it is not the flat "each
platform builds on itself" this section used to say:

| target | from macOS | what was seen |
|---|---|---|
| **macOS** | yes | `InnyTypes.app`, built and run |
| **Linux** | **yes**, in a container | a real `.deb`, built from this Mac — see below |
| **Windows** | **no** | `briefcase create windows` exits with *"Windows applications can only be built on Windows"* and does nothing else |

**Windows needs a Windows machine, and that is the whole answer.** Briefcase's Windows backend
builds a stub `.exe` and an MSI with WiX against Windows itself; there is no container and no
cross-compile, and the refusal above is Briefcase's own, before any work starts. The real path
is a Windows machine or a Windows CI runner, and nothing in this repository can shorten it.
This is a property of the platform, not an oversight to be reopened.

**Linux is different, because Briefcase builds it in a container.** The Linux backend does not
link against the host at all: it builds inside an image of the *target distribution*, so a Mac
can produce a Linux package as long as it has a container engine. What it looks for is a binary
called `docker`, and a `docker` that is really **podman** is enough — the whole build was done
that way, with a two-line shim on `PATH`:

```sh
printf '#!/bin/sh\nexec /opt/homebrew/bin/podman "$@"\n' > ~/bin/docker && chmod +x ~/bin/docker
uv run briefcase create  linux system --target debian:trixie
uv run briefcase build   linux system --target debian:trixie
uv run briefcase package linux system --target debian:trixie --adhoc-sign
```

Podman served every call Briefcase made — `info`, `buildx version`, `images`, `pull`, a
host-write test, `buildx build`, and the `run --volume` invocations that do the work — with no
change beyond the name. Three things had to be right, and each was found by the build failing:

- **The target distribution must ship Python 3.13**, because `requires-python` is `==3.13.*` and
  a `linux system` package uses the distribution's own Python. `ubuntu:jammy` (3.10) is refused
  by Briefcase itself; **`debian:trixie` (3.13) works**.
- **The toolkit's C extensions are compiled in the container**, so cairo's and GObject
  introspection's headers have to be there. That is what
  `[tool.briefcase.app.helper.linux.system.debian]` `system_requires` is for; without it the
  build stops at `error: metadata-generation-failed` for `pycairo`. `system_runtime_requires`
  is the other half: what the finished `.deb` depends on, so an installed application finds GTK.
- **`--adhoc-sign`**, or `briefcase package` stops to ask which GPG identity to sign with.

**What it produced:** `dist/helper_0.1.0-1~debian-trixie_arm64.deb`, 2.1 MB, carrying
`/usr/bin/helper`, `/usr/share/applications/it.l1nx.innytypes.helper.desktop` — D27's identifier,
the same string the notifications and the window class use — and the icon at every
`hicolor` size, and declaring `libcairo2, libgirepository-1.0-1, gir1.2-gtk-3.0,
libcanberra-gtk3-module` as its dependencies.

**Two things stand between that and a Linux package built from a clean checkout**, and both are
the owner's to write rather than a packaging problem:

- **A licence file**, named in `license-files` in `[project]`. Briefcase refuses to build a
  Linux package without one, because Debian requires a `copyright` file. The repository has no
  licence file; the build above was proved with a placeholder that was **not** committed.
- **A changelog** — `CHANGELOG`, `HISTORY`, `NEWS` or `RELEASES`, with or without an extension —
  in the same directory as `pyproject.toml`, for the same reason. Also proved with a placeholder
  that was not committed.

Two smaller things are worth knowing before a Linux package is ever published: the package is
named **`helper`** (Briefcase names it after the application, which D27's identifier forces to
be `helper`), and its maintainer field reads `Martin Teller <None>` because `[tool.briefcase]`
declares no `author_email`.

Three values in that configuration are load-bearing, and `tests/test_bundle.py` holds each of
them against the tree rather than against a remembered string:

- **The bundle identifier is D27's**, `it.l1nx.innytypes.helper`. Briefcase forms it from
  `bundle` plus the application's name, so the application is named `helper` under the prefix
  `it.l1nx.innytypes`. The same string is the Linux `.desktop` file's name and window class,
  the `desktop-entry` hint on every Linux notification and the Windows AppUserModelID; it is
  spelled once, in `innytypes.helper.config.BUNDLE_IDENTIFIER`, and the three platform modules
  and the test all read it from there.
- **The entry point is the one the console script names.** Briefcase starts a bundle with
  `python -m <application name>`, so `src/helper/` is the package it runs; its `__main__` holds
  no behaviour and calls `innytypes.helper.launcher.run_bundled`, whose default role is the
  very function `innytypes-helper` names. A renamed entry point would otherwise leave a bundle
  that builds, installs, opens and does nothing.
- **The bundle's `requires` is the package's own pinned dependency list**, plus the window
  toolkit. A bundle shipping a different set of versions would be a second answer to what
  InnyTypes runs on, and the one nobody tests against.

**The icon** is `src/innytypes/resources/innytypes.*`: a white arrow pointing downwards on a
black background, as the owner asked for. It is drawn by `tools/make_icon.py` — standard
library only, no image library anywhere — which writes the 1024px source PNG, the per-size PNGs
a Linux package installs, the Windows `.ico` and the macOS `.icns`. All of them are committed,
so the gate opens and checks the real images (square, black corners, white down the centre,
nothing transparent, and the point at the **bottom**) without installing anything, and a check
that the committed files are exactly what the committed script draws keeps the two from
drifting.

**What a bundle starts the host with.** An installed bundle has no Python executable: Briefcase
ships the interpreter as a framework (macOS) or a library (Windows) and exactly one executable,
the application's own launcher. So `python -m innytypes up` cannot be spelled there, and the
helper starts a second copy of **itself** with `--innytypes-host` instead
(`innytypes.helper.launcher.run_bundled`). The run-state record is as verifiable as before — it
carries the launcher's path, which is what the OS reports for that process — and the helper and
the host are still two processes. An unpackaged installation is unchanged and still runs
`python -m innytypes up`.

**What the drawing needed.** `innytypes.helper.toolkit.TogaDesktop` is the toolkit-backed
`Desktop` that slice 07b left to this slice, built on **Toga** because Briefcase already is the
packaging and Toga is the toolkit its bundles carry. It is **not** a dependency of `innytypes`:
nothing imports it at module level, `load_toolkit()` answers `None` when it is absent, and an
unpackaged run falls back to `HeadlessDesktop` and is still an application that quits. Toga is
declared in the Briefcase `requires` alone — pinned with `==`, because inside a bundle it is
runtime. It registers **no** status item and refuses to (F4), and the whole-source scan that
forbids the tray APIs covers it like everything else.

### Security warnings, for now

Owner decision F5: **no OS code signing for the time being.** The consequences users will see:

- **macOS:** the first open shows a warning that the app is from an unidentified developer. The
  user allows it once in System Settings → Privacy & Security → *Open Anyway*.
- **Windows:** SmartScreen shows *Windows protected your PC*. The user chooses *More info* → *Run
  anyway*.
- **Linux:** no warning of this kind.

Whether the warning appears **again after an automatic update** was open until a real bundle
could be built and a real swap performed over a quarantined copy of it. **On macOS it is now
answered: no second warning.** **Windows is still open.** The install instructions must show the
first-open steps with screenshots either way, so the warning does not look like malware.

**What was done, so the answer can be checked rather than believed.** A macOS bundle was built
(`briefcase create macOS`, `briefcase build macOS`) and copied twice. One copy was made to look
like a downloaded one by writing the attribute a browser writes —
`xattr -w -r com.apple.quarantine "0083;<hex time>;Safari;<uuid>" InnyTypes.app` — and the other
was left exactly as built. Then the swap the updater really performs was run over them:
`innytypes.helper.swap`'s own `_remove(previous)`, `_rename(live, previous)`,
`_rename(incoming, live)`, against a real `ReleaseRoots`, on real `.app` bundles.

**What was measured, before and after.**

| the bundle | `xattr -p com.apple.quarantine` | `spctl --assess --type execute` |
|---|---|---|
| freshly built | absent (`com.apple.provenance` only) | *rejected* |
| the "downloaded" copy | `0083;…;Safari;…`, on the bundle **and** on `Contents/MacOS/InnyTypes` | *rejected* |
| after the swap, at that same path | **absent** | *rejected* |
| the displaced copy, now `previous` | `0083;…;Safari;…`, intact | — |

**Why it comes out that way, and why it is not luck.** An extended attribute belongs to the
**inode**, and the swap is two `rename(2)` calls. The quarantined bundle is never written over:
it is renamed aside, and it takes its attribute with it. The new bundle arrives at the live path
carrying only what it already had, which is nothing. There is no step in which anything could
copy the attribute across — so this is a property of *the swap*, not of one macOS release.

**The dialog was checked too, not only the attribute.** The swapped-in bundle — at the exact
path that had held a quarantined bundle a moment earlier — was opened with `open -n`. It started
the helper, started Anytype and started the host, unattended, with nothing to click. Note the
third row of the table: `spctl` still answers *rejected*, because Briefcase ad-hoc signs
(`Signature=adhoc`, no Developer ID) and F5 chose that. Gatekeeper **would** refuse this bundle
if it assessed it. It does not assess it, because there is no quarantine attribute to make it
look. The warning was always a question of whether Gatekeeper looks, and after a swap it does
not.

**What is proven and what is inferred.** Proven on this machine: the quarantine attribute does
not survive the swap, and the bundle that takes the live path opens with no dialog. Inferred:
that the attribute a real browser writes is the one written here by hand — the flags and the
format are the documented ones, but no release has been distributed to compare against — and
that macOS goes on driving the dialog from that attribute. This is also consistent with what
the helper's own downloads do: a file fetched with `httpx` and written by Python carries
`com.apple.provenance` and **not** `com.apple.quarantine`, measured, so nothing in this code
path asks for the attribute in the first place.

**One thing this does not yet cover, and it is the thing to hold the updater to.** The swap
today replaces a *release directory* under `~/Library/Application Support/innytypes/release/`;
**nothing in the helper replaces a `.app` bundle**, because inside a bundle the code lives in
the bundle and the installer that would replace one is still the seam `UvCoreInstaller` stands
in for. The experiment applied the same two renames to real `.app` bundles, so the answer holds
for the bundle-replacing updater **as long as it stays two renames**. If it is ever written to
update a bundle *in place* — unpacking over the live directory instead of renaming a new one
into it — the quarantine attribute stays where it is, and the answer flips back to a second
warning.

**Windows is still open, and unchanged.** This machine is macOS and SmartScreen needs a Windows
machine, so nothing about it has been observed. SmartScreen scores by reputation on the *file*,
so a new unsigned executable is a new file to it, and the honest assumption stays: **the Windows
warning does reappear**. The install instructions must cover it as a step the user may see again
after an update, because being wrong that way costs a paragraph of documentation, and being
wrong the other way costs a user who thinks their updated application has been tampered with.
Code signing (an Apple Developer ID with notarization, Windows Authenticode) removes the
question on both platforms and remains the real answer.

Adding an Apple Developer ID with notarization, and Windows Authenticode signing, later is a change
to slices 07, 10 and 16. It does not change the minisign verification of updates.

### What slice 15 sharpened (Linux)

Building Linux settled what this platform actually needs from the helper, and the answer was
smaller than the slice's own description assumed. Each point below is narrower than what it
replaces, never wider.

- **There is no Linux process table, because there was nothing for one to do.** The slice was
  written expecting a `/proc` reader producing the pid / start time / executable path / RSS / CPU /
  open files / child count shape. `SystemProcessTable` already answers all seven, and `psutil`
  reads every one of them out of `/proc` on Linux — so a second reader would have been a second
  answer to a question that has one, with no caller and no kernel to check it against. What landed
  instead is a test that drives the existing reader with Linux-shaped values through a stand-in
  `psutil` and asserts the `ProcessFacts` and `ResourceSample` it produces. **The acceptance line
  in the WorkItem was amended to say so**, so the item and the code agree.
- **The `.desktop` entry is one value used twice.** `innytypes.helper.linux.DesktopEntry` is both
  the entry the Briefcase package installs and, through `LinuxLoginItem`, the copy in the XDG
  autostart directory — which is the whole of what `launch_at_login` (F7) means on this platform:
  register is writing one file, unregister is deleting it, and there is no service to ask.
- **The entry's `Exec` is an absolute path and carries no field codes**, and an entry without one
  is refused rather than written. An absolute path because a run-state record holds the executable
  the OS will report, and a record whose path does not match is one nothing will ever signal
  (*Phantom detection*). No `%f`/`%F`/`%u`/`%U`, because those are how a shell is told it may
  launch one copy per file — and InnyTypes is single-instance. `SingleMainWindow=true` asks a
  shell that understands it to raise the running window; the guarantee is still the lock.
- **Clicking a Linux notification opens the window through the `desktop-entry` hint.**
  `notify-send` has no callback to hand back, so `NotifySendBackend` names the installed
  application on every notification instead. The shell activates that entry on a click, the
  activation runs the entry's `Exec`, and that launch finds the lock held and brings the running
  window forward. The hint, the entry's file name and the window class are therefore one value —
  D27's bundle identifier — and they have to stay one or the click reaches nothing.
- **A desktop that will not show a notification stops nothing.** No notification daemon, no
  session bus, no `notify-send` installed: all three are logged and stepped over. A message that
  did not appear must never be why a quarantine goes unrecorded or a quit does not happen.
- **`/etc/machine-id` may legitimately be empty**, on an image whose identifier is generated at
  first boot and on a machine reset for re-provisioning, so `/var/lib/dbus/machine-id` is tried
  after it and an empty file counts as a miss rather than an answer. A machine with neither is
  told which paths were tried and why each missed. The raw value is hashed and registered with the
  credential redactor exactly as macOS's is — which is also what systemd asks of an application
  reading that file, so D20 and the platform's own rule are satisfied by one act.

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
- the text a notification carries reaching the operating system as **data** and never as part
  of a script something is about to compile — `osascript` on macOS, PowerShell on Windows

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
  fake plugin manifests with no real `uv` or `git` run. The version check leaves three seams
  open for the same reason and they are all filled in the gate: the **HTTP transport**, the
  **`git` command runner**, and the **lock resolver** that would otherwise run
  `uv pip compile`. So "no test makes a network call or runs a real `git`" is a property of
  the design, and the `auto_check_versions` switch is proved by asserting that the injected
  transport and the injected runner were asked for **nothing at all**.
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
| 05 | restart policy and control channel | N attempts with increasing backoff, the terminal state, the helper's commands to the host (start / stop / restart / kill / list), host exits reported to the helper. **The channel is real now** (`innytypes.helper.control`): the helper's owner-only socket, the host's connection and its `hello`, commands and their answers, exits carried back on the same connection, and the three named failures — no host connected, a dropped connection, and a command left unanswered, which is the stale verdict. Opening it is the helper's tick's, and connecting to it is the host process's |
| 06 | restart breaker and quarantine | N-in-window, the quarantine state, `innytypes helper release`, `innytypes helper status` |
| 07 | application launcher and quit | the `innytypes-helper` entry point, single-instance lock, helper starts or adopts Anytype and starts the host, the host relaunches a crashed helper but not an externally stopped one, every way of *Turning InnyTypes off* including `innytypes quit --force`, the `launch_at_login` switch. The bundles, the icon and the macOS login item behind that switch landed with slice 17. **Still to build:** the host's own way of noticing that the helper has gone — the rule it applies is landed and proved, the polling that feeds it arrives with the helper-to-host connection |
| 07b | the application's own window | `innytypes.helper.window`: what the window shows (every managed process, pending core and plugin updates with an Apply on the ones waiting for the user, the telemetry switch, the launch-at-login switch, Quit InnyTypes) and what each control does; closing does not quit; a second launch reopens rather than starting a second application; the first-launch telemetry question with the privacy notice, asked once; no system-tray icon, proved against the seam and against the whole source tree. The drawing landed with slice 17 (`TogaDesktop`), and `HeadlessDesktop` is still what an installation with no toolkit runs |
| 08 | telemetry pipeline | machine id, redaction, the bounded on-disk queue, background sending to GlitchTip and the usage backend, switch-off purges the queue, the privacy notice |
| 09 | core update check and verified download | the release index, forward-only and host-API-major guard, checksum + minisign verification, staging |
| 10 | core apply and roll back | the swap at quit, the health-confirmed launch, rollback, blocked versions, plugin compatibility check, plugin environments moved to the new host version, self-update. The Windows quit-time updater step landed with slice 16. **Settled on macOS:** the OS warning does **not** reappear after an update — the quarantine attribute belongs to the inode the swap renames aside, so the bundle that takes the live path carries none and Gatekeeper never looks; measured on a real bundle made to look downloaded. **Windows stays open**, because SmartScreen needs a Windows machine. See *Security warnings, for now* |
| 11 | plugin environments | one `uv` environment per plugin, `addons install` into it, recorded manifests for discovery |
| 12 | plugin version check | the `update` manifest section, index / PyPI / git sources, tag → commit pinning, the five consistency rules, `innytypes addons outdated` with blocking reasons |
| 13 | plugin update apply | staged locked environments, stop the affected group, swap, start in order, group rollback, `addons update` / `pin` / `unpin`, `auto` mode |
| 14 | user notification | system notifications for quarantine, rollback, staged updates, pending manual updates and blocked sets |
| 15 | Linux | the `.desktop` entry and the autostart copy behind `launch_at_login`, the Linux machine id (`/etc/machine-id`), desktop notifications through `notify-send` with the `desktop-entry` hint that makes a click reach the window. **No Linux process table:** `psutil` already reads every field the identity and resource checks consume out of `/proc`, so what landed is a test holding the existing reader to Linux-shaped values — see *What slice 15 sharpened*. The Briefcase Linux configuration and the icon landed with slice 17, and a real `.deb` has since been **built from this Mac**: Briefcase builds Linux in a container of the target distribution, and podman answers to the name `docker`. See *Building the bundles* |
| 16 | Windows | Start-menu launcher, Windows process table and `MachineGuid`, the quit-time updater step, toast notifications |
| 17 | the bundles, the icon, and the clickable application | `[tool.briefcase]` naming the application, D27's bundle identifier and the entry point the console script names; the icon drawn by `tools/make_icon.py` and committed at every size; `MacLoginItem`, the real macOS login item behind `launch_at_login`, with `UnpackagedLoginItem`'s refusal still standing for a run with no bundle; `TogaDesktop`, the toolkit-backed drawing, registering no status item; `--innytypes-host`, how a bundle with no interpreter starts the host. **Built and run on this machine:** the macOS bundle starts the helper and the host, starts Anytype when none is running and adopts one when there is, and Quit InnyTypes stops all of it — taking the Anytype it started with it and leaving an adopted one alone (F6, both branches seen). A Linux `.deb` has been built from this Mac too, in a container. **Not done:** the Windows package, which Briefcase refuses off a Mac and which needs a Windows machine or runner |
| 19 | the helper's tick, assembled | `innytypes.helper.supervision`: the one pass that reads the two sockets, samples and judges every managed process, counts the interventions, issues the restarts whose backoff has run out, runs the core update check on its schedule and tells the user — and the two loops that repeat it, the plain one and the toolkit's. The host's own restarts are routed to the helper's hands rather than onto the wire, and a failure in one pass is logged and followed by the next. See *The tick, and the two loops that run it* |
| 15 | Linux | `.desktop` launcher, Linux process table and machine id, desktop notifications |
| 16 | Windows | Start-menu and desktop shortcut specifications with the AppUserModelID, the handle-counting half of the process table, `MachineGuid` through an injected registry reader, the quit-time updater step, toast notifications through PowerShell. See *What slice 16 sharpened* |

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
- 17 needs 07, 07b and 16: it packages what they built, and the Windows shortcuts and the Linux
  `.desktop` entry have to agree with the bundle rather than be duplicated by it.
- 19 comes last of the macOS MVP, because it is the one that calls the rest: it needs 02 to 07
  for what it assembles and the real control channel to act through, and everything it wires is
  something one of those slices already decided.

WorkItems for these slices are seeded from this plan when the owner asks for them.

### What slice 16 sharpened

Building Windows settled what that platform really needs, which turned out to be less than the
slice was written expecting — because every seam that touches the machine was already injected,
and `psutil` answers the process table on all three platforms.

**What was already covered, and is recorded here so nobody rebuilds it.** The process table
needed no Windows reader: `SystemProcessTable` is one class for all three platforms, and the
identity check, the resource sample, the orphan rule and the polite-stop-then-kill sequence are
the same code everywhere. The forced stop needed nothing either — Windows has no `SIGKILL`,
which the existing lookup already handles by falling back to `SIGTERM`, and `os.kill` turns that
into a `TerminateProcess` call. The signal-name lookups in the launcher were likewise already
written so that a platform missing most of them imports cleanly.

**The one genuine difference in the process table is how open files are counted.** POSIX counts
**file descriptors** (`num_fds`); Windows has no such thing and counts **handles**
(`num_handles`) — a wider notion that includes open files and every other kernel object the
process holds. `psutil` offers exactly one of the two on any given machine, so the reader asks
for whichever is there. `max_open_files` therefore means "too many kernel objects" on Windows
and "too many descriptors" elsewhere, which is the same runaway in both cases and is what the
limit exists to catch. A process table offering neither is one this application will not
measure, which is the same "cannot vouch for it" every other unreadable process gets.

**The shortcuts are a specification, not a writer.** A `.lnk` is a binary object created through
COM, and the thing that creates one on a user's machine is the Briefcase bundle's installer
(F5) — not the helper, which by the time it runs is already installed. What this application
owes that installer is an unambiguous description: the target executable (`innytypes-helper`,
D27), no arguments, the icon, the working directory, and the **AppUserModelID**. Both shortcuts
carry the id, not only the Start-menu one, so a window raised from either is grouped under the
same taskbar identity as the toasts.

**One identifier, on all three platforms.** The reverse-DNS string that names the macOS bundle
and the Linux `.desktop` entry is the Windows AppUserModelID. It has to be one value: Windows
resolves the id by finding a Start-menu shortcut that carries it, and a toast raised under an id
no shortcut carries is silently dropped.

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

Slice 07 landed the entry point the bundle launches (`innytypes-helper`) and **not** the
bundle; **slice 17 landed the bundles** — see *Building the bundles*. An unpackaged installation
is unchanged and still starts the helper from the console script and the host with `python -m
innytypes up`; a bundle, which has no interpreter of its own, starts the host by starting itself
with `--innytypes-host`. The macOS bundle has been built and run on a real machine, and a Linux
`.deb` has been built from that same Mac in a container. **The Windows package has not been
built and cannot be from here**: Briefcase refuses it outright off a Mac, and the real path is a
Windows machine or a Windows CI runner — see *Building the bundles*.

**F6 — Anytype that is already running, and quitting.** *Answer:* as proposed. An Anytype that is
already running is adopted and watched. On quit, Anytype is stopped only if the application
started it.

**Both branches have now been seen on a real machine, from the built bundle.** Slice 17 could
only see adoption, because the owner's Anytype happened to be open; with Anytype closed, the
other branch was run:

- **Starting.** The bundle was opened with Anytype **not** running. The run-state file came back
  with three records — helper, host and `innytypes.anytype-app` — and the Anytype record's
  `parent_pid` was the **helper's** pid, which is how the file says *this application started
  it*. Anytype's own window came up with it.
- **Quitting.** `innytypes quit` ended the helper, and Anytype went with it: no `Anytype.app`
  process was left, the run-state file was back to `{"records": []}`, and the lock was released.
  That is the half of F6 slice 17 could not reach, because a quit may only stop an Anytype the
  application started.
- **The adopted branch, for contrast**, was seen in slice 17 and is unchanged: the adopted
  Anytype records **itself** as its parent, and it was still running after the quit.

So the run-state record's `parent_pid` is not bookkeeping — it is the one fact that decides
whether a quit is allowed to close the user's Anytype, and both of its values have now been
followed all the way to the outcome the user sees.

**F7 — Launch at login.** *Answer:* as proposed. A `launch_at_login` switch, off by default.

As slice 07 landed it, the switch is **real and stored** in `config.toml`, and the operating
system's login-item store is a **named seam**: `UnpackagedLoginItem` refuses out loud, because
registering a login item needs the identity of an installed bundle (F5). A hook that silently
succeeded would leave the window reading "on" and the application never starting at login, which
is the one outcome a user could not diagnose. The order is also fixed: the operating system is
asked first and the setting is written only once that has worked, so the file never claims
something the machine is not doing.

Slice 17 narrowed the refusal rather than softening it. A run **out of an installed bundle** now
gets a real login item on both platforms that have one: on macOS
(`innytypes.helper.macos.MacLoginItem`) a LaunchAgent in the user's own `~/Library/LaunchAgents`,
named for D27's identifier, whose `ProgramArguments` is the bundle's launcher and which is loaded
into the running session with `launchctl bootstrap` so the switch means something before the next
login; on Linux (`LinuxLoginItem`) the `.desktop` entry copied into the XDG autostart directory.
A run **not** out of a bundle still gets the refusal, word for word — `default_login_item` is the
one place that decides which of the two an installation has. A LaunchAgent rather than
`SMAppService` because Apple's modern API is Objective-C only and registers the calling bundle,
so it could not be exercised at all outside a built app; the LaunchAgent is a value this
application can render, assert and remove.

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
