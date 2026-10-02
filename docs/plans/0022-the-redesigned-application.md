---
type: plan
title: The redesigned application
status: APPROVED
created: 2026-10-02
updated: 2026-10-02
---

# 0022 — The redesigned application (release 0.3.0)

Status: APPROVED 2026-10-02 (owner); executing

**Goal:** the finished design (Penpot "InnyTypes v0.3.0", pages 00–06; `docs/ux/strategy-brief.md`,
`interaction-design.md`, `ux-writing.md`, `design-system.md`, `tokens/innytypes.tokens.json`)
becomes the only UI of InnyTypes, backend and frontend, shipped as **release 0.3.0**. The cutover
is sudden, massive and correct: 0.3.0 ships Setup, Configuration and Live and nothing of the
seven old pages, and the parity ledger says where every old behaviour went.

**Out of scope:** widgets (plan 0021, 0.4.0), audio (0020), non-text files (0019), the pipeline's
node definitions (summary, analysis, send-to-space, scheduling, approval), theming the Node-RED
editor, a tray (D14), Windows, and deleting the old Python app (WI-0018-32). Nothing here blocks
0021: the pop-up keeps `inny-view://`, its sandbox and CSP, and gains the generated `tokens.css`.

## What the code says

Read on `main` at `982e891`. "Does not exist" is a finding.

1. **UI: seven plain-TS pages behind one contract.** Pages `editor inbox snapshots events jobs
   packages settings` (`app/src/ui/pages/app.ts:22-29`), bundled as IIFE by esbuild
   (`app/package.json:14`), served on `inny-app://app/` (`app/src/shell/main.ts:122`, `:201`;
   `app/src/adapters/electron/schemes.ts:74-79`, `:122-125`). `AppApi`
   (`app/src/ui/contract.ts:299-425`) has 52 members: 46 calls and 6 push events (`onChildStatus
   onViewPresented onPendingViews onInbox onJobs onQuitQuestion`), exposed as `window.inny.app`
   (`app/src/shell/preload.ts:7`) over `app/src/shell/ipc.ts:4-89`; ops are allow-listed in
   `app/src/shell/runtime-calls.ts:28-58` and `app/src/shell/service-calls.ts:19-27`. **No call
   exists for InnyTypes' own update state, runs, flows, layouts, setup or spaces.** Forms draw
   text, select, checkbox and number only (`app/src/ui/view/render.ts:97-121`). The `ui` rule
   allows only `contract.ts`, `pages/*.ts`, `view/*.ts` (`app/.dependency-cruiser.cjs:53-60`),
   **which forbids every npm import: React fails it as written.** 600-line cap and `process.env`
   rule: `app/eslint.architecture.config.mjs:13`, `:27-50`; **`shell/main.ts` is exactly 600
   lines**, so new shell wiring needs its own files.
2. **Journal: work in hand, not history.** Rows are `input_id, instance_id, body`
   (`app/src/adapters/sqlite/journal.ts:20-27`); an entry holds input id, instance id, type,
   message, event, attempts, state, planned flags, view content and deadline
   (`app/src/domain/journal/entry.ts:51-80`); states are only `sent` and `awaiting` (`:13`).
   **An entry is cleared on `done` or `error`** (`entry.ts:3-4`; spec §7.1,
   `docs/specs/node-protocol-v2.md:592`): done and failed are never stored.
   - **A run id exists; a flow id does not.** A fresh emission's run is its event id, inherited by
     caused outputs (`app/src/adapters/process/node-process.ts:457-469`; spec §5.5), kept as
     `event.run` (`entry.ts:45-49`, `:99-108`). No record carries the tab `z`; only the update
     readiness check reads it (`app/src/application/instance-readiness.ts:18-33`). Snapshots
     carry `instanceId`, no run (`app/src/domain/views/views.ts:39-51`).
   - The `jobs` signal is one coalesced "changed" per write (`app/src/application/journal-replay.ts:37-65`,
     posted at `app/src/runtime/main.ts:278-280`); retry rules `entry.ts:202-232`.
   - **No re-run API exists.** A run starts from the app only by a snapshot action
     (`contract.ts:334-339`) or a created event type (`:379-380`); cancel exists
     (`journal-replay.ts:139-148`).
3. **Node-RED: embedded, locked, flows only read.** Only the documented `getFlows` is used
   (`app/src/adapters/nodered/engine.ts:115-126`); no `addFlow/updateFlow/deleteFlow`. The guard
   checks `POST /flows`, `POST /flow`, `PUT /flow/:id` (`app/src/adapters/nodered/guard-middleware.ts:68-70`;
   structural types `app/src/application/deploy-guard.ts:21`); palette lock and `nodesExcludes`
   `app/src/adapters/nodered/settings.ts:56-66`; types generated and registered through a global
   (`app/src/runtime/main.ts:184-273`). **Config schemas cannot declare dynamic options**: static
   `enum` only (`app/src/domain/forms/form-model.ts:88`, `:126`;
   `app/src/adapters/nodered/editor-forms.ts:140`); no `innytype` schema key exists in code, spec or SDKs.
   The editor is a cross-origin frame whose dirty flag and Deploy the shell reaches by script
   (`app/src/adapters/electron/editor-frame.ts:1-7`). Channel ops are a closed list
   (`app/src/domain/channel/messages.ts:81-127`).
4. **Packages: install from a folder exists; one previous version is kept, with no age.**
   Catalogue (signed) or folder/`.tgz` (unsigned, confirmed): `app/src/application/install-package.ts:4-10`,
   `app/src/application/package-environment.ts:45-51`. One `previous/<name>`, no time limit
   (`app/src/adapters/fs/package-roots.ts:4-5`, `:147`, `:162`; `rollBack` `:166-195`). **Rollback
   exists only inside an update**: instances not `ready` in 30 s swap back and block the version
   (`app/src/application/update-package.ts:13-16`, `:374`, `:436-445`). **No person-triggered go
   back and no register/unregister exist.** Only `packages/anytype` ships here; **monty and
   innyrize are not in this repo.**
5. **Self-update: verified, with no state stream and no rollback.** `latest-*.yml` is
   minisign-verified and the artifact's sha512 checked before electron-updater stages it
   (`app/src/application/update-check.ts:1-21`). `SelfUpdater` has only `checkForUpdates` and
   `quitAndInstall` (`app/src/ports/self-updater.ts`); `UpdateCheck` has `check installAtQuit
   schedule stop` (`update-check.ts:96-237`) answering `{ok, message}`; a person hears only the
   notices `core-update-available/refused` (`app/src/domain/notices/notices.ts:36-38`). **No
   rollback exists.** 15 ledger rows of `tests/test_helper_core_update.py` (beat-based health
   confirmation and automatic rollback) are `undecided`, "awaiting the owner", wi `WI-0018-24`
   (e.g. rows 1029-1034, 1042, 1061, 1065, 1081); rows 1041 and 1083 are PROPOSED owner-retired.
6. **Anytype: spaces can be read, types cannot, the UI reads neither.** Service ops:
   `anytype.status`, `anytype.pair.start`, `anytype.pair.complete`, `mcp.endpoint`,
   `mcp.endpoint.move` (`messages.ts:97-101`). `listSpaces` exists
   (`app/src/adapters/anytype/api-client.ts:192`); **`listTypes` does not**; `AnytypeStatus` has no
   spaces (`contract.ts:76-86`).
7. **Supervision: states exist; notification buttons and a tray do not.** `ChildState`
   (`contract.ts:15-23`); notice kinds (`notices.ts:18-42`). `Notifier` only raises and clears
   (`app/src/ports/notifier.ts:9-14`); a click opens the window, **no action buttons**
   (`app/src/adapters/electron/notifier.ts:39-41`). Dock badge `shell/main.ts:518`. **No tray, on
   purpose** (plan 0018 F4; `app/src/shell/desktop.ts:7-8`; `test/unit/no-tray.test.ts`).
8. **Settings and first run.** Endpoint, packages policy, sources, update policy, launch at login
   (`app/src/ports/settings-store.ts:12-52`); **no setup flag, retention or board layout**.
   Telemetry's `unset` answer is the only first-run question (`contract.ts:51-63`); migration is
   the one-time `config.toml` import (`app/src/shell/migration.ts:1-5`).
9. **Tests and gates.** The harness launches the real app on a temp userData
   (`app/test/e2e/app-harness.ts`); 22 e2e specs; conformance C1–C15. Ledger: 2,638 rows, 976
   ported, 156 replaced, 1,423 retired, **83 undecided**; **132 rows cite Playwright ids in 10
   specs** (supervision 32, anytype 20, package-updates 19, packages 13, mcp-endpoint 11, telemetry
   11, desktop 9, app-pages 9, one-log 7, node-red 1), which a rewrite moves. The licence set
   (`tools/licences.mjs:12-34`) covers React, Ark UI, Zag and Tailwind (MIT) but **lacks
   `OFL-1.1`** (IBM Plex), which is OSI-approved, so `:10-11` allows it. The old Python app
   (`src/innytypes`, `tests/`) still runs in the gate; its cutover WI-0018-32 is BLOCKED.

## Backend architecture

### A. Domain additions (pure; 95/90 coverage like all `domain/**`)

| Module | Holds |
|---|---|
| `domain/runs/` | `Run` keyed by `{flowId, runId}`, `runId` = the source event id (spec §5.5). States `copying running waiting failed done resumed`. Steps, one per journaled input: `{instanceId, name, startedAt, endedAt, state, progress, statusText}`. `notes[]`, `warnings[]`, `results[]` with their step names; `rerunOf`, `rerunFrom`; `cleared` (a UI flag, never a delete). `fold(events) → Run` is the only constructor. A step that errors makes the run `failed`: a failure is never a warning. |
| `domain/board/` | `BoardLayout {flowId, tabs[{id,name,order}], slots[{viewNodeId, kind: card\|question\|result, size: S\|M\|L, hidden, tabId, order}]}`. `reconcile(layout, viewNodes)`: a new view node appends a slot to the last tab at its suggested size; a removed node removes its slot; removing a tab moves its slots to the first; the last tab stays. `urgentHidden(layout, runs)`: a hidden slot never hides a waiting question or a failure. |
| `domain/flows/` | `health` → `ready`, `notSetUp(n)` (config fails `required`, or a credential is missing), `failingSince(day)` (latest finished run failed; day = start of the trailing failing streak). `lastRun`. |
| `domain/packages/states.ts` | Per package, three states each with `verifiedAt`: `registered\|unregistered`; `installed\|notInstalled\|installing(pct)\|verifying\|failedCheck`; `upToDate\|updateAvailable(v)\|updating\|updated(v, at)`; `goBackOffered(now)` (7 days), `fromFolder`, `unsigned`. No `verifiedAt`, no state shown. |
| `domain/updates/` | `upToDate checking downloading(pct) ready(v) offline(lastChecked) refused(v) updated(from,to,at) goingBack(v)`, each mapped to its `ux-writing.md` sentence key; `crashLoopAfterUpdate` (the runtime's crash-loop limit within 10 min of the first start on a new version). |
| `domain/setup/` | Welcome, Reports, Connect Anytype, Source folder, the starter's node forms (n), Ready (D19, 2026-10-02: no Packages or Starter-flow step); `next/back/resume`; `completed` once Ready is left. |
| `domain/status/` | Pill `running restarting stopped needsAttention`, banner `restarting down`, and the Live badge (waiting questions, hidden places included). |

### B. Protocol v2, revision 2.1 (additive)

The wire integer stays `2`: every addition is an optional field, as spec §1.3 allows; old
runtimes ignore them and old nodes never send them.
- **Notes and warnings (D3):** `done {in, notes?: [{level: "note"|"warning", text}]}`, ≤20 entries
  of ≤200 characters, extras dropped and logged.
- **Result lines (D16):** `done {in, results?: [{kind: "anytype"|"file"|"scheduled"|"plain", text,
  anytype?: {spaceId, objectId}, folder?, due?}]}`, ≤20. `folder` is opened only by
  `shell.showItemInFolder`, never executed.
- **Progress:** `status {…, in?, progress?: {done, total}, eta_s?, phase?: "copying"|"copied"}`.
  With `in` it updates that run's step line: the step's name in bold, the node's `text`, then
  "about N minutes left"; without, only the node's badge, as today. An unknown `phase` is absent.
- **Dynamic options (D9):** everything InnyTypes-specific about a config schema property lives
  in one `innytype` field whose value is an object. A string property declares options that
  InnyTypes resolves inside it: `"space": {"type": "string", "innytype": {"spaces": true}}` lists
  the paired Anytype's spaces; `"type": {"type": "string", "innytype": {"types": {"of": "space"}}}`
  lists the types of the space chosen in the sibling property that `of` names. The stored value
  stays a plain string. `innytype` is registered as an annotation keyword, so strict validation
  accepts it and it never changes what validates. Later keys (recorders, folders) join the same
  object when a plan defines them; none is defined now. The canvas form resolves it through a
  Host-checked admin route `/red/inny/options`, which asks services over the direct peer channel;
  Setup resolves it through `AppApi.nodeOptions`. The Anytype key never leaves services.
- The schema `docs/specs/node-protocol-v2.schema.json` and both SDKs gain these
  (`done(in, {notes, results})`, `progress(in, done, total, eta_s)`), and the SDKs' config-schema
  helpers pass the `innytype` object through unchanged. Conformance: **C20** notes
  and results reach the run; **C21** `status` with `in` reaches only that run's step; **C22**
  old-shape `done` and `status` still pass; **C23** `innytype` spaces and types options
  resolve against a fake Anytype. C16–C19 are reserved by plan 0021.

### C. Read models and persistence

- **Run records (D15)** are tables `runs`, `run_steps`, `run_lines` in `journal.sqlite`, written
  **in the same transaction** as the journal row they follow (journaled, presented, submitted,
  done, error, cancelled, re-sent), so a crash never leaves the two disagreeing. A step keeps its
  input message (≤1 MiB) for re-runs. `PRAGMA user_version` 0→1 only adds tables and indexes;
  journal rows gain only optional fields. The flow id is the source instance's `z`, which the
  registration now hands to every node process's identity.
- **Ops:** `run.list {flowId, state?, since?, search?, cursor?, limit}` (newest first, keyset on
  `(startedAt, runId)`), `run.get`, `run.clearDone` (undoable for a minute). The `jobs` signal
  becomes `runs {flowId}`, coalesced as today.
- **Retention (D8):** `runs.retentionDays`, 90 by default, pruned at start and daily; a run in
  progress is never pruned.
- **Board layouts** are shell state in `boards.json` (ajv-validated, atomic writes,
  `adapters/fs/board-store.ts` beside `placement-store.ts`), untouched by any redeploy;
  `reconcile` runs at read time.
- **No on/off mirror.** The tab's `disabled` flag is the truth; `flows-meta.json` keeps only
  `{flowId: {template, createdAt}}`.

### D. Flow administration (one Node-RED tab is one flow, D7)

- Runtime ops `flow.list`, `flow.setOn`, `flow.rename`, `flow.duplicate`, `flow.export`,
  `flow.delete`, `flow.fromTemplate`, `flow.node.form`, `flow.node.configure`, using only the
  documented `RED.runtime.flows.getFlow/addFlow/updateFlow/deleteFlow`. These bypass the HTTP
  routes, so **every write first calls the same `DeployGuard` check**, and **every write is
  refused while the canvas is dirty**: "Save or discard your changes on the canvas first."
- `flow.list` answers `{id, name, on, health, lastRun, viewNodes[], steps[]}`, `steps` in wire
  order from the sources (the Re-run from… order).
- Duplicate re-maps ids, wires and `z` and copies no credentials (those steps show "not set up").
  Export uses the shell's save dialog and holds no credentials. Delete cancels the flow's inputs
  in hand and deletes its runs, layout, meta, then the tab.
- Templates: `app/templates/<id>.json` (a tab export, no credentials) and `index.json`
  `{id, name, line, packages[], official}`; the build checks each against the guard.
- `flow.node.form` answers the type's config schema (options resolved), values and step name;
  `configure` validates with ajv, writes through `updateFlow`, and deploys that tab only.

### E. Re-run

`run.rerun {flowId, runId, from?}` starts a **new** run with `rerunOf` ("Re-run Tuesday 14:30").
Without `from`, the stored source event is emitted again from the source instance with a fresh
envelope. With `from`, that step's stored input is re-injected through the replay's `redeliver`
handle (`journal-replay.ts:102-114`) with its run re-stamped, and the earlier steps' results are
copied as kept. Refused, with a sentence, when the step is gone or the flow is off; run, with a
card note, when the step's config changed (risk 3). `run.rerunMany` and `run.deleteMany` take ≤100.
`run.delete` cancels the run's inputs in hand and deletes its records and snapshots (snapshot
records gain `run`); Anytype is never touched.

### F. Packages

- **Register / unregister (D6):** `packages.unregistered: [name]` in settings; `loadNodeTypes`
  skips them; files stay; only the runtime restarts. Refused while a deployed or undeployed flow
  uses a type (the `remove-package.ts` check), and the refusal names **every** flow and step that
  uses the package, not only the first. One use keeps the ux-writing sentence; several read:
  "Can't unregister *innyrize*: *Recordings to Anytype* uses its *Transcribe* step and *Invoices
  from the mailbox* uses its *Read PDF* step. Remove those steps first." A shipped package can be
  unregistered, never removed.
- **From a folder:** today's path origin; "Check for changes" re-hashes and re-judges
  (`domain/packages/versions.ts:280-291`); the row says "Unsigned".
- **Go back (D5):** `previous/<name>` is kept 7 days (timestamp in the record, pruned at start).
  Go back calls `rollBack`, restarts the runtime, checks readiness as an update does, and never
  blocks the version it left.
- **Verified states:** installed = content hash re-checked at start and on demand; registered =
  the current generation's `ready.types[]`; update = the last check's time. A `packages` push
  carries `verifiedAt` and install phases (fetching, verifying, building, swapping) as percentages.

### G. InnyTypes' own updates

- `UpdateCheck` publishes its `domain/updates` state (`onUpdateState`) and gains `checkNow`,
  `quitAndUpdate`, `goBack`.
- **Go back (D4):** at install the shell records `update.previous {version, tag, updatedAt}`.
  Within 7 days, Go back fetches that tag's `latest-*.yml` and `.minisig` from its GitHub release,
  verifies them with the same key, checks the artifact's sha512, sets electron-updater's
  `allowDowngrade` and installs at quit (risk 2).
- **Crash-loop offer:** the runtime's crash-loop limit within 10 minutes of the first start on a
  new version makes the banner and one notice offer "Go back to 0.2.1". Never automatic. This
  **replaces** the beat-based automatic rollback; its 15 ledger rows become `replaced` (by D4) or
  `owner-retired-behaviour`, and the owner acknowledged them on 2026-10-02 ("Ack as replaced by
  D4"), recorded as `owner_ack` yes by WI-0022-22.
- **Every 0.3.0 storage change is additive** (§C), so 0.2.1 still reads its data after Go back.

### H. Setup

- `setup {step, completed}` in settings, written at every step, so a quit resumes there. A 0.2.1
  user never sees Setup: migration sets `completed` when flows exist or telemetry is answered.
- Connect Anytype reuses pairing; on success services counts spaces and reads each space's types
  (new ops `anytype.spaces`, `anytype.types`; `listTypes` added to the client).
- The walkthrough (owner, 2026-10-02; D18, D19): **Welcome → Reports → Connect Anytype → Source
  folder → the starter's node forms (one per step, "Step n of N") → Ready**. The Setup sidebar
  lists Welcome, Reports, Anytype, Source folder, Steps and Ready.
- **No package step.** The packages that ship inside the app (D17, D18: `anytype` and `folder` in
  0.3.0) are installed and registered on their own as Setup starts, before Connect Anytype.
  monty and innyrize join once they publish signed archives, the same way.
- **No starter choice.** The starter `folder-to-anytype` is always installed: Setup runs
  `flow.fromTemplate` once, then **Source folder** writes the chosen folder into the starter's
  `folder` source with `flow.node.configure`, and the node forms walk the starter's remaining
  nodes in wire order with `flow.node.form/configure`. The flow is switched on only once its
  health is Ready; until then Flows reads "1 step not set up".
- **Ready** says "Your flow is on. Drop a file in *folder* to start. Or try it now with a
  10-second sample." · **Try with a sample** copies the bundled sample (`app/resources/sample/`)
  into the chosen folder, so the folder source fires and the run is real (WI-0022-25) · **Open
  Live** completes Setup and opens the starter's board · **I'll build my own** (secondary)
  completes Setup and opens Flows, the starter kept.

### I. Status, banner, badge, notifications

`domain/status` derives the pill and banner from `ChildStatus`, `AnytypeStatus` and current
notices; nothing new is supervised. The Live badge and the dock badge count waiting questions
from run records, hidden places included. `Notice` gains `actions[≤3]`, delivered as Electron
notification `actions` where supported (macOS); elsewhere the click opens Live on that run. Each
button is bound to its own `{flowId, runId, viewId}`, so two questions never cross.

## Frontend architecture

### J. Stack (D1, D2)

- **React 19** and **Ark UI (React)**: Dialog, Menu, Select, Combobox, Tabs, Switch, Checkbox,
  Tooltip, Toast, Progress, Popover, SegmentGroup, DatePicker, FileUpload, NumberInput, Slider.
  No other UI library.
- esbuild keeps bundling TSX (`--jsx=automatic`) for `ui/main.tsx` and `ui/view/view.tsx`;
  **Tailwind CSS 4** is its own `build:styles` step with `@tailwindcss/cli`
  (`src/ui/styles/app.css` → `dist/ui/app.css`).
- IBM Plex Sans and Mono (OFL-1.1) from `@fontsource/ibm-plex-*`, copied to `dist/ui/fonts` and
  loaded by `@font-face`. No network.
- The `ui` rule is rewritten: `ui/**` may import `ui/**` and only `react`, `react-dom`,
  `@ark-ui/react`; never `shell`, `application`, `adapters`, `domain`, `ports`. A fixture
  importing `electron` from `ui` must fail. `OFL-1.1` joins `tools/licences.mjs`.

### K. Tokens to code (D10)

`tools/tokens/build.mjs` generates `dist/generated/tokens.css` from the tokens file: `base` as
`:root` properties, `light` as the default semantic set, `dark` under
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and
`:root[data-theme="dark"]`. It runs before `build:styles` and **is not committed**. `app.css`
imports it and declares `@theme { --color-*: initial; … }`, so only token-bound utilities exist
(`bg-red-500` cannot compile). `tools/tokens/check.mjs` joins `gate:architecture` and fails on any
hex, `rgb(`, `hsl(`, `oklch(` literal or arbitrary colour class anywhere in `app/src/ui/**`. The
same `tokens.css` is served beside `view.js` for pop-ups.

### L. Component library (Penpot 1:1)

```
app/src/ui/components/
  atoms/      Button Switch TextField Select Checkbox StatusPill Progress Badge Link Icon Divider Tooltip
  molecules/  Field SuggestedField ListRow ResultLine NavItem DialogButtons NotificationActions
  organisms/  RunCard EmptyState Sidebar TabStrip Dialog RuntimeBanner QuestionPopout FlowsList
              RunHistory GeneralSection PackageRow Board Slot EditLayoutBar CanvasFrame SetupStep
  templates/  PageConfiguration PageCanvas PageLive WindowPopout WindowSetup
```

Props are named after the Penpot axes (`<Button kind="primary" state="loading" size="large">`,
`<RunCard state="done" done="both">`, `<Slot kind="question" size="M" hidden>`); each root carries
`data-component` and `data-variant`. **The gallery (D11)**, route `#/gallery`, renders every
component in every variant with three unrelated sample flows (*Recordings to Anytype*, *Invoices
from the mailbox*, *Photos from the camera card*), only in a dev build (unpackaged or
`INNY_DEV=1`) and stripped or refused when packaged. macOS screenshot baselines of every variant
in light and dark **are in the gate**: `gallery.e2e.ts` compares against committed baselines under
`app/test/e2e/baselines/`, fails on a diff, and regenerates them only with an explicit flag on an
intentional visual change.

### M. Screens and routing

| Route | Screen |
|---|---|
| `#/setup/<step>` | Setup walkthrough, no navigation |
| `#/live/<flowId>?tab=<tabId>` | Live: the flow's board (`#/live` alone: the empty state) |
| `#/configuration/flows` · `/flows/<id>/canvas` · `/flows/<id>/history` | Flows list; canvas frame (Node-RED iframe at `/red/#flow/<id>`, Save and run presses Deploy); Run history |
| `#/configuration/general` | General |
| `#/gallery` | dev only |

The window opens on Setup until `completed`, then Live; a notification opens `#/live/<flowId>`.
The Node-RED editor stays unthemed (risk 1); the generator names the palette categories Sources,
Steps, Questions and results. Pop-ups keep `inny-view://`, partition and CSP; their page becomes
`view.tsx` with `QuestionPopout` and the tokens (Continue, Later, Skip this step confirmed once).

### N. State

- `AppApi` gains: `runs run clearDone rerun rerunMany deleteRuns`; `flows setFlowOn renameFlow
  duplicateFlow exportFlow deleteFlow templates flowFromTemplate nodeForm configureNode
  nodeOptions`; `board saveBoard`; `setup setSetupStep completeSetup trySample`; `updateState
  checkNow quitAndUpdate goBack`; `registerPackage unregisterPackage chooseInstallFolder
  checkFolder goBackPackage`; `anytypeSpaces`; `status retention setRetention`. Push events:
  `onRuns onFlows onBoard onUpdateState onPackages onStatus onSetup`.
- At cutover the calls only old pages used go (`inbox`, `jobs`, `snapshots`, `eventTypes`…).
  Created event types become a source setting inside a flow (strategy brief §5); their runtime
  ops stay for the source's form.
- `ui/store.ts`: one external store per domain read with `useSyncExternalStore`, fed by push
  events; no other state library. Shell wiring goes to new `shell/flow-calls.ts`,
  `run-calls.ts`, `board.ts`, `setup.ts`; `main.ts` only constructs.

### O. Strings

`ui/strings.ts` holds one keyed entry per `ux-writing.md` line (dialogs, errors and
notifications included); components take keys, and a lint rule forbids JSX text literals in
`ui/components` and `ui/screens`. `strings.test.ts` "no string carries an internal" fails on a
UUID, an 8+ hex id, a pid, a port, a path, a type key or a package-internal name, with two
exceptions by key: the AI apps endpoint row and the "From a folder" caption.

### P. Accessibility (D12) and Q. Dark mode

WCAG 2.2 AA. `@axe-core/playwright` runs on every route and dialog in both themes; the gate fails
on any `serious` or `critical` finding. Keyboard paths: the ⋯ menus, every dialog (focus trap,
Escape = Cancel), the segmented filter, row selection, and Edit layout, where drag has a menu
alternative on each place (Move to tab ›, Move earlier, Move later, Size S/M/L, Hide).
`prefers-reduced-motion` disables `quick` and `settle`. Colour comes from tokens only:
`dark-mode.e2e.ts` sets `data-theme="dark"` on every route, samples computed `background-color`
and `color` of every `[data-component]`, and fails when any equals a light-theme surface value.

## Cutover and parity (R)

One work item deletes `app/src/ui/pages/*` and rewrites the e2e specs around the three surfaces
(elements by `data-testid` only). `tools/parity/check.ts` stays green at every item: the 132
Playwright-citing rows are re-pointed in the same commit that moves each test; a row whose
behaviour is gone (the Jobs list, the Events page) becomes `replaced` with its new home, or
`owner-retired-behaviour` with `owner_ack` when a person could see it. The 15 update-health rows
are acknowledged by the owner as replaced by D4 and recorded by WI-0022-22. The old Python app and its tests are untouched (D13).

## Decisions for the owner

- **D1 framework:** React 19, Ark's most used binding with the largest pool; Solid is lighter.
  **Owner: React.**
- **D2 CSS build:** `@tailwindcss/cli` as its own step; esbuild stays for TSX; no Vite, no PostCSS. **Owner: yes.**
- **D3 notes and warnings:** `notes` on `done`: atomic with success, a plain §1.3 addition, and the
  person's words stay out of the redacted log. New `log` levels change a closed enum that old
  runtimes refuse (`node-process.ts:384-386`). **Owner: "Yes, on done".**
- **D4 InnyTypes rollback:** Go back installs the previous signed release, offered 7 days; a crash
  loop within 10 minutes only *offers* it. Needs `owner_ack` on the 15 rows. **Owner: yes.**
  **Ledger, owner: "Ack as replaced by D4"**: the 15 update-health-rollback rows become
  `replaced` with `owner_ack` yes (WI-0022-22 records it).
- **D5 package rollback:** previous environment kept 7 days; Go back swaps and restarts the runtime. **Owner: yes.**
- **D6 unregister:** files kept, types not loaded, refused while used; shipped: never removed.
  **Owner: "Yes, but the package must then warn explicitly which flow is using it"**: the refusal
  names every flow and step that uses the package (§F).
- **D7 a flow:** one Node-RED tab; subflows are not flows; a run belongs to its source's tab. **Owner: yes.**
- **D8 retention:** 90 days, changeable in General (7, 30, 90, 365, Forever). **Owner: "Yes,
  configurable in general config".**
- **D9 options extension:** ~~`x-inny-options` with `from`~~. **Owner: no.** Verbatim: "all
  innytype related information goes to an innytype field that is itself a dict containing the
  spaces field { ..., innytype: { spaces: ...} }". Applied in §B: one `innytype` object per
  property, `{"spaces": true}` or `{"types": {"of": "space"}}`, room left for later keys.
- **D10 generated tokens:** built into `dist/generated`, not committed. **Owner: yes.**
- **D11 gallery:** dev-only route, with macOS screenshot baselines in the gate. **Owner: OK.**
  APPROVED. The route exists in dev builds only (stripped or refused when packaged); baselines of
  every variant in light and dark are committed under `app/test/e2e/baselines/`, the gate fails on
  a diff, and they are regenerated only with an explicit flag on an intentional change.
- **D12 axe:** in the gate, failing on serious and critical. **Owner: yes.**
- **D13 old Python app:** unchanged by 0.3.0; WI-0018-32 still deletes it. **Owner: yes.**
- **D14 tray:** the design names one; plan 0018 F4 forbids it (`no-tray.test.ts`). Recommended:
  none in 0.3.0, dock badge and notification buttons instead; a tray only if F4 is reversed.
  **Owner: "No tray in 0.3.0".**
- **D15 where runs live:** `journal.sqlite`, in the journal's transaction; a second file cannot
  stay consistent across a crash. **Owner: yes.**
- **D16 result lines:** `results` on `done`, by the node that did the thing, in any sink. **Owner: yes.**
- **D17 official packages:** only what ships inside the app. monty and innyrize must publish signed
  archives before WI-0022-17 bundles them; until then Setup lists Anytype and the starter is a
  folder-to-Anytype template. **Owner: "Offer AnyType mcp only until then"**: Setup's package
  step offers the shipped anytype package only; monty and innyrize appear once they publish
  signed archives.
  - 2026-10-02: monty and innyrize have not published signed archives; Setup offers anytype only
    (`application/official-packages.ts`). No folder-watching source ships either: the anytype
    package has nodes only, and Node-RED's own watch node is outside `core/common`. So the
    starter `folder-to-anytype` holds its watch step as a note, and "Try with a sample" has no
    watched folder to drop the sample into until a shipped package provides that source.
  - **Resolved 2026-10-02 (owner):** *"ship a setup step that configures the source folder"*. A
    first-party `folder` source package ships inside the app beside `anytype` (D18, WI-0022-25),
    the starter's watch step becomes its source node, and Setup's package step is removed (D19):
    shipped packages are set up on their own.
- **D18 folder source and its Setup step:** a first-party `folder` source package ships inside the
  app (`packages/folder`): it watches one folder and emits one `created` event per new file, with
  a debounce and partial writes ignored; the e2e fixture source shows the shape. Setup gains a
  **Source folder** step that configures it. **Owner, 2026-10-02: "ship a setup step that
  configures the source folder".** Built by WI-0022-25.
- **D19 Setup sets packages up and walks the forms:** no "Choose your packages" step and no "Start
  with a simple flow?" choice. Shipped packages are set up automatically, the starter is always
  installed, its node forms are walked at setup time, and "I'll build my own" is a secondary
  action on Ready. **Owner, 2026-10-02: "change setup steps to automatically setup the right
  plugins and go through the configuration step at setup time".** §H, WI-0022-16.
- **D20 scrim token:** `surface.scrim` in the light and dark sets, as hex8 colours because DTCG
  colour tokens cannot carry an opacity: light `#1c233099` (ink.1 at 60%), dark `#0f1216b3`
  (night.0 at 70%). The Dialog's scrim uses it instead of a raw ramp. **Owner, 2026-10-02: "add
  surface.scrim".**
- **D21 dialog radius:** the Dialog's radius is l (12), the same as a pop-out. **Owner,
  2026-10-02: "make same -> l".**
- **D22 accessibility departures accepted** as the code has them, recorded in `design-system.md`
  as the rule: pressed Primary and Destructive darken 10% (brightness 90%) instead of 80%
  opacity; the Select placeholder uses text.secondary; result-line links are underlined at rest;
  hidden places are inert at 40% opacity. **Owner, 2026-10-02: accepted.**
- **D23 telemetry endpoints:** usage counts go to Umami Cloud, endpoint `https://cloud.umami.is`,
  website id `84cf224b-98ed-426f-8829-43f872e36cab` (a public id, not a secret), posted to
  Umami's `/api/send`. Crash reports have no GlitchTip endpoint yet and stay unsent; the Reports
  section says so. Consent still gates everything. **Owner, 2026-10-02.** Built by WI-0022-26.
- **D24 build output in lint ignores:** generated build output (`dist/`) is listed in the lint
  ignores; it is never committed and never linted as source. **Owner, 2026-10-02.**

## Risks

1. **Node-RED editor boundary:** the canvas keeps Node-RED's look, and app writes during unsaved
   edits would collide with its merge prompt. Unthemed by decision; writes refused while dirty.
2. **electron-updater has no rollback:** a verified downgrade from a pinned tag with
   `allowDowngrade`; machine proof `update-go-back` (0.3.0 → 0.2.1 → 0.3.0, macOS).
3. **Re-run after the flow changed:** refused when the step is gone, noted when its config
   changed, the stored input validated against the step's declared input first.
4. **Migrations on the owner's real journal:** additive only, a `journal.sqlite.pre-0.3.0` copy
   first, tested on a 0.2.1 fixture database, **never** on the owner's files or real Anytype.
5. **Font licence:** OFL-1.1 added explicitly; fonts ship whole with their licence file.
6. **The `owner_ack` backlog:** the 15 update rows (acknowledged as replaced by D4) plus every
   visible behaviour the cutover moves, batched in `docs/parity/owner-review.md` by WI-0022-22.
7. **Ark UI under the pop-up CSP:** CSSOM writes pass `style-src 'self'`, `setAttribute('style')`
   does not; an e2e opens every Ark widget in the pop-up under the byte-identical CSP.
8. **Notification buttons are macOS-only in Electron;** the click path works everywhere.
9. **External package releases (D17)** can delay Setup's list; they never block the release.

## Acceptance

- Unit: `runs.test.ts` "one card per source event", "failure is never a warning", "resumed
  after replay"; `board.test.ts` "a new view node appends a slot", "a removed node removes its
  slot", "the last tab stays", "hidden never hides a waiting question"; `flows-health.test.ts`;
  `updates-state.test.ts` "every state has its sentence"; `setup.test.ts` "resumes at the same step".
- `test/integration/run-records.test.ts`: "a crash between journal and record is impossible",
  "retention never prunes a run in progress", "additive migration" (0.2.1 fixture database).
- `test/conformance/protocol-2-1.test.ts`: C20–C23 for the Python, TS and raw nodes; C1–C15 unchanged.
- e2e: `node-options` "spaces and types in a step's form" (canary absent from editor and log);
  `flows` "rename, duplicate, export, delete", "refused while the canvas has unsaved changes", "a
  template that fails the guard is refused"; `run-history` "re-run makes a new card", "re-run
  from a step keeps earlier results", "delete keeps Anytype objects", "a step no longer in the
  flow is refused"; `packages` "unregister refused while used, naming every flow and step", "install from a folder, check
  for changes", "go back within seven days, not after", "no state without checked-when";
  `updates` "every state sentence", "go back verifies the old release", "tampered old release
  refused"; `setup` "quit mid-setup resumes", "the starter's forms, then Ready, then Open Live lands in
  Live", "I'll build my own lands in Flows", "never shown again", "a 0.2.1 user never sees setup"; `live`
  "three runs, three cards", "edit layout survives a redeploy", "a hidden question still notifies
  and counts", "clear done is undoable", "keyboard move and resize"; `gallery` "every component,
  every variant, light and dark" against the committed macOS baselines in `app/test/e2e/baselines/`; `a11y` no serious or critical finding; `dark-mode` "no light
  fill in dark". Machine proof `update-go-back` passes.
- `tools/tokens/check.mjs` fails on `#fff` in `ui/`; `strings.test.ts` and `tokens.test.ts` pass.
- `app/src/ui/pages` is gone; `tools/parity/check.ts` reports 0 undecided for WI-0022-*, every
  needed `owner_ack` `yes`; `docs/loop/verify.sh` exits zero and prints `gate: GREEN`.

## Work items

Approved 2026-10-02 and seeded to `docs/loop/inbox/WI-0022-*.yaml`. Every block also
carries `canonical_id: '0022'`, `canonical_source: plans`, `status: TODO`, `slice` equal to its own number, and the last bullet
`'docs/loop/verify.sh exits zero and prints gate: GREEN.'` (plan 0018 §8.3). S is up to a day of
loop cycles, M a few; nothing is L. **26 items: 5 S, 21 M** (25 and 26 added 2026-10-02 for D18
and D23).

**Order.** At most two at once, each gated in its own worktree; one writer per shared file per
wave: `ui/contract.ts`, `shell/ipc.ts`, `ui/strings.ts` written whole by 10, never after;
`shell/main.ts` 16 then 20 rebases (wave 11); `runtime/main.ts` 08 (wave 4), 09 (wave 5), 15
then 19 rebases (wave 10); `app/package.json` and the lockfile 01, 17 and 26; the ledger 21 and 22.
25 takes wave 7's free slot beside 11 (it writes `packages/folder`, `app/templates` and
`flows.e2e.ts`, none of 11's files) and lands before 16; 26 runs after 20, beside 21 in wave 12.

| Wave | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Runs | 01 ∥ 02 | 03 ∥ 04 | 05 ∥ 06 | 07 ∥ 08 | 09 ∥ 17 | 10 | 11 ∥ 25 | 12 ∥ 18 | 13 ∥ 14 | 15 ∥ 19 | 16 ∥ 20 | 21 ∥ 26 | 22 ∥ 23 | 24 |

```yaml
- id: WI-0022-01-ui-stack-and-tokens
  title: React, Ark UI, Tailwind 4, Plex fonts and generated tokens, with the gates that hold them
  intent: Every screen needs the stack and the token rules first, enforced by the gate, not by convention.
  acceptance:
  - build:styles and tools/tokens/build.mjs produce dist/ui/app.css and dist/generated/tokens.css, nothing generated committed; the section J ui rule passes and its electron fixture fails it; OFL-1.1 added and the licence stage passes; tools/tokens/check.mjs in gate:architecture fails on the first raw colour in app/src/ui/** outside the generated tokens file, proven by a fixture; tokens.test.ts "dark guarded by data-theme" passes.
  size: M
  depends_on: []
- id: WI-0022-02-domain-runs-board-flows-setup-status
  title: Pure domain for runs, boards, flow health, setup and the status pill
  intent: The surfaces are views over these rules; prove them without a DOM or a runtime.
  acceptance:
  - domain/runs, board, flows, setup and status as section A; the runs, board, flows-health and setup tests named in Acceptance pass.
  size: M
  depends_on: []
- id: WI-0022-03-atoms-molecules-and-gallery
  title: Atoms and molecules mirroring Penpot, and the dev-only gallery route
  intent: Penpot is the spec; the code names the same components and axes so drift is visible.
  acceptance:
  - Every atom and molecule of design-system.md exists with props named after its axes and data-variant set; '#/gallery' exists in dev builds only and is stripped or refused when packaged; gallery.e2e.ts compares every variant in light and dark against committed macOS baselines under app/test/e2e/baselines/, fails on a diff in the gate, and regenerates them only with an explicit flag on an intentional change.
  size: M
  depends_on: [WI-0022-01-ui-stack-and-tokens]
- id: WI-0022-04-protocol-2-1
  title: done notes and results, status progress and innytype schema options, in spec, schema, codec and both SDKs
  intent: A run card shows only what a node can say; the additions stay optional so no package breaks.
  acceptance:
  - Spec revision 2.1 and the frame schema carry section B with the wire integer still 2; a config schema property declares options only as an innytype object, innytype.spaces true or innytype.types.of naming the sibling space property, and no x-inny-* key exists; C20 to C23 pass for the Python, TS and raw reference nodes and C1 to C15 pass unchanged.
  size: M
  depends_on: [WI-0022-02-domain-runs-board-flows-setup-status]
- id: WI-0022-05-organisms-and-templates
  title: Organisms and templates, drawn with sample data from three unrelated flows
  intent: The screens are assembled from these; the samples prove no component reads as one story.
  acceptance:
  - Every organism and template is in the gallery in every variant with the three sample flows, RunCard Done with Notes, Warnings and Both included; Slot has the section P keyboard menu.
  size: M
  depends_on: [WI-0022-03-atoms-molecules-and-gallery]
- id: WI-0022-06-run-records
  title: Run records in the journal's transaction, the runs read model, retention and the flow id
  intent: The journal forgets a run when it ends (entry.ts:3-4); Live and Run history need what it forgets without ever disagreeing with it.
  acceptance:
  - Section C's tables, user_version migration, pre-0.3.0 copy, run.* ops and z in every identity; the three run-records.test.ts cases pass; the runs signal replaces jobs and reaches the shell from the composition root, proven by an e2e that fires a created event and sees run.list grow.
  size: M
  depends_on: [WI-0022-02-domain-runs-board-flows-setup-status, WI-0022-04-protocol-2-1]
- id: WI-0022-07-domain-packages-and-updates
  title: Package states with checked-when, and the self-update state machine
  intent: A row never shows a state InnyTypes has not verified; the update sentences come from one machine.
  acceptance:
  - domain/packages/states.ts and domain/updates as section A; "every state has its sentence" and "no state without verifiedAt" pass.
  size: S
  depends_on: [WI-0022-02-domain-runs-board-flows-setup-status]
- id: WI-0022-08-flow-administration-and-templates
  title: Flows listed, switched, renamed, duplicated, exported, deleted and made from templates, through the guard
  intent: The runtime owns flow writes, never the page, and never past the deploy guard.
  acceptance:
  - Section D's flow.* ops, each write through DeployGuard and refused while dirty; app/templates with index.json checked at build; the three flows.e2e.ts cases pass.
  size: M
  depends_on: [WI-0022-06-run-records]
- id: WI-0022-09-anytype-options-in-forms
  title: Spaces and types read from Anytype into node forms, on the canvas and in Setup
  intent: The owner's O3, destinations chosen from real Anytype data, with the key kept in services.
  acceptance:
  - listTypes, anytype.spaces and anytype.types, the /red/inny/options route resolving innytype.spaces and innytype.types.of, and dynamic selects with "Reading your spaces…" and the not-paired sentence; node-options.e2e.ts passes with the canary absent; rebased on WI-0022-08's runtime/main.ts as its last change.
  size: M
  depends_on: [WI-0022-04-protocol-2-1, WI-0022-08-flow-administration-and-templates]
- id: WI-0022-10-appapi-v2-store-and-strings
  title: The whole AppApi of section N, the push events, the store and strings.ts
  intent: One contract change, landed whole, so no screen item touches the shared files.
  acceptance:
  - contract.ts, ipc.ts, app-bridge.ts and the new shell/*-calls.ts carry section N, shell/main.ts stays at or under 600 lines and only constructs, and contract tests cover every new call without a DOM; store.ts uses useSyncExternalStore only; strings.ts holds every ux-writing.md line; "no string carries an internal" passes.
  size: M
  depends_on: [WI-0022-06-run-records, WI-0022-07-domain-packages-and-updates, WI-0022-08-flow-administration-and-templates, WI-0022-09-anytype-options-in-forms]
- id: WI-0022-11-app-frame-routing-and-status
  title: Sidebar, hash routes, status pill, runtime banner, dialogs and the quit question
  intent: Every surface sits in this frame; the pill and banner must follow the supervisors.
  acceptance:
  - The section M routes resolve and the window opens on Setup until completed, then Live; pill and banner follow ChildStatus in the supervision e2e (Restart is Primary); the quit dialog has the three ux-writing buttons.
  size: M
  depends_on: [WI-0022-05-organisms-and-templates, WI-0022-10-appapi-v2-store-and-strings]
- id: WI-0022-12-live-board-and-edit-layout
  title: One board per flow, with tabs, places, sizes, hidden places and Edit layout
  intent: The room where the application lives; the layout is InnyTypes' state and survives every redeploy.
  acceptance:
  - board-store.ts and read-time reconcile; the Edit-layout bar, Add tab, the Remove tab dialog, Hidden (n), the once-only "New on the board" line; live.e2e.ts "edit layout survives a redeploy" and "keyboard move and resize" pass.
  size: M
  depends_on: [WI-0022-11-app-frame-routing-and-status]
- id: WI-0022-13-run-cards-questions-and-notifications
  title: Run cards in every state, inline questions, Later and Skip, notifications with buttons, badges
  intent: Moments 2 to 4 of interaction-design.md, from real run records, reaching the person when the window is closed.
  acceptance:
  - live.e2e.ts "three runs, three cards", "a hidden question still notifies and counts" and "clear done is undoable" pass; Copying turns to Safe to unplug on phase copied; notice actions bound per run; the start notification stops after five good runs; the dock badge counts waiting questions; view.tsx draws QuestionPopout with tokens.css and Ark widgets work under the byte-identical CSP.
  size: M
  depends_on: [WI-0022-12-live-board-and-edit-layout]
- id: WI-0022-14-configuration-flows-and-canvas
  title: The Flows list with health and the ⋯ menu, New flow from a template, and the canvas frame
  intent: Changing a flow is a place you go, not the home screen; the canvas keeps Node-RED's words inside it.
  acceptance:
  - Rows with switch, Last run, health, Edit, Run history and the ⋯ menu; the Delete dialog; template cards; the canvas frame with Save and run and Unsaved changes; palette categories Sources, Steps, Questions and results.
  size: M
  depends_on: [WI-0022-11-app-frame-routing-and-status, WI-0022-08-flow-administration-and-templates]
- id: WI-0022-15-run-history-and-rerun
  title: Run history with filters, search, selection, Re-run, Re-run from…, bulk and delete
  intent: A run is found again, read and re-run here; the board only filters it.
  acceptance:
  - Section E's ops and the design-system screen with the Selected bar and the row menu; the four run-history.e2e.ts cases pass.
  size: M
  depends_on: [WI-0022-13-run-cards-questions-and-notifications, WI-0022-14-configuration-flows-and-canvas]
- id: WI-0022-16-setup-walkthrough
  title: Setup from Welcome to Ready, resumable, with node forms and Try with a sample
  intent: A working flow within ten minutes, once and out of the way, never a settings page.
  acceptance:
  - Section H with the ux-writing strings and the 0.2.1 migration; the walkthrough is Welcome, Reports, Connect Anytype, Source folder, the starter's node forms ("Step n of N"), Ready, with the sidebar listing Welcome, Reports, Anytype, Source folder, Steps and Ready; there is no package step and no starter choice, the shipped packages are set up on their own and the starter is always installed; Ready offers Try with a sample, Open Live and I'll build my own (secondary); Try with a sample copies the sample into the chosen folder and a real run reaches Done; domain/setup's steps follow section A and setup.test.ts "resumes at the same step" passes on them; the five setup.e2e.ts cases pass.
  size: M
  depends_on: [WI-0022-14-configuration-flows-and-canvas, WI-0022-09-anytype-options-in-forms, WI-0022-17-official-packages-starter-and-sample, WI-0022-25-folder-source-package]
- id: WI-0022-17-official-packages-starter-and-sample
  title: Official packages shipped in the app, the starter template and the 10-second sample
  intent: Only what ships is set up (D17); the sample runs the starter flow for real once WI-0022-25 ships the folder source.
  acceptance:
  - index.json marks official templates; the starter passes the guard against the shipped packages; app/resources/sample holds a 10-second file with its licence; the shipped packages are the ones Setup sets up on its own (anytype in this item; folder added by WI-0022-25), and the starter is the folder-to-Anytype template; monty and innyrize are not shipped until they publish signed archives, and the item records that they are missing.
  size: S
  depends_on: [WI-0022-08-flow-administration-and-templates]
- id: WI-0022-18-general-tab
  title: General — Anytype, Recorders and folders, AI apps, Start at login, Reports, Advanced, retention
  intent: Settings about no single flow, each with its one-line state; the old Settings page's behaviours land here.
  acceptance:
  - Every section's state line and actions from ux-writing.md, See what would be sent in full, Advanced with the status details, retention 7/30/90/365/Forever; the anytype, mcp-endpoint, telemetry and desktop e2e behaviours pass on General.
  size: M
  depends_on: [WI-0022-11-app-frame-routing-and-status]
- id: WI-0022-19-package-management
  title: Register, unregister, install from catalogue or folder, update, check for changes and go back
  intent: Every state is verified with its checked-when, and nothing in use vanishes from a flow.
  acceptance:
  - Section F and the unsigned dialog; an unregister refused while in use names every flow and step that uses the package, one use with the ux-writing sentence and several in one sentence ending "Remove those steps first."; the four packages.e2e.ts cases pass; rebased on WI-0022-15's runtime/main.ts as its last change.
  size: M
  depends_on: [WI-0022-18-general-tab, WI-0022-07-domain-packages-and-updates]
- id: WI-0022-20-app-updates-and-go-back
  title: InnyTypes' own update status, Check now, Quit and update, Go back, and the crash-loop offer
  intent: electron-updater has no rollback; going back must be as verified as going forward (plan 0003 D10).
  acceptance:
  - Section G; the three updates.e2e.ts cases pass; proof update-go-back is in proofs.csv as todo for WI-0022-24; rebased on WI-0022-16's shell/main.ts as its last change.
  size: M
  depends_on: [WI-0022-18-general-tab, WI-0022-07-domain-packages-and-updates]
- id: WI-0022-21-cutover-old-pages
  title: Remove the seven old pages and their AppApi calls, and rewrite the e2e suite around the three surfaces
  intent: Sudden and massive and CORRECT; one release with the new UI only, every old behaviour accounted for.
  acceptance:
  - app/src/ui/pages, the old-only AppApi calls and their IPC channels are gone; every e2e finds elements by data-testid; the 132 Playwright-citing ledger rows name the new spec titles, and tools/parity/check.ts passes in the same commit.
  size: M
  depends_on: [WI-0022-15-run-history-and-rerun, WI-0022-16-setup-walkthrough, WI-0022-19-package-management, WI-0022-20-app-updates-and-go-back]
- id: WI-0022-22-parity-ledger-decided
  title: Every ledger row this plan moves or retires is decided, with the owner's acknowledgements
  intent: The update-health rows and every visible retirement need the owner; a ledger that waits is a list of intentions.
  acceptance:
  - The 15 test_helper_core_update.py rows become replaced by D4 with owner_ack yes, as the owner acknowledged on 2026-10-02 ("Ack as replaced by D4"); they and every row the cutover made user-visible carry fate, reason_code and owner_ack yes, listed in owner-review.md as one batch; check.ts --wi WI-0022-22 reports 0 undecided.
  size: S
  depends_on: [WI-0022-21-cutover-old-pages]
- id: WI-0022-23-accessibility-and-dark-mode
  title: axe on every route and dialog in both themes, keyboard paths, reduced motion, dark-mode sampling
  intent: WCAG 2.2 AA is a gate, not a review; state is never colour alone.
  acceptance:
  - a11y.e2e.ts reports no serious or critical finding; dark-mode.e2e.ts passes; every icon-only control has a label from strings.ts.
  size: M
  depends_on: [WI-0022-21-cutover-old-pages]
- id: WI-0022-24-release-0-3-0
  title: Release 0.3.0, tested locally first, then shipped
  intent: The 0.2.1 rule; the owner installs the built DMG on their own Mac before anything is published.
  acceptance:
  - app/package.json is 0.3.0; CHANGELOG and docs/INSTALL.md describe Setup, the three surfaces and Go back; the arm64 and x64 DMGs are installed locally over a 0.2.1 install with flows before the tag is pushed, and proof update-go-back passes.
  size: S
  depends_on: [WI-0022-17-official-packages-starter-and-sample, WI-0022-22-parity-ledger-decided, WI-0022-23-accessibility-and-dark-mode]
- id: WI-0022-25-folder-source-package
  title: A first-party folder source package
  intent: The starter needs a source that ships (D18); without one it cannot run and Try with a sample has nowhere to drop the sample.
  acceptance:
  - packages/folder with inny-package.json; a source that watches one folder and emits one created event per new file, with a debounce and partial writes ignored, in the shape of the e2e fixture source; it passes conformance against the reference suite; it ships inside the app beside anytype; the starter template uses it as its source and passes the check; flows.e2e.ts makes a flow from the starter that reads "1 step not set up", then Ready once the folder and the space are set.
  size: M
  depends_on: [WI-0022-04-protocol-2-1, WI-0022-08-flow-administration-and-templates]
- id: WI-0022-26-telemetry-endpoints
  title: Telemetry endpoints, Umami Cloud for usage counts, crash reports unsent
  intent: Consent was asked for but nothing had anywhere to go (D23); usage counts now reach Umami Cloud, crash reports wait for a GlitchTip endpoint.
  acceptance:
  - The Umami endpoint https://cloud.umami.is and website id 84cf224b-98ed-426f-8829-43f872e36cab are baked in as defaults in app/package.json's innytypes block; consent still gates everything; the GlitchTip DSN stays unset and the Reports section says "Crash reports aren't sent yet."; a unit test proves nothing is posted before consent and one usage event is posted to /api/send after it.
  size: S
  depends_on: [WI-0022-20-app-updates-and-go-back]
```
