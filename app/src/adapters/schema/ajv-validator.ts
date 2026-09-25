// ajv, the JSON Schema 2020-12 validator (plan 0018 §1), behind the SchemaValidator port.
//
// The declaration schema is the spec's own §2.6 block, extracted verbatim to
// docs/specs/inny-package.v2.schema.json. Every problem names its field as a JSON Pointer; a
// missing required property is named by its own path, not its parent's, so a refusal says
// "types/0/label: is required" rather than "types/0: must have required property 'label'".

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import declarationSchema from "../../../../docs/specs/inny-package.v2.schema.json" with { type: "json" };
import type { FieldProblem, JsonSchema } from "../../domain/packages/declaration";
import type { SchemaValidator } from "../../ports/schema-validator";

/** One ajv error as a field and a sentence. */
export function problemOf(error: ErrorObject): FieldProblem {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required" && typeof params["missingProperty"] === "string") {
    return { path: `${error.instancePath}/${params["missingProperty"]}`, message: "is required" };
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof params["additionalProperty"] === "string"
  ) {
    return {
      path: `${error.instancePath}/${params["additionalProperty"]}`,
      message: "is not a declared property",
    };
  }
  const allowed = params["allowedValues"];
  const message = Array.isArray(allowed)
    ? `must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`
    : (error.message ?? error.keyword);
  return { path: error.instancePath, message };
}

/** ajv's errors, one per field and sentence, in the order it found them. */
function problemsOf(errors: readonly ErrorObject[] | null | undefined): FieldProblem[] {
  const seen = new Set<string>();
  const problems: FieldProblem[] = [];
  for (const error of errors ?? []) {
    // `if`/`then` and `oneOf` add a summary error of their own after the specific ones.
    if (error.keyword === "if" || error.keyword === "oneOf") {
      continue;
    }
    const problem = problemOf(error);
    const key = `${problem.path} ${problem.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      problems.push(problem);
    }
  }
  return problems;
}

export class AjvSchemaValidator implements SchemaValidator {
  // Every error, not only the first, so a refusal lists everything that must change. Types
  // and `required` are left unstrict: the spec's schema uses `properties` and `required` inside
  // `if`/`then` without `type` and without restating the properties.
  readonly #ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictRequired: false,
  });
  // A type's own config schema, written by its author: keywords JSON Schema leaves open
  // (`x-secret`) are allowed.
  readonly #lenient = new Ajv2020({ allErrors: true, strict: false });
  readonly #declaration: ValidateFunction;
  /** Compiled config schemas, by their JSON text: each type's is compiled once. */
  readonly #compiled = new Map<string, ValidateFunction>();

  constructor() {
    this.#declaration = this.#ajv.compile(declarationSchema);
  }

  declaration(value: unknown): readonly FieldProblem[] {
    return this.#declaration(value) ? [] : problemsOf(this.#declaration.errors);
  }

  check(schema: JsonSchema, value: unknown): readonly FieldProblem[] {
    const text = JSON.stringify(schema);
    let validate = this.#compiled.get(text);
    if (validate === undefined) {
      try {
        validate = this.#lenient.compile(schema);
      } catch (error) {
        // A schema that is not one refuses every value, and says why.
        return [{ path: "", message: `the schema cannot be used: ${(error as Error).message}` }];
      }
      this.#compiled.set(text, validate);
    }
    return validate(value) ? [] : problemsOf(validate.errors);
  }
}
