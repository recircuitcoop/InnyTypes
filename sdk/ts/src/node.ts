// @innytypes/node: the TypeScript node SDK (node protocol v2, spec Appendix B), complete
// (WI-0018-26): start, run with input/cancel/action/trigger/fire/close, emit, done, error,
// status, log, present, snapshot, and anytypeKey(). WI-0018-20 built the subset the
// first-party Anytype nodes need first; this file grows it to the whole of Appendix B and
// passes C1 to C14 (app/test/conformance/sdk-node.test.ts, sdk-views.test.ts) without
// changing anything packages/anytype already calls. No runtime dependencies, Node's standard
// library only, so a package that bundles it ships one file that runs as it is.
//
// Revision 2.1 (spec 1.3, still wire protocol 2) adds done()'s report (notes, results) and
// progress(): optional, so a node that never uses them sends exactly the 2.0 frames.
//
// Two rules hold for everything this file writes:
// * stdout carries frames only (spec 3.3): console.log and friends go to stderr (C3).
// * Every registered secret is replaced by [redacted] in every frame and every stderr line,
//   so a key that turns up in an error message never leaves the process (spec 11.1). Every
//   credential value is protected the moment start() reads it, before any handler can run.

import * as fs from "node:fs";
import * as readline from "node:readline";

export interface StartInfo {
  readonly node: { readonly id: string; readonly type: string; readonly name: string };
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentials: Readonly<Record<string, string>>;
  readonly dataDir: string;
}

export interface InputEvent {
  readonly type: string;
  readonly data: unknown;
  readonly run?: string;
}

/** A snapshot the runtime hands back on `trigger` (spec 4.1): its id and its stored state. */
export interface TriggerSnapshot {
  readonly id: string;
  readonly state: unknown;
}

export interface Handlers {
  input?(id: string, event: InputEvent): void | Promise<void>;
  cancel?(id: string): void;
  /** Action views only: the person submitted or dismissed (spec 4.1 `action`). */
  action?(id: string, values: Readonly<Record<string, unknown>>): void | Promise<void>;
  /** Snapshot views only: an action was pressed (spec 4.1 `trigger`). */
  trigger?(
    action: string,
    snapshot: TriggerSnapshot,
    values: Readonly<Record<string, unknown>>,
  ): void | Promise<void>;
  /** Created event sources only: the person fired the event from the app (spec 4.1 `fire`). */
  fire?(data: Readonly<Record<string, unknown>>): void | Promise<void>;
  close?(): void | Promise<void>;
}

/** A view's content (spec 4.5 `viewContent`): what `present` and `snapshot` send. */
export interface ViewContent {
  readonly title?: string;
  readonly text?: string;
  readonly fields?: Readonly<Record<string, string | number | boolean | null>>;
  readonly form?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

type Frame = Record<string, unknown>;

/** A frame this node was about to send is over 1 MiB encoded (spec 3.5). The runtime would
 * only discard an oversize frame (and fail the input it belonged to), so this SDK refuses to
 * write one at all: a large payload belongs in a file, passed by path (spec 3.5). */
export class FrameTooLargeError extends Error {
  override name = "FrameTooLargeError";
}

/** The largest frame, in encoded UTF-8 bytes, excluding the newline (spec 3.5). */
const MAX_FRAME_BYTES = 1_048_576;

/** This type's declared output ports (spec 2.4 `outputs`), when the author opted in to
 * `emit()` refusing an undeclared one at the call site (C5, SHOULD) rather than letting the
 * runtime discard it later. `null` (the default) accepts anything, as the spike's SDK did. */
let declaredPorts: ReadonlySet<string> | null = null;

/** Declare this type's output ports, so `emit()` refuses an undeclared one immediately. */
export function declarePorts(ports: readonly string[]): void {
  declaredPorts = new Set(ports);
}

// ── redaction ────────────────────────────────────────────────────────────────────────────

/** What a redacted secret is replaced with, as the runtime's redactor writes it. */
export const REDACTED = "[redacted]";

const secrets = new Set<string>();

/** Register a secret: from now on it is replaced in every frame and stderr line. */
export function protect(secret: string): void {
  // An empty one would put the marker between every character of every line.
  if (secret !== "") {
    secrets.add(secret);
  }
}

/** `text` with every registered secret replaced, the longest first. */
export function redact(text: string): string {
  let redacted = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }
  return redacted;
}

function toStderr(...parts: unknown[]): void {
  const text = parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  process.stderr.write(redact(text) + "\n");
}

/** Taken over by start(), so importing this module changes nothing on its own. */
function guardStdio(): void {
  // stdout is the frame channel: a library that prints must not corrupt it (C3).
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.error = toStderr;
  // A crash is said on stderr redacted, never with Node's own unredacted report.
  process.on("uncaughtException", (caught: unknown) => {
    toStderr(caught instanceof Error ? (caught.stack ?? caught.message) : String(caught));
    process.exit(1);
  });
}

// ── frames ───────────────────────────────────────────────────────────────────────────────

/** One frame, one line, redacted (spec 3.2). Node writes each call whole: no interleaving. */
function send(frame: Frame): void {
  const line = redact(JSON.stringify(frame));
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(
      `frame too large: ${String(bytes)} bytes, the limit is ${String(MAX_FRAME_BYTES)}`,
    );
  }
  process.stdout.write(line + "\n");
}

export function ready(): void {
  send({ t: "ready" });
}

export function emit(port: string, data: unknown, inputId?: string): void {
  if (declaredPorts !== null && !declaredPorts.has(port)) {
    const declared = [...declaredPorts].sort().join(", ") || "(none)";
    throw new Error(
      `${JSON.stringify(port)} is not one of this type's declared outputs: ${declared}`,
    );
  }
  send(inputId === undefined ? { t: "emit", port, data } : { t: "emit", port, data, in: inputId });
}

/** A note or a warning on `done` (spec 4.2.1): a line on the step, never a failure. */
export interface DoneNote {
  readonly level: "note" | "warning";
  readonly text: string;
}

/** One thing the step did, in its own words (spec 4.2.1), and what the line opens. */
export interface DoneResult {
  readonly kind: "anytype" | "file" | "scheduled" | "plain";
  readonly text: string;
  readonly anytype?: { readonly spaceId: string; readonly objectId: string };
  readonly folder?: string;
  readonly due?: string;
}

/** What a step reports as it finishes (revision 2.1): at most 20 of each, 200 characters a text. */
export interface DoneReport {
  readonly notes?: readonly DoneNote[];
  readonly results?: readonly DoneResult[];
}

/** Finish `inputId`; with `report`, its notes and results reach the input's run (spec 4.2.1). */
export function done(inputId: string, report: DoneReport = {}): void {
  const frame: Frame = { t: "done", in: inputId };
  if (report.notes !== undefined) {
    frame["notes"] = report.notes;
  }
  if (report.results !== undefined) {
    frame["results"] = report.results;
  }
  send(frame);
}

/**
 * How far `inputId` has got (spec 4.2.2): a `status` naming the input, so its run's step shows
 * `doneCount` of `total` and the time left (`etaS`, seconds). `text` defaults to "2 of 3"; the
 * node's badge shows it as any status.
 */
export function progress(
  inputId: string,
  doneCount: number,
  total: number,
  etaS?: number,
  text: string = `${String(doneCount)} of ${String(total)}`,
): void {
  const frame: Frame = {
    t: "status",
    text: text.slice(0, 200),
    fill: "blue",
    shape: "dot",
    in: inputId,
    progress: { done: doneCount, total },
  };
  if (etaS !== undefined) {
    // JSON has no Infinity or NaN: JSON.stringify would quietly write null.
    if (!Number.isFinite(etaS) || etaS < 0) {
      throw new Error(`etaS must be a finite number of seconds >= 0, not ${String(etaS)}`);
    }
    frame["eta_s"] = etaS;
  }
  send(frame);
}

export function error(inputId: string | undefined, message: string): void {
  // The spec's limit is 2,000 characters (§4.5); longer would be refused as invalid.
  const text = message.slice(0, 2000);
  send(
    inputId === undefined
      ? { t: "error", message: text }
      : { t: "error", in: inputId, message: text },
  );
}

export function status(
  text: string,
  fill: "red" | "green" | "yellow" | "blue" | "grey" = "blue",
  shape: "ring" | "dot" = "dot",
): void {
  send({ t: "status", text: text.slice(0, 200), fill, shape });
}

export function log(msg: string, level: "debug" | "info" | "warn" | "error" = "info"): void {
  send({ t: "log", level, msg });
}

export function present(inputId: string, content: ViewContent): void {
  send({ t: "present", in: inputId, content });
}

export function snapshot(content: ViewContent, state: unknown, inputId?: string): void {
  send(
    inputId === undefined
      ? { t: "snapshot", content, state }
      : { t: "snapshot", content, state, in: inputId },
  );
}

// ── the conversation ─────────────────────────────────────────────────────────────────────

/** stdin's lines, from start() on. */
let incoming: AsyncIterator<string> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** stdin's lines; start() must have run. */
function lines(): AsyncIterator<string> {
  if (incoming === null) {
    throw new Error("start() reads the start frame first");
  }
  return incoming;
}

/** Read the start frame, the first line (spec 4.1). Anything else ends the process. */
export async function start(): Promise<StartInfo> {
  guardStdio();
  const reader = readline.createInterface({ input: process.stdin, terminal: false });
  incoming = reader[Symbol.asyncIterator]();
  const first = await incoming.next();
  const frame: unknown = first.done === true ? null : JSON.parse(first.value);
  if (!isRecord(frame) || frame["t"] !== "start" || frame["protocol"] !== 2) {
    toStderr("the first frame was not a protocol 2 start");
    process.exit(2);
  }
  const node = isRecord(frame["node"]) ? frame["node"] : {};
  const credentials: Record<string, string> = isRecord(frame["credentials"])
    ? (frame["credentials"] as Record<string, string>)
    : {};
  // Every credential is protected the moment it is read, before any handler can run (spec
  // 11.1): a node author does not have to remember to call protect() themself.
  for (const value of Object.values(credentials)) {
    protect(value);
  }
  return {
    node: {
      id: typeof node["id"] === "string" ? node["id"] : "",
      type: typeof node["type"] === "string" ? node["type"] : "",
      name: typeof node["name"] === "string" ? node["name"] : "",
    },
    config: isRecord(frame["config"]) ? frame["config"] : {},
    credentials,
    dataDir: typeof frame["data_dir"] === "string" ? frame["data_dir"] : "",
  };
}

/** Send `closed`, and exit once it is written: a pipe's write can still be pending. */
function closeAndExit(): void {
  process.stdout.write(JSON.stringify({ t: "closed" }) + "\n", () => {
    process.exit(0);
  });
}

/**
 * Send `ready`, then hand every frame to its handler until `close` (answered with `closed`)
 * or the end of stdin (spec 6.4). Inputs run concurrently; one whose handler throws fails
 * with its message, redacted. Unknown frames are ignored (spec 1.3).
 */
export async function run(handlers: Handlers): Promise<void> {
  ready();
  const reader = lines();
  for (;;) {
    const next = await reader.next();
    if (next.done === true) {
      await handlers.close?.();
      process.exit(0);
    }
    const frame: unknown = JSON.parse(next.value);
    if (!isRecord(frame)) {
      continue;
    }
    if (frame["t"] === "input" && typeof frame["id"] === "string" && isRecord(frame["event"])) {
      const id = frame["id"];
      const event = frame["event"] as unknown as InputEvent;
      Promise.resolve()
        .then(() => handlers.input?.(id, event))
        .catch((caught: unknown) => {
          error(id, caught instanceof Error ? caught.message : String(caught));
        });
    } else if (frame["t"] === "cancel" && typeof frame["in"] === "string") {
      handlers.cancel?.(frame["in"]);
    } else if (frame["t"] === "action" && typeof frame["in"] === "string") {
      const id = frame["in"];
      const values = isRecord(frame["values"]) ? frame["values"] : {};
      Promise.resolve()
        .then(() => handlers.action?.(id, values))
        .catch((caught: unknown) => {
          error(id, caught instanceof Error ? caught.message : String(caught));
        });
    } else if (
      frame["t"] === "trigger" &&
      typeof frame["action"] === "string" &&
      isRecord(frame["snapshot"]) &&
      typeof frame["snapshot"]["id"] === "string"
    ) {
      const action = frame["action"];
      const triggerSnapshot: TriggerSnapshot = {
        id: frame["snapshot"]["id"],
        state: frame["snapshot"]["state"],
      };
      const values = isRecord(frame["values"]) ? frame["values"] : {};
      // No input id here (spec 4.1: a NEW run): an exception has nothing to fail, only to say.
      Promise.resolve()
        .then(() => handlers.trigger?.(action, triggerSnapshot, values))
        .catch((caught: unknown) => {
          log(caught instanceof Error ? caught.message : String(caught), "error");
        });
    } else if (frame["t"] === "fire" && isRecord(frame["data"])) {
      const data = frame["data"];
      Promise.resolve()
        .then(() => handlers.fire?.(data))
        .catch((caught: unknown) => {
          log(caught instanceof Error ? caught.message : String(caught), "error");
        });
    } else if (frame["t"] === "close") {
      await handlers.close?.();
      closeAndExit();
      return;
    }
  }
}

// ── the Anytype key (spec 11.1) ──────────────────────────────────────────────────────────

/** Where the runtime says the key is; the app's domain/anytype/pins.ts names the same two. */
export const ANYTYPE_KEY_FILE_VARIABLE = "INNYTYPES_ANYTYPE_KEY_FILE";
export const ANYTYPE_KEY_LEGACY_FILE_VARIABLE = "INNYTYPES_ANYTYPE_KEY_LEGACY_FILE";

/** The runtime gave this process no key file: it is not a first-party Anytype node. */
export class NoKeyFileError extends Error {
  override name = "NoKeyFileError";
}

// O_NOFOLLOW does not exist on Windows, where links need privileges to make anyway.
const NO_FOLLOW = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;

/** A key file's trimmed text; null when it is missing or empty. Never through a link. */
function readKeyFile(file: string): string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw new Error(`the Anytype key file ${file} could not be read: ${String(code)}`, {
      cause: caught,
    });
  }
  try {
    const text = fs.readFileSync(descriptor, "utf8").trim();
    return text === "" ? null : text;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * The Anytype key, read now from the file the runtime named (the legacy file only when the
 * canonical one holds nothing), and registered with this process's redactor before it is
 * returned. Null when there is no key yet. Read on every call, so a new pairing is used at once.
 */
export function anytypeKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const file = env[ANYTYPE_KEY_FILE_VARIABLE];
  if (file === undefined || file === "") {
    throw new NoKeyFileError(
      "InnyTypes gave this node no Anytype key file; only its own Anytype nodes are given one",
    );
  }
  const legacy = env[ANYTYPE_KEY_LEGACY_FILE_VARIABLE];
  const key =
    readKeyFile(file) ?? (legacy === undefined || legacy === "" ? null : readKeyFile(legacy));
  if (key !== null) {
    protect(key);
  }
  return key;
}
