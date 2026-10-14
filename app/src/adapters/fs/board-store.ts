// Every flow's board in one JSON file, boards.json (plan 0022 §C), beside the pop-out placements:
// `{"<flowId>": {"layout": BoardLayout, "fresh": [viewNodeId]}}`. Shell state: no redeploy and
// no flow write ever touches it; domain/board's `reconcile` brings a kept layout in line with the
// flow each time it is read (shell/board.ts).
//
// Each entry is checked with ajv when the file is read; one that does not validate is left out,
// so that flow's board starts again from the default rather than drawing a broken one. Written
// whole on every change through a temporary file and a rename, so a crash mid-write leaves the
// old file. A file that is missing or unreadable is an empty one.

import * as fs from "node:fs";
import * as path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";

import { SLOT_KINDS, SLOT_SIZES } from "../../domain/board/layout";
import type { BoardStore, StoredBoard } from "../../ports/board-store";

/** One kept board: exactly the domain's BoardLayout, and the names not yet said. */
const STORED_BOARD_SCHEMA = {
  type: "object",
  required: ["layout", "fresh"],
  additionalProperties: false,
  properties: {
    fresh: { type: "array", items: { type: "string" } },
    layout: {
      type: "object",
      required: ["flowId", "tabs", "slots"],
      additionalProperties: false,
      properties: {
        flowId: { type: "string", minLength: 1 },
        tabs: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "name", "order"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 },
              name: { type: "string" },
              order: { type: "integer", minimum: 0 },
            },
          },
        },
        slots: {
          type: "array",
          items: {
            type: "object",
            required: ["viewNodeId", "kind", "size", "hidden", "tabId", "order"],
            additionalProperties: false,
            properties: {
              viewNodeId: { type: "string", minLength: 1 },
              kind: { enum: [...SLOT_KINDS] },
              size: { enum: [...SLOT_SIZES] },
              hidden: { type: "boolean" },
              tabId: { type: "string", minLength: 1 },
              order: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
  },
} as const;

const validStoredBoard = new Ajv2020({ allErrors: true, strict: true }).compile<StoredBoard>(
  STORED_BOARD_SCHEMA,
);

/** The file's text, or null when it cannot be read (it is not there yet). */
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The valid entries of the file's text, by flow id; anything else is left out. */
export function parseBoards(text: string | null): Map<string, StoredBoard> {
  const boards = new Map<string, StoredBoard>();
  if (text === null) {
    return boards;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return boards;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return boards;
  }
  for (const [flowId, entry] of Object.entries(parsed)) {
    // A layout filed under another flow's id is not this flow's board.
    if (validStoredBoard(entry) && entry.layout.flowId === flowId) {
      boards.set(flowId, entry);
    }
  }
  return boards;
}

export class JsonBoardStore implements BoardStore {
  readonly #file: string;
  readonly #boards: Map<string, StoredBoard>;

  constructor(file: string) {
    this.#file = file;
    this.#boards = parseBoards(readText(file));
  }

  get(flowId: string): StoredBoard | null {
    return this.#boards.get(flowId) ?? null;
  }

  set(board: StoredBoard): void {
    const checked: unknown = board;
    if (!validStoredBoard(checked)) {
      throw new Error(`refusing to keep a board that does not validate (${board.layout.flowId})`);
    }
    this.#boards.set(board.layout.flowId, board);
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.#boards), null, 2));
    fs.renameSync(temporary, this.#file);
  }
}
