// The revision 2.1 fields of `done` and `status` (spec 4.2.1, 4.2.2), cut to their bounds
// before the frame is validated.
//
// A node's `done` or `status` is never refused for these fields: a `done` refused would leave
// its input open for good, over nothing more than a note that was too long. So what breaks a
// bound or a shape is dropped (or a text cut), each drop is named for the log, and the frame
// that is left satisfies the §4.5 schema. A frame without these fields comes back unchanged,
// the very same object: 2.0 frames mean exactly what they always did.

/** At most this many notes, and as many results, on one `done` (spec 4.2.1). */
export const MAX_REPORT_ENTRIES = 20;

/** At most this many characters in one note's or result's `text` (spec 4.2.1). */
export const MAX_REPORT_TEXT = 200;

const NOTE_LEVELS: readonly unknown[] = ["note", "warning"];
const RESULT_KINDS: readonly unknown[] = ["anytype", "file", "scheduled", "plain"];
const PHASES: readonly unknown[] = ["copying", "copied"];

type Json = Record<string, unknown>;

/** A frame after its 2.1 fields were bounded, and what was dropped or cut, for the log. */
export interface Bounded {
  readonly frame: Json;
  readonly dropped: readonly string[];
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** `text` cut to the bound; the cut is noted. */
function cut(text: string, where: string, dropped: string[]): string {
  if (text.length <= MAX_REPORT_TEXT) {
    return text;
  }
  dropped.push(`${where} text cut from ${String(text.length)} to ${String(MAX_REPORT_TEXT)}`);
  return text.slice(0, MAX_REPORT_TEXT);
}

function noteOf(entry: unknown, where: string, dropped: string[]): Json | null {
  if (!isRecord(entry) || !NOTE_LEVELS.includes(entry["level"])) {
    dropped.push(`${where} dropped: no level "note" or "warning"`);
    return null;
  }
  if (typeof entry["text"] !== "string") {
    dropped.push(`${where} dropped: no text`);
    return null;
  }
  return { level: entry["level"], text: cut(entry["text"], where, dropped) };
}

function resultOf(entry: unknown, where: string, dropped: string[]): Json | null {
  if (!isRecord(entry) || !RESULT_KINDS.includes(entry["kind"])) {
    dropped.push(`${where} dropped: no kind "anytype", "file", "scheduled" or "plain"`);
    return null;
  }
  if (typeof entry["text"] !== "string") {
    dropped.push(`${where} dropped: no text`);
    return null;
  }
  const result: Json = { kind: entry["kind"], text: cut(entry["text"], where, dropped) };
  const anytype = entry["anytype"];
  if (isRecord(anytype) && isText(anytype["spaceId"]) && isText(anytype["objectId"])) {
    result["anytype"] = { spaceId: anytype["spaceId"], objectId: anytype["objectId"] };
  } else if (anytype !== undefined) {
    dropped.push(`${where}.anytype dropped: it needs a spaceId and an objectId`);
  }
  for (const field of ["folder", "due"] as const) {
    const value = entry[field];
    if (isText(value)) {
      result[field] = value;
    } else if (value !== undefined) {
      dropped.push(`${where}.${field} dropped: not a text`);
    }
  }
  return result;
}

/** One list of entries: the well-formed ones, at most MAX_REPORT_ENTRIES of them. */
function listOf(
  value: unknown,
  name: "notes" | "results",
  entryOf: (entry: unknown, where: string, dropped: string[]) => Json | null,
  dropped: string[],
): Json[] | null {
  if (!Array.isArray(value)) {
    dropped.push(`${name} dropped: not a list`);
    return null;
  }
  const kept = value.flatMap((entry: unknown, index) => {
    const bounded = entryOf(entry, `${name}[${String(index)}]`, dropped);
    return bounded === null ? [] : [bounded];
  });
  if (kept.length > MAX_REPORT_ENTRIES) {
    const extra = kept.length - MAX_REPORT_ENTRIES;
    dropped.push(
      `${name}: ${String(extra)} over the limit of ${String(MAX_REPORT_ENTRIES)} dropped`,
    );
    return kept.slice(0, MAX_REPORT_ENTRIES);
  }
  return kept;
}

/** A `done` with its `notes` and `results` bounded (spec 4.2.1). */
export function boundDone(frame: Json): Bounded {
  if (!("notes" in frame) && !("results" in frame)) {
    return { frame, dropped: [] };
  }
  const dropped: string[] = [];
  const bounded: Json = { ...frame };
  delete bounded["notes"];
  delete bounded["results"];
  if ("notes" in frame) {
    const notes = listOf(frame["notes"], "notes", noteOf, dropped);
    if (notes !== null) {
      bounded["notes"] = notes;
    }
  }
  if ("results" in frame) {
    const results = listOf(frame["results"], "results", resultOf, dropped);
    if (results !== null) {
      bounded["results"] = results;
    }
  }
  return { frame: bounded, dropped };
}

/** A `status` with its `in`, `progress`, `eta_s` and `phase` bounded (spec 4.2.2). */
export function boundStatus(frame: Json): Bounded {
  if (!("in" in frame || "progress" in frame || "eta_s" in frame || "phase" in frame)) {
    return { frame, dropped: [] };
  }
  const dropped: string[] = [];
  const bounded: Json = { ...frame };
  const inputId = frame["in"];
  if (inputId !== undefined && !(isText(inputId) && inputId.length <= 128)) {
    delete bounded["in"];
    dropped.push("in dropped: not an input id");
  }
  const progress = frame["progress"];
  if (progress !== undefined) {
    const valid =
      isRecord(progress) &&
      isCount(progress["done"]) &&
      isCount(progress["total"]) &&
      progress["done"] <= progress["total"];
    if (valid) {
      bounded["progress"] = { done: progress["done"], total: progress["total"] };
    } else {
      delete bounded["progress"];
      dropped.push("progress dropped: it needs whole numbers done <= total");
    }
  }
  const eta = frame["eta_s"];
  // Finite too: `1e999` is valid JSON and parses to Infinity, which no schema calls a number.
  if (eta !== undefined && !(typeof eta === "number" && Number.isFinite(eta) && eta >= 0)) {
    delete bounded["eta_s"];
    dropped.push("eta_s dropped: not a number of seconds");
  }
  // An unknown phase is absent (spec 4.2.2): a later revision may name more, and saying so on
  // every status would only be noise.
  if (frame["phase"] !== undefined && !PHASES.includes(frame["phase"])) {
    delete bounded["phase"];
  }
  return { frame: bounded, dropped };
}
