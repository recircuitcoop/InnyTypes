// The runtime's half of the editor sync (WI-0018-12): `editor.nodes` lists the node sets the
// editor would load, `editor.sync` raises node/removed, then node/added, and refuses a change it
// cannot read.

import { describe, expect, it } from "vitest";

import { answerEditorCall, parsePaletteChange } from "../../src/application/editor-events";
import type { NodeRedEditorEvents, NodeSet, NodeSetSummary } from "../../src/ports/node-red-engine";
import { RecordingLogger } from "../fakes/children";

function engine(sets: NodeSet[]) {
  const raised: string[] = [];
  const fake: NodeRedEditorEvents = {
    nodeSets: () => Promise.resolve(sets),
    raiseNodeAdded: (ids) => {
      const known = ids.filter((id) => sets.some((set) => set.id === id));
      raised.push(`added ${known.join(",")}`);
      return Promise.resolve(known);
    },
    raiseNodeRemoved: (removed: readonly NodeSetSummary[]) => {
      raised.push(`removed ${removed.map((set) => set.id).join(",")}`);
    },
  };
  return { fake, raised };
}

const SETS: NodeSet[] = [
  { id: "node-red/inject", module: "node-red", types: ["inject"], enabled: true },
  { id: "node-red/empty", module: "node-red", types: [], enabled: true },
  { id: "node-red/late", module: "node-red", types: ["inny-late"], enabled: true },
];

describe("editor.nodes", () => {
  it("lists every set as the editor loads it, one with no types too, as id and types", async () => {
    const { fake } = engine(SETS);
    await expect(
      answerEditorCall("editor.nodes", null, fake, new RecordingLogger()),
    ).resolves.toEqual({
      ok: true,
      value: [
        { id: "node-red/inject", types: ["inject"] },
        { id: "node-red/empty", types: [] },
        { id: "node-red/late", types: ["inny-late"] },
      ],
    });
  });
});

describe("editor.sync", () => {
  it("raises node/removed first, then node/added, and logs what it raised", async () => {
    const { fake, raised } = engine(SETS);
    const logger = new RecordingLogger();
    const answer = await answerEditorCall(
      "editor.sync",
      {
        added: ["node-red/late", "node-red/unknown"],
        removed: [{ id: "node-red/gone", types: ["x"] }],
      },
      fake,
      logger,
    );
    expect(raised).toEqual(["removed node-red/gone", "added node-red/late"]);
    expect(answer).toEqual({
      ok: true,
      value: { added: ["node-red/late"], removed: ["node-red/gone"] },
    });
    expect(logger.lines).toEqual([
      "INFO editor sync: node/added for [node-red/late], node/removed for [node-red/gone]",
    ]);
  });

  it("refuses a change it cannot read, and raises nothing", async () => {
    const { fake, raised } = engine(SETS);
    for (const args of [
      null,
      "x",
      { added: "x", removed: [] },
      { added: [], removed: "x" },
      { added: [1], removed: [] },
      { added: [], removed: [{ id: "", types: [] }] },
      { added: [], removed: [{ id: "a", types: [1] }] },
      { added: [], removed: [null] },
    ]) {
      expect(parsePaletteChange(args)).toBeNull();
      await expect(
        answerEditorCall("editor.sync", args, fake, new RecordingLogger()),
      ).resolves.toEqual({
        ok: false,
        error: "editor.sync needs {added: string[], removed: {id, types}[]}",
      });
    }
    expect(raised).toEqual([]);
  });
});
