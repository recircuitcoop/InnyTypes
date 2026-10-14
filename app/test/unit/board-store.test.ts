// boards.json (plan 0022 §C): every flow's board in one file, each entry checked with ajv when
// read, written whole through a rename.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonBoardStore, parseBoards } from "../../src/adapters/fs/board-store";
import { newLayout } from "../../src/domain/board/layout";
import type { StoredBoard } from "../../src/ports/board-store";

const BOARD: StoredBoard = { layout: newLayout("f1", "Overview"), fresh: ["q1"] };

const scratchFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inny-boards-")), "boards.json");

describe("board store", () => {
  it("keeps a board across a new store on the same file, written through a rename", () => {
    const file = scratchFile();
    new JsonBoardStore(file).set(BOARD);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(new JsonBoardStore(file).get("f1")).toEqual(BOARD);
    expect(new JsonBoardStore(file).get("f2")).toBeNull();
  });

  it("reads a missing, unreadable or non-object file as empty", () => {
    expect(new JsonBoardStore(scratchFile()).get("f1")).toBeNull();
    expect(parseBoards("{ not json").size).toBe(0);
    expect(parseBoards("[]").size).toBe(0);
    expect(parseBoards("null").size).toBe(0);
  });

  it("leaves out an entry that does not validate, or that is filed under another flow", () => {
    const noTabs = { ...BOARD, layout: { ...BOARD.layout, tabs: [] } };
    const badSize = {
      ...BOARD,
      layout: { ...BOARD.layout, slots: [{ ...BOARD.layout.slots[0], size: "XL" }] },
    };
    const text = JSON.stringify({ f1: BOARD, f2: noTabs, f3: badSize, f4: BOARD });
    expect([...parseBoards(text).keys()]).toEqual(["f1"]);
  });

  it("refuses to keep a board that does not validate", () => {
    const store = new JsonBoardStore(scratchFile());
    const broken = { ...BOARD, fresh: [1] } as unknown as StoredBoard;
    expect(() => {
      store.set(broken);
    }).toThrow(/does not validate/);
  });
});
