// Event types created in the app (spec §9; arch_pivot P9, P11b; WI-0018-13).
//
// A person names a type, labels it and gives its payload fields; it becomes `user.<name>.v1`.
// A version is immutable (spec 5.2.2): a schema change makes `.vN+1` beside it, and an
// unchanged schema is refused. A version still used by a node, deployed or only in the editor,
// is not deleted. Every created type is a `source` of the synthetic `user-events` package.
//
// Pure: no I/O, no library. The payload schema is JSON Schema 2020-12; a real validator
// (ajv, through the SchemaValidator port) judges values against it, and this file judges the
// schema itself against what the app lets a person make.

import type {
  Declaration,
  DeclaredCommand,
  DeclaredType,
  FieldProblem,
  JsonSchema,
  LoadedType,
} from "../packages/declaration";
import { nodeTypeName } from "../packages/declaration";

/** The package created types are declared in (spec 2.1.2, 9.5). */
export const USER_EVENTS_PACKAGE = "user-events";

/** The owner of every created event type's name (spec 5.2.1). */
export const USER_OWNER = "user";

/** The dialect every payload schema is written in. */
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Spec 9.1: the base name of a created type. */
export const EVENT_NAME = /^[a-z][a-z0-9_]{1,39}$/;

/** Spec 9.2: a payload field's name. */
export const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The field types a person may choose; `object` holds fields of its own. */
export const FIELD_TYPES: readonly string[] = ["string", "number", "integer", "boolean", "object"];

/** How deep objects may nest, the payload itself being depth 1. */
export const MAX_DEPTH = 4;

/** How many fields one object may have. */
export const MAX_FIELDS = 40;

/** The longest label the palette shows (spec 2.4 `label`), less room for " v<N>". */
export const MAX_LABEL = 50;

/** The port every created source emits on (spec 9.5). */
export const EVENT_PORT = "event";

/** One stored version of a created event type. Never changed once stored. */
export interface EventTypeRecord {
  readonly name: string;
  readonly version: number;
  /** `user.<name>.v<version>`. */
  readonly type: string;
  readonly label: string;
  /** The payload's JSON Schema 2020-12 object schema. */
  readonly schema: JsonSchema;
  /** Epoch ms. */
  readonly createdAt: number;
}

/** A node as a flow or the editor holds it: its id, its type and its name. */
export interface FlowNode {
  readonly id: string;
  readonly type: string;
  readonly name?: string;
}

/** Who uses a version: node ids in the deployed flows, and only in the editor. */
export interface Usage {
  readonly deployed: readonly string[];
  readonly undeployed: readonly string[];
}

/** A change judged: the record to store, or why not (409 for a conflict, spec 9.1, 9.4). */
export type Judged =
  | { readonly ok: true; readonly record: EventTypeRecord }
  | { readonly ok: false; readonly error: string; readonly status?: 409 };

export const eventTypeName = (name: string, version: number): string =>
  `${USER_OWNER}.${name}.v${String(version)}`;

/** The type id in the `user-events` package: `<name>-v<N>` (spec 2.1.3 allows the hyphen). */
export const userTypeId = (name: string, version: number): string => `${name}-v${String(version)}`;

/** The Node-RED type of a created version: `inny-user-events-<name>-v<N>`. */
export const userNodeType = (name: string, version: number): string =>
  nodeTypeName(USER_EVENTS_PACKAGE, userTypeId(name, version));

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value whose keys are sorted all the way down, and whose `required` lists are too. */
function canonical(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item));
    return key === "required" ? [...items].sort() : items;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((inner) => [inner, canonical(value[inner], inner)]),
    );
  }
  return value;
}

/** Whether two schemas say the same: the order of keys and of `required` does not count. */
export function sameSchema(a: JsonSchema, b: JsonSchema): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const OBJECT_KEYS = ["type", "title", "properties", "required", "additionalProperties"];
const ROOT_KEYS = [...OBJECT_KEYS, "$schema"];
const FIELD_KEYS = ["type", "title", "enum"];

/** An enum's values, judged against its field's type. */
function enumProblems(field: string, type: unknown, values: unknown): string[] {
  if (type !== "string" && type !== "number" && type !== "integer") {
    return [`Field ${field}: only text and number fields can have a list of values.`];
  }
  if (!Array.isArray(values) || values.length === 0) {
    return [`Field ${field}: its list of values is empty.`];
  }
  const fits = (value: unknown): boolean =>
    type === "string"
      ? typeof value === "string" && value !== ""
      : typeof value === "number" &&
        Number.isFinite(value) &&
        (type === "number" || Number.isInteger(value));
  if (!values.every(fits)) {
    return [`Field ${field}: every value in its list must be a ${type}.`];
  }
  if (new Set(values).size !== values.length) {
    return [`Field ${field}: a value is listed twice.`];
  }
  return [];
}

/** An object schema's problems, and those of every field in it. `at` is its dotted path. */
function objectProblems(schema: unknown, at: string, depth: number): string[] {
  const where = at === "" ? "The payload" : `Field ${at}`;
  if (!isRecord(schema) || schema["type"] !== "object") {
    return [`${where} must be an object.`];
  }
  const problems: string[] = [];
  const allowed = at === "" ? ROOT_KEYS : OBJECT_KEYS;
  for (const key of Object.keys(schema).filter((k) => !allowed.includes(k))) {
    problems.push(`${where}: "${key}" is not something the field editor makes.`);
  }
  if (schema["additionalProperties"] !== true) {
    problems.push(`${where} must allow additional properties.`);
  }
  if (schema["title"] !== undefined && typeof schema["title"] !== "string") {
    problems.push(`${where}: its title must be text.`);
  }
  const properties = isRecord(schema["properties"]) ? schema["properties"] : null;
  if (properties === null || Object.keys(properties).length === 0) {
    problems.push(
      at === "" ? "At least one payload field is required." : `${where} has no fields.`,
    );
    return problems;
  }
  if (Object.keys(properties).length > MAX_FIELDS) {
    problems.push(`${where} has more than ${String(MAX_FIELDS)} fields.`);
  }
  const required = schema["required"] ?? [];
  if (
    !Array.isArray(required) ||
    !required.every((name) => typeof name === "string" && name in properties) ||
    new Set(required).size !== required.length
  ) {
    problems.push(`${where}: "required" must list its own fields, each once.`);
  }
  for (const [name, field] of Object.entries(properties)) {
    const path = at === "" ? name : `${at}.${name}`;
    if (!FIELD_NAME.test(name)) {
      problems.push(
        `Field name ${JSON.stringify(name)} is invalid: 1 to 40 lower-case letters, digits ` +
          "and _, starting with a letter.",
      );
      continue;
    }
    problems.push(...fieldProblems(field, path, depth));
  }
  return problems;
}

/** One field's problems: its type, its title, its enum, and an object's own fields. */
function fieldProblems(field: unknown, path: string, depth: number): string[] {
  if (!isRecord(field) || !FIELD_TYPES.includes(String(field["type"]))) {
    return [`Field ${path}: its type must be one of ${FIELD_TYPES.join(", ")}.`];
  }
  if (field["type"] === "object") {
    return depth >= MAX_DEPTH
      ? [`Field ${path}: objects nest at most ${String(MAX_DEPTH - 1)} deep.`]
      : objectProblems(field, path, depth + 1);
  }
  const problems = Object.keys(field)
    .filter((key) => !FIELD_KEYS.includes(key))
    .map((key) => `Field ${path}: "${key}" is not something the field editor makes.`);
  if (field["title"] !== undefined && typeof field["title"] !== "string") {
    problems.push(`Field ${path}: its title must be text.`);
  }
  if (field["enum"] !== undefined) {
    problems.push(...enumProblems(path, field["type"], field["enum"]));
  }
  return problems;
}

/**
 * What is wrong with a payload schema by the limits of spec 9.2, as the app extends them:
 * string, number, integer and boolean fields, each optionally required and (but booleans)
 * optionally limited to a list of values, and objects of such fields. Empty when nothing is.
 */
export function payloadProblems(schema: unknown): string[] {
  const problems = objectProblems(schema, "", 1);
  if (isRecord(schema) && schema["$schema"] !== undefined && schema["$schema"] !== SCHEMA_DIALECT) {
    problems.push(`The payload schema must be JSON Schema 2020-12 (${SCHEMA_DIALECT}).`);
  }
  return problems;
}

/** A label as stored: trimmed; null with why when it cannot be one. */
function judgeLabel(label: unknown): { label: string } | { error: string } {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (trimmed === "") {
    return { error: "A label is required." };
  }
  if (trimmed.length > MAX_LABEL) {
    return { error: `The label is longer than ${String(MAX_LABEL)} characters.` };
  }
  return { label: trimmed };
}

/** The versions of `name`, oldest first. */
export function versionsOf(
  records: readonly EventTypeRecord[],
  name: string,
): readonly EventTypeRecord[] {
  return records.filter((r) => r.name === name).sort((a, b) => a.version - b.version);
}

/** A new event type, `user.<name>.v1` (spec 9.1). */
export function judgeCreate(
  records: readonly EventTypeRecord[],
  input: { readonly name: unknown; readonly label: unknown; readonly schema: unknown },
  now: number,
): Judged {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!EVENT_NAME.test(name)) {
    return {
      ok: false,
      error:
        `${JSON.stringify(name)} is invalid: 2 to 40 lower-case letters, digits and _, starting ` +
        "with a letter. It becomes user.<name>.v1.",
    };
  }
  const label = judgeLabel(input.label);
  if ("error" in label) {
    return { ok: false, error: label.error };
  }
  const problems = payloadProblems(input.schema);
  if (problems.length > 0) {
    return { ok: false, error: problems.join(" ") };
  }
  if (versionsOf(records, name).length > 0) {
    return {
      ok: false,
      status: 409,
      error:
        `An event type named ${USER_OWNER}.${name} already exists; change its schema to make a ` +
        "new version instead.",
    };
  }
  const schema = input.schema as JsonSchema;
  return {
    ok: true,
    record: {
      name,
      version: 1,
      type: eventTypeName(name, 1),
      label: label.label,
      schema,
      createdAt: now,
    },
  };
}

/**
 * A new version of `name` (spec 9.3): `.v<N+1>` beside the others, which are never changed. The
 * schema must differ from the latest version's; the label is the latest's unless one is given.
 */
export function judgeVersion(
  records: readonly EventTypeRecord[],
  input: { readonly name: unknown; readonly schema: unknown; readonly label?: unknown },
  now: number,
): Judged {
  const name = typeof input.name === "string" ? input.name : "";
  const latest = versionsOf(records, name).at(-1);
  if (latest === undefined) {
    return { ok: false, error: `No event type named ${USER_OWNER}.${name} exists.` };
  }
  const label = input.label === undefined ? { label: latest.label } : judgeLabel(input.label);
  if ("error" in label) {
    return { ok: false, error: label.error };
  }
  const problems = payloadProblems(input.schema);
  if (problems.length > 0) {
    return { ok: false, error: problems.join(" ") };
  }
  const schema = input.schema as JsonSchema;
  if (sameSchema(schema, latest.schema)) {
    return {
      ok: false,
      status: 409,
      error: `The schema is unchanged from ${latest.type}; no new version was made.`,
    };
  }
  const version = latest.version + 1;
  return {
    ok: true,
    record: {
      name,
      version,
      type: eventTypeName(name, version),
      label: label.label,
      schema,
      createdAt: now,
    },
  };
}

/**
 * Who uses the Node-RED type `nodeType`: the deployed flows' nodes, and the editor's nodes that
 * are not deployed. A node deployed and still in the editor counts as deployed.
 */
export function usageOf(
  nodeType: string,
  deployed: readonly FlowNode[],
  editor: readonly FlowNode[],
): Usage {
  const deployedIds = deployed.filter((n) => n.type === nodeType).map((n) => n.id);
  const inFlows = new Set(deployed.map((n) => n.id));
  const undeployed = editor
    .filter((n) => n.type === nodeType && !inFlows.has(n.id))
    .map((n) => n.id);
  return { deployed: deployedIds, undeployed };
}

/** Why `type` may not be deleted (spec 9.4, P11b), naming the nodes; null when unused. */
export function deletionRefusal(type: string, usage: Usage): string | null {
  const parts: string[] = [];
  if (usage.deployed.length > 0) {
    parts.push(`deployed node(s) ${usage.deployed.join(", ")}`);
  }
  if (usage.undeployed.length > 0) {
    parts.push(`node(s) ${usage.undeployed.join(", ")} in the editor, not yet deployed`);
  }
  if (parts.length === 0) {
    return null;
  }
  return (
    `Refused: ${type} is used by ${parts.join(" and by ")}; remove them from the flow ` +
    "(and deploy) first."
  );
}

/** A payload's problems, as a person reads them: "Field title is required." (spec 9.6). */
export function payloadRefusal(problems: readonly FieldProblem[]): string {
  return problems
    .map((problem) => {
      const field = problem.path.slice(1).split("/").join(".");
      return field === ""
        ? `The payload ${problem.message}.`
        : `Field ${field} ${problem.message}.`;
    })
    .join(" ");
}

/** One created version as a `source` of `user-events` (spec 9.5). */
function sourceOf(record: EventTypeRecord, command: DeclaredCommand): DeclaredType {
  return {
    id: userTypeId(record.name, record.version),
    kind: "source",
    label: `${record.label} v${String(record.version)}`,
    description:
      `Emits ${record.type}, created in the app. Fire it from the Events page, or wire a ` +
      "message into its input: its payload is checked against the type's schema.",
    command,
    config: { type: "object", properties: {} },
    outputs: [{ port: EVENT_PORT, event: record.type }],
    input: true,
    event: record.type,
    payload: record.schema,
  };
}

/** The synthetic `user-events` package: one source per stored version, oldest first. */
export function userEventsDeclaration(
  records: readonly EventTypeRecord[],
  command: DeclaredCommand,
): Declaration {
  const sorted = [...records].sort((a, b) =>
    a.name === b.name ? a.version - b.version : a.name < b.name ? -1 : 1,
  );
  return {
    protocol: 2,
    package: USER_EVENTS_PACKAGE,
    version: "0.0.0",
    types: sorted.map((record) => sourceOf(record, command)),
  };
}

/** The declaration's types as loaded types, in `folder` (where its declaration is written). */
export function userEventTypes(declaration: Declaration, folder: string): LoadedType[] {
  return declaration.types.map((type) => ({ declaration, type, folder }));
}
