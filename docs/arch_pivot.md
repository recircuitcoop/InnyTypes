# Plan 0017, slice 01: the Node-RED spike — report

Branch `spike/0017-node-red`, worktree `innytypes-spike-0017`, all code under `spike/`.
Commits d70d2ec, e47e027, bba89ac. Run on macOS 26 (Darwin 25.3, arm64), 2026-09-25.

Stack:
- Electron 44.4.5, with bundled Node 24.21.0. Node-RED 5 needs Node 22.9 or later.
- Node-RED 5.0.7, embedded with `RED.init` on the app's own Express 4.22.2 server.
- Python 3.13: the spike venv in dev, and python-build-standalone 3.13.12 in the package.
- monty 0.1.0, installed unchanged (read-only) from `~/git/monty`.

## 1. Verdict

Overall: PASS on macOS for P1–P7 and P8-macOS. P8-Windows is BLOCKED, so the spike as a whole is
BLOCKED-in-part. Nothing in Node-RED's core was patched or forked, so the fail condition was not met.

| | Verdict | Evidence |
|---|---|---|
| P1 distinct types | PASS | See below |
| P2 a real flow | PASS | See below |
| P3 a long job | PASS | See below |
| P4 retry and pending views | PASS | See below |
| P5 isolation | PASS | See below |
| P6 compatibility table | PASS | Section 3 |
| P7 locked palette | PASS | See below |
| P8-macOS packaging | PASS | See below |
| P8-Windows | BLOCKED | No Windows machine |

### P1 — distinct node types: PASS

Five types are generated at startup from `packages/*/inny-package.json` by `runtime/generate.js`.
Node-RED loads them through `settings.nodesDir`.

| Type | Kind | Package | Outputs |
|---|---|---|---|
| Folder watcher | source | monty | `new`, `updated`, `deleted` |
| Diarize | node | innyrize (stub) | `diarized` |
| Create Anytype object | node | anytype | `created` |
| Name the speakers | action view | views | `named` |
| Result | snapshot view | views | `recorded`, plus the action port `Run again` |

Each type has:
- its own palette entry and category ("InnyTypes sources", "InnyTypes nodes", "InnyTypes views"),
  plus its own icon and label;
- one output per event type, labelled with the event name, for example `new (monty.new.v1)`;
- an edit form generated from its JSON Schema: text, number, checkbox and select inputs, with the
  schema's descriptions shown as tips;
- its secrets (`writeOnly` / `x-secret`) as Node-RED credentials.

The credential path was exercised with Diarize's `hf_token`:
- it is stored only encrypted, in `flows_cred.json`;
- it arrived in the start frame, and the log says "hf_token present";
- its value appears in no log, journal or flow file.

Evidence:
- `evidence/p1-01-canvas-p2-flow.png`
- `evidence/p1-02-diarize-form.png`
- `evidence/p1-03-folder-watcher-form.png`
- `evidence/p1-04-canvas-after.png`
- The editor's own `RED.nodes.getType()` returned the category, inputs, outputs, output labels,
  default fields and credential fields for each type.

### P2 — a real flow: PASS

The flow: Folder watcher → Diarize → Name the speakers → Create Anytype object → Result.

1. monty's REAL `monty.triggers.folder.FolderWatcher` drove the source, not a fallback. The adapter
   is `packages/monty/folder_watcher.py`. It builds the watcher from the instance config, with its
   state file in the instance's own data folder, and turns each `Change` into an emit on the port
   named after the change kind.
2. A new `.wav` file in the watched folder (`spike/scratch/inbox`) emitted `monty.new.v1`.
3. The Diarize stub ran for 3 s, with progress, and emitted `innyrize.diarized.v1` with a folder.
4. Name the speakers presented a form in the app's Inbox, with a badge and a notification. The flow
   waited.
5. I quit and restarted the app at this point (P4). The view was still pending afterwards.
6. I filled the form through the real app page and pressed Submit. The submission became the
   view's output.
7. Create object made a real object on the local Anytype API, in the space "Cleanup".
8. Result recorded a snapshot and passed the event through.
9. Later I opened the snapshot from the app's Snapshots list and pressed "Run again".
   - A FRESH message, with a new run id and a new `_msgid`, left the Result node's action port.
   - It reached the debug node and Diarize wired to that port, and a new "Name the speakers" view
     was presented.

The run id and `_msgid` of the first run stayed the same across the restart in step 5.

A snapshot action that cannot run is shown disabled, with its reason. This was tested on the
packaged app, and each press was refused with HTTP 409 and the same reason:
- with the action port unwired: "Nothing is wired to the "Run again" output.";
- with the Result node deleted from the flow: "The view that took this snapshot is no longer in
  the flow.".

A press is never silently dropped.

The action view can also be dismissed from the Inbox. The dismissal is an error frame, which
reaches the Catch node.

Evidence:
- `evidence/p2-01-inbox-pending-before-quit.png`
- `evidence/p2-02-snapshot-opened.png`
- `evidence/p2-03-run-again-pressed.png`
- `evidence/p2-04-snapshot-action-disabled-view-deleted.png`
- `evidence/logs/dev-innytypes.log`, from 12:13:16 to 12:14:23

### P3 — a long job: PASS

- The "Diarize (15 min)" node in the Lab flow ran with a duration of 900 s.
- It sent a status frame every 5 s, which appeared under the node on the canvas.
- At 10:44 into the job the status read "diarizing long.wav: 71% (640s of 900s)".
- I then pressed the real Cancel button on the app's Jobs page, through the page. The process
  stopped the job and sent `error "cancelled after 644s"`. That became `done(err)` and reached the
  Catch node.
- Nothing in Node-RED or the runtime has an input timeout, and none was hit.

Evidence:
- `evidence/p3-01-canvas-progress-after-10-min.png`
- `evidence/p3-02-jobs-before-cancel.png`
- `evidence/p3-03-jobs-after-cancel.png`
- `evidence/p3-04-canvas-after-cancel.png`
- `evidence/logs/p3.out`
- `evidence/logs/dev-innytypes.log`, from 12:15:54 to 12:26:39

### P4 — retry and pending views: PASS

1. **Quit mid-job, restart** (`tools/p4.sh retry-once`, `evidence/logs/p4-once.out`):
   - I quit 12 s into a 40 s job.
   - On restart the log shows "re-sending journaled input b07a46bf… (attempt 2, sent)".
   - The job completed, the debug node received it, and the Complete node fired.
2. **Quit mid-job twice** (`tools/p4.sh retry-fail`, `evidence/logs/p4-fail.out`):
   - After the second restart the log shows "input 0ca569b1… failed: not done after 2 attempts".
   - The error reached the Catch node with the original message.
3. **Quit with an action view pending, restart:**
   - The journal kept the entry as "awaiting". On restart it was re-sent, and the view process
     presented it again under the SAME input id.
   - It was still in the Inbox, and was then submitted normally (P2 step 5).
   - A pending view does not use up retry attempts, because waiting may take days across many
     restarts.

### P5 — isolation: PASS

- Every node instance is its own process. Seven were running, each with its own PID, listed on the
  app's Jobs page.
- I killed the "Diarize (40 s)" process with `kill -9` 5 s into a job, at 12:16:19. Then:
  - The runtime logged "process exited unexpectedly (signal SIGKILL)" and failed the in-flight
    input with `done(err)`. The Catch node received it, with the error, the source node and a stack
    trace, and printed it to the log.
  - The 15-minute job in another Diarize process kept running without a gap: 25 s, 30 s, 35 s…
  - The watcher, the other Diarize and the three view and Anytype processes kept the same PIDs.
  - Node-RED's admin API still answered (`/red/flows` returned 200).
  - A new file dropped in the watched folder 4 s later went through the watcher, Diarize and on to
    Name the speakers.
  - The killed node was respawned 1 s later, with a new PID, and was ready.
- An input that fails inside the node (a missing file) also takes the `done(err)` path to the Catch
  node.

Evidence: `evidence/logs/dev-innytypes.log`, from 12:16:13 to 12:16:39.

### P7 — a locked palette: PASS

**npm installs.**
- Settings: `externalModules.palette.allowInstall: false`, `allowUpload: false`,
  `modules.allowInstall: false`, `autoInstall: false`, and deny-all lists.
- With these, Node-RED does not mount the install route at all. `POST /red/nodes` returns 404 for
  an install by module name, an install by URL, and a tarball upload.
- The editor has no "Manage palette" menu item.

**A module dropped by hand into `userDir/node_modules`.**
- I planted a fake `node-red-contrib-spike-probe`, a module that logs a warning when it loads, and
  restarted the app.
- It was not loaded and does not appear in the node list. Node-RED only loads modules listed in the
  userDir's `package.json`.

**Core nodes that remain.** These are Node-RED's `core/common` folder: plumbing that runs no user
code.

| Node | Why it stays |
|---|---|
| inject | test trigger; no code |
| debug | output and log |
| catch | error routing (P5) |
| complete | completion routing |
| status | status routing |
| link in / link out / link call | wiring |
| comment | notes |
| junction | layout |
| global-config | required by Node-RED |
| unknown | required by Node-RED, as the placeholder for missing types |

**Core nodes excluded.** Every other core node file, through `settings.nodesExcludes`, computed at
startup from Node-RED's own `core/` folders. No patch was needed.
- Code-running nodes: function (`10-function.js`), exec (`90-exec.js`), template
  (`80-template.js`).
- Everything else: switch, change, range, delay, trigger, rbe, tls, http proxy, mqtt, http in,
  http request, websocket, tcp, udp, csv, html, json, xml, yaml, split, sort, batch, file and
  watch.
- `functionExternalModules: false` is also set.

**Importing a flow that contains excluded nodes.**

1. Deployed through the admin API with no guard:
   - The flow contained function, exec and template nodes, with an inject wired to an exec running
     `touch /tmp/SHOULD_NOT_EXIST_spike0017`.
   - Node-RED ACCEPTED it (HTTP 204).
   - The excluded nodes never ran, and the marker file does not exist.
   - BUT Node-RED then stopped EVERY flow and logged "Waiting for missing types to be registered:
     function, exec, template". All seven InnyTypes processes were closed. One imported flow took
     the whole runtime down.
2. So I added a guard in `main.js`:
   - It is ordinary Express middleware on `POST /red/flows`, placed in front of `RED.httpAdmin`,
     outside Node-RED.
   - It checks every node's type against `RED.nodes.getType()`, which is public in the embedding
     API.
   - It refuses the deploy with HTTP 400:
     `{"code":"unknown_types","message":"Not installed in InnyTypes: function, exec, template"}`.
   - All seven processes kept running.
3. Import through the editor (`RED.view.importNodes`, the same path as Import from the menu):
   - The editor showed the nodes as "unknown: function" and "unknown: exec", with "Imported
     unrecognised types".
   - Deploy gives Node-RED's own "The workspace contains some unknown node types… Are you sure?"
     dialog.
   - After "Confirm deploy", the editor showed "Deploy failed: … Not installed in InnyTypes:
     function, exec". Nothing was deployed and nothing ran.
4. The same guard refused the same flow on the packaged app.

Evidence:
- `evidence/p7-01-editor-import-excluded-nodes.png`
- `evidence/p7-02-editor-deploy-excluded-nodes.png`
- `evidence/p7-03-editor-deploy-refused.png`
- `evidence/logs/flows-with-excluded.json`
- `evidence/logs/dev-innytypes.log`, at 12:38:54 (without the guard) and at 12:39:44 and 12:40:27
  (refused)

### P8 — packaging

**macOS: PASS.**
- Built with electron-builder 26.15.3 using `electron-builder --mac dir`: unsigned, arm64,
  425 MB. Output: `spike/dist/mac-arm64/InnyTypes Spike.app`.
- It bundles:
  - Node-RED 5.0.7 inside the app archive;
  - the node packages, unpacked from the archive through `asarUnpack` so their Python files can be
    run;
  - python-build-standalone CPython 3.13.12, downloaded with
    `UV_PYTHON_INSTALL_DIR=… uv python install 3.13` and copied to `Contents/Resources/python`,
    with monty and psutil installed into it by
    `uv pip install --python … --break-system-packages ~/git/monty`.
- The packaged app uses its own bundled Python. Every node process was
  `…/Contents/Resources/python/bin/python3 …/app.asar.unpacked/packages/…`.
- It ran the full P2 flow on its own port and data folder:
  - watched folder, Diarize, and the action view submitted through the page;
  - a real Anytype object;
  - the snapshot, and Run again starting a new run.
- It also passed the disabled-action tests, and a smoke run of the final build: the deploy guard,
  stderr routing and the error path.
- Evidence: `evidence/p8-01-packaged-snapshot-run-again.png`,
  `evidence/logs/packaged-innytypes.log`.

**Windows: BLOCKED.**
- There is no Windows machine, and nothing was claimed.
- Needed:
  - a Windows 11 x64 machine or VM with Node 22 or later;
  - an `electron-builder --win dir` build;
  - a Windows python-build-standalone in `build-python/python`, where the Python path becomes
    `python\python.exe` instead of `python/bin/python3`;
  - the P2 to P5 runs repeated there.
- Likely issues:
  - The path fix-up in `realDir()` handles `app.asar` with the platform separator but is untested
    on Windows.
  - Closing children with `SIGKILL` is emulated on Windows.

## 2. Did anything require patching or forking Node-RED core?

No. `node_modules/node-red` and `node_modules/@node-red/*` are exactly as npm installed them. The
spike uses only public surfaces:

- **Embedding:** `RED.init(server, settings)`, `RED.start()`, `RED.stop()`, and `RED.httpAdmin` and
  `RED.httpNode` mounted on the app's own Express app.
- **Settings:** `userDir` (inside `spike/`), `nodesDir`, `nodesExcludes`, `externalModules`,
  `functionExternalModules`, `credentialSecret` (a random secret in userDir, not in git), a custom
  `logging` handler, and `editorTheme`.
- **Node API:**
  - `RED.nodes.createNode`, and `RED.nodes.registerType(type, ctor, {credentials})`;
  - `on('input', (msg, send, done))` and `on('close', (removed, done))`;
  - `node.status`, `node.send`, `node.receive`, `node.warn`, `node.error`;
  - `RED.util.cloneMessage`.
- **Runtime:** `RED.events` (`flows:started`) and `RED.nodes.getType`.
- **Admin HTTP API:** `POST /red/flows` and `POST /red/inject/:id`.

The deploy guard (P7) and the app's own API at `/app/api` are Express routes on the app's server.
They are not inside Node-RED.

## 3. Node protocol v2, as drafted

Transport:
- JSON lines over stdin and stdout, one process per node INSTANCE.
- stdout carries only frames. stderr goes to the one log, as level STDERR.
- The Python helper is `packages/_sdk/inny_node.py`.

### From the runtime to the node

| Frame | Fields | Meaning |
|---|---|---|
| `start` | `protocol: 2`, `node: {id, type, name}`, `config`, `credentials`, `data_dir` | Always the first line. `config` is coerced to the schema's types, because Node-RED returns form values as strings. `credentials` holds Node-RED's decrypted values. `data_dir` is a private folder for this instance. |
| `input` | `id`, `event: {type, data, run}` | One event to handle. The entry is written to the journal on disk BEFORE this frame is sent. |
| `cancel` | `in` | Cancel that input, whether queued or running. |
| `action` | `in`, `values` | The person's submission to an action view. `__dismiss__: true` means dismissed. |
| `trigger` | `action`, `snapshot: {id, state}`, `values` | A snapshot action was pressed. |
| `close` | — | Stop. The node must answer `closed` and exit. After 5 s the runtime sends SIGKILL. |

### From the node to the runtime

| Frame | Fields | What the runtime does |
|---|---|---|
| `ready` | — | Initial status: "ready", or "watching" for a source. |
| `status` | `text`, `fill`, `shape` | Calls `node.status`. It is also shown on the app's Jobs page and logged at debug level. |
| `log` | `level`, `msg` | Writes it to the one log, with credentials redacted. A `warn` also goes to `node.warn`. |
| `emit` | `port`, `data`, optional `in` | See below. |
| `done` | `in` | Calls `done()` and clears the journal entry. The Complete node fires. |
| `error` | `in`, `message` | With an `in`: calls `done(new Error(message))` and clears the journal entry, so the Catch node receives it. Without one: `node.error` and the log only. |
| `present` | `in`, `content: {title, text, form}` | Marks the journal entry "awaiting" and sets the status to "waiting for you". Adds an Inbox entry, the dock badge and a notification. |
| `snapshot` | `content`, `state`, optional `in` | Stores the snapshot with the type's declared actions, the node id and the time. |
| `closed` | — | The acknowledgement of `close`. |

`emit` in detail:
- The port must be one the type declares. Anything else is refused and logged, which binds the
  node's identity.
- With `in`, the output is sent through that input's own `send`. It keeps the input's `_msgid` and
  run id, and `msg.inny.cause` is the input id.
- Without `in`, it is a FRESH message with a new run id. This is used by sources, and by snapshot
  actions that start a new run.

### The message on the wire

- `msg.payload` is the event data.
- `msg.topic` is the event type, for example `monty.new.v1`.
- `msg.inny.event` is a CloudEvents-shaped envelope: `specversion`, `id`, `source`, `type`, `time`
  and `datacontenttype`.
  - `source` is `inny://<package>/<type>/<node id>`. It is stamped by the runtime, never by the
    node process.
- `msg.inny.run` is the run id, carried from the first event of the run.
- `_msgid` is Node-RED's own id, kept for outputs caused by an input.

### The journal

- `journal.json` in the Node-RED data folder, replaced atomically on each change.
- An entry holds the input id, node id, message, event, attempts, state (`sent` or `awaiting`) and
  the presented content.
- On start, each node replays its entries through `node.receive(msg)` once `flows:started` has
  fired, so what it emits has somewhere to go.
- For a `sent` entry: if it has had 2 or more attempts, it fails with `done(err)`; otherwise it is
  re-sent as attempt 2.
- An `awaiting` entry (a pending action view) is re-sent without counting an attempt, and is
  presented again.
- When a node is removed from the flow, its entries are dropped, with a log line.
- When a node process crashes, its `sent` entries fail at once through `done(err)`. Its `awaiting`
  entries are re-sent to the respawned process.

### How every row of the plan's compatibility table was exercised

| Row | Exercised by | Result |
|---|---|---|
| An instance per canvas node, its own config, created on deploy and closed on redeploy | `start` and `close`/`closed`. Two Diarize instances ran with different configs (3 s, 900 s, 40 s). Close was acknowledged on every redeploy and quit. | Pass. |
| `input` with `done()` / `done(err)`, so Catch and Complete work | The input id, `done`, `error`. Catch received failures from kills, cancels, missing files, retries and dismissals. Complete fired on success. | Pass. |
| Numbered output ports | Folder watcher's three ports: `new` at 12:13:16, `deleted` at 12:42:30, `updated` at 12:42:32. Result's action port. | Pass. |
| `msg` as an object | `payload`, `topic`, `_msgid` and `msg.inny`, visible in the debug output in the log. | Pass. |
| `node.status()` for progress | `status` frames, as in P3. | Pass. |
| error, warn and log into one log | `log` frames and stderr, the latter tested with a deliberate stderr line from Diarize. Node-RED's own log is routed into the same file through a custom logging handler. | Pass. |
| Credentials per node, encrypted | `hf_token` as a Node-RED credential, encrypted with the userDir secret. Delivered in `start` and never logged: the redaction was tested, and the value appears nowhere in the log. | Pass. |
| Sources emit spontaneously | `emit` without `in`, from monty's watcher thread. | Pass. |
| A slow node queues, reported and never silent | The journal, plus the node's own queue: "queued input … (1 ahead)" was logged for three quick inputs. All three were then cancelled from the app: one "cancelled after 2s", two "cancelled before it started". | Pass. There is no queue limit yet; that is a slice 03 item. |
| Views: present, action, snapshot, trigger; the fresh message a view sends | All four frames, as in P2. A fresh `node.send` with no input id works on the action port. | Pass. |

## 4. Surprises: where Node-RED pushed back against the out-of-process model

1. **The editor inside Electron could hang quit.**
   - The editor sets a `beforeunload` guard while it holds undeployed changes. In a browser that
     asks "leave the page?". In Electron it SILENTLY cancels `app.quit()`.
   - The result was an app with its flows stopped, its server closed and its process still alive.
   - The next start then exited silently on the single-instance lock. I found this in the P4
     retry-once run and had to kill the stuck process by PID.
   - Fixed by handling `webContents.on('will-prevent-unload')`: the quit goes ahead, the undeployed
     edits are lost, and a line is logged. Slice 03 should ask the person instead.
2. **A deploy naming unknown types stops the whole runtime.**
   - Node-RED accepts the flow, stops every flow and waits for the missing types. See P7.
   - Only a guard in front of the admin API prevents it.
3. **Redeploy semantics.**
   - A "full" deploy (the default) closes and restarts EVERY node. In-flight inputs are replayed
     from the journal as attempt 2, so a redeploy uses up the retry, and a later crash then fails
     the step.
   - A "modified nodes" deploy leaves untouched nodes alone; the 40 s job ran on uninterrupted.
     However, a deploy that includes a node's `credentials` marks that node as changed.
   - Evidence: `evidence/logs/p4-redeploy.out`.
4. **`done()` with async work.**
   - The `done` from an old instance is simply never called when that instance is replaced on
     redeploy or restart, and Node-RED doesn't complain.
   - Correctness depends entirely on the journal replay. It worked: Complete fired exactly once, on
     the replayed attempt.
   - The replay marker `_innyReplay` leaks into the message the Complete node receives. It should be
     removed from the message the input handler gets.
5. **Fresh messages from views.**
   - Legal. `node.send()` on the action port with no input behaves like an inject node, and
     downstream nodes treat it as a new message.
   - Catch and Complete are scoped to the input that caused an output, so a snapshot action's run
     can only be traced by `msg.inny.run`, not by `_msgid`.
6. **Credentials.**
   - They work as designed. The runtime receives them in the constructor as `node.credentials`.
   - Only the runtime ever holds decrypted values. They go to the process in `start` and are
     redacted from the one log.
   - `credentialSecret` must be managed by the app. The spike keeps a random one in userDir. Slice 03
     should use the OS keychain.
7. **Editor details.**
   - Numeric form values come back as strings, so the runtime coerces them from the schema.
   - `editorTheme.palette.editable` is deprecated in favour of `externalModules`.
   - Generated types are listed under module "node-red" in the node list, because `nodesDir` files
     have no package of their own. This is cosmetic.
   - The editor inside an iframe in the app's own page works: forms, deploy, status and debug
     sidebar all behaved.
8. **Admin security.**
   - Node-RED's admin API has no authentication, so any local process can deploy flows. The spike's
     debug hooks (eval, capture, quit) are only on with `INNY_SPIKE_DEBUG=1`.
   - Slice 03 needs `adminAuth` or a per-launch token.
9. **Packaging.**
   - electron-builder drops `@node-red/nodes/examples`, which causes a harmless unhandled rejection
     ("examples not found") at startup. An explicit `files` include did not bring it back.
   - Node-RED bundles npm's install machinery (arborist, pacote, npm-registry-fetch) even though
     the install route is disabled.
   - The build is unsigned and arm64 only.
   - Node package files must be unpacked from the app archive (`asarUnpack`) for child processes
     to run them.
10. **Electron's data folder.**
    - The first dev runs wrote Electron's cache to `~/Library/Application Support/InnyTypes
      Spike`. I removed it.
    - `INNY_APPDATA` now keeps it inside `spike/`. It also keeps the dev and packaged runs'
      single-instance locks apart.
11. **The owner used the app during the spike.** Three action views were submitted by hand
    ("test1"/"test2" and others). That is how three extra Anytype objects came about (section 6).
    The controlled evidence was not disturbed; the log shows exactly which submissions were mine.

## 5. What the full build (slice 03) should do differently

1. **Make the deploy guard a first-class port.**
   - Validate every deploy against the installed, verified node packages, not only against
     "registered in Node-RED".
   - Add authentication to the admin API with a per-launch token.
2. **Separate "re-sent because of a redeploy" from "re-sent after a crash or quit"**, so that
   editing a flow does not use up a job's retry. Consider deploy type "nodes" by default.
3. **Journal:**
   - replace the single JSON file with an append-only log or SQLite;
   - add a bounded, reported queue per instance;
   - keep enough of the input to rebuild the message that Catch and Complete see, without internal
     markers.
4. **Validate config and view forms with a real JSON Schema 2020-12 validator (ajv).** Render forms
   properly: required fields, enums, numbers and nested objects.
5. **Views:** render each view's content in a sandboxed webview or iframe with a strict content
   security policy, as the plan says. The spike renders generic content inside the app page.
   Add the optional timeout output for action views.
6. **Quit flow:** own the "undeployed changes" decision in the shell, and always call `RED.stop()`
   before exiting.
7. **Packaging:**
   - sign and notarise;
   - build per architecture, or universal;
   - build for Windows and Linux;
   - pin the python-build-standalone version and its hash;
   - give each node package its own environment instead of one shared Python;
   - restore Node-RED's examples folder, or silence the error.
8. **Declarations:** add icons, the SDK for JS and TS nodes, and a per-type `protocol` version. Put
   the declaration in each node package's own repository; plan slice 05.

## 6. Cleanup notes

### Anytype test objects to delete

All are in the space "Cleanup", id
`bafyreifew2oesia4d7ky4efsofefl23zbjrdtuovnadqg5eq7afby6oahq.1zl109kygfonz`.

| Name | Object id | Created by |
|---|---|---|
| InnyTypes spike test 2026-09-25 14:14:06 | `bafyreic3a3fulfqgyjou7idhfwpysadeirhbwyljfsz3n3d72iqsqulouq` | my P2 run |
| InnyTypes spike test 2026-09-25 14:14:36 | `bafyreiaik6nyt6iiyr2sln7heenofnmwaqbpprg7v64aixjdt4ydfgx2s4` | the owner, by hand in the window |
| InnyTypes spike test 2026-09-25 14:29:55 | `bafyreibohsxxzadhwgqxegrhys66w6xhkwht4jfilevnyou3aabgzsp6ki` | the owner, by hand |
| InnyTypes spike test 2026-09-25 14:30:42 | `bafyreigzg74wzvfrfhzuokmpyl2jsl4nbrthugtuv3unpiekja3yg3fyym` | the owner, by hand |
| InnyTypes spike test (packaged app) 2026-09-25 14:18:54 | `bafyreieilmeen4h62asarj2pe4uqg4kl5ekjuivc5vxhno2oivrpko56re` | my P8 run |

That is five objects, not one. Two came from my controlled runs: one on purpose, so that P8 ran the
real flow in the packaged app. Three came from the owner using the open window.

### The Anytype key

- It was read at runtime only, by the Create object process, from the existing key store
  (`~/.config/innytypes/anytype_api_key`, the same file `innytypes.anytype_mcp.keys` writes).
- It was never passed through Node-RED, and never printed, logged, committed or written into flow
  files.
- `spike/tools/key_leak_scan.py` found it in 0 of 287 spike files (including the logs, journals and
  flows under `.userdir*`) and 0 times in the git history of `spike/`.

### Processes

- None left running. Both the dev app and the packaged app were quit through their normal quit.
- Every node process acknowledged `close` and exited with code 0. The journal is empty (`{}`).
- One hung dev app, PID 4062, stuck by surprise 1, was killed by PID during the run.
- The InnyTypes app and the Anytype app were not touched.

### Files

- Gitignored under `spike/`:
  - `.userdir/` and `.userdir-packaged/`: data folders, logs, journals, `flows_cred.json`, the
    credential secret, and the planted probe module `node_modules/node-red-contrib-spike-probe`;
  - `node_modules/`, `.venv/`, `build-python/`, `dist/`, `scratch/`.
- Outside `spike/`: I removed `~/Library/Application Support/InnyTypes Spike`, which only held
  Electron's cache.
- Nothing outside the worktree was changed. `~/git/monty` was only read and installed from, not
  modified.
