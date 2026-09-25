// The journal's entries and the retry rules (spec §7, arch_pivot P4 and P11c).
//
// An input is journaled before its `input` frame is written, and its entry is cleared on
// `done` or `error`. What is left in the journal when an instance starts is re-sent, and this
// file decides how: an interruption the runtime planned (a node-type change, a redeploy) is
// not the step's fault and is not counted; a crash or a quit is counted; a step counted twice
// fails; a view waiting on a person is never counted, however often it is re-sent.
//
// Pure: no I/O. The store (ports/journal-store.ts) keeps entries; the node process
// (adapters/process/node-process.ts) applies these rules to them.

/** `sent`: the step is (or will be) with the node; `awaiting`: an action view waits (spec 8.1). */
export type EntryState = "sent" | "awaiting";

/** Why an instance was closed (spec 6.2, 7.3): the runtime's `stop` reason, or Node-RED's. */
export type CloseReason =
  /** A redeploy re-creates the instance: a close that is neither a quit nor a removal. */
  | "redeploy"
  /** The runtime was stopped for a node-type change (`stop` reason `types`). */
  | "types"
  /** The runtime was stopped because the app quits (`stop` reason `quit`). */
  | "quit"
  /** The node was deleted from the flow and deployed (Node-RED's `removed = true`). */
  | "removed";

/** The planned interruptions: re-sent without counting (spec 7.3). */
export type PlannedBy = "redeploy" | "types";

/** The maximum of counted attempts: the first send plus one retry (spec 7.3, the owner's P4). */
export const MAX_ATTEMPTS = 2;

/**
 * The part of the Node-RED message the journal keeps (spec 7.1), and ALL a replayed message
 * carries (spec 5.1): no internal marker ever rides on it (plan 0018 §7), so Catch and
 * Complete see exactly these fields.
 */
export interface JournaledMessage {
  readonly payload: unknown;
  readonly topic?: unknown;
  readonly inny?: unknown;
  readonly _msgid?: string;
}

/** The event of an `input` frame (spec 4.1). */
export interface JournaledEvent {
  readonly type: string;
  readonly data: unknown;
  readonly run?: string;
}

export interface JournalEntry {
  /** The input id, assigned by the runtime and kept across every re-send (spec 7.2). */
  readonly inputId: string;
  readonly instanceId: string;
  /** The Node-RED type name of the instance. */
  readonly type: string;
  readonly message: JournaledMessage;
  readonly event: JournaledEvent;
  /**
   * How often the step was handed to a node process, counted by the rules above. 0 for an
   * input held at the queue bound when its instance closed: it never reached a process.
   */
  readonly attempts: number;
  readonly state: EntryState;
  /** Set when a planned close interrupted the step; cleared when it is re-sent. */
  readonly planned: boolean;
  readonly plannedBy: PlannedBy | null;
  /** The presented view's content while `awaiting` (spec 8.1); null otherwise. */
  readonly content: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The message a journaled input came with, reduced to the four fields that are kept. */
export function journaledMessage(message: JournaledMessage): JournaledMessage {
  const kept: { -readonly [K in keyof JournaledMessage]: JournaledMessage[K] } = {
    payload: message.payload,
  };
  if (message.topic !== undefined) {
    kept.topic = message.topic;
  }
  if (message.inny !== undefined) {
    kept.inny = message.inny;
  }
  if (message._msgid !== undefined) {
    kept._msgid = message._msgid;
  }
  return kept;
}

/** The `input` frame's event for a message: its topic, its payload and its run (spec 5.1). */
export function eventOf(message: JournaledMessage): JournaledEvent {
  const type = typeof message.topic === "string" ? message.topic : "";
  const inny = message.inny;
  const run =
    typeof inny === "object" && inny !== null && typeof (inny as { run?: unknown }).run === "string"
      ? (inny as { run: string }).run
      : undefined;
  return run === undefined ? { type, data: message.payload } : { type, data: message.payload, run };
}

export interface NewEntry {
  readonly inputId: string;
  readonly instanceId: string;
  readonly type: string;
  readonly message: JournaledMessage;
  readonly now: number;
  /** 1 for an input about to be sent; 0 for one held at the bound (see `attempts`). */
  readonly attempts?: 0 | 1;
}

/** A new entry, in state `sent`, with its first attempt (spec 7.1, 7.3 "starts at 1"). */
export function newEntry(fields: NewEntry): JournalEntry {
  const message = journaledMessage(fields.message);
  return {
    inputId: fields.inputId,
    instanceId: fields.instanceId,
    type: fields.type,
    message,
    event: eventOf(message),
    attempts: fields.attempts ?? 1,
    state: "sent",
    planned: false,
    plannedBy: null,
    content: null,
    createdAt: fields.now,
    updatedAt: fields.now,
  };
}

/** A presented action view: the entry waits on a person (spec 8.1). */
export function presented(
  entry: JournalEntry,
  content: Readonly<Record<string, unknown>>,
  now: number,
): JournalEntry {
  return { ...entry, state: "awaiting", content, updatedAt: now };
}

/** A submitted or dismissed view: the step is with the node again (spec 8.2). */
export function submitted(entry: JournalEntry, now: number): JournalEntry {
  return { ...entry, state: "sent", updatedAt: now };
}

/** What a close does to an entry of the closed instance. */
export type OnClose =
  { readonly kind: "keep"; readonly entry: JournalEntry } | { readonly kind: "drop" };

/**
 * A close of the instance (spec 6.7, 7.3). A removal drops the entry. A planned close marks a
 * step in progress `planned` with `plannedBy`, so its re-send is not counted. A quit changes
 * nothing: its re-send is counted. An awaiting view is never marked: it is never counted anyway.
 */
export function onClose(entry: JournalEntry, reason: CloseReason, now: number): OnClose {
  if (reason === "removed") {
    return { kind: "drop" };
  }
  if (reason === "quit" || entry.state === "awaiting") {
    return { kind: "keep", entry };
  }
  return { kind: "keep", entry: { ...entry, planned: true, plannedBy: reason, updatedAt: now } };
}

/** What a replay does with an entry left in the journal when its instance starts. */
export type OnReplay =
  | {
      readonly kind: "resend";
      readonly entry: JournalEntry;
      /** Whether this re-send used up an attempt. */
      readonly counted: boolean;
      /** Why, in words for the log. */
      readonly why: string;
    }
  | { readonly kind: "fail"; readonly message: string };

/** The retry rules of spec 7.3 and 7.4, applied to one entry at replay. */
export function onReplay(entry: JournalEntry, now: number): OnReplay {
  if (entry.state === "awaiting") {
    // Waiting may take days; a view is re-presented on every start, never counted (7.4).
    return {
      kind: "resend",
      entry: { ...entry, planned: false, plannedBy: null, updatedAt: now },
      counted: false,
      why: "an action view waiting on a person is never counted",
    };
  }
  if (entry.planned) {
    return {
      kind: "resend",
      entry: { ...entry, planned: false, plannedBy: null, updatedAt: now },
      counted: false,
      why: `interrupted by a planned restart (${entry.plannedBy ?? "redeploy"}); not counted`,
    };
  }
  // A crash (no close ran) or a quit: the attempt is counted.
  if (entry.attempts >= MAX_ATTEMPTS) {
    return { kind: "fail", message: `not done after ${String(MAX_ATTEMPTS)} attempts` };
  }
  const attempts = entry.attempts + 1;
  return {
    kind: "resend",
    entry: { ...entry, attempts, updatedAt: now },
    counted: true,
    why: `interrupted by a crash or a quit; attempt ${String(attempts)} of ${String(MAX_ATTEMPTS)}`,
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value read back from storage is a journal entry of this shape. */
export function isJournalEntry(value: unknown): value is JournalEntry {
  if (!isRecord(value)) {
    return false;
  }
  const { inputId, instanceId, type, message, event, attempts, state } = value;
  const { planned, plannedBy, content, createdAt, updatedAt } = value;
  return (
    typeof inputId === "string" &&
    typeof instanceId === "string" &&
    typeof type === "string" &&
    isRecord(message) &&
    isRecord(event) &&
    typeof event["type"] === "string" &&
    typeof attempts === "number" &&
    (state === "sent" || state === "awaiting") &&
    typeof planned === "boolean" &&
    (plannedBy === null || plannedBy === "redeploy" || plannedBy === "types") &&
    (content === null || isRecord(content)) &&
    typeof createdAt === "number" &&
    typeof updatedAt === "number"
  );
}
