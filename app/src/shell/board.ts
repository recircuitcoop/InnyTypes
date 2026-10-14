// A flow's board (plan 0022 §A, §C): its tabs and places, kept in boards.json by the board store
// (adapters/fs/board-store.ts) and reconciled at read time with the flow's view nodes, so a
// redeploy never resets what the person arranged: a view node the flow gained gets a place at
// the end of the last tab, one it lost loses its place, and nothing else moves.
//
// * `board.get` reads the kept board (a new one, its first tab "Overview", when none is kept),
//   reconciles it, and keeps the result when reconciling changed it. The places a kept board
//   gains are `fresh`: Edit layout's bar names them once. A board seen for the first time names
//   nothing: everything on it is new.
// * `board.save` applies one Edit-layout change (general-contract BoardChange) with the domain's
//   own operations and keeps the result at once; `seen` (Done) forgets `fresh`. A change the
//   domain refuses (the last tab) is answered with its line.
import type { IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import {
  addTab,
  BoardError,
  hideSlot,
  moveSlot,
  newLayout,
  reconcile,
  removeTab,
  renameTab,
  resizeSlot,
  showSlot,
  type BoardLayout,
  type ViewNode,
} from "../domain/board/layout";
import type { BoardStore, StoredBoard } from "../ports/board-store";
import type { Logger } from "../ports/logger";
import type { Answer } from "../ui/answer";
import type { FlowSummary } from "../ui/flow-contract";
import type { BoardChange, BoardView } from "../ui/general-contract";
import { STRINGS } from "../ui/strings";
import { flowAnswer } from "./flow-calls";
import { guarded, opOf, refused, unknownOp } from "./answer";
import { IPC } from "./ipc";

export interface BoardDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Pick<Supervisor, "call" | "onViewEvent">;
  /** boards.json. */
  readonly boards: BoardStore;
  /** The push events (shell/push.ts). */
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  readonly logger: Logger;
}

type ReadDeps = Pick<BoardDeps, "runtime" | "boards" | "logger">;

/** The view nodes of `flowId`, as the runtime lists them now; a refusal when it is gone. */
async function viewNodesOf(deps: ReadDeps, flowId: string): Promise<Answer<ViewNode[]>> {
  const listed = flowAnswer<readonly FlowSummary[]>(
    await deps.runtime.call("flow.list", null),
    "board.get",
    deps.logger,
  );
  if (!listed.ok) {
    return listed;
  }
  const flow = listed.value.find((each) => each.id === flowId);
  if (flow === undefined) {
    return refused("gone", "flows.refused.gone");
  }
  return { ok: true, value: flow.viewNodes.map((node) => ({ id: node.id, kind: node.kind })) };
}

const sameLayout = (a: BoardLayout, b: BoardLayout): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The board of `flowId` as it reads now: the kept layout reconciled with the flow's view nodes,
 * kept again when that changed it. `fresh` gains what a kept board gained and loses what it lost.
 */
export async function readBoard(deps: ReadDeps, flowId: string): Promise<Answer<BoardView>> {
  const nodes = await viewNodesOf(deps, flowId);
  if (!nodes.ok) {
    return nodes;
  }
  const kept = deps.boards.get(flowId);
  const start = kept?.layout ?? newLayout(flowId, STRINGS["board.firstTab"]);
  const { layout, added, removed } = reconcile(start, nodes.value);
  if (kept !== null && sameLayout(kept.layout, layout)) {
    return { ok: true, value: kept };
  }
  const gone = new Set(removed);
  const fresh = kept === null ? [] : [...kept.fresh.filter((id) => !gone.has(id)), ...added];
  const board: StoredBoard = { layout, fresh };
  deps.boards.set(board);
  return { ok: true, value: board };
}

/** The domain's operation for one Edit-layout change. */
function applyChange(layout: BoardLayout, change: BoardChange): BoardLayout {
  switch (change.kind) {
    case "move":
      return moveSlot(layout, change.viewNodeId, change.tabId, change.order);
    case "size":
      return resizeSlot(layout, change.viewNodeId, change.size);
    case "hide":
      return hideSlot(layout, change.viewNodeId);
    case "show":
      return showSlot(layout, change.viewNodeId);
    case "add-tab":
      return addTab(layout, change.name).layout;
    case "rename-tab":
      return renameTab(layout, change.tabId, change.name);
    case "remove-tab":
      return removeTab(layout, change.tabId);
    case "seen":
      return layout;
  }
}

/** Apply one change to the board as it reads now, and keep it. */
export async function saveBoard(
  deps: ReadDeps,
  flowId: string,
  change: BoardChange,
): Promise<Answer<BoardView>> {
  const read = await readBoard(deps, flowId);
  if (!read.ok) {
    return read;
  }
  let layout: BoardLayout;
  try {
    layout = applyChange(read.value.layout, change);
  } catch (error) {
    if (!(error instanceof BoardError)) {
      throw error;
    }
    deps.logger.info(`board.save ${change.kind} refused for ${flowId}: ${error.message}`);
    return error.reason === "last-tab"
      ? refused("last-tab", "board.lastTab")
      : refused("failed", "refused.failed");
  }
  const board: StoredBoard = {
    layout,
    fresh: change.kind === "seen" ? [] : read.value.fresh,
  };
  deps.boards.set(board);
  return { ok: true, value: board };
}

/** What the page sent as a change, when it is one; the domain checks the rest. */
function changeOf(value: unknown): BoardChange | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const kind = (value as { kind?: unknown }).kind;
  const kinds = ["move", "size", "hide", "show", "add-tab", "rename-tab", "remove-tab", "seen"];
  return typeof kind === "string" && kinds.includes(kind) ? (value as BoardChange) : null;
}

export function wireBoard(deps: BoardDeps): void {
  const { ipc, runtime, toPage, logger } = deps;
  ipc.handle(IPC.boardCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async () => {
      const flowId = args["flowId"];
      if (op === "board.get") {
        return typeof flowId === "string"
          ? readBoard(deps, flowId)
          : refused("gone", "flows.refused.gone");
      }
      if (op === "board.save") {
        const change = changeOf(args["change"]);
        if (typeof flowId !== "string" || change === null) {
          return refused("failed", "refused.failed");
        }
        const saved = await saveBoard(deps, flowId, change);
        if (saved.ok) {
          toPage(IPC.boardChanged, { flowId });
        }
        return saved;
      }
      return unknownOp(op, "board", logger);
    });
  });
  // A flow's view nodes may have changed with the flows: each board reads anew.
  runtime.onViewEvent((event) => {
    if (event.t !== "flows") {
      return;
    }
    void runtime.call("flow.list", null).then((result) => {
      const listed = flowAnswer<readonly FlowSummary[]>(result, "board.changed", logger);
      for (const flow of listed.ok ? listed.value : []) {
        toPage(IPC.boardChanged, { flowId: flow.id });
      }
    });
  });
}
