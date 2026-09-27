# The Python SDK: `innytypes-node`

Source: `sdk/python/src/innytypes_node/`. Standard library only — no dependency your package
ever has to reconcile with another package's, or with the host's (`sdk/python/pyproject.toml`
declares `dependencies = []`, and `sdk/python/tests/test_stdlib_only.py` holds it, both as a
declared fact and by inspecting every import in the module).

## Install

Your package's `requirements.lock` names `innytypes-node` like any other pinned, hash-locked
dependency (`docs/authors/packaging.md`). During development, point your interpreter at
`sdk/python/src` directly, or `uv pip install -e sdk/python` from the repository root.

## The `Node` class

```python
from innytypes_node import Node

node = Node()  # reads and checks the start frame; sends nothing before that (spec 4.1)

node.node          # {"id", "type", "name"}
node.config        # your instance's settings, already coerced to your config schema's types
node.credentials   # your instance's secret settings; NEVER log, emit or snapshot these
node.data_dir       # a private folder for this instance, persists across restarts
```

| Method | Sends |
|---|---|
| `node.ready()` | `ready` — `run()` calls this for you; call it yourself only if you drive the loop by hand. |
| `node.emit(port, data, input_id=None)` | `emit`. Omit `input_id` to start a NEW run (a source, a snapshot action, a fire). |
| `node.done(input_id)` | `done` — the input's work is finished. |
| `node.error(input_id, message)` | `error`. `input_id=None` is an error with no input (logged, no Catch). |
| `node.status(text, fill="blue", shape="dot")` | `status` — shown on the Jobs page. |
| `node.log(message, level="info")` | `log` — written to the one log, redacted. |
| `node.present(input_id, content)` | `present` — an action view's content (spec §8.1). |
| `node.snapshot(content, state, input_id=None)` | `snapshot` — a snapshot view's record (spec §8.3). |

## Running the conversation

```python
def on_input(input_id: str, event: dict) -> None:
    node.emit("out", event["data"], input_id)
    node.done(input_id)

node.run(on_input=on_input, on_cancel=None, on_action=None, on_trigger=None, on_fire=None, on_close=None)
```

`run()` sends `ready`, then dispatches every frame to the matching handler **on its own daemon
thread** — inputs, actions and triggers may all complete concurrently (spec §4.3.3 allows
this). If your work must be serial, queue it yourself inside your handlers (the queue the raw
`rawnode` conformance fixture uses, `app/test/fixtures/raw-node/node.py`, is one pattern). An
exception that escapes `on_input` or `on_action` fails that input with `error` automatically,
so you do not have to wrap every handler in `try`/`except` just to guarantee exactly one
terminal frame (spec's C4). An exception from `on_trigger` or `on_fire` (which start a new run,
with no input to fail) is logged instead.

`run()` returns after an explicit `close` (having sent `closed`) or at end-of-input (spec
§6.4) — either way your script then falls off the end and the process exits.

## What the SDK guarantees, without you asking for it

- **stdout carries frames only** (spec §3.3, conformance C3). Once `Node()` has read the start
  frame, `print()` and anything else that writes to `sys.stdout` or `sys.stderr` is redirected
  to the real stderr — redacted — so a library's own logging, or a raw `print()` you left in
  by accident, can never corrupt the frame stream.
- **Every credential is protected automatically** (spec §11.1, conformance C13): the moment
  `Node()` reads the start frame, every value in `credentials` is registered with the
  redactor. A credential that turns up in a log line or an exception message becomes
  `"[redacted]"` — you do not have to remember to call `protect()` yourself. Call
  `innytypes_node.protect(secret)` for anything else worth protecting (a token you fetch at
  runtime, say), and `innytypes_node.redact(text)` to redact text by hand.
- **A frame over 1 MiB is refused before it is ever sent** (`FrameTooLargeError`, spec §3.5):
  the runtime would only discard it and fail the input anyway. Pass a large payload as a file
  path instead (the pattern `folderflow`'s fixture uses for a folder).
- **An undeclared port is refused at the call site**, if you tell the SDK your ports:
  `Node(ports=["out", "done"])` makes `emit("nope", ...)` raise immediately, rather than
  silently reaching a runtime that would refuse and log it anyway (spec's C5).

## A complete example

`sdk/python/examples/echo` is a whole installable package — its `inny-package.json`, its one
file, nothing else — worth reading end to end before writing your own.
