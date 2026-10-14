// A real JSON Schema 2020-12 validator (plan 0018 §1: ajv), for what the spike only coerced
// (spec 2.5.3 [UNPROVEN]): node package declarations against the spec's §2.6 schema, and each
// instance's configuration against its type's `config` schema, before the start frame.

import type { FieldProblem, JsonSchema } from "../domain/packages/declaration";

/**
 * Where a value first failed a schema, by the schema alone: ajv's keyword and schema path.
 * It names nothing of the value (no instance path, no message), so it may be logged.
 */
export interface SchemaFailure {
  readonly keyword: string;
  readonly schemaPath: string;
}

export interface SchemaValidator {
  /** What is wrong with a declaration by the spec's §2.6 schema; empty when nothing is. */
  declaration(value: unknown): readonly FieldProblem[];
  /** What is wrong with `value` by `schema`; empty when nothing is. */
  check(schema: JsonSchema, value: unknown): readonly FieldProblem[];
  /** Where `value` first fails `schema`, naming nothing of the value; null when it passes. */
  firstFailure(schema: JsonSchema, value: unknown): SchemaFailure | null;
}
