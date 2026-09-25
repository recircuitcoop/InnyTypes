// application/load-node-types.ts: every declaration the store read is judged, a refused package
// is left out whole with its reasons, and the others still load (spec 1.3, 2.6).

import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { loadNodeTypes } from "../../src/application/load-node-types";
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
