// The `innytype` annotation (spec 2.4.1, decision D9): one object per config property, read
// back for the form, accepted by strict validation, refused at the declaration when malformed,
// and never a change to what validates.
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import {
  INNYTYPE_ANNOTATION,
  INNYTYPE_KEYWORD,
  innytypeOptions,
} from "../../src/domain/forms/innytype";
import { formModel } from "../../src/domain/forms/form-model";
import type { JsonSchema } from "../../src/domain/packages/declaration";

const SPACE = { type: "string", title: "Space", innytype: { spaces: true } };
const TYPE = { type: "string", title: "Type", innytype: { types: { of: "space" } } };
const CONFIG: JsonSchema = {
  type: "object",
  required: ["space"],
  properties: { space: SPACE, type: TYPE },
};

/** A declaration of one node type whose config schema is `config`. */
function declaration(config: unknown): unknown {
  return {
    protocol: 2,
    package: "optionsnode",
    version: "0.0.0",
    types: [
      {
        id: "pick",
        kind: "node",
        label: "Pick",
        command: ["{package}/node.py"],
        config,
        outputs: [],
      },
    ],
  };
}

describe("innytypeOptions", () => {
  it("reads spaces and types-of-a-sibling", () => {
    expect(innytypeOptions(SPACE)).toEqual({ source: "spaces" });
    expect(innytypeOptions(TYPE)).toEqual({ source: "types", of: "space" });
  });

  it("reads nothing where nothing this revision defines is declared", () => {
    const cases: JsonSchema[] = [
      { type: "string" },
      { type: "integer", innytype: { spaces: true } },
      { type: "string", innytype: true },
      { type: "string", innytype: { recorders: true } },
      { type: "string", innytype: { spaces: false } },
      { type: "string", innytype: { types: { of: "" } } },
      { type: "string", innytype: { types: "space" } },
      { type: "string", innytype: { spaces: true, types: { of: "space" } } },
    ];
    for (const property of cases) {
      expect(innytypeOptions(property)).toBeNull();
    }
  });

  it("names the one keyword the annotation spends", () => {
    expect(INNYTYPE_KEYWORD).toBe("innytype");
    expect(INNYTYPE_ANNOTATION).toEqual({ keyword: "innytype" });
  });
});

describe("the form model", () => {
  it("keeps where a text field's options come from, the value still a plain string", () => {
    const [space, type] = formModel(CONFIG).fields;
    expect(space).toMatchObject({ key: "space", control: "text", innytype: { source: "spaces" } });
    expect(type).toMatchObject({
      key: "type",
      control: "text",
      innytype: { source: "types", of: "space" },
    });
    expect(formModel({ properties: { plain: { type: "string" } } }).fields[0]).not.toHaveProperty(
      "innytype",
    );
  });
});

describe("validation with the annotation", () => {
  it("is accepted by a strict validator once registered, and refused before", () => {
    expect(() => new Ajv2020({ strict: true }).compile(CONFIG)).toThrow(/innytype/);
    const strict = new Ajv2020({ strict: true }).addKeyword(INNYTYPE_ANNOTATION);
    expect(strict.compile(CONFIG)({ space: "s1", type: "t1" })).toBe(true);
  });

  it("never changes which values validate", () => {
    const validator = new AjvSchemaValidator();
    const bare: JsonSchema = {
      type: "object",
      required: ["space"],
      properties: { space: { type: "string" }, type: { type: "string" } },
    };
    const values: unknown[] = [
      { space: "s1", type: "t1" },
      { space: "s1" },
      {},
      { space: 5 },
      { space: "s1", type: ["t1"] },
    ];
    for (const value of values) {
      expect(validator.check(CONFIG, value)).toEqual(validator.check(bare, value));
    }
    expect(validator.check(CONFIG, { space: "s1", type: "t1" })).toEqual([]);
    expect(validator.check(CONFIG, { space: 5 })).not.toEqual([]);
  });
});

describe("the declaration schema", () => {
  const validator = new AjvSchemaValidator();

  it("accepts spaces and types-of on string properties", () => {
    expect(validator.declaration(declaration(CONFIG))).toEqual([]);
    expect(validator.declaration(declaration({ type: "object" }))).toEqual([]);
  });

  it("leaves room for keys a later revision defines, beside the one it requires", () => {
    const later = {
      properties: { folder: { type: "string", innytype: { spaces: true, folders: true } } },
    };
    expect(validator.declaration(declaration(later))).toEqual([]);
  });

  it("checks nested objects and table rows as it checks the top level", () => {
    const nested = {
      properties: {
        group: { type: "object", properties: { space: SPACE } },
        rows: { type: "array", items: { type: "object", properties: { type: TYPE } } },
      },
    };
    expect(validator.declaration(declaration(nested))).toEqual([]);
    const bad = { type: "integer", innytype: { spaces: true } };
    const refused: [unknown, string][] = [
      [{ group: { type: "object", properties: { p: bad } } }, "/group/properties/p/type"],
      [
        { rows: { type: "array", items: { type: "object", properties: { p: bad } } } },
        "/rows/items/properties/p/type",
      ],
      [
        { g: { type: "object", properties: { h: { type: "object", properties: { p: bad } } } } },
        "/g/properties/h/properties/p/type",
      ],
    ];
    for (const [properties, path] of refused) {
      const problems = validator.declaration(declaration({ properties }));
      expect(problems.map((problem) => problem.path)).toContain(
        `/types/0/config/properties${path}`,
      );
    }
  });

  it("refuses a malformed annotation, naming the property", () => {
    const refused: [unknown, string][] = [
      [{ type: "integer", innytype: { spaces: true } }, "/types/0/config/properties/p/type"],
      [{ innytype: { spaces: true } }, "/types/0/config/properties/p/type"],
      [
        { type: "string", innytype: { spaces: "yes" } },
        "/types/0/config/properties/p/innytype/spaces",
      ],
      [
        { type: "string", innytype: { types: {} } },
        "/types/0/config/properties/p/innytype/types/of",
      ],
      [
        { type: "string", innytype: { types: { of: "" } } },
        "/types/0/config/properties/p/innytype/types/of",
      ],
      [{ type: "string", innytype: "spaces" }, "/types/0/config/properties/p/innytype"],
      [{ type: "string", innytype: {} }, "/types/0/config/properties/p/innytype/spaces"],
      [{ type: "string", innytype: { folders: true } }, "/types/0/config/properties/p/innytype"],
      [
        { type: "string", innytype: { spaces: true, types: { of: "space" } } },
        "/types/0/config/properties/p/innytype",
      ],
    ];
    for (const [property, path] of refused) {
      const problems = validator.declaration(declaration({ properties: { p: property } }));
      expect(problems.map((problem) => problem.path)).toContain(path);
    }
  });
});
