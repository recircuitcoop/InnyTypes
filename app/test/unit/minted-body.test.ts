// The inventory of pinned tools whose body the child wraps under `body` (plan 0023, WI-0023-01):
// re-derived from the recorded input schemas, which are proven to be the pinned ones by their
// signatures in tool_surface.json, and tied to that surface so a re-recording fails here.
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { committedToolSurface, toolSignature } from "../../src/adapters/anytype/tool-surface";
import {
  INVENTORIED_SURFACE,
  MINTED_BODY_TOOLS,
  type MintedBodyShape,
} from "../../src/domain/anytype/minted-body";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SURFACE = committedToolSurface(path.join(APP, "src", "adapters", "anytype"));

/** The input schemas of the minted-body tools, as the child's tools/list served them. */
const SCHEMAS = JSON.parse(
  fs.readFileSync(path.join(APP, "test", "fixtures", "minted-body", "input-schemas.json"), "utf8"),
) as Record<string, { properties: Record<string, Record<string, unknown>>; required: string[] }>;

/** The parser's own test (parser.ts:600-622): only an object with properties is flattened. */
function mintedShape(body: Record<string, unknown>): MintedBodyShape | "flattened" {
  if (Array.isArray(body["anyOf"])) {
    return "anyOf";
  }
  if (body["type"] === "object" && body["properties"] === undefined) {
    return "object-without-properties";
  }
  return "flattened";
}

describe("the minted-body inventory", () => {
  it("was taken against the committed tool surface, so a re-recorded surface fails here", () => {
    expect(toolSignature(SURFACE.tools)).toBe(INVENTORIED_SURFACE);
  });

  it("rests on recorded schemas that are byte for byte the pinned ones", () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      expect(SURFACE.tools[name], name).toBe(toolSignature(schema));
    }
  });

  it("names exactly the recorded tools whose body is minted, with the shape each has", () => {
    expect(Object.keys(MINTED_BODY_TOOLS).sort()).toEqual(Object.keys(SCHEMAS).sort());
    for (const [name, tool] of Object.entries(MINTED_BODY_TOOLS)) {
      const schema = SCHEMAS[name];
      const body = schema?.properties["body"];
      expect(body, name).toBeDefined();
      expect(schema?.required, name).toContain("body");
      expect(mintedShape(body ?? {}), name).toBe(tool.shape);
      const forms = Array.isArray(body?.["anyOf"]) ? body["anyOf"].length : 1;
      expect(tool.forms, name).toHaveLength(forms);
    }
  });

  it("holds the two tools the report saw refused", () => {
    expect(MINTED_BODY_TOOLS).toHaveProperty("API-create-object");
    expect(MINTED_BODY_TOOLS).toHaveProperty("API-update-type");
  });
});
