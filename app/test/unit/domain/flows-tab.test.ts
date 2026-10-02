// One tab as a flow (plan 0022 §D, D7): a copy's ids are re-mapped with every reference between
// them, and holds no credentials; an export holds none at any depth; steps come in wire order.
import { describe, expect, it } from "vitest";
import {
  hasCredentials,
  remapIds,
  wireOrder,
  withoutCredentials,
  type TabNode,
} from "../../../src/domain/flows/tab";

/** New ids in order: n1, n2, … */
function ids() {
  let next = 0;
  return () => `n${String(++next)}`;
}

const node = (id: string, fields: Record<string, unknown> = {}): TabNode => ({
  id,
  type: "inny-pkg-step",
  ...fields,
});

describe("remapIds", () => {
  it("gives every node a new id and follows z, g, wires, links, scope and config references", () => {
    const nodes: TabNode[] = [
      node("src", { z: "tab", g: "grp", wires: [["mid", "outside"], []], name: "mid" }),
      node("mid", { z: "tab", server: "cfg", wires: [["end"]] }),
      node("end", { type: "link out", z: "tab", links: ["lin", "elsewhere"] }),
      node("lin", { type: "link in", z: "tab", links: ["end"] }),
      node("grp", { type: "group", z: "tab", nodes: ["src", "mid"] }),
      node("catch", { type: "catch", z: "tab", scope: ["mid"], types: ["page", "task"] }),
      node("cfg", { type: "inny-pkg-config" }),
    ];
    const copy = remapIds(nodes, ids());
    expect(copy.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    const [src, mid, end, lin, grp, katch] = copy;
    // `z` names a tab the copy does not hold: it stays, for the new tab to replace.
    expect(src).toMatchObject({ z: "tab", g: "n5", wires: [["n2"], []], name: "mid" });
    expect(mid).toMatchObject({ server: "n7", wires: [["n3"]] });
    expect(end).toMatchObject({ links: ["n4"] });
    expect(lin).toMatchObject({ links: ["n3"] });
    expect(grp).toMatchObject({ nodes: ["n1", "n2"] });
    // A list naming no copied node is left as it is.
    expect(katch).toMatchObject({ scope: ["n2"], types: ["page", "task"] });
  });

  it("copies no credentials, at any depth, and never changes the nodes it was given", () => {
    const original = node("a", {
      credentials: { token: "s3cret" },
      nested: { credentials: { key: "k" }, kept: 1 },
      wires: "not a list of ports",
    });
    const before = JSON.stringify(original);
    const [copy] = remapIds([original], ids());
    expect(copy).toEqual({
      id: "n1",
      type: "inny-pkg-step",
      nested: { kept: 1 },
      wires: "not a list of ports",
    });
    expect(hasCredentials(copy)).toBe(false);
    expect(JSON.stringify(original)).toBe(before);
  });

  it("keeps each output port, even one left with no wire, and drops what is not an id", () => {
    const [copy] = remapIds([node("a", { wires: [["gone"], "x", [7, "a"]] })], ids());
    expect(copy?.["wires"]).toEqual([[], [], ["n1"]]);
  });
});

describe("withoutCredentials and hasCredentials", () => {
  it("strips every credentials key, in objects and lists alike", () => {
    const value = [{ id: "a", credentials: {} }, { list: [{ credentials: 1, b: 2 }] }, "text", 3];
    expect(hasCredentials(value)).toBe(true);
    expect(withoutCredentials(value)).toEqual([{ id: "a" }, { list: [{ b: 2 }] }, "text", 3]);
    expect(hasCredentials(withoutCredentials(value))).toBe(false);
    expect(hasCredentials(null)).toBe(false);
  });
});

describe("wireOrder", () => {
  const isSource = (n: TabNode) => n.type === "source";

  it("starts at the sources, then follows the wires breadth first", () => {
    const nodes: TabNode[] = [
      node("summarise", { wires: [["file"]], y: 300 }),
      node("file", { wires: [], y: 400 }),
      node("comment", { type: "comment", x: 10, y: 10 }),
      node("transcribe", { wires: [["summarise", "notify"]], y: 200 }),
      node("notify", { y: 500 }),
      node("watch", { type: "source", wires: [["transcribe"]], x: 500, y: 100 }),
    ];
    expect(wireOrder(nodes, isSource).map((n) => n.id)).toEqual([
      "watch",
      "comment",
      "transcribe",
      "summarise",
      "notify",
      "file",
    ]);
  });

  it("puts a node only a loop reaches last, by position, and each node once", () => {
    const nodes: TabNode[] = [
      node("b", { wires: [["a"]], x: 20, y: 50 }),
      node("a", { wires: [["b"]], x: 10, y: 50 }),
      node("c", { wires: [["c"]], y: 10 }),
      node("root", { wires: [["d", "d"]], y: 0 }),
      node("d", { wires: [["root"]] }),
    ];
    // root is wired into by d, so nothing is a root: every node is in a loop.
    expect(wireOrder(nodes, isSource).map((n) => n.id)).toEqual(["root", "d", "c", "a", "b"]);
  });

  it("orders roots top to bottom, then left to right, after the sources", () => {
    const nodes: TabNode[] = [
      node("right", { x: 200, y: 10 }),
      node("left", { x: 100, y: 10 }),
      node("top", { y: 0 }),
      node("noPosition"),
    ];
    expect(wireOrder(nodes, isSource).map((n) => n.id)).toEqual([
      "top",
      "noPosition",
      "left",
      "right",
    ]);
  });
});
