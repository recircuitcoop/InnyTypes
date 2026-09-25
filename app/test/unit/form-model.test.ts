// domain/forms/form-model.ts: a type's config JSON Schema read as a form (spec 2.5, plan 0005's
// table as an array of objects). What survives of the old settings form
// (tests/test_settings_form.py, test_table_form.py): every declared field in declaration order,
// each with the control, label, tip and default it is drawn with, required ones marked, a
// table's columns, and rows added, removed and reordered without touching the others.

import { describe, expect, it } from "vitest";

import {
  addRow,
  formModel,
  isSecret,
  moveRow,
  newRow,
  removeRow,
  secretKeys,
  withoutSecrets,
  type Field,
} from "../../src/domain/forms/form-model";

/** Every control a config schema can ask for, in one schema. */
const EVERY_CONTROL = {
  type: "object",
  required: ["label", "count", "volumes", "token"],
  properties: {
    label: { type: "string", title: "Label" },
    ratio: { type: "number", title: "Ratio", description: "A fraction." },
    count: { type: "integer", default: 3 },
    enabled: { type: "boolean", title: "Enabled", default: false },
    mode: { enum: ["fast", "slow"], default: "fast" },
    token: { type: "string", title: "Token", writeOnly: true },
    apikey: { type: "string", "x-secret": true },
    retry: {
      type: "object",
      required: ["attempts"],
      properties: { attempts: { type: "integer" }, backoff: { type: "number" } },
    },
    volumes: {
      type: "array",
      title: "Volumes",
      items: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", title: "Name" },
          readonly: { type: "boolean", default: false },
        },
      },
    },
  },
};

const byKey = (fields: readonly Field[], key: string): Field => {
  const field = fields.find((f) => f.key === key);
  if (field === undefined) {
    throw new Error(`no field ${key}`);
  }
  return field;
};

describe("formModel", () => {
  const { fields } = formModel(EVERY_CONTROL);

  it("lists every declared property as a field, in the schema's order", () => {
    expect(fields.map((f) => f.key)).toEqual([
      "label",
      "ratio",
      "count",
      "enabled",
      "mode",
      "token",
      "apikey",
      "retry",
      "volumes",
    ]);
  });

  it("gives each schema type its control (spec 2.5.1)", () => {
    expect(Object.fromEntries(fields.map((f) => [f.key, f.control]))).toEqual({
      label: "text",
      ratio: "number",
      count: "integer",
      enabled: "checkbox",
      mode: "select",
      token: "password",
      apikey: "password",
      retry: "group",
      volumes: "table",
    });
  });

  it("marks the required fields, at every level", () => {
    expect(fields.filter((f) => f.required).map((f) => f.key)).toEqual([
      "label",
      "count",
      "token",
      "volumes",
    ]);
    const retry = byKey(fields, "retry").fields ?? [];
    expect(retry.map((f) => [f.key, f.required])).toEqual([
      ["attempts", true],
      ["backoff", false],
    ]);
    const columns = byKey(fields, "volumes").fields ?? [];
    expect(columns.map((f) => [f.key, f.required])).toEqual([
      ["name", true],
      ["readonly", false],
    ]);
  });

  it("labels a field by its title, else its key, with its description as a tip", () => {
    expect(byKey(fields, "ratio")).toMatchObject({ label: "Ratio", help: "A fraction." });
    expect(byKey(fields, "count")).toMatchObject({ label: "count", help: null });
  });

  it("carries a declared default, and no default when none is declared", () => {
    expect(byKey(fields, "count").default).toBe(3);
    expect(byKey(fields, "enabled").default).toBe(false);
    expect("default" in byKey(fields, "label")).toBe(false);
  });

  it("offers a select's options in the schema's order", () => {
    expect(byKey(fields, "mode").options).toEqual(["fast", "slow"]);
    expect(formModel({ properties: { n: { enum: [3, 1, 2] } } }).fields[0]?.options).toEqual([
      3, 1, 2,
    ]);
  });

  it("draws a nested object's own fields, and a table's columns", () => {
    expect(byKey(fields, "retry").fields?.map((f) => f.control)).toEqual(["integer", "number"]);
    expect(byKey(fields, "volumes").fields?.map((f) => f.control)).toEqual(["text", "checkbox"]);
  });

  it("draws an array of anything but objects as text, for the validator to judge", () => {
    const { fields: list } = formModel({ properties: { tags: { type: "array", items: {} } } });
    expect(list[0]?.control).toBe("text");
  });

  it("publishes an empty form for a schema that declares no properties", () => {
    expect(formModel({ type: "object" })).toEqual({ fields: [] });
  });
});

describe("secrets", () => {
  it("are the writeOnly and x-secret properties, and nothing else", () => {
    expect(secretKeys(EVERY_CONTROL)).toEqual(["token", "apikey"]);
    expect(isSecret({ type: "string", writeOnly: false })).toBe(false);
  });

  it("are left out of the config schema, and out of its required list", () => {
    const plain = withoutSecrets(EVERY_CONTROL);
    expect(Object.keys(plain["properties"] as object)).not.toContain("token");
    expect(plain["required"]).toEqual(["label", "count", "volumes"]);
  });
});

describe("rows of a table", () => {
  const columns = formModel(EVERY_CONTROL).fields.find((f) => f.key === "volumes")?.fields ?? [];
  const a = { name: "a" };
  const b = { name: "b" };
  const c = { name: "c" };

  it("adds a row of the columns' defaults at the end", () => {
    expect(newRow(columns)).toEqual({ readonly: false });
    expect(addRow([a], columns)).toEqual([a, { readonly: false }]);
  });

  it("removes one row and keeps the others in order", () => {
    expect(removeRow([a, b, c], 1)).toEqual([a, c]);
    expect(removeRow([a, b], 5)).toEqual([a, b]);
  });

  it("moves one row and keeps the others in order", () => {
    expect(moveRow([a, b, c], 2, 0)).toEqual([c, a, b]);
    expect(moveRow([a, b, c], 0, 1)).toEqual([b, a, c]);
  });

  it("changes nothing for a move outside the rows", () => {
    expect(moveRow([a, b], 0, -1)).toEqual([a, b]);
    expect(moveRow([a, b], 2, 0)).toEqual([a, b]);
  });

  it("never changes the rows it was given", () => {
    const rows = [a, b, c];
    addRow(rows, columns);
    removeRow(rows, 0);
    moveRow(rows, 0, 2);
    expect(rows).toEqual([a, b, c]);
  });
});
