// Form values to the types their schema declares (spec 2.5.3, arch_pivot P11b §5).
//
// Node-RED hands every text and number input back as a string ("3", "2.5", ""). Before the
// start frame the runtime turns each value into what the schema says it is, and the editor
// does the same before it validates. Coercion never guesses: a string that is not a number
// stays a string, so the validator refuses it by name rather than the node receiving 0 or NaN.
// An empty value is unset, and an unset property takes its declared default.
//
// Pure: no I/O, no library.

import type { JsonSchema } from "../packages/declaration";
import { isSecret, propertiesOf, withoutSecrets } from "./form-model";

const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}

/** One value to its schema's type; `undefined` means unset. */
export function coerceValue(schema: JsonSchema, value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  const options = schema["enum"];
  if (Array.isArray(options)) {
    if (value === "" && !options.includes("")) {
      return undefined;
    }
    // A select hands back its option as text: the option whose text it is.
    if (typeof value === "string" && !options.includes(value)) {
      return options.find((option) => String(option) === value) ?? value;
    }
    return value;
  }
  switch (schema["type"]) {
    case "integer":
      return typeof value === "string" ? fromText(value, INTEGER) : value;
    case "number":
      return typeof value === "string" ? fromText(value, NUMBER) : value;
    case "boolean":
      if (value === "") {
        return undefined;
      }
      return value === "true" ? true : value === "false" ? false : value;
    case "object":
      return isRecord(value) ? coerceObject(schema, value) : value;
    case "array": {
      const items = schema["items"];
      return Array.isArray(value) && isSchema(items)
        ? value.map((item: unknown) => coerceValue(items, item) ?? item)
        : value;
    }
    default:
      return value;
  }
}

/** A number written as text, or the text itself when it is not one; blank is unset. */
function fromText(text: string, shape: RegExp): unknown {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (!shape.test(trimmed)) {
    return text;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : text;
}

/**
 * Every declared property of an object to its type, unset ones to their default. Properties
 * the schema does not declare are kept, for the validator to judge.
 */
export function coerceObject(schema: JsonSchema, value: Fields): Record<string, unknown> {
  const declared = new Map(propertiesOf(schema));
  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).filter(([key]) => !declared.has(key)),
  );
  for (const [key, property] of declared) {
    const coerced = coerceValue(property, value[key]);
    if (coerced !== undefined) {
      result[key] = coerced;
    } else if ("default" in property) {
      result[key] = structuredClone(property["default"]);
    }
  }
  return result;
}

/**
 * An instance's `config` (spec 4.1 `start`): the declared, non-secret properties of its
 * Node-RED node, coerced. Node-RED's own fields (id, type, z, wires, name, x, y) are not
 * declared, so they never reach the node process.
 */
export function configOf(schema: JsonSchema, node: Fields): Record<string, unknown> {
  const plain = withoutSecrets(schema);
  const declared = Object.fromEntries(
    propertiesOf(plain)
      .filter(([key]) => key in node)
      .map(([key]) => [key, node[key]]),
  );
  return coerceObject(plain, declared);
}

/**
 * An instance's `credentials` (spec 2.5.2, 4.1): the declared secrets Node-RED holds for it,
 * each a non-empty string. A secret never set is absent.
 */
export function credentialsOf(schema: JsonSchema, held: Fields): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const [key, property] of propertiesOf(schema)) {
    const value = held[key];
    if (isSecret(property) && typeof value === "string" && value !== "") {
      credentials[key] = value;
    }
  }
  return credentials;
}
