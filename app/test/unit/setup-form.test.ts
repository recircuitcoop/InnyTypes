// ui/setup-form.ts (plan 0022 §H, ux-writing "The first run (Setup)"): the Connect Anytype step's
// line, a step form read from its schema, what Continue sends, a refusal's problems by field, and
// a line whose names are drawn in italics. No DOM: SetupScreen and SetupForm only draw these.
import { describe, expect, it } from "vitest";
import type { AnytypeStatus } from "../../src/ui/contract";
import {
  anytypeStep,
  draftOf,
  markedParts,
  plainOf,
  problemsByField,
  setupFields,
  valuesOf,
} from "../../src/ui/setup-form";
import { STRINGS } from "../../src/ui/strings";

const status = (state: AnytypeStatus["state"], pairing = false): AnytypeStatus => ({
  state,
  detail: null,
  childPid: null,
  beats: 0,
  pairing,
});
const spaces = (n: number) => ({
  ok: true as const,
  value: { options: Array.from({ length: n }, (_, i) => ({ value: `s${String(i)}`, label: "S" })) },
});

describe("Connect Anytype", () => {
  it("asks for the code, says Anytype is not running, or counts the spaces", () => {
    expect(anytypeStep(null, null, false)).toEqual({ kind: "waiting", line: null });
    expect(anytypeStep(status("no-key", true), null, false)).toEqual({
      kind: "code",
      line: STRINGS["setup.anytype.running"],
    });
    expect(anytypeStep(status("no-key"), null, true)).toEqual({
      kind: "not-running",
      line: STRINGS["setup.anytype.notRunning"],
    });
    expect(anytypeStep(status("unreachable"), null, false).kind).toBe("not-running");
    expect(anytypeStep(status("ready"), spaces(8), false)).toEqual({
      kind: "connected",
      line: "Connected. Found 8 spaces.",
    });
    expect(anytypeStep(status("ready"), spaces(1), false).line).toBe("Connected. Found 1 space.");
    // Ready, but the spaces not read yet: nothing said, Connect still offered.
    expect(anytypeStep(status("ready"), null, false)).toEqual({ kind: "waiting", line: null });
    expect(anytypeStep(status("starting"), null, false).kind).toBe("waiting");
  });
});

const SCHEMA = {
  type: "object",
  required: ["space_id"],
  properties: {
    space_id: { type: "string", title: "Space", innytype: { spaces: true } },
    type_key: { type: "string", innytype: { types: { of: "space_id" } }, default: "page" },
    note: { type: "string", description: "Said in the note." },
    token: { type: "string", writeOnly: true, title: "Token" },
    count: { type: "integer", default: 2 },
    ratio: { type: "number" },
    loud: { type: "boolean", default: true },
    mode: { enum: ["fast", "slow"] },
    rows: { type: "array", items: { type: "object" } },
    group: { type: "object" },
    odd: { type: "string", innytype: { spaces: true, types: { of: "x" } } },
    broken: 7,
  },
};

describe("a step's form", () => {
  it("reads each property it can draw, in order; a group or a table is left to the canvas", () => {
    const fields = setupFields(SCHEMA);
    expect(fields.map((field) => [field.key, field.kind])).toEqual([
      ["space_id", "text"],
      ["type_key", "text"],
      ["note", "text"],
      ["token", "secret"],
      ["count", "integer"],
      ["ratio", "number"],
      ["loud", "boolean"],
      ["mode", "enum"],
      ["odd", "text"],
    ]);
    expect(fields[0]).toMatchObject({
      label: "Space",
      required: true,
      innytype: { source: "spaces" },
    });
    expect(fields[1]).toMatchObject({
      label: "type_key",
      required: false,
      innytype: { source: "types", of: "space_id" },
    });
    expect(fields[2]?.help).toBe("Said in the note.");
    expect(fields[7]?.options).toEqual(["fast", "slow"]);
    // Both sources at once is no source, as the domain reads it.
    expect(fields[8]?.innytype).toBeNull();
    expect(setupFields({})).toEqual([]);
    expect(setupFields({ properties: { a: { type: "string" } }, required: "a" })[0]?.required).toBe(
      false,
    );
  });

  it("opens with the step's values, else the defaults, and never shows a secret", () => {
    const fields = setupFields(SCHEMA);
    expect(
      draftOf(fields, { space_id: "sp-1", token: "kept", ratio: 0.5, mode: { odd: true } }),
    ).toEqual({
      space_id: "sp-1",
      type_key: "page",
      note: "",
      token: "",
      count: "2",
      ratio: "0.5",
      loud: true,
      mode: "",
      odd: "",
    });
  });

  it("sends what is filled, numbers as numbers, and leaves an empty field out", () => {
    const fields = setupFields(SCHEMA);
    const draft = {
      ...draftOf(fields, {}),
      space_id: "sp-1",
      count: "3",
      ratio: "about half",
      token: " ",
      loud: false,
    };
    expect(valuesOf(fields, draft)).toEqual({
      space_id: "sp-1",
      type_key: "page",
      count: 3,
      ratio: "about half",
      loud: false,
    });
    expect(valuesOf(fields, {})).toEqual({});
  });

  it("names the fields a refusal found wrong", () => {
    expect(
      problemsByField([
        { path: "/space_id", message: "is required" },
        { path: "/rows/0/name", message: "must be a string" },
      ]),
    ).toEqual({ space_id: "is required", rows: "must be a string" });
    expect(problemsByField(undefined)).toEqual({});
  });
});

describe("a line with names in italics", () => {
  it("splits the template where ux-writing marks a name, then fills it", () => {
    const parts = markedParts("setup.form.title", { step: "File *in* Anytype" });
    expect(parts).toEqual([
      { text: "Set up: ", named: false },
      { text: "File *in* Anytype", named: true },
    ]);
    expect(plainOf(parts)).toBe("Set up: File *in* Anytype");
    expect(plainOf(markedParts("setup.ready.body", { folder: "Inbox" }))).toBe(
      "Your flow is on. Drop a file in Inbox to start. Or try it now with a 10-second sample.",
    );
    expect(markedParts("setup.ready.body")[1]).toEqual({ text: "{folder}", named: true });
  });
});
