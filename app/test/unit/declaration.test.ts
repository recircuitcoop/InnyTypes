// domain/packages/declaration.ts with the real ajv validator (adapters/schema): node package
// declarations parsed against the spec's §2.6 schema, and refused by field (spec 2, 1.3, 5.2).
// Several behaviours of the old manifest parser (tests/test_addon_manifest.py) carry over: a
// parsed declaration is frozen, every refusal names its field, and a version this runtime does
// not implement is refused naming both versions.

import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import {
  inputsOf,
  nodeTypeName,
  parseDeclaration,
  portsOf,
  type DeclaredType,
  type ParsedDeclaration,
} from "../../src/domain/packages/declaration";

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const validator = new AjvSchemaValidator();
const parse = (value: unknown): ParsedDeclaration =>
  parseDeclaration(value, (v) => validator.declaration(v));

/** The problems of a refused declaration; fails the test when it was accepted. */
function refused(value: unknown): readonly string[] {
  const parsed = parse(value);
  if (parsed.ok) {
    throw new Error("the declaration was accepted");
  }
  return parsed.problems;
}

function nodeType(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "diarize",
    kind: "node",
    label: "Diarize",
    command: ["{python}", "{package}/diarize.py"],
    config: { type: "object" },
    outputs: [{ port: "done", event: "monty.diarized.v1" }],
    ...overrides,
  };
}

function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { protocol: 2, package: "monty", version: "0.1.0", types: [nodeType()], ...overrides };
}

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

/** The spec's own §2.7 example. */
function specExample(): unknown {
  const spec = fs.readFileSync(path.join(REPOSITORY, "docs/specs/node-protocol-v2.md"), "utf8");
  const section = spec.slice(spec.indexOf("### 2.7 Example"), spec.indexOf("## 3. Transport"));
  return JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "");
}

describe("the declaration schema file", () => {
  it("is exactly the JSON Schema block of spec §2.6", () => {
    const spec = fs.readFileSync(path.join(REPOSITORY, "docs/specs/node-protocol-v2.md"), "utf8");
    const section = spec.slice(
      spec.indexOf("### 2.6 JSON Schema"),
      spec.indexOf("### 2.7 Example"),
    );
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "";
    const file = fs.readFileSync(
      path.join(REPOSITORY, "docs/specs/inny-package.v2.schema.json"),
      "utf8",
    );
    expect(JSON.parse(file)).toEqual(JSON.parse(block));
  });
});

describe("parseDeclaration", () => {
  it("parses the spec's own example into readable fields", () => {
    const parsed = parse(specExample());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { declaration: d } = parsed;
    expect(d.package).toBe("monty");
    expect(d.version).toBe("0.1.0");
    expect(d.environment).toEqual({ kind: "uv-python", python: "3.13" });
    const [watcher] = d.types;
    expect(watcher?.kind).toBe("source");
    expect(watcher?.label).toBe("Folder watcher");
    expect(watcher?.outputs.map((o) => o.port)).toEqual(["new", "updated", "deleted"]);
    expect(watcher?.config["required"]).toEqual(["folder"]);
  });

  it("parses a declaration without the optional sections", () => {
    const parsed = parse(declaration());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.declaration.environment).toBeUndefined();
  });

  it("accepts the protocol this runtime implements", () => {
    expect(parse(declaration({ protocol: 2 })).ok).toBe(true);
  });

  it("refuses a protocol this runtime does not implement, naming both versions", () => {
    expect(refused(declaration({ protocol: 3 }))).toEqual([
      "protocol: 3 is not implemented by this runtime, which implements protocol 2",
    ]);
    expect(refused(declaration({ protocol: 1 }))[0]).toContain("protocol: 1 is not implemented");
  });

  it("refuses a protocol that is not the integer 2", () => {
    expect(refused(declaration({ protocol: "2" }))).toEqual([
      'protocol: "2" is not implemented by this runtime, which implements protocol 2',
    ]);
  });

  it.each(["protocol", "package", "version", "types"])(
    "refuses a declaration missing %s, by name",
    (field) => {
      expect(refused(without(declaration(), field))).toContain(`${field}: is required`);
    },
  );

  it.each(["id", "kind", "label", "command", "config", "outputs"])(
    "refuses a type missing %s, by its path",
    (field) => {
      const type = without(nodeType(), field);
      expect(refused(declaration({ types: [type] }))).toContain(`types/0/${field}: is required`);
    },
  );

  it("refuses a declaration that is not a JSON object", () => {
    for (const value of [[], "monty", 2, null]) {
      expect(refused(value)).toEqual(["the declaration: must be a JSON object"]);
    }
  });

  it("refuses a version that is not a string", () => {
    expect(refused(declaration({ version: 1 }))).toEqual(["version: must be string"]);
  });

  it.each(["1monty", "Whodunnit", "", "who dunnit", "m"])(
    "refuses a package name that cannot own event types: %j",
    (name) => {
      expect(refused(declaration({ package: name }))[0]).toMatch(/^package: must match pattern/);
    },
  );

  it.each([
    ".transcribed.v1",
    "Whodunnit.Transcribed.v1",
    "",
    "whodunnit..v1",
    "whodunnit.transcribed.1",
    "whodunnit.transcribed.v01",
    "whodunnit.transcribed.v0",
    "whodunnit.transcribed.vX",
    "whodunnit.transcribed",
  ])("refuses an event type name that breaks the grammar, by its path: %j", (event) => {
    const type = nodeType({ outputs: [{ port: "done", event }] });
    expect(refused(declaration({ types: [type] }))[0]).toMatch(
      /^types\/0\/outputs\/0\/event: must match pattern/,
    );
  });

  it("refuses emitting under another package's name, or under user (spec 5.2.3)", () => {
    const other = nodeType({ outputs: [{ port: "done", event: "whodunnit.transcribed.v1" }] });
    expect(refused(declaration({ types: [other] }))).toEqual([
      'types/0/outputs/0/event: "whodunnit.transcribed.v1" is owned by "whodunnit"; ' +
        "package monty may emit only monty.*",
    ]);
    const user = nodeType({ outputs: [{ port: "done", event: "user.note.v1" }] });
    expect(refused(declaration({ types: [user] }))[0]).toContain(
      "reserved for created event types",
    );
  });

  it("refuses a port named after a Node-RED message field, and a port declared twice", () => {
    const shadow = nodeType({ outputs: [{ port: "topic", event: "monty.a.v1" }] });
    expect(refused(declaration({ types: [shadow] }))).toEqual([
      'types/0/outputs/0/port: "topic" is a Node-RED message field',
    ]);
    const twice = nodeType({
      kind: "view",
      view: "snapshot",
      outputs: [{ port: "go", event: "monty.a.v1" }],
      actions: [{ id: "go", label: "Go", event: "monty.b.v1" }],
    });
    expect(refused(declaration({ types: [twice] }))).toEqual([
      'types/0/actions/0/id: port "go" is declared twice',
    ]);
  });

  it("refuses two types with one id in a package", () => {
    expect(refused(declaration({ types: [nodeType(), nodeType()] }))).toEqual([
      'types/1/id: "diarize" is declared twice in this package',
    ]);
  });

  it("refuses a view without its view kind, and actions on anything but a snapshot view", () => {
    expect(refused(declaration({ types: [nodeType({ kind: "view" })] }))).toContain(
      "types/0/view: is required",
    );
    const actions = [{ id: "again", label: "Again", event: "monty.again.v1" }];
    expect(refused(declaration({ types: [nodeType({ actions })] }))).toContain(
      "types/0/kind: must be equal to constant",
    );
  });

  it("lists every problem, not only the first", () => {
    const problems = refused(declaration({ version: 3, types: [nodeType({ label: "" })] }));
    expect(problems).toEqual(
      expect.arrayContaining([
        "version: must be string",
        "types/0/label: must NOT have fewer than 1 characters",
      ]),
    );
  });

  it("freezes a parsed declaration all the way down", () => {
    const parsed = parse(declaration());
    if (!parsed.ok) {
      throw new Error("refused");
    }
    const type = parsed.declaration.types[0] as DeclaredType;
    expect(Object.isFrozen(parsed.declaration)).toBe(true);
    expect(Object.isFrozen(type.outputs[0])).toBe(true);
    expect(() => {
      (type as { label: string }).label = "changed";
    }).toThrow(TypeError);
  });

  it("leaves the value it was given unfrozen and unchanged", () => {
    const value = declaration();
    parse(value);
    expect(Object.isFrozen(value)).toBe(false);
    expect(value).toEqual(declaration());
  });
});

describe("the ports and names of a type", () => {
  it("derives the Node-RED type name from the package and the type id (spec 2.1.4)", () => {
    expect(nodeTypeName("monty", "folder-watcher")).toBe("inny-monty-folder-watcher");
  });

  it("numbers the pass-through outputs first, then one port per action (spec 2.2)", () => {
    const type = nodeType({
      kind: "view",
      view: "snapshot",
      outputs: [
        { port: "shown", event: "monty.shown.v1" },
        { port: "kept", event: "monty.kept.v1" },
      ],
      actions: [{ id: "redo", label: "Redo", event: "monty.redo.v1" }],
    }) as unknown as DeclaredType;
    expect(portsOf(type)).toEqual([
      { port: "shown", event: "monty.shown.v1", label: "shown (monty.shown.v1)", action: false },
      { port: "kept", event: "monty.kept.v1", label: "kept (monty.kept.v1)", action: false },
      { port: "redo", event: "monty.redo.v1", label: "action: Redo", action: true },
    ]);
  });

  it("gives a source no input unless it declares one, and every other kind one", () => {
    const of = (fields: Record<string, unknown>) => inputsOf(nodeType(fields) as never);
    expect(of({ kind: "source" })).toBe(0);
    expect(of({ kind: "source", input: true })).toBe(1);
    expect(of({ kind: "node" })).toBe(1);
    expect(of({ kind: "view", view: "action" })).toBe(1);
  });
});
