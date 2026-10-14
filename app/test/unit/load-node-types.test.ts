// application/load-node-types.ts: every declaration the store read is judged, a refused package
// is left out whole with its reasons, and the others still load (spec 1.3, 2.6).

import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { loadNodeTypes, unregisteredNames } from "../../src/application/load-node-types";
import { RecordingLogger } from "../fakes/children";

const validator = new AjvSchemaValidator();

function declared(name: string, overrides: Record<string, unknown> = {}) {
  const type = (id: string) => ({
    id,
    kind: "node",
    label: id,
    command: ["{package}/run"],
    config: { type: "object" },
    outputs: [{ port: "out", event: `${name}.out.v1` }],
  });
  return {
    name,
    folder: `/packages/${name}`,
    document: {
      protocol: 2,
      package: name,
      version: "1.0.0",
      types: [type("one"), type("two")],
      ...overrides,
    },
  };
}

describe("loadNodeTypes", () => {
  it("loads every type of every accepted package, with its folder", () => {
    const logger = new RecordingLogger();
    const loaded = loadNodeTypes([declared("alpha"), declared("beta")], validator, logger);
    expect(loaded.map((l) => `${l.declaration.package}/${l.type.id} ${l.folder}`)).toEqual([
      "alpha/one /packages/alpha",
      "alpha/two /packages/alpha",
      "beta/one /packages/beta",
      "beta/two /packages/beta",
    ]);
    expect(logger.lines).toEqual([]);
  });

  it("leaves an unregistered package's types out, and says so (plan 0022 §F, D6)", () => {
    const logger = new RecordingLogger();
    const loaded = loadNodeTypes([declared("alpha"), declared("beta")], validator, logger, [
      "alpha",
    ]);
    expect(loaded.map((l) => l.declaration.package)).toEqual(["beta", "beta"]);
    expect(logger.lines).toEqual([
      "INFO node package alpha is unregistered: its types are not loaded",
    ]);
  });

  it("reads the unregistered names from the packages setting; an unreadable one unregisters none", () => {
    const logger = new RecordingLogger();
    expect(unregisteredNames(() => ({ unregistered: ["alpha"] }), logger)).toEqual(["alpha"]);
    expect(unregisteredNames(() => undefined, logger)).toEqual([]);
    expect(unregisteredNames(() => ({ unregistered: "alpha" }), logger)).toEqual([]);
    expect(logger.lines.some((line) => line.startsWith("WARN the packages setting"))).toBe(true);
  });

  it("refuses a package of another protocol, naming the version, and loads the rest", () => {
    const logger = new RecordingLogger();
    const loaded = loadNodeTypes(
      [declared("alpha", { protocol: 3 }), declared("beta")],
      validator,
      logger,
    );
    expect(loaded.map((l) => l.declaration.package)).toEqual(["beta", "beta"]);
    expect(logger.lines).toEqual([
      "ERROR node package alpha (/packages/alpha) is refused and not loaded: protocol: 3 is " +
        "not implemented by this runtime, which implements protocol 2",
    ]);
  });

  it("refuses a package the schema refuses, with every reason by field", () => {
    const logger = new RecordingLogger();
    expect(
      loadNodeTypes([declared("alpha", { version: 1, types: [] })], validator, logger),
    ).toEqual([]);
    expect(logger.lines).toEqual([
      "ERROR node package alpha (/packages/alpha) is refused and not loaded: version: must be " +
        "string; types: must NOT have fewer than 1 items",
    ]);
  });
});
