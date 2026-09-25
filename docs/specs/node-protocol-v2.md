---
type: spec
title: InnyTypes node protocol v2
status: DRAFT
created: 2026-09-25
source: plan 0017, slice 02; derived from the slice 01 spike (docs/arch_pivot.md)
---

# InnyTypes node protocol v2

## 0. Conventions

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

Vocabulary, as in plan 0017:

| Term | Meaning |
|---|---|
| **event** | A message travelling along a wire in a flow. Its type is a versioned name. |
| **source** | A type that starts runs by emitting events. It normally has no input (but see `input`, section 2.4). |
| **node** | A type that takes an event in, does work, and emits events. A sink is a node with no outputs. |
| **view** | A type whose result is shown to the person in the InnyTypes app: an **action** view (the flow waits) or a **snapshot** view (it records and passes on). |
| **flow** | A graph of sources, nodes and views, drawn on the canvas. |
| **node package** | The installable unit that declares one or more types. |
| **runtime** | The InnyTypes process that embeds Node-RED, runs node processes, and keeps the journal. |
| **shell** | The Electron main process: windows, lock, quit, notifications, and supervision of the runtime. |
| **instance** | One node of a type placed on the canvas. There is one process per instance. |

Every requirement is one of two kinds:
- **PROVEN** by the slice 01 spike on macOS arm64, with Electron 44.4.5, Node-RED 5.0.7 and
  Python 3.13 (see docs/arch_pivot.md, criteria P1–P11);
- **unproven — slice 03 must prove**, marked in place as **[UNPROVEN]**.

A requirement with no mark is either proven or a direct consequence of something proven.

Sections 10 and part of 8.5 are **INTERNAL**: they bind the InnyTypes runtime and shell, not node
package authors.

## 1. Scope and versioning

1. This document specifies:
   - the node package declaration;
   - the conversation between the runtime and a node process (the frames);
   - the event envelope;
   - the lifecycle, journal and retry rules;
   - the view contract;
   - created event types;
   - the internal shell ↔ runtime channel;
   - the security rules;
   - conformance.
2. The protocol version is the integer `2`.
   - A declaration MUST carry `"protocol": 2`.
   - The runtime MUST send `"protocol": 2` in every start frame.
3. **Compatibility.**
   - The runtime MUST refuse to install or load a package whose `protocol` it does not implement,
     with a reason naming the version.
   - Within version 2:
     - fields MAY be added to frames and declarations;
     - receivers MUST ignore unknown fields;
     - receivers MUST NOT fail on them.
   - Removing a field, changing a field's meaning, or adding a frame that a receiver MUST
     understand requires protocol 3.
   - A new frame type that receivers MAY ignore is allowed in 2. A node receiving an unknown frame
     type MUST ignore it. The runtime receiving one MUST log a warning and ignore it.
4. Version 1 (the pre-0017 plugin contract, `{kind, payload}`, fire-and-forget) is not supported.
   There is no bridge; plan 0017's cutover converts packages in one wave.

## 2. The node package declaration (`inny-package.json`)

### 2.1 Location and identity

1. Every node package MUST contain exactly one `inny-package.json` at its root.
2. `package` is the package name, matching `^[a-z][a-z0-9_]{1,39}$`. It MUST be unique among
   installed packages.
   - The runtime MUST refuse a second package with an existing name, and report it; the one
     already installed wins.
   - The name `user-events` is RESERVED for created event types (section 9).
3. Each type has an `id`, matching `^[a-z][a-z0-9_-]{0,63}$`, unique within its package.
4. The Node-RED node type name is derived, never declared: `inny-<package>-<id>`.

### 2.2 Types

| `kind` | Inputs | Outputs | Notes |
|---|---|---|---|
| `source` | 0, or 1 if `input: true` | one per declared event type | Emits spontaneously; every emission starts a new run. |
| `node` | 1 | zero or more, one per event type | Zero outputs makes it a sink. |
| `view` with `view: "action"` | 1 | one per event type | The flow waits at it (section 8). |
| `view` with `view: "snapshot"` | 1 | the pass-through outputs, then one per action | Records state; its actions start new runs (section 8). |

Output ports are numbered in declaration order: first `outputs[]`, then, for snapshot views,
`actions[]`. The runtime MUST map ports by that order. A node process refers to ports by name,
never by number.

### 2.3 Commands and environments

1. `command` is an argv array. It MAY be given per OS, as `{"darwin": [...], "win32": [...],
   "linux": [...], "default": [...]}`; a bare array means all platforms.
   - **[UNPROVEN]** Only darwin was exercised.
2. Placeholders the runtime MUST substitute in every argv element:
   - `{python}`: the Python interpreter of the package's environment;
   - `{node}`: the Node.js binary the runtime provides;
   - `{package}`: the absolute, real (unpacked) directory of the package.

   A literal `{` MUST be written `{{`.
3. `environment` declares how the package is installed and run:
   - `{"kind": "uv-python", "python": "3.13"}`;
   - `{"kind": "node", "node": ">=22"}`;
   - `{"kind": "executable", "binaries": {"<platform>-<arch>": {"path": "...", "sha256": "..."}}}`,
     one binary per Node `process.platform`-`process.arch` pair (`darwin-arm64`, `linux-x64`,
     `win32-x64`).

   The runtime MUST run each package in its own verified environment (WI-0018-15):
   - `uv-python`: a uv venv on the bundled Python 3.13, then `uv pip sync --require-hashes` from
     the package's `requirements.lock` (exact pins, sha256 hashes only; absent means no
     dependencies). Any other `python` is refused with a reason.
   - `node`: pre-bundled JavaScript only; nothing runs npm. A package whose commands run a
     package manager, whose `package.json` declares dependencies or install scripts, or which
     ships a `binding.gyp`, is refused.
   - `executable`: the binary for this platform must be present and match its `sha256`.

   The environment is built in staging and swapped in only once complete. **[UNPROVEN]** Built
   and tested on darwin only, with the system uv and Python 3.13 standing in for the bundled
   ones (WI-0018-23).
4. The working directory of a node process MUST be `{package}`. Paths inside an app archive MUST
   be rewritten to their unpacked twin (proven for `app.asar` → `app.asar.unpacked`).
5. **The package archive.** A package is published as a `.tgz` of its files plus `files.json`
   (`{"files": {"<path>": "<sha256>"}}`, listing every file) and `files.json.minisig` (the
   publisher's minisign signature of `files.json`). The runtime MUST verify, in order: the
   signature; every file against its hash, refusing any file not listed; the content hash
   (the sha256 of the sorted `sha256sum` lines of the files) against the one recorded for the
   same package and version, refusing a different one (plan 0013). A path install has no
   signature and is compared by content hash in the same way.

### 2.4 Type fields

| Field | Applies to | Required | Meaning |
|---|---|---|---|
| `id` | all | MUST | See 2.1. |
| `kind` | all | MUST | `source`, `node` or `view`. |
| `view` | view | MUST for views | `action` or `snapshot`. |
| `label` | all | MUST | Palette label, 1 to 60 characters. |
| `description` | all | SHOULD | Help text shown in the editor. |
| `icon` | all | MAY | A Node-RED icon name, for example `font-awesome/fa-users` or `file.svg`. |
| `command` | all | MUST | See 2.3. |
| `config` | all | MUST | A JSON Schema 2020-12 object schema for the instance configuration. Properties marked `"writeOnly": true` or `"x-secret": true` are credentials (2.5). |
| `outputs` | all | MUST (it may be empty for a sink) | An array of `{port, event}`: `port` matches `^[a-z][a-z0-9_]{0,39}$` and is unique within the type; `event` is an event type name (5.2). |
| `actions` | snapshot views | MAY | An array of `{id, label, event, form?}`: `id` is the port name; `form` is an optional JSON Schema for values asked for when the action is pressed. |
| `input` | sources | MAY | `true`: the source gets one input. A message on it is validated against `payload` and emitted as a new run (9.5). |
| `event`, `payload` | sources with one output | MAY | The single event type and its payload JSON Schema. REQUIRED for created event types. |
| `window` | views | via `config` | Views SHOULD declare a config property `window` with enum `["inline", "popout"]`, so that each instance chooses (8.5). |

Types MUST NOT declare an output port named after a Node-RED internal (`_msgid`, `topic`).

### 2.5 Config and credentials

1. The editor form for a type MUST be generated from `config`:

   | Schema | Form control |
   |---|---|
   | `type: string` | text input |
   | `number` or `integer` | number input |
   | `boolean` | checkbox |
   | `enum` | select |
   | a secret | password input |

   `title` gives the label, `description` a tip, and `default` the default value.
2. Secret properties MUST become Node-RED credentials, stored encrypted in `flows_cred.json` with
   the runtime's credential secret. They MUST NOT appear in `flows.json`.
3. Before the start frame, the runtime MUST coerce the form values to the schema types (Node-RED
   returns strings; proven).
   **[UNPROVEN]** Full validation with a real JSON Schema 2020-12 validator (for example ajv); the
   spike coerced only.

### 2.6 JSON Schema of the declaration

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://innytypes/schemas/inny-package.v2.json",
  "type": "object",
  "required": ["protocol", "package", "version", "types"],
  "properties": {
    "protocol": { "const": 2 },
    "package": { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,39}$" },
    "version": { "type": "string" },
    "environment": {
      "type": "object",
      "required": ["kind"],
      "properties": {
        "kind": { "enum": ["uv-python", "node", "executable"] },
        "python": { "type": "string" },
        "node": { "type": "string" },
        "binaries": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "required": ["path", "sha256"],
            "properties": {
              "path": { "type": "string", "minLength": 1 },
              "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
            }
          }
        }
      }
    },
    "types": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/type" } }
  },
  "$defs": {
    "argv": { "type": "array", "minItems": 1, "items": { "type": "string" } },
    "command": {
      "oneOf": [
        { "$ref": "#/$defs/argv" },
        {
          "type": "object",
          "properties": {
            "darwin": { "$ref": "#/$defs/argv" },
            "win32": { "$ref": "#/$defs/argv" },
            "linux": { "$ref": "#/$defs/argv" },
            "default": { "$ref": "#/$defs/argv" }
          },
          "additionalProperties": false
        }
      ]
    },
    "eventName": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_]*)+\\.v[1-9][0-9]*$" },
    "output": {
      "type": "object",
      "required": ["port", "event"],
      "properties": {
        "port": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,39}$" },
        "event": { "$ref": "#/$defs/eventName" }
      }
    },
    "action": {
      "type": "object",
      "required": ["id", "label", "event"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,39}$" },
        "label": { "type": "string", "minLength": 1, "maxLength": 60 },
        "event": { "$ref": "#/$defs/eventName" },
        "form": { "type": "object" }
      }
    },
    "type": {
      "type": "object",
      "required": ["id", "kind", "label", "command", "config", "outputs"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z][a-z0-9_-]{0,63}$" },
        "kind": { "enum": ["source", "node", "view"] },
        "view": { "enum": ["action", "snapshot"] },
        "label": { "type": "string", "minLength": 1, "maxLength": 60 },
        "description": { "type": "string" },
        "icon": { "type": "string" },
        "command": { "$ref": "#/$defs/command" },
        "config": { "type": "object" },
        "outputs": { "type": "array", "items": { "$ref": "#/$defs/output" } },
        "actions": { "type": "array", "items": { "$ref": "#/$defs/action" } },
        "input": { "type": "boolean" },
        "event": { "$ref": "#/$defs/eventName" },
        "payload": { "type": "object" }
      },
      "allOf": [
        { "if": { "properties": { "kind": { "const": "view" } } }, "then": { "required": ["view"] } },
        { "if": { "required": ["actions"] }, "then": { "properties": { "kind": { "const": "view" }, "view": { "const": "snapshot" } } } },
        { "if": { "required": ["input"] }, "then": { "properties": { "kind": { "const": "source" } } } }
      ]
    }
  }
}
```

### 2.7 Example

```json
{
  "protocol": 2,
  "package": "monty",
  "version": "0.1.0",
  "environment": { "kind": "uv-python", "python": "3.13" },
  "types": [
    {
      "id": "folder-watcher",
      "kind": "source",
      "label": "Folder watcher",
      "icon": "file.svg",
      "command": ["{python}", "{package}/folder_watcher.py"],
      "config": {
        "type": "object",
        "required": ["folder"],
        "properties": {
          "folder": { "type": "string", "title": "Folder" },
          "extensions": { "type": "string", "default": ".wav" }
        }
      },
      "outputs": [
        { "port": "new", "event": "monty.new.v1" },
        { "port": "updated", "event": "monty.updated.v1" },
        { "port": "deleted", "event": "monty.deleted.v1" }
      ]
    }
  ]
}
```

## 3. Transport

1. **One process per instance.** The runtime MUST start one process per node instance on the
   canvas, never one per package or per type (proven: two Diarize instances ran with different
   configs).
2. **JSON lines over stdio.**
   - Each frame is one JSON object, UTF-8, serialised on ONE line and terminated by `\n` (LF).
   - Frames flow runtime → node on the node's stdin, and node → runtime on its stdout.
   - A node MUST flush stdout after each frame.
   - Writes from several threads MUST be serialised so that frames never interleave (proven: the
     Python SDK holds a lock).
3. **stdout carries frames only.**
   - A node MUST NOT write anything but frames to stdout.
   - The runtime MUST log a non-JSON stdout line as a protocol violation, at level `stdout`, and
     otherwise ignore it.
4. **stderr goes to the one log.** The runtime MUST write every stderr line to the one log, at
   level `STDERR`, tagged with the type and instance id. Credentials are redacted (11.1).
5. **Frame size.**
   - A frame MUST NOT exceed 1 MiB (1,048,576 bytes) of encoded UTF-8, excluding the newline.
   - The runtime MUST accept frames up to that size.
   - On an oversize frame, the runtime MUST log it and discard it. If the frame carried an input
     id, the runtime MUST fail that input with `done(err)` ("frame too large").
   - Large payloads SHOULD be passed as file paths, as Diarize passes a folder.
   - **[UNPROVEN]** The limit is a spike-era decision; it has not been tested.
6. Encoding MUST be UTF-8. A frame that is not valid UTF-8 or not valid JSON is a protocol
   violation, handled as in 3.3.

## 4. Frames

Every frame is a JSON object with a string field `t`.
- Input ids (`id`, `in`) are opaque strings, UUIDs in practice, assigned by the runtime.
- A node MUST NOT invent an input id.
- A node MUST NOT reuse an id after `done`/`error`.

### 4.1 Runtime → node

| `t` | Fields | When | The node MUST |
|---|---|---|---|
| `start` | `protocol` (2), `node: {id, type, name}`, `config` (object), `credentials` (object of strings), `data_dir` (string) | Exactly once, as the FIRST line. | Read it before any other frame. It MAY write to `data_dir`, a private folder per instance that persists across restarts. It MUST NOT log `credentials`. |
| `input` | `id`, `event: {type, data, run}` | For each event arriving at the instance. It may be a re-send (7.3). | Eventually answer with exactly one `done` or `error` for `id` (awaiting views: after an `action`). It MAY emit outputs for `id` before that. It MUST treat a re-sent `id` as the same work, which SHOULD be idempotent. |
| `cancel` | `in` | The person cancelled that input (proven: Jobs page). | Stop the work as soon as practical, and answer `error {in, message}`. A queued input is cancelled before it starts ("cancelled before it started"). An unknown `in` is ignored. |
| `action` | `in`, `values` (object) | Action views only: the person submitted, or dismissed. | Submitted: emit on an output with `in`, then `done`. Dismissed (`values.__dismiss__ === true`): `error {in, "dismissed by the person"}`. |
| `trigger` | `action` (port id), `snapshot: {id, state}`, `values` | Snapshot views only: an action was pressed. | Emit on the port named `action` WITHOUT `in` (a new run), carrying the snapshot state and `values`. |
| `fire` | `data` (object, already validated) | Created event sources: the person fired the event from the app. | Emit on its one port without `in`. |
| `close` | — | On redeploy, removal, quit or runtime restart. | Stop its work, send `closed`, and exit with code 0. Deadline: 5 s (6.3). |

### 4.2 Node → runtime

| `t` | Fields | When | The runtime MUST |
|---|---|---|---|
| `ready` | — | Once, after `start` is handled. | Set the status to "ready", or "watching" for sources, unless a `status` already arrived. **[UNPROVEN]** A start deadline: the runtime SHOULD fail the instance if `ready` has not come within 30 s. |
| `status` | `text`, `fill` (red, green, yellow, blue or grey), `shape` (ring or dot) | At any time. | Call `node.status()` and show it on the Jobs page. |
| `log` | `level` (debug, info, warn or error), `msg` | At any time. | Write it to the one log, redacted. A `warn` MAY also go to `node.warn`. |
| `emit` | `port`, `data`, optional `in` | See 5.4. | Refuse an undeclared port (log it and drop it). Refuse an unknown `in` (log it and drop it). Otherwise send per 5.4. |
| `done` | `in` | The input's work is finished. | Call `done()`, clear the journal entry, and mark the job done. The Complete node fires. |
| `error` | `message`, optional `in` | The input's work failed. | With `in`: `done(new Error(message))`, clear the journal entry; the Catch node fires. Without `in`: log it and `node.error(message)` (no Catch). |
| `present` | `in`, `content` | Action views: show this to the person. | Set the journal entry to `awaiting` with `content`, and apply section 8. |
| `snapshot` | `content`, `state`, optional `in` | Snapshot views: record this. | Store the snapshot with the type's actions, the instance id and the time. |
| `closed` | — | In answer to `close`. | Stop waiting for the acknowledgement. |

### 4.3 Ordering rules

1. `start` precedes everything; `ready` precedes every other node frame except `log` and `status`.
   **[UNPROVEN]** The spike did not enforce this; nodes did send `log` before `ready`.
2. For a given input id: zero or more `emit {in}`, then at most one `present` (action views), then
   exactly one terminal `done` or `error`. Frames for that id after the terminal frame MUST be
   ignored by the runtime, and logged.
3. A node MAY process inputs concurrently and MAY complete them out of order. A node that
   processes serially MUST queue inputs (the Diarize stub queues them).
4. After `close`, a node MUST NOT emit. The runtime ignores frames after `closed`.

### 4.4 Timeouts

| Deadline | Value | Status |
|---|---|---|
| `close` → `closed` and exit | 5 s, then SIGKILL | proven |
| Work on an input | NONE; an input may take hours (proven: 644 s with progress, then cancelled) | proven |
| An action view waiting | NONE; it survives restarts | proven |
| `start` → `ready` | 30 s | **[UNPROVEN]** |
| A runtime `stop` for quit | 10 s, then the shell kills the runtime | proven as code, not exercised |

### 4.5 JSON Schemas for the frames

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://innytypes/schemas/frames.v2.json",
  "$defs": {
    "id": { "type": "string", "minLength": 1, "maxLength": 128 },
    "start": {
      "type": "object",
      "required": ["t", "protocol", "node", "config", "credentials", "data_dir"],
      "properties": {
        "t": { "const": "start" },
        "protocol": { "const": 2 },
        "node": {
          "type": "object",
          "required": ["id", "type"],
          "properties": { "id": { "type": "string" }, "type": { "type": "string" }, "name": { "type": "string" } }
        },
        "config": { "type": "object" },
        "credentials": { "type": "object", "additionalProperties": { "type": "string" } },
        "data_dir": { "type": "string" }
      }
    },
    "input": {
      "type": "object",
      "required": ["t", "id", "event"],
      "properties": {
        "t": { "const": "input" },
        "id": { "$ref": "#/$defs/id" },
        "event": {
          "type": "object",
          "required": ["type", "data"],
          "properties": { "type": { "type": "string" }, "data": {}, "run": { "type": "string" } }
        }
      }
    },
    "cancel": { "type": "object", "required": ["t", "in"], "properties": { "t": { "const": "cancel" }, "in": { "$ref": "#/$defs/id" } } },
    "action": { "type": "object", "required": ["t", "in", "values"], "properties": { "t": { "const": "action" }, "in": { "$ref": "#/$defs/id" }, "values": { "type": "object" } } },
    "trigger": {
      "type": "object",
      "required": ["t", "action", "snapshot", "values"],
      "properties": {
        "t": { "const": "trigger" },
        "action": { "type": "string" },
        "snapshot": { "type": "object", "required": ["id"], "properties": { "id": { "type": "string" }, "state": {} } },
        "values": { "type": "object" }
      }
    },
    "fire": { "type": "object", "required": ["t", "data"], "properties": { "t": { "const": "fire" }, "data": { "type": "object" } } },
    "close": { "type": "object", "required": ["t"], "properties": { "t": { "const": "close" } } },
    "ready": { "type": "object", "required": ["t"], "properties": { "t": { "const": "ready" } } },
    "status": {
      "type": "object",
      "required": ["t", "text"],
      "properties": {
        "t": { "const": "status" },
        "text": { "type": "string", "maxLength": 200 },
        "fill": { "enum": ["red", "green", "yellow", "blue", "grey"] },
        "shape": { "enum": ["ring", "dot"] }
      }
    },
    "log": {
      "type": "object",
      "required": ["t", "msg"],
      "properties": { "t": { "const": "log" }, "level": { "enum": ["debug", "info", "warn", "error"] }, "msg": { "type": "string" } }
    },
    "emit": {
      "type": "object",
      "required": ["t", "port", "data"],
      "properties": { "t": { "const": "emit" }, "port": { "type": "string" }, "data": {}, "in": { "$ref": "#/$defs/id" } }
    },
    "done": { "type": "object", "required": ["t", "in"], "properties": { "t": { "const": "done" }, "in": { "$ref": "#/$defs/id" } } },
    "error": {
      "type": "object",
      "required": ["t", "message"],
      "properties": { "t": { "const": "error" }, "message": { "type": "string", "maxLength": 2000 }, "in": { "$ref": "#/$defs/id" } }
    },
    "present": {
      "type": "object",
      "required": ["t", "in", "content"],
      "properties": { "t": { "const": "present" }, "in": { "$ref": "#/$defs/id" }, "content": { "$ref": "#/$defs/viewContent" } }
    },
    "snapshot": {
      "type": "object",
      "required": ["t", "content", "state"],
      "properties": { "t": { "const": "snapshot" }, "content": { "$ref": "#/$defs/viewContent" }, "state": {}, "in": { "$ref": "#/$defs/id" } }
    },
    "closed": { "type": "object", "required": ["t"], "properties": { "t": { "const": "closed" } } },
    "viewContent": {
      "type": "object",
      "properties": {
        "title": { "type": "string", "maxLength": 200 },
        "text": { "type": "string", "maxLength": 20000 },
        "fields": { "type": "object", "additionalProperties": { "type": ["string", "number", "boolean", "null"] } },
        "form": { "type": "object" }
      }
    }
  }
}
```

## 5. The event envelope

### 5.1 The Node-RED message

When the runtime sends an event to the next node on a wire, the Node-RED `msg` MUST be:

| Field | Value |
|---|---|
| `msg.payload` | the event data (`emit.data`) |
| `msg.topic` | the event type name |
| `msg.inny.event` | the CloudEvents-shaped envelope (5.3) |
| `msg.inny.run` | the run id (5.5) |
| `msg.inny.cause` | the input id that caused this output, when there is one |
| `msg._msgid` | Node-RED's id. It MUST be kept for outputs caused by an input (the runtime sends a clone of the input message through that input's `send`), and is new for a new run. |

### 5.2 Event type names

1. Form: `<owner>.<name>.v<N>`, lower case, where:
   - `<owner>` is the package name, or `user` for created event types (section 9);
   - `<name>` MAY contain dots for sub-names (`anytype.object.created.v1`);
   - `N` is an integer ≥ 1.
2. A version is IMMUTABLE. Once published, `x.y.vN`'s payload schema MUST NOT change. Any change
   is a new version, `vN+1`, declared beside the old one.
3. A package MUST NOT emit event types under another package's owner, and MUST NOT emit `user.*`.
   **[UNPROVEN]** The spike checked emits against declared PORTS (which fixes the type), not owner
   prefixes at install time. The installer must check the prefixes.

### 5.3 The envelope (`msg.inny.event`)

```json
{
  "specversion": "1.0",
  "id": "<uuid, new per emission>",
  "source": "inny://<package>/<type id>/<node instance id>",
  "type": "<event type name>",
  "time": "<RFC 3339 UTC>",
  "datacontenttype": "application/json"
}
```

- The runtime MUST stamp every field. `source` MUST come from the instance that emitted, never
  from the node process: a node cannot name another source (proven).
- The data itself is `msg.payload`, not a field of the envelope.

### 5.4 Emitting

1. `emit {port, data, in}`, with a live `in`: the runtime clones the input's message, replaces
   `payload` and `topic`, sets `msg.inny = {event, run: <the input's run>, cause: in}`, and sends
   through that input's `send`. That keeps the correlation with the input.
2. `emit {port, data}`, with no `in`: a NEW run. The runtime builds a fresh message
   `{payload, topic, inny: {event, run: event.id}}` and sends it with `node.send`. This is how
   sources, snapshot actions and fires start runs (proven).
3. The output goes on the port index of `port` (2.2). Other ports receive nothing.

### 5.5 Runs and causation

- A run starts at a fresh emission, and its id is that event's `id`.
- Every output caused by an input inherits the input's run.
- `cause` names the input id.
- A run survives restarts, because the journal keeps the message.

## 6. Lifecycle

1. **Deploy.** When a flow is deployed, Node-RED constructs each instance and the runtime MUST
   spawn its process and send `start`.
   - A **full** deploy closes and re-creates EVERY instance.
   - A **modified-nodes** deploy re-creates only the changed ones. Including credentials in a
     deploy marks that node as changed.
   - The runtime SHOULD use modified-nodes deploys by default.
2. **Close.** On a redeploy, a removal, a quit or a runtime restart, Node-RED closes the instance.
   The runtime MUST send `close`, wait for `closed` and the exit, and only then call Node-RED's
   close `done`.
3. **Deadline.** If the process has not exited 5 s after `close`, the runtime MUST SIGKILL it and
   log it.
4. **End of input means close.** A node MUST treat end of file on stdin exactly as `close`: stop
   and exit. This is how node processes follow a dead runtime.
   - Proven: every node process was gone within 0.45 s of a `kill -9` of the runtime, and within
     0.2 s of a `kill -9` of the shell.
   - **[UNPROVEN]** Windows and Linux.
5. **An unexpected exit** of a node process (a crash, a kill):
   - The runtime MUST fail every `sent` input of that instance with `done(err)` ("node process
     exited (…) while handling this event"), clear their journal entries, set a red status and
     log it.
   - `awaiting` inputs MUST NOT fail; they are re-sent to the next process.
   - The runtime MUST respawn the process after 1 s. It MUST stop respawning after 5 unexpected
     exits (proven as code).
   - **[UNPROVEN]** A time-windowed crash-loop limit and its UI.
6. **Parent death.**
   - The runtime process MUST end when the shell dies (proven with Electron `utilityProcess`
     semantics on macOS). It MUST also run a watchdog: if `process.ppid` changes, it exits.
   - Node processes follow by 6.4.
   - **[UNPROVEN]** Windows and Linux, and Windows Job Objects for node processes.
7. **Removal.** When a node is deleted from the flow and deployed (Node-RED closes it with
   `removed = true`), its journal entries MUST be dropped, each logged. Snapshots it took remain,
   with their actions disabled (8.4).

## 7. The journal and retry

1. **Journal before send.** Before writing an `input` frame, the runtime MUST durably record:
   - the input id, instance id and type;
   - the message (`payload`, `topic`, `inny`, `_msgid`);
   - the event, the attempt count and the state `sent`;
   - the time.

   It MUST clear the entry on `done` or `error`. (The spike wrote a JSON file, replaced
   atomically.) **[UNPROVEN]** An append-only log or SQLite for volume.
2. **Replay.** When an instance starts, after Node-RED's `flows:started`, the runtime MUST re-send
   each journal entry of that instance through `node.receive`, keeping the original input id.
3. **Attempts.** `attempts` starts at 1. On replay:

   | Why the step was interrupted | Replay |
   |---|---|
   | **Planned**: the runtime was stopped for a node-type change (`stop` reason `types`), or the instance was closed by a redeploy (a close that is neither a quit nor a removal) | The entry was marked `planned: true, plannedBy`. It MUST be re-sent WITHOUT counting, and the flag cleared. |
   | **Crash**: the runtime or node process died; no close ran | The attempt IS counted. |
   | **Quit**: `stop` reason `quit` | The attempt IS counted (the owner's P4 rule). |

   With a counted attempt, the maximum is 2 (the first send plus one retry): a step with
   `attempts >= 2` MUST fail with `done(err)` ("not done after 2 attempts") so the Catch node sees
   it, and its entry MUST be cleared. Otherwise `attempts` is incremented and the step re-sent.
4. **Awaiting views never count.** An entry in state `awaiting` is re-sent on every start, any
   number of times, with no attempt counted. Waiting may take days.
5. **Removal** drops entries (6.7).
6. **Bounded queue.** The runtime MUST bound the number of inputs outstanding per instance
   (journaled, not yet done), and MUST report it on the Jobs page and in the log, never silently
   dropping.
   - At the bound it MUST either hold further inputs at the upstream wire, or fail them with
     `done(err)` ("queue full"). Which one is a runtime setting.
   - The value is a runtime setting.
   - **[UNPROVEN]** The spike had no bound.

## 8. Views

### 8.1 Present (action views)

1. On `present {in, content}`, the runtime MUST set the journal entry to `awaiting`, store
   `content`, put it in the app's Inbox, update the badge count and raise a notification.
2. **First presentation vs re-presentation.**
   - A presentation is FIRST if the entry had no stored `content` before.
   - After a restart or redeploy the input is re-sent, and the view re-presents under the same id;
     that is a re-presentation.
   - Only a first presentation MAY open a pop-out by itself (8.5).
   - After a restart, pending views wait quietly in the Inbox, from where they can be opened
     again (proven P10e).
3. `content` is rendered generically by the app:

   | Field | Rendered as |
   |---|---|
   | `title` | a heading |
   | `text` | preformatted text |
   | `fields` | a key → value table |
   | `form` | JSON Schema properties, as inputs |
   | `table` | `{columns, rows}` as a table |
   | `media` | images: `data:image/…` URIs, or files of the view page's own origin |
   | `anytype` | `{objectId, spaceId, name?}` as a link that Anytype opens |
   | `component` | `{element}`: the view's OWN package's web component, in the pop-out sandbox (8.5.3) |

   (Proven by WI-0018-11's e2e, `app/test/e2e/app-pages.e2e.ts`.)

### 8.2 Submission and dismissal

1. **Submit.** The app sends `action {in, values}`, and the runtime sets the entry back to `sent`.
   The node emits with `in`, then sends `done`. The flow continues from the view's output.
2. **Dismiss.** `values.__dismiss__ === true`. The node answers `error`, which reaches the Catch
   node. A dismissal is the person's decision, not a failure of the node.
3. **Closing a pop-out without submitting** is neither: the entry stays `awaiting`, and nothing is
   sent (proven P10d).
4. **Timeout (optional; WI-0018-10).** An action view type MAY declare an output port `timeout`
   and a config property `timeout_seconds`.
   - When an instance sets a positive `timeout_seconds`, the runtime journals a deadline with the
     view's FIRST presentation. A re-presentation keeps it, so a restart never moves it.
   - When the deadline passes with the view still pending (at once, if it passed while the app
     was down), the runtime emits the input's data on `timeout` for that input (the run goes
     on), sends `cancel {in}` to the node, and ends the step with `done`.
   - The node never emits on `timeout` itself.

### 8.3 Snapshots

1. On `snapshot {content, state, in?}`, the runtime MUST store a record with:
   - its own id;
   - the instance id, node type, label and time;
   - `content`, `state` and the `window` setting;
   - the type's declared `actions`.

   A snapshot is not live: it is what the flow produced at that moment.
2. A snapshot view SHOULD also emit on its pass-through output and send `done`.
3. **Pressing an action** makes the runtime send `trigger {action, snapshot: {id, state}, values}`
   to the CURRENT process of the instance that took the snapshot. The node emits on port `action`
   with no `in`: a new run (proven). Each press is a new run.

### 8.4 Disabled actions

When a snapshot is opened, and again when an action is pressed, the runtime MUST judge each action
against the flow as it is NOW. It MUST refuse a press with a reason, never drop it silently.

| Condition | Reason (proven wording) | HTTP |
|---|---|---|
| the instance is no longer in the deployed flow | "The view that took this snapshot is no longer in the flow." | 409 |
| the action's port is wired to nothing | `Nothing is wired to the "<label>" output.` | 409 |
| the runtime is restarting or down | "the InnyTypes runtime is restarting; try again in a moment" | 409 |

### 8.5 Pop-outs (the security contract is INTERNAL; the `window` option is for authors)

1. A view instance whose config has `window: "popout"` opens its view in a separate window on its
   first presentation. A snapshot opens in a pop-out only when the person asks for it.
2. Several pop-outs MAY be open at once, one per pending view or snapshot. They are independent,
   and a second open of the same one focuses the existing window.
3. **The pop-out page** MUST be served by the SHELL, never by the runtime:
   - on the custom scheme `inny-view://app/…` (privileged: standard, secure), or, for a view
     drawn by its package's `component`, on `inny-view://<package>/…`, where the shell serves
     the same page plus the package's own `view/` files;
   - in its own session partition `inny-views`;
   - with a request filter that cancels every URL outside that scheme.

   (Proven: a page served by the runtime can hang half-loaded when the runtime restarts.)
4. **webPreferences** MUST be exactly (proven, read back from the live window):
   - `contextIsolation: true`;
   - `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `nodeIntegrationInWorker: false`;
   - `sandbox: true`;
   - `webSecurity: true`, `allowRunningInsecureContent: false`;
   - `webviewTag: false`, `navigateOnDragDrop: false`, `spellcheck: false`;
   - `preload` set to the view bridge.

   Navigation MUST be prevented, and new windows denied.
5. **CSP**, sent as a response header:

   ```
   default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
   connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'
   ```

6. **The bridge** is `window.inny` with exactly three calls, and NONE takes an id:
   - `get()` → the view or snapshot this window was opened for: `{kind: "view" | "snapshot" | "gone", …}`;
   - `submit(values)` → action views only;
   - `action(actionId, values)` → snapshots only.

   The shell MUST bind each window to its target and refuse anything else ("not an action view",
   "not a snapshot").
7. **Value limits across the bridge:** a flat object; keys are strings of at most 64 characters;
   values are string (truncated to 2,000 characters), number or boolean. Everything else is
   dropped.
8. A view page MUST retry `get()` while the runtime is restarting, and say so to the person.
9. Proven from inside a live pop-out:
   - no `require`, `process` or `module`;
   - `fetch` to the runtime API and to `file://` is blocked;
   - `eval` raises EvalError;
   - an injected inline script does not run;
   - `window.open` is denied.

   The same probes pass from inside a third-party view component (a package's own web
   component) running in this sandbox (proven by WI-0018-11's e2e).

## 9. Created event types

1. **Naming.**
   - The person gives a name matching `^[a-z][a-z0-9_]{1,39}$`, a label (required), and at least
     one payload field.
   - The type is `user.<name>.v1`.
   - A duplicate base name MUST be refused (409): "already exists; change its schema to make a new
     version instead".
2. **The payload schema limits.**
   - Fields have names matching `^[a-z][a-z0-9_]{0,39}$`, unique within the type.
   - Types are string, number, integer or boolean, each optionally required.
   - The result is a JSON Schema 2020-12 object with `additionalProperties: true`.
   - **[UNPROVEN]** Nested objects, arrays and enums.
3. **Versioning.**
   - A schema change creates `user.<name>.v<N+1>` beside the existing versions. Earlier versions
     MUST NOT be modified.
   - An unchanged schema MUST be refused ("The schema is unchanged from …; no new version was
     made.").
4. **Deletion.**
   - A version used by any node in the DEPLOYED flows MUST be refused (409), naming the node ids.
     Deleting it anyway would leave Node-RED waiting for a missing type, which stops every flow.
   - An unused version MAY be deleted.
   - **[UNPROVEN]** Refusing when only the person's UNDEPLOYED edits use it.
5. **The synthetic package.**
   - Created types are declared in a package named `user-events`, generated by the runtime from its
     store.
   - There is one `source` per version, with `input: true`, `event`, `payload`, and one output
     `event`.
   - Its command is the runtime's generic event-source process.
6. **Firing, and its validation.**
   - From the app, the runtime MUST validate the values against the version's payload schema and
     refuse with a reason ("Field path is required.", "Field minutes must be integer."), and only
     then send `fire {data}` to every deployed instance of that version (or to one named instance).
     With none deployed it refuses: "No deployed source emits …".
   - From a wire (the source's input, for example a snapshot action), the runtime MUST validate
     the incoming `msg.payload`. If invalid, it MUST fail the input with `done(err)`. If valid,
     the node emits a NEW run and sends `done` for the input.
   - **[UNPROVEN]** The spike checked types and required fields only; slice 03 must use a full
     validator.
7. **Taking effect.** A new or deleted version changes the set of node types. The runtime MUST be
   restarted as a process for it to take effect (10.4). Node-RED cannot add a type to a running
   runtime, and `RED.stop()` + `RED.start()` in the same process breaks it (proven).

## 10. The shell ↔ runtime channel (INTERNAL — not for node authors)

1. **Processes.**
   - The shell (Electron main) forks ONE runtime as an Electron `utilityProcess`, and supervises it.
   - The runtime hosts the HTTP server (Node-RED at `/red` behind the deploy guard), Node-RED, the
     journal and the node processes.
   - There is no HTTP app API. The app pages (`inny-app://app/…`) and the pop-outs (8.5.3) are
     served by the SHELL, so a runtime restart never blanks them. Every page call goes over IPC
     to the shell and, for the runtime, on as a `call` (below).
2. **Messages.** Structured-clone objects with a field `t`, over the utilityProcess port. Calls
   carry `rid` (a UUID) and are answered by a `reply` with the same `rid`.

   Shell → runtime:

   | `t` | Fields |
   |---|---|
   | `init` | `config: {port, userDir, python, packagesDir, appDir, generation, restart: {reason, added[], removed[], requestedAt} \| null, forkedAt}` |
   | `stop` | `reason: "quit" \| "types" \| "restart"`. The runtime records the reason for 7.3, runs `RED.stop()`, sends `stopped` and exits 0. |
   | `call` | `rid, op, args`, where `op` is `view.get {id}`, `view.submit {id, values}`, `view.list`, `snapshot.get {id}`, `snapshot.action {id, action, values}`, `snapshot.list`, `job.list` or `job.cancel {id}` |
   | `reply` | `rid, result` |

   Runtime → shell:

   | `t` | Fields |
   |---|---|
   | `ready` | `pid, generation, types[], restart: {…, ms, registered[[type, bool]]} \| null` |
   | `failed` | `error` |
   | `present` | `id, window, first, title` |
   | `pending` | `count` |
   | `restart-request` | `reason, added[], removed[], requestedAt` |
   | `reply` | `rid, result` |
   | `stopped` | `reason` |

3. **Timeouts and typed errors.**
   - Every `call` MUST time out after 5 s. (The shell opens a pop-out itself, on a FIRST
     `present` whose `window` is `popout`; the runtime never asks it to.)
   - A call MUST answer at once, without being sent, when the runtime is not `running`.
   - The results are `{ok: false, error, code}` with `code` one of:
     - `restarting` (planned restart in progress);
     - `down` (crashed, recovering);
     - `timeout`;
     - `stopped` (the runtime exited while the call was outstanding).
   - **[UNPROVEN]** The spike returned the texts, not the `code` field.
4. **Restart for types.**
   1. The runtime regenerates the node modules and sends `restart-request`.
   2. The shell sends `stop {reason: "types"}`, waits for the exit, and forks the next generation
      with `init.config.restart`.
   3. The new runtime logs and reports `restart.ms`, the time from request to types registered
      (proven: 285 to 327 ms).
   4. Open windows and pop-outs stay.
5. **The open editor after a restart.**
   - The app page compares the editor's node sets with `GET /red/nodes`, and sends what differs
     to the runtime as a `call` (10.1: there is no HTTP app API).
   - The runtime raises `runtime-event` `node/added` / `node/removed` with `getNodeList` entries;
     the editor updates its palette without a reload, keeping undeployed edits.
   - This relies on Node-RED's editor convention (borderline public).
   - **[UNPROVEN]** A fallback: an automatic editor reload when the editor is clean, and a prompt
     when it is dirty.
6. **Crash.**
   - On an unexpected runtime exit, the shell restarts it after 250 ms × n (capped at 5 s).
   - It shows the state in the app page, and the Inbox keeps its last contents.
   - **[UNPROVEN]** A crash-loop limit that stops and shows an error.
7. **Quit.**
   - The shell sends `stop {reason: "quit"}` and kills the runtime after 10 s if it has not exited.
   - The shell and the runtime MUST NOT outlive each other (6.6).
8. **`childState`**, pushed by the shell to the app page:

   | State | Meaning |
   |---|---|
   | `starting` | the first fork |
   | `running` | the runtime is up |
   | `restarting-planned` | the shell has sent `stop` for a restart |
   | `restarting` | forking the next generation after a planned stop |
   | `recovering` | forking after a crash |
   | `down` | crashed, waiting for the backoff |
   | `stopped` | quit |

## 11. Security

1. **Credentials.**
   - Delivered only in `start.credentials`.
   - Stored only encrypted by Node-RED. The credential secret is the runtime's, kept in userDir
     with mode 0600.
   - The runtime MUST register every credential value with the log redactor before any log line
     is written, and replace occurrences with `[redacted]` (proven).
   - Nodes MUST NOT log, emit or snapshot credentials.
   - Keys for core services (the Anytype API key) MAY instead be read by the node at run time from
     the InnyTypes key store, and MUST NOT pass through Node-RED (proven with Create object).
   - **[UNPROVEN]** Keeping the credential secret in the OS keychain.
2. **Identity is bound.**
   - The runtime stamps `source`, `id`, `time` and `type` (from the port).
   - A node MAY emit only on its declared ports, and only for its own live input ids.
   - Anything else is refused and logged.
3. **The deploy guard.** In front of Node-RED's `POST /red/flows`, the runtime MUST refuse (400,
   `{"code":"unknown_types","message":"Not installed in InnyTypes: …"}`) any deploy naming a type
   that is not registered.
   - It checks with the documented `RED.runtime.nodes.getNodeList`.
   - Structural types `tab`, `subflow` and `group`, and `subflow:*`, are allowed.
   - Without the guard, Node-RED accepts the deploy and stops every flow (proven).
4. **The palette lock (D1).**
   - Settings: `externalModules.palette.allowInstall: false`, `allowUpload: false`,
     `modules.allowInstall: false`, `autoInstall: false`, deny-all lists,
     `functionExternalModules: false`.
   - With these, Node-RED does not mount the install routes (404) and shows no palette manager.
   - A module dropped into `userDir/node_modules` is not loaded (proven).
   - Hot-added packages come ONLY through InnyTypes' installer. **[UNPROVEN]** Signature and lock
     verification before a declaration reaches the watched folder; the watched folder MUST NOT be
     writable by node processes.
5. **Core nodes.**
   - **Allowed:** exactly Node-RED's `core/common`: inject, debug, complete, catch, status,
     link in / out / call, comment, junction, global-config, unknown.
   - **Excluded with `nodesExcludes`:** every other core node, above all function, exec and
     template, which run arbitrary code in Node-RED's process.
6. **The admin API.**
   - It is bound to 127.0.0.1.
   - **[UNPROVEN]** Authentication (`adminAuth` or a per-launch token). Until then any local
     process can deploy.
7. **Node-RED ships the npm CLI** (a dependency of `@node-red/registry`). The runtime MUST never
   enable a path that spawns it. **[UNPROVEN]** Removing it from the build.

## 12. Conformance

### 12.1 SDK checklist

A node SDK (any language) conforms when it:
- [ ] reads `start` first, and exposes `config`, `credentials`, `data_dir` and `node`;
- [ ] writes one frame per line, UTF-8, flushed, never interleaved across threads;
- [ ] writes nothing but frames to stdout, and routes its own logging to stderr or `log` frames;
- [ ] sends `ready` after `start`;
- [ ] delivers `input`, `cancel`, `action`, `trigger`, `fire` and `close` to handlers, and ignores
      unknown frame types and unknown fields;
- [ ] provides `emit(port, data, in?)`, `done(in)`, `error(in?, message)`, `status`, `log`,
      `present`, `snapshot`;
- [ ] answers `close` with `closed`, then exits 0 within 5 s;
- [ ] treats EOF on stdin as `close`, and exits without error;
- [ ] never logs credentials;
- [ ] completes every input with exactly one `done` or `error`.

### 12.2 The conformance suite

The suite runs the SDK's reference node under a harness that plays the runtime.

| # | Test | Passes when |
|---|---|---|
| C1 | start / ready | `ready` follows `start` within 30 s; no stdout before `start` is read |
| C2 | framing | 10,000 frames from 8 threads parse one per line; one 1 MiB frame round-trips |
| C3 | stdout hygiene | a library `print` / `console.log` inside a handler does not reach stdout (the SDK redirects it) |
| C4 | input completion | 100 inputs each get exactly one terminal frame; emits carry the right `in` |
| C5 | undeclared port | the runtime refuses and logs; the SDK SHOULD refuse at the call site |
| C6 | cancel | a running input ends with `error` "cancelled …"; a queued one with "cancelled before it started" |
| C7 | close | `closed` is sent and the process exits 0 within 5 s while an input is running |
| C8 | EOF | closing stdin makes the process exit within 1 s, without a traceback |
| C9 | unknown frame | a frame `{"t":"future"}` is ignored |
| C10 | action view | `present`, then `action`, gives `emit {in}` + `done`; `__dismiss__` gives `error` |
| C11 | snapshot view | `snapshot` + pass-through `emit` + `done`; `trigger` gives `emit` with no `in` on the action port |
| C12 | fire | `fire` gives `emit` with no `in` |
| C13 | credentials | a credential value never appears on stdout (outside `start`) or stderr |
| C14 | replay | a re-sent input id (the same id twice across restarts) is accepted and completes |
| C15 | runtime-side | journal before send; planned / crash / quit attempt rules; the awaiting view is never counted; removal drops entries; deploy guard; palette lock; pop-out sandbox probes (8.5.9) |

C15 binds the runtime, not SDKs. Of these, C1, C4 to C8, C10 to C12, C14 and C15 were exercised
by the spike, by hand and by script. **[UNPROVEN]** C2, C3, C9 and C13 as automated tests, and
everything in C1 to C15 on Windows and Linux.

## Appendix A — The minimal Python SDK surface

From `spike/packages/_sdk/inny_node.py`:

```python
class Node:
    node: dict          # {id, type, name}
    config: dict
    credentials: dict   # never log
    data_dir: str

    def __init__(self) -> None: ...          # reads and checks the start frame
    def send(self, frame: dict) -> None: ... # one line, locked, flushed
    def ready(self) -> None: ...
    def emit(self, port: str, data, input_id: str | None = None) -> None: ...
    def done(self, input_id: str) -> None: ...
    def error(self, input_id: str | None, message: str) -> None: ...
    def status(self, text: str, fill: str = "blue", shape: str = "dot") -> None: ...
    def log(self, message: str, level: str = "info") -> None: ...
    def present(self, input_id: str, content: dict) -> None: ...
    def snapshot(self, content: dict, state, input_id: str | None = None) -> None: ...

    def run(self, on_input=None, on_cancel=None, on_action=None,
            on_trigger=None, on_fire=None, on_close=None) -> None:
        """Sends ready, dispatches frames; on close sends closed and returns;
        on EOF calls on_close and returns."""
```

The spike's SDK does not yet:
- redirect stray `print` to stderr (C3);
- enforce the frame size limit;
- refuse undeclared ports locally.

## Appendix B — The equivalent minimal JS/TS SDK surface

**[UNPROVEN]** Not built in the spike; it mirrors Appendix A.

```ts
export interface StartInfo {
  node: { id: string; type: string; name: string };
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  dataDir: string;
}

export interface Handlers {
  input?(id: string, event: { type: string; data: unknown; run?: string }): void | Promise<void>;
  cancel?(id: string): void;
  action?(id: string, values: Record<string, string | number | boolean>): void;
  trigger?(action: string, snapshot: { id: string; state: unknown }, values: Record<string, unknown>): void;
  fire?(data: Record<string, unknown>): void;
  close?(): void | Promise<void>;
}

export declare function start(): Promise<StartInfo>; // reads the start frame from stdin
export declare function ready(): void;
export declare function emit(port: string, data: unknown, inputId?: string): void;
export declare function done(inputId: string): void;
export declare function error(inputId: string | undefined, message: string): void;
export declare function status(text: string, fill?: "red" | "green" | "yellow" | "blue" | "grey", shape?: "ring" | "dot"): void;
export declare function log(msg: string, level?: "debug" | "info" | "warn" | "error"): void;
export declare function present(inputId: string, content: { title?: string; text?: string; fields?: Record<string, unknown>; form?: object }): void;
export declare function snapshot(content: object, state: unknown, inputId?: string): void;
export declare function run(handlers: Handlers): Promise<void>; // resolves after close/EOF
```

Implementation notes for the JS SDK:
- use `readline` on `process.stdin` for frames, and `process.stdout.write(JSON.stringify(f) + "\n")`
  for output;
- redirect `console.log` to stderr;
- on stdin `end`, run `close` and exit 0.
