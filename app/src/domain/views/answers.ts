// What a view may send back (spec 8.5.7, plan 0021 §1-3): any JSON object, judged in the
// runtime by the bounds below and by its type's `answer` schema, on the pop-out and the in-app
// path alike. A type with no `answer` schema gets the default shape, the flat object every
// view sent before 0.4.0. A refusal is loud: nothing reaches the node and the view keeps
// waiting, its page saying REFUSED_ANSWER.
//
// Pure: the bounds, the default shape and the sentence. The schema check is the runtime's
// (application/views.ts, through the SchemaValidator port).

/** What the person reads when an answer is refused (plan 0021 §3). */
export const REFUSED_ANSWER =
  "That answer couldn't be sent: it doesn't match what this step expects. " +
  "Your answer is still here. Try again, or skip this step.";

/** The bounds every answer is judged by (plan 0021 D1). */
export const MAX_ANSWER_BYTES = 64 * 1024;
export const MAX_ANSWER_DEPTH = 8;
export const MAX_ANSWER_KEYS = 1_000;
export const MAX_ANSWER_STRING = 16 * 1024;

/** Keys refused at any depth: aimed at a node's object handling, never data. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** The default shape, for a type with no `answer` schema: keys and strings at most this long. */
export const FLAT_MAX_KEY_LENGTH = 64;
export const FLAT_MAX_STRING_LENGTH = 2_000;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The answer's size as JSON text, in UTF-8 bytes; null when it is not JSON at all. */
export function serialisedBytes(values: unknown): number | null {
  try {
    // Undefined for a value JSON has no text for (undefined, a function), despite its type.
    const text = JSON.stringify(values) as string | undefined;
    return text === undefined ? null : new TextEncoder().encode(text).length;
  } catch {
    // A cycle, or a BigInt.
    return null;
  }
}

/** True when the answer is larger than MAX_ANSWER_BYTES: the shell's check before the hop. */
export function oversized(values: unknown): boolean {
  const bytes = serialisedBytes(values);
  return bytes !== null && bytes > MAX_ANSWER_BYTES;
}

/**
 * What breaks a bound in `values`, or null when nothing does. Walked iteratively, so a deep
 * value cannot exhaust the stack before its depth is judged. The top-level object is depth 1.
 */
export function boundsProblem(values: unknown): string | null {
  if (!isRecord(values)) {
    return "the answer is not an object";
  }
  const bytes = serialisedBytes(values);
  if (bytes === null) {
    return "the answer is not JSON";
  }
  if (bytes > MAX_ANSWER_BYTES) {
    return `the answer is ${String(bytes)} bytes, over ${String(MAX_ANSWER_BYTES)}`;
  }
  let keys = 0;
  const stack: { value: unknown; depth: number }[] = [{ value: values, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (typeof value === "string") {
      if (value.length > MAX_ANSWER_STRING) {
        return `a string is over ${String(MAX_ANSWER_STRING)} characters`;
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return "a number is not finite";
      }
      continue;
    }
    if (value === null || typeof value === "boolean") {
      continue;
    }
    if (typeof value !== "object") {
      return `a ${typeof value} is not JSON`;
    }
    if (depth > MAX_ANSWER_DEPTH) {
      return `the answer is nested deeper than ${String(MAX_ANSWER_DEPTH)}`;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        stack.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return `the key ${key} is not allowed`;
      }
      keys += 1;
      if (keys > MAX_ANSWER_KEYS) {
        return `the answer has over ${String(MAX_ANSWER_KEYS)} keys`;
      }
      stack.push({ value: item, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * What keeps `values` out of the default shape, or null when it fits: a flat object of
 * strings of at most 2,000 characters, finite numbers and booleans, keys of at most 64.
 */
export function defaultShapeProblem(values: Readonly<Record<string, unknown>>): string | null {
  for (const [key, value] of Object.entries(values)) {
    if (key.length > FLAT_MAX_KEY_LENGTH) {
      return `a key is over ${String(FLAT_MAX_KEY_LENGTH)} characters`;
    }
    if (typeof value === "string") {
      if (value.length > FLAT_MAX_STRING_LENGTH) {
        return `${key}: a string over ${String(FLAT_MAX_STRING_LENGTH)} characters`;
      }
      continue;
    }
    if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
      continue;
    }
    return `${key}: must be a string, number or boolean`;
  }
  return null;
}

/** A dismissal (spec 8.2.2): judged by the bounds, never by a schema. */
export const isDismissal = (values: Readonly<Record<string, unknown>>): boolean =>
  values["__dismiss__"] === true;
