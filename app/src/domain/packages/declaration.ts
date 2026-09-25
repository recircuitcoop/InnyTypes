// The node package declaration, `inny-package.json` (spec §2), as the runtime holds it once
// it has been parsed and refused or accepted (plan 0018 §3, the addons/manifest.py row).
//
// Like the old manifest it refuses and never warns: a declaration that breaks any rule is not
// loaded, and every refusal names the field it is about. The shape is judged by the spec's
// own §2.6 JSON Schema, which the caller checks with a real validator (ajv, in
// adapters/schema) and hands in as `check`; this file adds what a schema cannot say.
//
// Pure: no I/O, no library.

/** The one protocol version this runtime implements (spec 1.2). */
export const PROTOCOL = 2;

/** Spec 2.4: output ports that would shadow a Node-RED message field. */
const RESERVED_PORTS: readonly string[] = ["_msgid", "topic"];

/** The owner reserved for created event types (spec 5.2.1, 5.2.3). */
const USER_OWNER = "user";

export type Kind = "source" | "node" | "view";

/** A JSON Schema object, as declared (spec 2.4 `config`, `payload`, `form`). */
export type JsonSchema = Readonly<Record<string, unknown>>;

export type DeclaredCommand =
  | readonly string[]
  | {
      readonly darwin?: readonly string[];
      readonly win32?: readonly string[];
      readonly linux?: readonly string[];
      readonly default?: readonly string[];
    };

export interface DeclaredOutput {
  readonly port: string;
  readonly event: string;
}

export interface DeclaredAction {
  readonly id: string;
  readonly label: string;
  readonly event: string;
  readonly form?: JsonSchema;
}

export interface DeclaredType {
  readonly id: string;
  readonly kind: Kind;
  readonly view?: "action" | "snapshot";
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly command: DeclaredCommand;
  readonly config: JsonSchema;
  readonly outputs: readonly DeclaredOutput[];
  readonly actions?: readonly DeclaredAction[];
  readonly input?: boolean;
  readonly event?: string;
  readonly payload?: JsonSchema;
}

/** An executable package's binary for one platform: its path in the package, and its sha256. */
export interface DeclaredBinary {
  readonly path: string;
  readonly sha256: string;
}

export interface Declaration {
  readonly protocol: 2;
  readonly package: string;
  readonly version: string;
  readonly environment?: {
    readonly kind: "uv-python" | "node" | "executable";
    readonly python?: string;
    readonly node?: string;
    /** `executable` only: one binary per `<platform>-<arch>`, with its sha256 (spec 2.3.3). */
    readonly binaries?: Readonly<Record<string, DeclaredBinary>>;
  };
  readonly types: readonly DeclaredType[];
}

/** A type of a loaded package, and the folder its package is in (spec 2.3.4). */
export interface LoadedType {
  readonly declaration: Declaration;
  readonly type: DeclaredType;
  readonly folder: string;
}

/** One problem a schema validator found: the JSON Pointer of the field, and what is wrong. */
export interface FieldProblem {
  readonly path: string;
  readonly message: string;
}

export type ParsedDeclaration =
  | { readonly ok: true; readonly declaration: Declaration }
  | { readonly ok: false; readonly problems: readonly string[] };

/** One output port of a type, in port order (spec 2.2). */
export interface Port {
  readonly port: string;
  readonly event: string;
  /** The label the editor shows beside the port. */
  readonly label: string;
  /** A snapshot view's action port, which comes after every pass-through port. */
  readonly action: boolean;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A problem as a person reads it: the field, then what is wrong with it. */
function said(problem: FieldProblem): string {
  const field = problem.path === "" ? "the declaration" : problem.path.slice(1);
  return `${field}: ${problem.message}`;
}

/** Freeze a parsed value all the way down, so no holder can change what was judged. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

/** The rules a JSON Schema cannot state: uniqueness, reserved ports, event owners. */
function beyondTheSchema(declaration: Declaration): string[] {
  const problems: string[] = [];
  const typeIds = new Set<string>();
  declaration.types.forEach((type, index) => {
    const at = `types/${String(index)}`;
    if (typeIds.has(type.id)) {
      problems.push(`${at}/id: ${JSON.stringify(type.id)} is declared twice in this package`);
    }
    typeIds.add(type.id);
    const ports = new Set<string>();
    const named: { port: string; event: string; field: string }[] = [
      ...type.outputs.map((o, i) => ({ ...o, field: `${at}/outputs/${String(i)}` })),
      ...(type.actions ?? []).map((a, i) => ({
        port: a.id,
        event: a.event,
        field: `${at}/actions/${String(i)}`,
      })),
    ];
    for (const { port, event, field } of named) {
      const portField = field.includes("/actions/") ? `${field}/id` : `${field}/port`;
      if (RESERVED_PORTS.includes(port)) {
        problems.push(`${portField}: ${JSON.stringify(port)} is a Node-RED message field`);
      }
      if (ports.has(port)) {
        problems.push(`${portField}: port ${JSON.stringify(port)} is declared twice`);
      }
      ports.add(port);
      // Spec 5.2.3: a package emits under its own name only, and never `user.*`.
      const owner = event.slice(0, event.indexOf("."));
      if (owner !== declaration.package) {
        problems.push(
          `${field}/event: ${JSON.stringify(event)} is owned by ${JSON.stringify(owner)}` +
            (owner === USER_OWNER ? ", which is reserved for created event types" : "") +
            `; package ${declaration.package} may emit only ${declaration.package}.*`,
        );
      }
    }
  });
  return problems;
}

/**
 * Parse a declaration (any JSON value). The protocol is judged first, so a package written for
 * another version is refused naming both versions (spec 1.3) rather than with a schema error.
 * Then `check` (the spec 2.6 schema, through a real validator), then the rules beyond it.
 */
export function parseDeclaration(
  value: unknown,
  check: (value: unknown) => readonly FieldProblem[],
): ParsedDeclaration {
  if (!isRecord(value)) {
    return { ok: false, problems: ["the declaration: must be a JSON object"] };
  }
  if ("protocol" in value && value["protocol"] !== PROTOCOL) {
    return {
      ok: false,
      problems: [
        `protocol: ${JSON.stringify(value["protocol"])} is not implemented by this runtime, ` +
          `which implements protocol ${String(PROTOCOL)}`,
      ],
    };
  }
  const schemaProblems = check(value);
  if (schemaProblems.length > 0) {
    return { ok: false, problems: schemaProblems.map(said) };
  }
  // The schema has judged the shape: from here on the value is a Declaration.
  const declaration = structuredClone(value) as unknown as Declaration;
  const problems = beyondTheSchema(declaration);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, declaration: deepFreeze(declaration) };
}

/** The Node-RED type name, derived and never declared (spec 2.1.4). */
export function nodeTypeName(packageName: string, typeId: string): string {
  return `inny-${packageName}-${typeId}`;
}

/**
 * Every output port of a type, in the order the runtime maps them (spec 2.2): the declared
 * `outputs` (pass-through), then, for a snapshot view, one port per action.
 */
export function portsOf(type: DeclaredType): Port[] {
  const passThrough = type.outputs.map((output) => ({
    port: output.port,
    event: output.event,
    label: `${output.port} (${output.event})`,
    action: false,
  }));
  const actions = (type.actions ?? []).map((action) => ({
    port: action.id,
    event: action.event,
    label: `action: ${action.label}`,
    action: true,
  }));
  return [...passThrough, ...actions];
}

/** How many inputs a type has (spec 2.2): a source none, unless it declares `input: true`. */
export function inputsOf(type: DeclaredType): 0 | 1 {
  return type.kind === "source" && type.input !== true ? 0 : 1;
}
