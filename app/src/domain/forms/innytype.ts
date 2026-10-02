// The `innytype` annotation of a config schema property (spec 2.4.1, plan 0022 §B, decision D9):
// where a property's options come from, as the form layer needs to know it.
//
// Everything InnyTypes-specific about a property lives in its one `innytype` object. Two keys
// are defined: `{"spaces": true}` (the paired Anytype's spaces) and `{"types": {"of": "<p>"}}`
// (the types of the space chosen in sibling property `p`). This only reads the declaration;
// resolving the options against Anytype is the options route's job (WI-0022-09), not this.
//
// Pure: no I/O, no library.

import type { JsonSchema } from "../packages/declaration";

/** The annotation's keyword, the one key a config schema property spends on InnyTypes. */
export const INNYTYPE_KEYWORD = "innytype";

/**
 * The keyword as a JSON Schema validator registers it (ajv's `addKeyword`): a pure annotation,
 * with no validation of its own and no type of its own, so a strict validator accepts a schema
 * that carries it and judges every value exactly as without it. Its shape is the declaration
 * schema's to check (spec 2.6, `$defs/innytype`), once, when a package is read.
 */
export const INNYTYPE_ANNOTATION = { keyword: INNYTYPE_KEYWORD } as const;

/** Where a string property's options come from. */
export type InnytypeOptions =
  { readonly source: "spaces" } | { readonly source: "types"; readonly of: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The options a property declares through `innytype`; null when it declares none, when it is
 * not a string property, or when the annotation is not one this revision defines. A later key
 * is ignored rather than refused (spec 2.4.1.3), so the form draws a plain input for it.
 */
export function innytypeOptions(property: JsonSchema): InnytypeOptions | null {
  const annotation = property[INNYTYPE_KEYWORD];
  if (!isRecord(annotation) || property["type"] !== "string") {
    return null;
  }
  const types = annotation["types"];
  const of = isRecord(types) && typeof types["of"] === "string" ? types["of"] : "";
  const spaces = annotation["spaces"] === true;
  // Both at once is refused by the declaration schema; read here as neither, never a guess.
  if (spaces === (of !== "")) {
    return null;
  }
  return spaces ? { source: "spaces" } : { source: "types", of };
}
