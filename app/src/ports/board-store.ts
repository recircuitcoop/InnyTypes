// Where each flow's board is kept (plan 0022 §C): shell state, untouched by any redeploy
// (adapters/fs/board-store.ts, boards.json).

import type { BoardLayout } from "../domain/board/layout";

/** A flow's board as kept: the person's layout and the places Edit layout has not yet named. */
export interface StoredBoard {
  readonly layout: BoardLayout;
  /**
   * The view nodes that got a place since Edit layout last named new places: its bar says
   * "New on the board: …" for them once, then they are forgotten.
   */
  readonly fresh: readonly string[];
}

export interface BoardStore {
  /** The board kept for `flowId`; null when none is (or the kept one does not validate). */
  get(flowId: string): StoredBoard | null;
  /** Keep `board` for its flow; durable when it returns. */
  set(board: StoredBoard): void;
}
