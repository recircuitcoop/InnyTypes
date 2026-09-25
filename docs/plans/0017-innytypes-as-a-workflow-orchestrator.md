---
type: plan
title: InnyTypes as a workflow orchestrator — architecture reassessment and framework choice
status: PROPOSED
created: 2026-09-25
updated: 2026-09-25
---

# 0017 — InnyTypes as a workflow orchestrator

## Why this exists

The owner, 2026-09-25: *"InnyTypes is becoming some kind of multiworkflow orchestrator where the
monty is an event source, innyrize a node and message passing between the nodes. What I am doing
right now, with conf and plugins is just clumsy. I need to reassess the whole problem."* They want a
framework, *"like n8n, nodered or anything like that (whatever the language)"*, that provides
*"the grammar to define the events, nodes and views that will run when a source event fires all
the way to the sink event"*. The grammar may differ from the executable, and InnyTypes must stay
usable on macOS, Windows and Linux.

## The owner's constraints (answered 2026-09-25)

| Question | Answer |
|---|---|
| Who runs it | **Other people, one desktop each.** So licences must allow redistribution. |
| How flows are written | **A visual canvas only.** |
| What happens to today's code | *"Depending on the result of the research, anything is possible."* |
| Crash or quit mid-job | **Retry the step, and fall back on best effort.** Exactly-once is not needed. |
| Anytype | *"It is the reason it exists and it can be a NODE inside the workflow."* |
| Shell | Whatever the research says. |
| Node authors | **Python and JS/TS first-class, any executable, and third parties publish nodes.** |
| Installer size | Does not matter. |
| Standing preference | OSI open source, and EU. |

## What we have today (hexagonal assessment, 2026-09-25)

About 40k lines in `src/innytypes`, in three buckets:
- **about 44% a generic engine:** the event bus, the plugin runtime, supervision, install, verify
  and update, and settings;
- **about 9% Anytype:** the MCP child, the key, the API and the gateway;
- **about 45% desktop shell:** the Toga window, the launcher, notifications, telemetry, core update,
  and the macOS, Windows and Linux seams.

**Worth keeping, whatever is chosen:**
- **The node contract.** A plugin is a process that receives JSON events on stdin through
  `Addon.handle` and emits through a bound `AddonContext`. It has a manifest and a declared
  settings schema, and it needs no import of InnyTypes: monty declares its own Protocols, and
  whodunnit knows nothing of InnyTypes. That is already a language-neutral node protocol.
- **Process isolation.** Each plugin runs in its own verified uv environment (lock hashes,
  minisign). This is exactly what a third-party node ecosystem needs, and it is what the popular
  engines lack.
- **The cross-platform seam pattern** (a Protocol plus a per-OS factory), redaction, and the
  verification discipline.

**Structural debts:**
- no domain package;
- more than eight composition roots, with `build_control_channel` duplicated;
- 33 `default_*` factories that hide wiring;
- no storage or HTTP ports;
- global logging state;
- three god modules: `window.py` (3007 lines), `launcher.py` (2580) and `cli.py` (1689);
- the generic engine imports Anytype and helper modules.

**What is genuinely clumsy is the missing grammar.** Plugins are connected by configuration files
and manifests. Plan 0016 was about to add "wires" as yet more configuration. A workflow framework
exists to replace exactly that.

## Research summary (five tracks, 2026-09-25)

**Excluded, and why:**
- **n8n.** The Sustainable Use License is not OSI, and redistributing it inside a product needs a
  paid Embed License.
- **Windmill.**
  - Postgres is mandatory on every desktop.
  - AGPL applies, and proprietary Enterprise code is bundled even in the Community Edition binary.
  - Its third-party sandbox, nsjail, is Linux-only.
  - It has no filesystem trigger.
  - It is the best polyglot engine, but built for servers.
- **Kestra** (a JVM with H2 or Postgres, and Windows is weak); **NiFi** and **Hop** (heavy JVMs).
- **Camunda 8**, whose licence is not OSI; **Temporal** (US, and its local mode is dev-only);
  **Restate** (BSL, not OSI).
- **Activepieces** (embedding is SaaS-only and paid); **Flowise** (end of life August 2026).
- **Motia/iii** (Elastic License 2.0 engine, mid-rebrand); **Flyte** (Kubernetes only);
  **Prefect**, **Dagster** and **Airflow** (batch pipelines, Python-only orchestration).

**The one engine that fits every hard constraint: Node-RED.**
- **Licence and governance.** Apache-2.0, run by the OpenJS Foundation, with FlowFuse as the
  commercial sponsor. Version 5.0 (September 2026) requires Node 22.9 or later.
- **Embeddable.** A documented embedding API (`RED.init` on your own Express server), no
  database, flows stored as a versionable JSON file, and it runs on all three OSes.
- **A proven visual canvas**, and a node catalogue of about 6,000 npm nodes.
- **Its gaps, which InnyTypes would fill:**
  - **third-party npm nodes run unsandboxed inside the one Node process;**
  - messages in flight are lost on a crash, so retry is not built in;
  - node forms are hand-written HTML, not generated from a schema;
  - it has no filesystem trigger;
  - Python only goes through exec or DIY bridges.

**The standards worth adopting whichever engine is chosen:**
- **CloudEvents**, as the event envelope;
- **JSON Schema** (2020-12), for node inputs, outputs and settings;
- the **FBP network protocol**, as the precedent for separating a UI from a runtime in another
  language;
- **React Flow / xyflow** (MIT, webkid GmbH, Berlin) if we ever draw our own canvas.

**Considered as a backbone and not needed:** NATS (Apache-2.0, single binary). The current
socketpair bus already works, and the owner's "retry the step" does not call for a broker.

## Recommendation

**Adopt Node-RED as the grammar, canvas and router. Keep InnyTypes as the node runtime, the trust
layer and the Anytype core. Ship it in an Electron shell.**

1. **Node-RED owns the canvas, the flow file and the message routing between nodes.** This
   replaces the configuration wiring, including plan 0016's wires, with a visual flow the person
   draws.
2. **InnyTypes provides exactly one Node-RED node type: the InnyTypes node.** Every InnyTypes
   plugin appears in the palette through it. It:
   - starts the plugin as an **isolated process** through today's runtime (its own environment,
     verified, supervised);
   - speaks today's JSON-over-stdin contract, mapping `msg.payload` to an event in and an emitted
     event back to `msg`;
   - **generates its edit form from the plugin's declared settings schema**;
   - reports progress with Node-RED's `node.status`.

   monty becomes a source node, innyrize a processing node, and Anytype a node. Python, JS and
   any executable are all first-class, because the node is a process and not a Node-RED module.
3. **The palette is InnyTypes' catalogue, not npm.** Node-RED's palette manager is disabled, so
   third parties publish InnyTypes plugins that are signed, locked and process-isolated. This
   closes Node-RED's biggest hole, unsandboxed third-party code, by construction.

   Whether to also allow selected native Node-RED nodes (say, the core HTTP, MQTT and function
   nodes) is decision D1 below.
4. **"Retry the step" lives in the InnyTypes node.** Each job handed to a process is journaled
   before it is sent and cleared when the process answers. After a restart, journaled jobs are
   re-sent once, then marked failed, which is best effort. innyrize's plan already specifies
   this journal inside the plugin; the node runtime generalises it so every plugin gets it.
5. **Shell: Electron.**
   - Size does not matter, and Electron bundles Node, which Node-RED 5 needs.
   - The Python node runtime runs as a sidecar, bundled with its own Python like today's
     Briefcase build.
   - Tauri was the alternative: it gives smaller installers, but we would ship and manage a
     Node 22+ runtime ourselves, and still have Python.
6. **Anytype stays core.** The MCP child, key and gateway stay InnyTypes services, and Anytype
   also appears as nodes (write an object, read a space).

**What happens to today's code, by bucket:**

| Bucket | Fate |
|---|---|
| Plugin runtime, supervision, install, verify, update, settings schema | **Kept.** It becomes the node runtime behind the InnyTypes node and loses its window code. |
| Event bus and plan 0016 wiring | **Mostly replaced** by Node-RED routing. The per-process channel stays as the node protocol. |
| Anytype (MCP, key, API, gateway) | **Kept.** |
| Toga window, launcher, launch at login, notifications, core update | **Replaced** by Electron equivalents over time. The macOS, Windows and Linux seams are re-used where they are not UI. |
| Composition-root and god-module debts | Paid down as the shell moves, not before. |

## The alternative we did not choose

**Our own canvas: React Flow, our own graph JSON, and the existing Python runtime doing the
routing.**
- **Gain:** full control, one fewer runtime (no Node-RED), and the grammar ours outright.
- **Cost:** we would build and maintain the editor, flow storage, debugging views and routing
  semantics that Node-RED gives us mature.
- It becomes the right answer only if the D2 spike shows Node-RED's in-process message model
  fighting the out-of-process node model.

## Decisions for the owner

- **D1:** Only InnyTypes nodes in the palette (safe, smaller)? Or also a vetted set of native
  Node-RED nodes, which are unsandboxed but let the person use its ~6,000-node ecosystem?
- **D2:** Run a **spike before committing**? It would be a throwaway branch: Electron plus
  embedded Node-RED plus one InnyTypes node running the real monty and innyrize, one flow from
  a watched folder to an output folder, on macOS, then Windows. Recommended.
- **D3:** **Pause plan 0016** (runtime wiring in configuration), because a canvas replaces it?
  Recommended. Plan 0015 (MCP child logs) and innyrize plan 0001 are unaffected: innyrize's
  contract — a field naming a file in, `innyrize.diarized.v1` out — is exactly an InnyTypes node.

## Risks

1. **The Node-RED message model versus long-running process nodes.** One job taking an hour, with
   cancellation and progress, has to feel native. The spike answers this.
2. **Two runtimes in one app** (Node for the canvas and routing, Python for the nodes). Updates,
   logs and crash handling now span both. The owner's log discipline (plans 0012 and 0014)
   must cover Node-RED's own log too.
3. **Node-RED 5 moves fast** (Node 22+, ESM). We pin a version and update deliberately, the way
   the Anytype MCP package is pinned today.

## Sources

The research tracks, with URLs, are in the session record of 2026-09-25. The key facts:
- Node-RED licence and embedding: https://github.com/node-red/node-red,
  https://nodered.org/docs/user-guide/runtime/embedding
- The n8n licence: https://docs.n8n.io/sustainable-use-license/
- The Windmill licence and self-hosting: https://github.com/windmill-labs/windmill/blob/main/LICENSE,
  https://www.windmill.dev/docs/advanced/self_host
- The Restate licence: https://github.com/restatedev/restate/blob/main/LICENSE
- The Camunda licence: https://camunda.com/blog/2024/04/licensing-update-camunda-8-self-managed/
- xyflow: https://xyflow.com/open-source
- The FBP protocol: http://flowbased.github.io/fbp-protocol/
- CloudEvents: https://cloudevents.io

## Status

PROPOSED 2026-09-25, waiting on D1–D3.
