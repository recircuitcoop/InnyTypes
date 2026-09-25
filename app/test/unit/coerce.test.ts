// domain/forms/coerce.ts: Node-RED's string form values back to their schema types before the
// start frame (spec 2.5.3, arch_pivot P11b §5). Property tests: each runs a few hundred cases
// from a seeded generator, so a failure names a case that can be run again.

import { describe, expect, it } from "vitest";

import { coerceObject, coerceValue, configOf, credentialsOf } from "../../src/domain/forms/coerce";

// ── a seeded generator ───────────────────────────────────────────────────────────────────

const RUNS = 500;

/** mulberry32: a small, well-mixed PRNG, so every run draws the same cases. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Run `property` on RUNS cases drawn from `seed`; a failure reports the case number. */
function forAll(seed: number, property: (next: () => number, run: number) => void): void {
  const next = random(seed);
  for (let run = 0; run < RUNS; run += 1) {
    try {
      property(next, run);
    } catch (error) {
      throw new Error(`property failed on case ${String(run)} of seed ${String(seed)}`, {
        cause: error,
      });
    }
  }
}

const int = (next: () => number, span: number): number => Math.floor(next() * 2 * span) - span || 1; // never -0
const pick = <T>(next: () => number, items: readonly T[]): T =>
  items[Math.floor(next() * items.length)] as T;
const padded = (next: () => number, text: string): string =>
  `${pick(next, ["", " ", "  "])}${text}${pick(next, ["", " ", "\t"])}`;

/** A double of any magnitude, including ones String() writes with an exponent. */
function double(next: () => number): number {
  const magnitude = 10 ** (Math.floor(next() * 40) - 20);
  return (next() - 0.5) * magnitude || 0.5;
}

/** A string with at least one character that is no part of a number. */
function wordy(next: () => number): string {
  const letters = ["a", "b", "c", "x", "y", "z", "!", "?", ",", "_"];
  let text = String(int(next, 1000));
  const at = Math.floor(next() * (text.length + 1));
  text = text.slice(0, at) + pick(next, letters) + text.slice(at);
  return text;
}

// ── properties ───────────────────────────────────────────────────────────────────────────

describe("coerceValue: property tests", () => {
  it("an integer written as text by Node-RED comes back as that integer", () => {
    forAll(1, (next) => {
      const value = int(next, 1_000_000_000);
      expect(coerceValue({ type: "integer" }, padded(next, String(value)))).toBe(value);
    });
  });

  it("a number written as text comes back as that number, exponents included", () => {
    forAll(2, (next) => {
      const value = double(next);
      expect(coerceValue({ type: "number" }, padded(next, String(value)))).toBe(value);
    });
  });

  it("a boolean written as text comes back as that boolean", () => {
    forAll(3, (next) => {
      const value = next() < 0.5;
      expect(coerceValue({ type: "boolean" }, String(value))).toBe(value);
    });
  });

  it("an enum option written as text comes back as the option itself, of its own type", () => {
    forAll(4, (next) => {
      const options = [int(next, 50), `s${String(int(next, 50))}`, double(next), true];
      const option = pick(next, options);
      expect(coerceValue({ enum: options }, String(option))).toBe(option);
    });
  });

  it("text that is not a number stays that text, so the validator refuses it", () => {
    forAll(5, (next) => {
      const text = wordy(next);
      expect(coerceValue({ type: "integer" }, text)).toBe(text);
      expect(coerceValue({ type: "number" }, text)).toBe(text);
    });
  });

  it("a value already of its type is never changed", () => {
    forAll(6, (next) => {
      const n = double(next);
      const i = int(next, 1000);
      const b = next() < 0.5;
      const s = wordy(next);
      expect(coerceValue({ type: "number" }, n)).toBe(n);
      expect(coerceValue({ type: "integer" }, i)).toBe(i);
      expect(coerceValue({ type: "boolean" }, b)).toBe(b);
      expect(coerceValue({ type: "string" }, s)).toBe(s);
      expect(coerceValue({ type: "string" }, String(i))).toBe(String(i));
    });
  });

  it("coercing twice is coercing once", () => {
    const schemas = [
      { type: "integer" },
      { type: "number" },
      { type: "boolean" },
      { type: "string" },
      { enum: [1, "1x", 2.5] },
    ];
    forAll(7, (next) => {
      const schema = pick(next, schemas);
      const raw = pick(next, [
        String(int(next, 99)),
        String(double(next)),
        wordy(next),
        "true",
        "false",
        "",
        "2.5",
      ]);
      const once = coerceValue(schema, raw);
      expect(coerceValue(schema, once)).toEqual(once);
    });
  });

  it("every row of a table is coerced, and the rows keep their number and order", () => {
    const schema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              size: { type: "number" },
              copies: { type: "integer" },
              on: { type: "boolean" },
              inner: { type: "object", properties: { depth: { type: "integer" } } },
            },
          },
        },
      },
    };
    forAll(8, (next) => {
      const typed = Array.from({ length: Math.floor(next() * 6) }, (_, index) => ({
        name: `row ${String(index)}`,
        size: double(next),
        copies: int(next, 100),
        on: next() < 0.5,
        inner: { depth: int(next, 9) },
      }));
      const asNodeRedHasThem = typed.map((row) => ({
        name: row.name,
        size: String(row.size),
        copies: String(row.copies),
        on: String(row.on),
        inner: { depth: String(row.inner.depth) },
      }));
      expect(coerceObject(schema, { rows: asNodeRedHasThem })).toEqual({ rows: typed });
    });
  });
});

// ── examples ─────────────────────────────────────────────────────────────────────────────

describe("coerceValue: the cases a property does not show", () => {
  it("treats blank text as unset, and unset as unset", () => {
    for (const type of ["integer", "number", "boolean"]) {
      expect(coerceValue({ type }, "")).toBeUndefined();
      expect(coerceValue({ type }, "   ")).toBe(type === "boolean" ? "   " : undefined);
    }
    expect(coerceValue({ type: "string" }, undefined)).toBeUndefined();
    expect(coerceValue({ type: "string" }, null)).toBeUndefined();
    expect(coerceValue({ enum: ["a"] }, "")).toBeUndefined();
    expect(coerceValue({ enum: ["", "a"] }, "")).toBe("");
  });

  it("never turns a fractional or overflowing integer text into something else", () => {
    expect(coerceValue({ type: "integer" }, "2.5")).toBe("2.5");
    expect(coerceValue({ type: "number" }, "1e999")).toBe("1e999");
    expect(coerceValue({ type: "number" }, "Infinity")).toBe("Infinity");
    expect(coerceValue({ type: "number" }, "0x10")).toBe("0x10");
  });

  it("leaves a value of the wrong shape for an object or an array to the validator", () => {
    expect(coerceValue({ type: "object" }, "{}")).toBe("{}");
    expect(coerceValue({ type: "array", items: { type: "integer" } }, "1")).toBe("1");
    expect(coerceValue({ type: "array" }, ["1"])).toEqual(["1"]);
  });

  it("leaves an unknown text of a boolean, and an enum text that is no option", () => {
    expect(coerceValue({ type: "boolean" }, "yes")).toBe("yes");
    expect(coerceValue({ enum: [1, 2] }, "3")).toBe("3");
  });
});

describe("coerceObject", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer", default: 3 },
      name: { type: "string" },
      list: { type: "array", default: [{ a: 1 }] },
    },
  };

  it("gives an unset property its default, as a copy", () => {
    const first = coerceObject(schema, { count: "", name: "x" });
    expect(first).toEqual({ count: 3, name: "x", list: [{ a: 1 }] });
    (first["list"] as { a: number }[])[0] = { a: 2 };
    expect(coerceObject(schema, {})["list"]).toEqual([{ a: 1 }]);
  });

  it("drops an unset property that has no default, and keeps undeclared ones", () => {
    expect(coerceObject(schema, { name: "", extra: "kept" })).toEqual({
      count: 3,
      name: "",
      list: [{ a: 1 }],
      extra: "kept",
    });
    expect(coerceObject(schema, { name: null })).not.toHaveProperty("name");
  });
});

describe("configOf and credentialsOf", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      token: { type: "string", writeOnly: true },
      key: { type: "string", "x-secret": true },
    },
  };

  it("takes only the declared, non-secret properties of a Node-RED node, coerced", () => {
    const node = {
      id: "n1",
      type: "inny-x-y",
      z: "tab",
      name: "mine",
      wires: [[]],
      x: 10,
      count: "7",
      token: "leaked into the node?",
    };
    expect(configOf(schema, node)).toEqual({ count: 7 });
  });

  it("takes the declared secrets Node-RED holds, and only those set", () => {
    expect(credentialsOf(schema, { token: "s3cret", key: "", other: "not declared" })).toEqual({
      token: "s3cret",
    });
    expect(credentialsOf(schema, { key: 5 })).toEqual({});
  });
});
