---
type: plan
title: InnyTypes as a workflow orchestrator — sources, nodes, views and flows on embedded Node-RED
status: APPROVED
created: 2026-09-25
updated: 2026-09-25
---

# 0017 — InnyTypes as a workflow orchestrator

## Why this exists

The owner, 2026-09-25: *"InnyTypes is becoming some kind of multiworkflow orchestrator where the
monty is an event source, innyrize a node and message passing between the nodes. What I am doing
right now, with conf and plugins is just clumsy. I need to reassess the whole problem."* They want a
framework that provides *"the grammar to define the events, nodes and views that will run when a
source event fires all the way to the sink event"*, with a grammar that may differ from the
executable, on macOS, Windows and Linux.

## Vocabulary: the pivot

InnyTypes no longer has plugins. From this plan on:

| Term | Meaning | Examples |
|---|---|---|
| **Event** | A message travelling along a wire in a flow. Its type is a versioned name. | `monty.new.v1`, `innyrize.diarized.v1` |
| **Source** | A node type with no input. It starts flows by emitting events, and each event type it emits is its own output. | monty's *Folder watcher* (outputs `new`, `updated`, `deleted`); monty's *Volume watcher* (adds `mounted`, `unmounted`) |
| **Node** | A node type that takes an event in, does work, and emits events out. A sink is a node with no outputs. | innyrize's *Diarize*; Anytype's *Create object*, *Update object*, *Read space* |
| **View** | A node type that presents something to the person inside the InnyTypes app. There are two kinds (see below). | *Name the speakers* (action); *Transcript* (snapshot) |
| **Flow** | A graph of sources, nodes and views, drawn on the canvas. | BOYA recording → Diarize → Name the speakers → Create Anytype object |
| **Node package** | The installable, verified, isolated unit that provides one or more source, node or view types. It replaces "plugin". | the `monty` package provides two sources; `innyrize` provides one node |
| **Runtime** | What InnyTypes runs to execute node packages, each in its own process. | — |

## The owner's constraints and decisions

| | Answer |
|---|---|
| Who runs it | Other people, one desktop each, so licences must allow redistribution |
| Authoring | A visual canvas only |
| Crash or quit mid-job | Retry the step, and fall back on best effort |
| Anytype | *"It is the reason it exists and it can be a NODE inside the workflow."* |
| Node authors | Python and JS/TS first-class, any executable, and third parties |
| Installer size | Does not matter |
| **D1** | **Only InnyTypes node types in the palette.** No npm palette and no native third-party Node-RED nodes. |
| **D2** | **A spike comes first.** **If it fails, go with React Flow and a Python runtime.** |
| **D3** | **Plan 0016 is paused**, because the canvas replaces configuration wiring. |
| **Switchover** | *"sudden and massive and CORRECT"*. There is no gradual migration and no period where the old and new shells run side by side. |

## Research outcome (five tracks, 2026-09-25)

**Chosen engine: Node-RED.** It is the only engine meeting every hard constraint:
- Apache-2.0, run by the OpenJS Foundation;
- a documented embedding API, no database, and a flow saved as a JSON file;
- a mature canvas, on all three OSes.

**Excluded:**
- n8n: its licence is not OSI, and embedding needs a paid Embed License.
- Windmill: Postgres on every desktop, AGPL plus proprietary code bundled in the free edition, a
  sandbox that is Linux-only, and no filesystem trigger.
- Kestra, NiFi and Hop: too heavy (JVM).
- Camunda 8: licence. Temporal: US, and its local mode is for development only. Restate: BSL.
- Activepieces: SaaS-only embedding. Flowise: end of life. Motia/iii: ELv2. Flyte: Kubernetes.
- Prefect, Dagster and Airflow: batch pipelines.

**Node-RED's gaps, which InnyTypes fills:**
- third-party npm nodes run unsandboxed in one process. Closed by D1: the palette holds only
  InnyTypes types, and those run out of process.
- a crash loses messages in flight. Handled by a job journal.
- forms are hand-written. InnyTypes generates them.
- there is no filesystem trigger. monty's sources provide it.

**The fallback (D2 fails):**
- React Flow / xyflow for the canvas (MIT, webkid GmbH, Berlin);
- our own flow JSON;
- the Python runtime doing the routing.

**Standards either way:**
- JSON Schema 2020-12 for node configuration, inputs and outputs;
- a CloudEvents-shaped envelope for events.

## Architecture

1. **Electron shell.** Electron is the whole application: window, tray, instance lock, quit,
   launch at login, notifications, updates, logs, and the Anytype endpoint settings. It embeds
   Node-RED (`RED.init` on its own Express server). The canvas is Node-RED's editor, shown inside
   the app. **Views** are pages of the app itself, not Node-RED's dashboard.
2. **One Node-RED node type per source, node and view in each installed package.** They are
   **distinct types, not one generic node**. When a package is installed, InnyTypes generates a
   Node-RED node module for each type it declares, with:
   - its own palette entry, category (input, function, output, or view), icon and label;
   - its own input and output ports, **one output per event type** it emits;
   - its own edit form, **generated from the type's JSON Schema**, with secrets as Node-RED
     credentials.

   All generated types share one runtime implementation underneath, which starts and speaks to
   the node's process. The user sees *Folder watcher*, *Diarize*, *Create Anytype object* and
   *Name the speakers*, not "InnyTypes node".
3. **Out-of-process execution.** Every source, node or view instance on the canvas runs in its
   own process, from its package's own verified environment: Python in uv, Node for JS, or any
   executable.
   - The flow is the unit of configuration. A node instance's form values are its configuration,
     so there are no per-package settings files. This replaces plans 0004/0005's settings files
     for flows.
   - One process per *instance*, not per package, because two Diarize nodes on the canvas may be
     configured differently.
4. **The palette is locked (D1).** Node-RED's palette manager is disabled. Only node packages
   installed through InnyTypes, and so signed, locked and verified, provide types.
5. **Retry the step.** Every event handed to a node process is journaled before it is sent and
   cleared when the node reports it done. After a restart, journaled events are re-sent once,
   then reported failed. That is best effort, as the owner chose.
6. **Anytype is core, and appears as nodes.** InnyTypes keeps its Anytype services: the MCP
   server, the key, the API client and the gateway. Anytype also appears on the canvas as node
   types: create, update or read an object, read a space.

## Views: a departure from Node-RED's node-only model

A view is a node type whose result is shown to the person **in the InnyTypes app** (the Electron
window), not in Node-RED's editor. There are two kinds, fixed per type:

- **Action view: the flow waits.** When an event reaches it, the app shows the view, for example
  *"Name the speakers in this recording"* with a form or buttons, and the flow **stops at that
  node** until the person acts. What they submit becomes the view's output event, and the flow
  continues from there.
  - **A pending action survives a restart.** It is journaled like any step, and waiting may take
    days.
  - The app keeps an **inbox of pending actions**, with a badge and a notification.
  - An action view may declare a timeout output (for example, "after 7 days, continue with
    defaults"). It is optional.
- **Snapshot view: no wait.** It passes the event straight through, or ends the flow, and
  **records the state of an object at that moment**, for example the transcript, or the Anytype
  object that was just created. The person can open it later from the app's view list. It is a
  record of what the flow produced. It is not live.
  - **A snapshot can also trigger source events.** The owner, 2026-09-25: *"in the snapshot,
    they can also trigger source events"*. A snapshot view type may declare **actions**, for
    example *"Diarize again with this roster"* or *"Send to Anytype"*. Each action has its own
    event type and its own **output port**, so on the canvas the view has two kinds of output:
    - the pass-through output, which fires when the snapshot is taken;
    - one output per action, which fires later, whenever the person presses that action while
      looking at the snapshot.
  - **An action starts a new run; it does not resume the old one.** Its event carries the state
    the snapshot captured, plus the values of any form the action asks for. It then travels
    along whatever is wired to that output **now**, like an event from a source. It is journaled
    like any source event, and it can be pressed again, with each press a new run.
  - **If the view node has since been deleted from the flow**, or that action output wired to
    nothing, the snapshot still opens. Its actions are shown disabled, with the reason. A press
    is never silently dropped.
  - This is the general form of plan 0011's buttons. A monty *re-emit* is just an action on a
    snapshot of a watched folder or volume. Plan 0011 is folded into this design and is not
    built separately.

**How a view is drawn:**
- a view type declares its content with a schema: text, a table, a form, media, a link to an
  Anytype object;
- the app renders that content generically;
- a view type may also ship its own web component for rich content, such as a transcript
  synchronised with its audio.

A third-party component runs **sandboxed**: an isolated webview or iframe with a strict content
security policy, talking to the app only through messages. It never gets Node or filesystem
access.

## Is the existing contract compatible with Node-RED?

**Not as it stands, and nothing has proved it yet.** The earlier draft of this plan claimed the
contract was "already a language-neutral node protocol". That is only half true: it is
language-neutral, but it is a publish/subscribe *plugin* contract, and a Node-RED node has a
different shape.

| Node-RED needs | Today's contract | Change required (node protocol v2) |
|---|---|---|
| A node **instance** per canvas node, each with its own config, created on deploy and closed on redeploy (`on('close', done)`) | One process per plugin, with settings read from a file at start | A start frame carrying the instance's config. The close frame gets an acknowledgement. |
| `on('input', (msg, send, done))`: each input is **completed** with `done()` or `done(err)`, so Catch and Complete nodes work | Fire-and-forget events, and emits are not tied to the input that caused them | An **input id** on every input. Outputs carry that id, and a `done` or `error` frame closes the input. |
| **Numbered output ports** | Emits by kind | Map kinds to ports from the type's declaration: one port per event type. |
| `msg` is an object (`payload`, `topic`, `_msgid`, and more) | `{kind, payload}` | The envelope maps onto `msg` as `payload`, plus `topic` for the event type, with correlation kept in `_msgid`. |
| `node.status()` for progress on the canvas | Nothing | A **status** frame. |
| `node.error`, `node.warn`, `node.log` | The plugin's own logger (plan 0014) | A **log** frame, or stderr, both routed to the one log. |
| Credentials per node, encrypted | A secrets store per plugin | Node-RED credentials fields, delivered in the start frame, never logged. |
| Sources emit spontaneously | Already true: emits at any time | Unchanged. |
| A slow node just queues | A bounded queue of 128, then dropped | The journal plus a per-instance queue, reported and never silent. |
| Views | Do not exist | New frames: `present` (show the view with content), `action` (the person's submission comes back), `snapshot` (record the state), and `trigger` (a snapshot's action starts a new run from its action output). In Node-RED terms, the view node sends a **fresh** message with no input id on that port. That is legal, like an inject node, but it has to be proven. |

What survives from today:
- one process per unit of work;
- JSON over stdio;
- a bound identity, so nothing can forge another node's events;
- declared event types, versioned in the name;
- JSON Schema for configuration;
- verified isolated environments.

What changes is the conversation between the runtime and a node. **The spike must prove every
row of this table**, not assume it.

## The switchover: sudden, massive, correct

There is no gradual migration. The owner: *"this should be sudden and massive and CORRECT"*. After
the spike passes:

1. **Build the new application complete, on its own**: Electron, embedded Node-RED, the runtime,
   the generated node types, views, and Anytype services and nodes. It is built to the hexagonal
   target from the 2026-09-25 assessment:
   - **one composition root**;
   - **ports for storage, HTTP, processes, the clock, notifications and the desktop**;
   - **no god modules**;
   - no domain code importing Anytype or the shell.
2. **Parity is proven, not hoped for.** Today's suite (about 2,600 tests) encodes every behaviour
   the old application promises. **Each test is either ported to the new application, or retired
   with a written reason** (for example, "Toga-specific", or "plugin settings files replaced by
   node config"). The ledger is committed, and nothing is dropped silently. Every behaviour the
   old app shows on the machine is re-proved on the machine in the new one, per OS:
   - the MCP child supervised and restarted;
   - the endpoint moved live;
   - the refusal notices;
   - the log;
   - launch at login;
   - updates;
   - quit.
3. **Node packages are converted to protocol v2 in the same wave.** monty becomes two sources,
   innyrize a node, and Anytype a set of nodes. Their repositories get their own plans.
4. **One cutover.** The old Toga shell, the plugin runtime and the configuration wiring are
   deleted in one change, once every row of the parity ledger is green on macOS, Windows and
   Linux.

## Slices

| # | What |
|---|---|
| 01 | **The spike (D2).** A throwaway branch, judged against the pass/fail criteria below. |
| 02 | Node protocol v2 specified: frames, envelope, the journal, views. It is written from what the spike proved. |
| 03 | The new application built complete (the hexagonal target, Electron, Node-RED, runtime, type generation, views, Anytype). |
| 04 | The parity ledger: every old test ported or retired with a reason, and machine proofs per OS. |
| 05 | Node packages on protocol v2: monty, innyrize and Anytype. These are plans in their own repos. |
| 06 | Cutover: delete the old shell, runtime and wiring in one change. |

Slices 03 to 05 are seeded after slice 01 passes, from what it learned.

## The spike (slice 01): pass/fail, decided before it starts

It runs on macOS first, then Windows. **It fails if any of P1–P6 can only be met by patching or
forking Node-RED's core.** A failure sends us to the fallback: React Flow with the Python
runtime.

- **P1 — distinct node types.** Types generated from package declarations appear as separate
  palette entries, each with its own ports and a schema-generated form. The minimum set:
  - monty *Folder watcher* (a source; outputs new, updated, deleted);
  - a *Diarize*-shaped node;
  - an Anytype *Create object* node;
  - one action view;
  - one snapshot view.
- **P2 — a real flow.** The real monty process watches a folder, then Diarize (the real innyrize
  if ready, otherwise a stub process speaking the same protocol), then the action view waits in
  the Electron window until the person names the speakers, then Anytype *Create object* on the
  real local Anytype, then the snapshot view records the created object. **Then, days later in
  effect, the person opens that snapshot and presses one of its actions. A new run starts from the
  view's action output and reaches a node wired to it.**
- **P3 — a long job.** A node job running at least 10 minutes shows progress on the canvas, can
  be cancelled from the app, and hits no timeout.
- **P4 — retry.** Quit the app mid-job, and the step is retried once on restart. Quit while an
  action view is pending, and it is still pending after restart.
- **P5 — isolation.** Each instance is its own process. Killing one does not affect Node-RED or
  other nodes. Its error reaches a Catch node and the log.
- **P6 — every row of the compatibility table** is exercised, and the protocol frames it needed
  are written down.
- **P7 — a locked palette.** npm installation of nodes is impossible from the app.
- **P8 — packaging.** The Electron app, with Node-RED and the Python runtime bundled, builds and
  runs on macOS, and on Windows. If no Windows machine is available, the spike says so and is
  blocked, not passed.

## Plans affected

- **0016** is PAUSED (D3). Its slice 01 finding stands, because it proved that no test ran two
  real processes, but the configuration wiring is replaced by the canvas.
- **0015** (MCP child logs) still applies until the cutover. The new app must carry the same
  behaviour.
- **innyrize 0001** keeps its core (diarize a file, emit a folder), but it becomes a node package
  on protocol v2. Its manifest, settings and job file are reshaped by slice 05, and it needs its
  own re-plan after the spike.
- **monty's plans** are re-planned after the spike, to become source types.

## Status

APPROVED 2026-09-25 with D1–D3 decided.

**Slice 01, the spike, finished 2026-09-25.** It PASSES on macOS and is BLOCKED on Windows.
- It is on branch `spike/0017-node-red` (`d70d2ec`..`ba2e706`), and the full report is
  `docs/arch_pivot.md` on main.
- P1–P7 and P8-macOS pass. Nothing in Node-RED's core was patched or forked, so the fallback is not
  triggered.
- P8-Windows is BLOCKED: there is no Windows machine. The spike cannot fully pass until it runs on
  one.
- Findings slice 03 must carry:
  - **a deploy naming an uninstalled type stops the WHOLE runtime.** A guard in front of the admin
    API is required.
  - Node-RED's admin API has no authentication. **The owner ruled this not a problem**
    (2026-09-25), because InnyTypes runs as a desktop application. No token is to be added.
  - a full redeploy restarts every node and uses up the job's retry. Redeploy re-sends must be
    kept apart from crash re-sends.
  - the editor's unload guard silently cancels quit in Electron.
  - the journal should move to append-only storage or SQLite, with a bounded queue.
  - forms must be validated with a real JSON Schema validator.
  - the credential secret should live in the OS keychain.
- Protocol v2 is drafted in section 3 of the report.
