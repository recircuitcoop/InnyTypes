// Setup's words and forms without a DOM (plan 0022 §H, ux-writing "The first run (Setup)"): the
// Connect Anytype step's state, a step form read from its JSON Schema, the values a form sends,
// and a line whose `*…*` names are drawn in italics. screens/SetupScreen.tsx only draws these.
//
// The step forms read the schema the runtime answers (NodeForm.schema) here, in the UI: the
// domain's form model is code, which the UI may not import (app/.dependency-cruiser.cjs).
import type { Answer } from "./answer";
import type { AnytypeStatus } from "./contract";
import type { NodeOptions } from "./flow-contract";
import { plural, STRINGS, t, type StringKey } from "./strings";

// ── Connect Anytype ──────────────────────────────────────────────────────────────────────────

/** Where the Connect Anytype step is, and the line it shows. */
export type AnytypeStepState =
  /** Paired and answering: "Connected. Found 8 spaces." and Continue. */
  | { readonly kind: "connected"; readonly line: string }
  /** Anytype shows a code: "Anytype is asking for a code. Type it here." with the code field. */
  | { readonly kind: "code"; readonly line: string }
  /** Anytype is not answering: "Open Anytype, then come back. InnyTypes will notice." */
  | { readonly kind: "not-running"; readonly line: string }
  /** Not known yet, or Anytype is starting: no line, Connect offered. */
  | { readonly kind: "waiting"; readonly line: null };

/**
 * The Connect Anytype step from Anytype's state, its spaces once it is ready, and whether the
 * last attempt to start pairing failed (Anytype did not answer).
 */
export function anytypeStep(
  status: AnytypeStatus | null,
  spaces: Answer<NodeOptions> | null,
  pairingFailed: boolean,
): AnytypeStepState {
  if (status === null) {
    return { kind: "waiting", line: null };
  }
  if (status.pairing) {
    return { kind: "code", line: t("setup.anytype.running") };
  }
  if (status.state === "ready" && spaces?.ok === true) {
    const line = plural(spaces.value.options.length, "setup.anytype.connected");
    return { kind: "connected", line };
  }
  if (pairingFailed || status.state === "unreachable") {
    return { kind: "not-running", line: t("setup.anytype.notRunning") };
  }
  return { kind: "waiting", line: null };
}

// ── a step's form, from its schema ──────────────────────────────────────────────────────────

export type SetupFieldKind = "text" | "secret" | "number" | "integer" | "boolean" | "enum";

/** One field of a step form. */
export interface SetupField {
  readonly key: string;
  readonly kind: SetupFieldKind;
  /** `title`, else the key. */
  readonly label: string;
  readonly help: string | null;
  readonly required: boolean;
  /** An enum's choices, as text. */
  readonly options: readonly string[];
  /** Options from Anytype (spec 2.4.1): the spaces, or the types of the space in `of`. */
  readonly innytype:
    { readonly source: "spaces" } | { readonly source: "types"; readonly of: string } | null;
  readonly default: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function kindOf(property: Record<string, unknown>): SetupFieldKind | null {
  if (property["writeOnly"] === true || property["x-secret"] === true) {
    return "secret";
  }
  if (Array.isArray(property["enum"])) {
    return "enum";
  }
  switch (property["type"]) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "object":
    case "array":
      // A group or a table is set up on the canvas, not in Setup.
      return null;
    default:
      return "text";
  }
}

function innytypeOf(property: Record<string, unknown>): SetupField["innytype"] {
  const annotation = property["innytype"];
  if (!isRecord(annotation) || property["type"] !== "string") {
    return null;
  }
  const types = annotation["types"];
  const of = isRecord(types) && typeof types["of"] === "string" ? types["of"] : "";
  const spaces = annotation["spaces"] === true;
  // Both at once, or neither, is read as no options (as domain/forms/innytype.ts reads it).
  if (spaces === (of !== "")) {
    return null;
  }
  return spaces ? { source: "spaces" } : { source: "types", of };
}

/** The fields Setup draws for a step's schema, in the order it declares its properties. */
export function setupFields(schema: Readonly<Record<string, unknown>>): SetupField[] {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = new Set(
    Array.isArray(schema["required"]) ? schema["required"].map((key) => String(key)) : [],
  );
  return Object.entries(properties).flatMap(([key, property]): SetupField[] => {
    if (!isRecord(property)) {
      return [];
    }
    const kind = kindOf(property);
    if (kind === null) {
      return [];
    }
    const title = property["title"];
    const description = property["description"];
    return [
      {
        key,
        kind,
        label: typeof title === "string" && title !== "" ? title : key,
        help: typeof description === "string" && description !== "" ? description : null,
        required: required.has(key),
        options: kind === "enum" ? (property["enum"] as unknown[]).map((each) => String(each)) : [],
        innytype: innytypeOf(property),
        default: property["default"],
      },
    ];
  });
}

/** What a form holds while it is filled: text for every field, a boolean for a switch. */
export type Draft = Readonly<Record<string, string | boolean>>;

/** The form as it opens: the step's values, else each field's default; a secret is never shown. */
export function draftOf(
  fields: readonly SetupField[],
  values: Readonly<Record<string, unknown>>,
): Draft {
  return Object.fromEntries(
    fields.map((field): [string, string | boolean] => {
      const given: unknown =
        field.kind === "secret" ? undefined : (values[field.key] ?? field.default);
      if (field.kind === "boolean") {
        return [field.key, given === true];
      }
      // Only a value a field can show is shown; anything else opens empty.
      const shown = typeof given === "string" || typeof given === "number" ? String(given) : "";
      return [field.key, shown];
    }),
  );
}

/**
 * The values Continue sends (flow.node.configure): an empty field is left out, so a required one
 * is refused by its schema rather than saved empty; a number is sent as one when it reads as one.
 */
export function valuesOf(fields: readonly SetupField[], draft: Draft): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((field): [string, unknown][] => {
      const value = draft[field.key];
      if (typeof value === "boolean") {
        return [[field.key, value]];
      }
      if (value === undefined || value.trim() === "") {
        return [];
      }
      if (field.kind === "number" || field.kind === "integer") {
        const number = Number(value);
        return [[field.key, Number.isFinite(number) ? number : value]];
      }
      return [[field.key, value]];
    }),
  );
}

/** The fields a refusal named (`/space_id` → `space_id`), each with what is wrong. */
export function problemsByField(
  problems: readonly { readonly path: string; readonly message: string }[] | undefined,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    (problems ?? []).map((problem) => [
      problem.path.replace(/^\//, "").split("/")[0] ?? "",
      problem.message,
    ]),
  );
}

// ── a line with names in italics ─────────────────────────────────────────────────────────────

/** A part of a line: its text, and whether it is a name the person gave or chose. */
export interface MarkedPart {
  readonly text: string;
  readonly named: boolean;
}

/**
 * The line `key` with its slots filled, split where ux-writing marks a name with `*…*`. The
 * template is split before it is filled, so a "*" in a name never moves the split.
 */
export function markedParts(
  key: StringKey,
  params: Readonly<Record<string, string | number>> = {},
): MarkedPart[] {
  const fill = (text: string) =>
    text.replace(/\{([a-zA-Z]+)\}/g, (whole, slot: string) => {
      const value = params[slot];
      return value === undefined ? whole : String(value);
    });
  return STRINGS[key]
    .split("*")
    .map((text, index) => ({ text: fill(text), named: index % 2 === 1 }))
    .filter((part) => part.text !== "");
}

/** The line as read aloud: its parts, without the marks. */
export const plainOf = (parts: readonly MarkedPart[]) => parts.map((part) => part.text).join("");
