// The protocol v2 frame codec (spec §3, §4): JSON lines, 1 MiB per frame, every frame's shape
// validated by ajv against the spec's own §4.5 schemas, extracted verbatim to
// docs/specs/node-protocol-v2.schema.json. A frame is checked here or nowhere: the rest of
// the runtime only ever holds a frame this module let through.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import frameSchemas from "../../../../docs/specs/node-protocol-v2.schema.json" with { type: "json" };
import type { InputEvent, NodeStatus, ViewContent } from "../../ports/node-process";

/** The largest frame, in encoded UTF-8 bytes, excluding the newline (spec 3.5). */
export const MAX_FRAME_BYTES = 1_048_576;

/**
 * How much of an oversize line is still held, so that its `in` can be read exactly and the
 * input failed. A line longer than this is counted and dropped without being held at all: a
 * node process cannot make the runtime buffer without end.
 */
export const OVERSIZE_HOLD_BYTES = 16 * MAX_FRAME_BYTES;

// ── frame types ──────────────────────────────────────────────────────────────────────────

/** Runtime → node (spec 4.1). */
export type RuntimeFrame =
  | {
      t: "start";
      protocol: 2;
      node: { id: string; type: string; name: string };
      config: Readonly<Record<string, unknown>>;
      credentials: Readonly<Record<string, string>>;
      data_dir: string;
    }
  | { t: "input"; id: string; event: InputEvent }
  | { t: "cancel"; in: string }
  | { t: "action"; in: string; values: Readonly<Record<string, unknown>> }
  | { t: "trigger"; action: string; snapshot: { id: string; state: unknown }; values: object }
  | { t: "fire"; data: Readonly<Record<string, unknown>> }
  | { t: "close" };

/** Node → runtime (spec 4.2). */
export type NodeFrame =
  | { t: "ready" }
  | ({ t: "status" } & Partial<NodeStatus> & { text: string })
  | { t: "log"; level?: "debug" | "info" | "warn" | "error"; msg: string }
  | { t: "emit"; port: string; data: unknown; in?: string }
  | { t: "done"; in: string }
  | { t: "error"; message: string; in?: string }
  | { t: "present"; in: string; content: ViewContent }
  | { t: "snapshot"; content: ViewContent; state: unknown; in?: string }
  | { t: "closed" };

const RUNTIME_FRAMES = ["start", "input", "cancel", "action", "trigger", "fire", "close"];
const NODE_FRAMES = [
  "ready",
  "status",
  "log",
  "emit",
  "done",
  "error",
  "present",
  "snapshot",
  "closed",
];

// ── validation ───────────────────────────────────────────────────────────────────────────

// Strict, so a schema typo is an error rather than a keyword quietly ignored; union types are
// the spec's own (`viewContent.fields` values).
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
ajv.addSchema(frameSchemas);
const SCHEMA_ID = frameSchemas.$id;

function validatorFor(t: string): ValidateFunction {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${t}`);
  if (validate === undefined) {
    throw new Error(`the frame schema has no definition for ${JSON.stringify(t)}`);
  }
  return validate;
}

const VALIDATORS = new Map<string, ValidateFunction>(
  [...RUNTIME_FRAMES, ...NODE_FRAMES].map((t) => [t, validatorFor(t)]),
);

function problemsOf(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

// ── decoding ─────────────────────────────────────────────────────────────────────────────

/** What one stdout line turned out to be. */
export type Decoded =
  | { kind: "frame"; frame: NodeFrame }
  /** Over 1 MiB: discarded (spec 3.5). `inputId` is the `in` it carried, if it could be read. */
  | { kind: "oversize"; bytes: number; inputId: string | null }
  /** Not UTF-8, not JSON, or not a frame at all (spec 3.3, 3.6). `text` is for the log. */
  | { kind: "violation"; reason: string; text: string }
  /** A frame of a type the runtime does not know: warned about and ignored (spec 1.3). */
  | { kind: "unknown"; t: string }
  /** A known frame type whose shape breaks its §4.5 schema. */
  | { kind: "invalid"; t: string; problems: string };

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const LOSSY_UTF8 = new TextDecoder("utf-8");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `in` an oversize frame carried, read exactly by parsing it; null when it cannot be. */
function inputIdOf(line: Uint8Array): string | null {
  if (line.length > OVERSIZE_HOLD_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(STRICT_UTF8.decode(line));
    return isRecord(parsed) && typeof parsed["in"] === "string" ? parsed["in"] : null;
  } catch {
    return null;
  }
}

/** Decode one stdout line (without its newline). */
export function decodeFrame(line: Uint8Array): Decoded {
  if (line.length > MAX_FRAME_BYTES) {
    return { kind: "oversize", bytes: line.length, inputId: inputIdOf(line) };
  }
  let text: string;
  try {
    text = STRICT_UTF8.decode(line);
  } catch {
    return { kind: "violation", reason: "not UTF-8", text: LOSSY_UTF8.decode(line) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "violation", reason: "not JSON", text };
  }
  if (!isRecord(parsed) || typeof parsed["t"] !== "string") {
    return { kind: "violation", reason: "not a frame (no string field t)", text };
  }
  const t = parsed["t"];
  if (!NODE_FRAMES.includes(t)) {
    return { kind: "unknown", t };
  }
  const validate = VALIDATORS.get(t) as ValidateFunction;
  if (!validate(parsed)) {
    return { kind: "invalid", t, problems: problemsOf(validate) };
  }
  return { kind: "frame", frame: parsed as NodeFrame };
}

// ── encoding ─────────────────────────────────────────────────────────────────────────────

/** A frame the runtime was about to send is over 1 MiB (spec 3.5). */
export class FrameTooLargeError extends Error {
  override name = "FrameTooLargeError";
}

/** One line to write to a node's stdin: validated, sized, newline-terminated. */
export function encodeFrame(frame: RuntimeFrame): string {
  const t = frame.t;
  const validate = VALIDATORS.get(t) as ValidateFunction;
  if (!validate(frame)) {
    // The runtime built it, so this is a bug here, not the node's fault: fail loudly.
    throw new Error(`the runtime built an invalid ${t} frame: ${problemsOf(validate)}`);
  }
  const json = JSON.stringify(frame);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(
      `frame too large: ${String(bytes)} bytes, the limit is ${String(MAX_FRAME_BYTES)}`,
    );
  }
  return `${json}\n`;
}

// ── line splitting ───────────────────────────────────────────────────────────────────────

/** One line read from a stream: its bytes, or only its length when it was too long to hold. */
export type ReadLine = { kind: "line"; bytes: Buffer } | { kind: "dropped"; bytes: number };

/**
 * Splits a byte stream into LF-terminated lines, holding at most OVERSIZE_HOLD_BYTES of one
 * line. Bytes, not strings: the frame limit is in encoded bytes, and a multi-byte character
 * split across two chunks must not be decoded half by half.
 */
export class LineReader {
  #held: Buffer[] = [];
  #heldBytes = 0;
  /** The current line outgrew the hold: only its length is counted now. */
  #dropping = false;
  #length = 0;

  push(chunk: Buffer): ReadLine[] {
    const lines: ReadLine[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        this.#hold(chunk.subarray(start));
        return lines;
      }
      this.#hold(chunk.subarray(start, newline));
      lines.push(this.#take());
      start = newline + 1;
    }
  }

  /** The stream ended: an unterminated last line is still a line. */
  end(): ReadLine[] {
    return this.#length > 0 ? [this.#take()] : [];
  }

  #hold(part: Buffer): void {
    this.#length += part.length;
    if (this.#dropping) {
      return;
    }
    if (this.#heldBytes + part.length > OVERSIZE_HOLD_BYTES) {
      this.#dropping = true;
      this.#held = [];
      this.#heldBytes = 0;
      return;
    }
    if (part.length > 0) {
      this.#held.push(part);
      this.#heldBytes += part.length;
    }
  }

  #take(): ReadLine {
    const line: ReadLine = this.#dropping
      ? { kind: "dropped", bytes: this.#length }
      : { kind: "line", bytes: Buffer.concat(this.#held) };
    this.#held = [];
    this.#heldBytes = 0;
    this.#dropping = false;
    this.#length = 0;
    return line;
  }
}
