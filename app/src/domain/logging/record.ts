// One log record, its levels, the line the one log holds, and the wire form a child uses to
// hand a record to the shell (plan 0018 §2.2 and the §3 row for logs.py, spec 3.4).
//
// The shell is the only process that writes the log. The runtime and the services process
// write each record as one JSON line on their stdout pipe; the shell parses, redacts and
// appends it. The line in the file keeps the old app's format (logs.py:198-201), so one file
// read across the old app and the new one reads the same way.

/** A level as the file spells it. STDERR and stdout are spec 3.3 and 3.4's own levels. */
export type LevelName = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL" | "STDERR" | "stdout";

/**
 * The number each level filters by, Python's numbers (logs.py resolves names through
 * `logging`). What a process printed outside its log ranks as a warning: standard error is
 * where a process says something is wrong (the old CHILD_STDERR_LEVEL), and a node's non-frame
 * stdout is a protocol violation (spec 3.3).
 */
export const LEVELS: Readonly<Record<LevelName, number>> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
  STDERR: 30,
  stdout: 30,
};

/** The levels a person may write in INNYTYPES_LOG_LEVEL, for the refusal to name. */
export const LEVEL_NAMES = ["debug", "info", "warning", "error", "critical"] as const;

/**
 * A test-mode default, stated as one (logs.py:179-184): DEBUG is the level at which the thing
 * under examination is visible at all. It becomes INFO when events stop being the question.
 */
export const DEFAULT_LEVEL = LEVELS.DEBUG;

/** How much of one printed line is kept (children.py MAX_CHILD_OUTPUT_LINE). */
export const MAX_OUTPUT_LINE = 2000;

/** What a cut line ends with, so a reader knows the rest was dropped rather than never said. */
export const TRUNCATED = "… (line truncated)";

export interface LogRecord {
  /** Milliseconds since the epoch, taken by the process that wrote the record. */
  readonly time: number;
  readonly level: LevelName;
  /** The process id of the writer: three processes share one file (logs.py:198-200). */
  readonly pid: number;
  /** Who wrote it: `innytypes.shell`, `innytypes.runtime`, `innytypes.node.<type>.<id>`. */
  readonly name: string;
  readonly msg: string;
}

/** One verbosity setting as a level number; an Error naming what was wrong otherwise. */
export function resolveLevel(value: string | number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LEVEL;
  }
  if (typeof value === "number") {
    return value;
  }
  const upper = value.trim().toUpperCase();
  const named = LEVEL_NAMES.find((name) => name.toUpperCase() === upper);
  if (named === undefined) {
    // Quoted the way logs.py quotes it (Python's repr), so the old line and the new one match.
    throw new Error(`'${value}' is not a logging level; expected one of ${LEVEL_NAMES.join(", ")}`);
  }
  return LEVELS[named.toUpperCase() as LevelName];
}

/** The name a level number is written with, for the opening line (`at DEBUG`). */
export function levelLabel(level: number): string {
  const name = LEVEL_NAMES.find(
    (candidate) => LEVELS[candidate.toUpperCase() as LevelName] === level,
  );
  return name === undefined ? `Level ${String(level)}` : name.toUpperCase();
}

/** `text` cut to MAX_OUTPUT_LINE characters, saying so when it was cut. */
export function truncateLine(text: string): string {
  return text.length > MAX_OUTPUT_LINE ? `${text.slice(0, MAX_OUTPUT_LINE)}${TRUNCATED}` : text;
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/**
 * The line the file holds: `LOG_FORMAT = "%(asctime)s %(levelname)-8s %(process)6d
 * %(name)s: %(message)s"`, with Python's asctime (local time, a comma before milliseconds).
 */
export function formatLine(record: LogRecord): string {
  const at = new Date(record.time);
  const asctime =
    `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1, 2)}-${pad(at.getDate(), 2)} ` +
    `${pad(at.getHours(), 2)}:${pad(at.getMinutes(), 2)}:${pad(at.getSeconds(), 2)},` +
    pad(at.getMilliseconds(), 3);
  const process = String(record.pid).padStart(6, " ");
  return `${asctime} ${record.level.padEnd(8, " ")} ${process} ${record.name}: ${record.msg}\n`;
}

// ── the wire: what a child writes on its stdout for the shell ─────────────────────────────

/**
 * One line of a child's stdout. A `log` is a record; a `protect` hands the shell a credential
 * the child registered, so the shell redacts it too. Both travel on the same pipe on purpose:
 * a pipe keeps order, so the shell always learns a secret before the first line that could
 * carry it.
 */
export type WireLine =
  | { readonly kind: "log"; readonly record: LogRecord }
  | { readonly kind: "protect"; readonly secret: string }
  | { readonly kind: "text"; readonly text: string };

export function encodeRecord(record: LogRecord): string {
  const { time, level, pid, name, msg } = record;
  return `${JSON.stringify({ t: "log", time, level, pid, name, msg })}\n`;
}

export function encodeProtect(secret: string): string {
  return `${JSON.stringify({ t: "protect", secret })}\n`;
}

function isLevelName(value: unknown): value is LevelName {
  return typeof value === "string" && Object.hasOwn(LEVELS, value);
}

function parsed(line: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * One stdout line of a child, read back. Anything that is not a well-formed record or
 * protect line is `text`: something the process printed outside its log (a library's
 * console.log, a crash message), which is kept rather than dropped.
 */
export function parseWireLine(line: string): WireLine {
  const fields = parsed(line);
  if (fields === null) {
    return { kind: "text", text: line };
  }
  if (fields["t"] === "protect" && typeof fields["secret"] === "string") {
    return { kind: "protect", secret: fields["secret"] };
  }
  const { time, level, pid, name, msg } = fields;
  if (
    fields["t"] === "log" &&
    typeof time === "number" &&
    isLevelName(level) &&
    typeof pid === "number" &&
    typeof name === "string" &&
    typeof msg === "string"
  ) {
    return { kind: "log", record: { time, level, pid, name, msg } };
  }
  return { kind: "text", text: line };
}
