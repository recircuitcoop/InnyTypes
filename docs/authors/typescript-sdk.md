# The TypeScript SDK: `@innytypes/node`

Source: `sdk/ts/src/node.ts`. No runtime dependencies — a package built on it ships one
bundled file that runs as it is (no `npm install` step ever runs against an installed
package, spec §2.3.3).

## Install and bundle

During development, import it directly: `import { start, run, emit, ... } from
"@innytypes/node"` resolves to `sdk/ts/src/node.ts` inside this workspace. To publish, bundle
your entry point with everything inlined — `inny-pack build` does this for you with esbuild
(`docs/authors/packaging.md`); `packages/anytype` (the first-party Anytype nodes) is the
existing example of the same bundling, `esbuild src/main.ts --bundle --platform=node
--target=node22 --format=cjs --outfile=dist/main.cjs`.

## The functions

```ts
import { start, run, emit, done, error, status, log, present, snapshot } from "@innytypes/node";

const info = await start(); // reads and checks the start frame; nothing is sent before this
info.node; // { id, type, name }
info.config; // your instance's settings
info.credentials; // your instance's secret settings — NEVER log, emit or snapshot these
info.dataDir; // a private folder for this instance, persists across restarts
```

| Call | Sends |
|---|---|
| `ready()` | `ready` — `run()` calls this for you. |
| `emit(port, data, inputId?)` | `emit`. Omit `inputId` to start a NEW run. |
| `done(inputId)` | `done`. |
| `error(inputId \| undefined, message)` | `error`. |
| `status(text, fill?, shape?)` | `status`. |
| `log(msg, level?)` | `log`. |
| `present(inputId, content)` | `present` (spec §8.1). |
| `snapshot(content, state, inputId?)` | `snapshot` (spec §8.3). |
| `declarePorts(ports)` | Nothing — makes `emit()` refuse an undeclared port at the call site (conformance C5). |
| `protect(secret)` / `redact(text)` | Nothing — register or redact by hand; every credential is protected automatically (below). |

## Running the conversation

```ts
declarePorts(["out"]);
await start();
await run({
  input: async (id, event) => {
    emit("out", event.data, id);
    done(id);
  },
  cancel: (id) => { /* ... */ },
  action: (id, values) => { /* action views */ },
  trigger: (action, snapshot, values) => { /* snapshot views */ },
  fire: (data) => { /* created event sources */ },
  close: async () => { /* ... */ },
});
```

Each handler runs as a microtask, so several inputs may be in flight at once (spec §4.3.3
allows this; queue inside your handler if your work must be serial). A handler that throws
fails that input with `error` (`input`, `action`) or is logged (`trigger`, `fire`, which start
a new run with nothing to fail) — the same guarantee the Python SDK gives, so C4's "exactly
one terminal frame" holds without you writing `try`/`catch` everywhere. `run()` resolves after
an explicit `close` (having sent `closed` and exited 0) or at end-of-input (spec §6.4).

## What the SDK guarantees, without you asking for it

- **stdout carries frames only** (spec §3.3, C3): `console.log` and friends are redirected to
  stderr, redacted, the moment this module is imported.
- **Every credential is protected automatically** (spec §11.1, C13): `start()` registers every
  value of `credentials` with the redactor before returning it, so a value that turns up in a
  log line is `"[redacted]"` without you calling `protect()` yourself.
- **A frame over 1 MiB throws `FrameTooLargeError`** rather than being sent (spec §3.5): the
  runtime would only discard it and fail the input. Pass a large payload as a file path.
- **`declarePorts()` makes an undeclared `emit()` throw immediately** (C5), instead of
  reaching a runtime that would refuse and log it later.
- **`anytypeKey()`** (used by the first-party Anytype nodes, not part of the general
  contract) reads InnyTypes' own pairing key from the file the runtime names in
  `INNYTYPES_ANYTYPE_KEY_FILE`, registers it with the redactor, and returns `null` when there
  is none yet. A third-party package has no use for it unless it specifically talks to the
  Anytype API the way InnyTypes' own nodes do.

## A complete example

`sdk/ts/examples/echo` is a whole installable package worth reading end to end before writing
your own.
