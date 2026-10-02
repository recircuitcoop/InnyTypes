// The flow administration's files (plan 0022 §C, §D): `flows-meta.json`, which keeps only
// `{template, createdAt}` and survives a restart, and the templates folder the build checked.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FsTemplateSource, parseTemplateIndex } from "../../src/adapters/fs/flow-templates";
import { JsonFlowMetaStore, parseFlowsMeta } from "../../src/adapters/fs/flows-meta-store";
import { RecordingLogger } from "../fakes/children";

const scratches: string[] = [];
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inny-flow-stores-"));
  scratches.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratches.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("flows-meta.json", () => {
  it("keeps each flow's template and creation time across a restart, written whole", () => {
    const file = path.join(scratch(), "deeper", "flows-meta.json");
    const store = new JsonFlowMetaStore(file);
    expect(store.get("a")).toBeNull();
    store.set("a", { template: "starter", createdAt: 1 });
    store.set("b", { template: null, createdAt: 2 });
    store.remove("a");
    store.remove("never-there");
    const again = new JsonFlowMetaStore(file);
    expect(again.get("a")).toBeNull();
    expect(again.get("b")).toEqual({ template: null, createdAt: 2 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      b: { template: null, createdAt: 2 },
    });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("reads a missing, broken or wrong file as empty, and skips entries of the wrong shape", () => {
    expect(parseFlowsMeta(null).size).toBe(0);
    expect(parseFlowsMeta("{not json").size).toBe(0);
    expect(parseFlowsMeta("[1]").size).toBe(0);
    const read = parseFlowsMeta(
      JSON.stringify({
        ok: { template: "t", createdAt: 3 },
        badTemplate: { template: 4, createdAt: 3 },
        badTime: { template: null, createdAt: "now" },
        notAnObject: 5,
      }),
    );
    expect([...read]).toEqual([["ok", { template: "t", createdAt: 3 }]]);
  });
});

describe("the templates folder", () => {
  const ENTRY = {
    id: "starter",
    name: "Starter",
    line: "l",
    packages: ["p"],
    official: true,
    starter: true,
  };

  it("lists the index's entries of the right shape, in its order", () => {
    expect(parseTemplateIndex({})).toEqual([]);
    expect(
      parseTemplateIndex([
        ENTRY,
        null,
        { ...ENTRY, id: "../escape" },
        { ...ENTRY, id: "x", packages: [1] },
        { ...ENTRY, id: "y", official: "yes" },
        { ...ENTRY, id: "z", name: 1 },
        { ...ENTRY, id: "s", starter: "yes" },
        { id: "plain", name: "Plain", line: "l", packages: [], official: true },
      ]),
    ).toEqual([
      ENTRY,
      // An entry that does not say is not the starter.
      { id: "plain", name: "Plain", line: "l", packages: [], official: true, starter: false },
    ]);
  });

  it("reads a listed template's nodes, and nothing for an id the index does not list", () => {
    const dir = scratch();
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify([ENTRY, { ...ENTRY, id: "odd" }]),
    );
    fs.writeFileSync(
      path.join(dir, "starter.json"),
      JSON.stringify([{ id: "t", type: "tab" }, { id: "n" }, 7]),
    );
    fs.writeFileSync(path.join(dir, "odd.json"), JSON.stringify({ not: "a list" }));
    fs.writeFileSync(path.join(dir, "unlisted.json"), JSON.stringify([{ id: "t", type: "tab" }]));
    const logger = new RecordingLogger();
    const source = new FsTemplateSource(dir, logger);
    expect(source.index()).toEqual([ENTRY, { ...ENTRY, id: "odd" }]);
    expect(source.nodes("starter")).toEqual([{ id: "t", type: "tab" }]);
    expect(source.nodes("odd")).toBeNull();
    expect(source.nodes("unlisted")).toBeNull();
  });

  it("offers nothing, and says so, when the index cannot be read", () => {
    const logger = new RecordingLogger();
    const source = new FsTemplateSource(path.join(scratch(), "missing"), logger);
    expect(source.index()).toEqual([]);
    expect(logger.lines).toContainEqual(
      expect.stringContaining("the flow template file index.json cannot be read"),
    );
  });
});
