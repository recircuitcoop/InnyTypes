// The shell ↔ child channel's messages (spec 10.2), typed and versioned.
//
// The spike's channel was untyped objects answered with bare texts (arch_pivot P11 §6.3).
// Here every message carries the channel version `v`, and both ends parse what arrives
// before acting on it: a structured clone is `unknown` until it is checked, and a message
// from another version is refused rather than guessed at.
//
// INTERNAL: this is not the node protocol; node authors never see it.

/** The version both ends speak. A message with any other `v` is refused. */
export const CHANNEL_VERSION = 1;

/** Why the shell stops a child: a quit, a restart for node types, or any other restart. */
export type StopReason = "quit" | "types" | "restart";

/** Why a planned restart happened, handed to the next generation in `init`. */
export interface RestartInfo {
  readonly reason: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly requestedAt: number;
}

/**
 * What a child is told at start. Settings travel here, never through an inherited
 * environment (arch_pivot P9 surprise 5).
 */
export interface InitConfig {
  readonly generation: number;
  /** The loopback port for the runtime's HTTP server; the same for every generation. */
  readonly port: number | null;
  readonly userDir: string;
  readonly restart: RestartInfo | null;
  readonly forkedAt: number;
  /**
   * Node-RED's credential secret (WI-0018-06), for the runtime only. It travels in memory,
   * by structured clone, and is never written anywhere unencrypted.
   */
  readonly credentialSecret?: string;
  /**
   * Where the Anytype key and the proxy token live, for the services process only: resolved
   * once by the shell from its own HOME, so the child never looks a secret up for itself and a
   * test's scratch paths are the only ones it can reach (WI-0018-18, after an e2e run read the
   * real key through a HOME the shell had not passed on).
   */
  readonly secretFiles?: SecretPaths;
}

/** One secret's file, and the read-only legacy file it may still be in. */
export interface SecretPath {
  readonly file: string;
  readonly legacy?: string;
}

export type SecretPaths = Readonly<
  Partial<Record<"anytype-api-key" | "mcp-proxy-token", SecretPath>>
>;

function isSecretPaths(value: unknown): value is SecretPaths {
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([name, where]) =>
      (name === "anytype-api-key" || name === "mcp-proxy-token") &&
      isRecord(where) &&
      isString(where["file"]) &&
      where["file"] !== "" &&
      (where["legacy"] === undefined || isString(where["legacy"])),
  );
}

/**
 * The call operations (spec 10.2): the runtime's views and snapshots, and the services
 * process's Anytype status and pairing (WI-0018-18).
 */
export type CallOp =
  | "view.get"
  | "view.submit"
  | "snapshot.get"
  | "snapshot.action"
  | "anytype.status"
  | "anytype.pair.start"
  | "anytype.pair.complete";

const CALL_OPS: readonly string[] = [
  "view.get",
  "view.submit",
  "snapshot.get",
  "snapshot.action",
  "anytype.status",
  "anytype.pair.start",
  "anytype.pair.complete",
];

/** What a child answers a call with. A channel failure is a `ChannelError`, not this. */
export type OpResult =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** Shell → child. */
export type ShellMessage =
  | { readonly v: 1; readonly t: "init"; readonly config: InitConfig }
  | { readonly v: 1; readonly t: "stop"; readonly reason: StopReason }
  /**
   * One end of the runtime ↔ services channel (§2.2), transferred with this message. Sent
   * whenever both are running and either is a new generation; it replaces the one before.
   */
  | { readonly v: 1; readonly t: "peer" }
  | {
      readonly v: 1;
      readonly t: "call";
      readonly rid: string;
      readonly op: CallOp;
      readonly args: unknown;
    };

/** Child → shell. */
export type ChildMessage =
  | {
      readonly v: 1;
      readonly t: "ready";
      readonly pid: number;
      readonly generation: number;
      readonly port: number | null;
    }
  | { readonly v: 1; readonly t: "failed"; readonly error: string }
  | { readonly v: 1; readonly t: "stopped"; readonly reason: StopReason }
  | { readonly v: 1; readonly t: "reply"; readonly rid: string; readonly result: OpResult };

type Fields = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isPortOrNull = (value: unknown): value is number | null =>
  value === null || (isNumber(value) && Number.isInteger(value) && value > 0 && value < 65_536);
const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isString);

export function isStopReason(value: unknown): value is StopReason {
  return value === "quit" || value === "types" || value === "restart";
}

export function isCallOp(value: unknown): value is CallOp {
  return isString(value) && CALL_OPS.includes(value);
}

function isRestartInfo(value: unknown): value is RestartInfo {
  return (
    isRecord(value) &&
    isString(value["reason"]) &&
    isStringList(value["added"]) &&
    isStringList(value["removed"]) &&
    isNumber(value["requestedAt"])
  );
}

function isInitConfig(value: unknown): value is InitConfig {
  return (
    isRecord(value) &&
    isNumber(value["generation"]) &&
    isPortOrNull(value["port"]) &&
    isString(value["userDir"]) &&
    (value["restart"] === null || isRestartInfo(value["restart"])) &&
    isNumber(value["forkedAt"]) &&
    (value["credentialSecret"] === undefined ||
      (isString(value["credentialSecret"]) && value["credentialSecret"] !== "")) &&
    (value["secretFiles"] === undefined || isSecretPaths(value["secretFiles"]))
  );
}

function isOpResult(value: unknown): value is OpResult {
  if (!isRecord(value)) {
    return false;
  }
  if (value["ok"] === true) {
    return "value" in value;
  }
  return value["ok"] === false && isString(value["error"]);
}

/** The message's fields when it is an object of this channel version; null otherwise. */
function versioned(raw: unknown): Fields | null {
  return isRecord(raw) && raw["v"] === CHANNEL_VERSION && isString(raw["t"]) ? raw : null;
}

/** A shell message as the child receives it, or null when it is not one of this version. */
export function parseShellMessage(raw: unknown): ShellMessage | null {
  const m = versioned(raw);
  if (m === null) {
    return null;
  }
  switch (m["t"]) {
    case "init":
      return isInitConfig(m["config"]) ? { v: 1, t: "init", config: m["config"] } : null;
    case "stop":
      return isStopReason(m["reason"]) ? { v: 1, t: "stop", reason: m["reason"] } : null;
    case "peer":
      return { v: 1, t: "peer" };
    case "call":
      return isString(m["rid"]) && isCallOp(m["op"])
        ? { v: 1, t: "call", rid: m["rid"], op: m["op"], args: m["args"] }
        : null;
    default:
      return null;
  }
}

/** A child message as the shell receives it, or null when it is not one of this version. */
export function parseChildMessage(raw: unknown): ChildMessage | null {
  const m = versioned(raw);
  if (m === null) {
    return null;
  }
  switch (m["t"]) {
    case "ready":
      return isNumber(m["pid"]) && isNumber(m["generation"]) && isPortOrNull(m["port"])
        ? { v: 1, t: "ready", pid: m["pid"], generation: m["generation"], port: m["port"] }
        : null;
    case "failed":
      return isString(m["error"]) ? { v: 1, t: "failed", error: m["error"] } : null;
    case "stopped":
      return isStopReason(m["reason"]) ? { v: 1, t: "stopped", reason: m["reason"] } : null;
    case "reply":
      return isString(m["rid"]) && isOpResult(m["result"])
        ? { v: 1, t: "reply", rid: m["rid"], result: m["result"] }
        : null;
    default:
      return null;
  }
}
