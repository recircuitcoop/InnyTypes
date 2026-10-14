// What a view may send back (spec 8.5.7, plan 0021 §1-3): any JSON object, judged in the
// runtime by the bounds below and by its type's `answer` schema, on the pop-out and the in-app
// path alike. A type with no `answer` schema gets the default shape, the flat object every
// view sent before 0.4.0. A refusal is loud: nothing reaches the node and the view keeps
// waiting, its page saying REFUSED_ANSWER. A component's props and a view's draft are judged
// by the same bounds (spec 8.1.5, 8.1.6).
//
// Pure: the bounds, the default shape and the sentence. The schema check is the runtime's
// (application/views.ts, through the SchemaValidator port). No reason given here names a key
// or a value of the answer: reasons are logged, answers never are.

/** What the person reads when an answer is refused (plan 0021 §3). */
export const REFUSED_ANSWER =
  "That answer couldn't be sent: it doesn't match what this step expects. " +
  "Your answer is still here. Try again, or skip this step.";

/** The bounds every answer is judged by (plan 0021 D1). */
export const MAX_ANSWER_BYTES = 64 * 1024;
export const MAX_ANSWER_DEPTH = 8;
export const MAX_ANSWER_KEYS = 1_000;
/** The longest string, in UTF-8 bytes. */
export const MAX_ANSWER_STRING_BYTES = 16 * 1024;

/** Keys refused at any depth: aimed at a node's object handling, never data. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The default shape, for a type with no `answer` schema: keys and strings at most this long,
 * counted in UTF-16 code units (a JavaScript string's length), as before 0.4.0.
 */
export const FLAT_MAX_KEY_LENGTH = 64;
export const FLAT_MAX_STRING_LENGTH = 2_000;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const encoder = new TextEncoder();

/** A string's length in UTF-8 bytes. */
const utf8Bytes = (text: string): number => encoder.encode(text).length;

/**
 * True for a plain JSON container: an array, or an object whose prototype is Object's or
 * null. A Date, Map, Set, ArrayBuffer, typed array or class instance is not one, though
 * JSON.stringify would quietly turn it into something else.
 */
function isPlainContainer(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    return prototype === Array.prototype;
  }
  return prototype === Object.prototype || prototype === null;
}

/** True when anything in `values` is an object that is not a plain JSON container. */
function hasNonPlain(values: unknown): boolean {
  const stack: unknown[] = [values];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) {
      continue;
    }
    if (!isPlainContainer(value)) {
      return true;
    }
    stack.push(...(Object.values(value) as unknown[]));
  }
  return false;
}

/** The answer's size as JSON text, in UTF-8 bytes; null when it is not JSON at all. */
export function serialisedBytes(values: unknown): number | null {
  try {
    // Undefined for a value JSON has no text for (undefined, a function), despite its type.
    const text = JSON.stringify(values) as string | undefined;
    return text === undefined ? null : utf8Bytes(text);
  } catch {
    // A cycle, or a BigInt.
    return null;
  }
}

/**
 * The shell's check before the hop: true when the answer is larger than MAX_ANSWER_BYTES, or
 * holds an object that is not plain JSON. Everything else is the runtime's to judge.
 */
export function refusedBeforeHop(values: unknown): boolean {
  const bytes = serialisedBytes(values);
  if (bytes === null) {
    // An object JSON cannot write (a cycle, a BigInt) is refused, and never walked.
    return typeof values === "object" && values !== null;
  }
  return bytes > MAX_ANSWER_BYTES || hasNonPlain(values);
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
      if (utf8Bytes(value) > MAX_ANSWER_STRING_BYTES) {
        return `a string is over ${String(MAX_ANSWER_STRING_BYTES)} bytes in UTF-8`;
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
    if (!isPlainContainer(value)) {
      return "an object is not a plain JSON object or array";
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
        return "a key is __proto__, constructor or prototype";
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
 * strings of at most 2,000 characters, finite numbers and booleans, keys of at most 64
 * characters (UTF-16 code units both).
 */
export function defaultShapeProblem(values: Readonly<Record<string, unknown>>): string | null {
  for (const [key, value] of Object.entries(values)) {
    if (key.length > FLAT_MAX_KEY_LENGTH) {
      return `a key is over ${String(FLAT_MAX_KEY_LENGTH)} characters`;
    }
    if (typeof value === "string") {
      if (value.length > FLAT_MAX_STRING_LENGTH) {
        return `a string is over ${String(FLAT_MAX_STRING_LENGTH)} characters`;
      }
      continue;
    }
    if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
      continue;
    }
    return "a value is not a string, finite number or boolean";
  }
  return null;
}

// ── props and drafts: the same bounds (spec 8.1.5, 8.1.6) ───────────────────────────────

/** Why a step whose props are refused fails (plan 0021 §4, spec 8.1.5): reaches Catch. */
export const PROPS_REFUSED = "the view's props do not match its declared schema";

/** What the page is told when a draft is refused (spec 8.1.6). */
export const REFUSED_DRAFT = "That draft couldn't be kept: it is too large or not plain JSON.";

/**
 * What keeps a presented content's component props out, or null: the bounds, then
 * `schemaProblem` (the type's `props` schema; null when it declares none). Props absent are
 * judged as `{}`; a content with no component has no props to judge.
 */
export function propsProblem(
  content: Readonly<Record<string, unknown>>,
  schemaProblem: (props: Readonly<Record<string, unknown>>) => string | null,
): string | null {
  const component = content["component"];
  if (!isRecord(component)) {
    return null;
  }
  const props = component["props"] ?? {};
  const outOfBounds = boundsProblem(props);
  if (outOfBounds !== null) {
    return outOfBounds;
  }
  return schemaProblem(props as Readonly<Record<string, unknown>>);
}

/** A dismissal of an action view (spec 8.2.2): judged by the bounds, never by a schema. */
export const isDismissal = (values: Readonly<Record<string, unknown>>): boolean =>
  values["__dismiss__"] === true;
