// A flow's board (plan 0022 §A, §C): its tabs and places, reconciled at read time with the flow's
// view nodes. The board store (adapters/fs/board-store.ts, boards.json) is WI-0022-12's: until it
// lands, `board.get` answers the default layout of domain/board's `newLayout`, reconciled, and
// `board.save` is not available. The first tab's name is ui/strings.ts's "Overview".
import type { IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import { newLayout, reconcile, type BoardLayout, type ViewNode } from "../domain/board/layout";
import type { Logger } from "../ports/logger";
import type { Answer } from "../ui/answer";
import type { FlowSummary } from "../ui/flow-contract";
import { STRINGS } from "../ui/strings";
import { flowAnswer } from "./flow-calls";
import { guarded, notAvailable, opOf, refused, unknownOp } from "./answer";
import { IPC } from "./ipc";

export interface BoardDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Pick<Supervisor, "call" | "onViewEvent">;
  /** The push events (shell/push.ts). */
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  readonly logger: Logger;
}

/** The board of `flowId` as it reads now: the layout kept (none yet), reconciled with its view nodes. */
export async function readBoard(
  deps: Pick<BoardDeps, "runtime" | "logger">,
  flowId: string,
): Promise<Answer<BoardLayout>> {
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
  const viewNodes: ViewNode[] = flow.viewNodes.map((node) => ({ id: node.id, kind: node.kind }));
  return {
    ok: true,
    value: reconcile(newLayout(flowId, STRINGS["board.firstTab"]), viewNodes).layout,
  };
}

export function wireBoard(deps: BoardDeps): void {
  const { ipc, runtime, toPage, logger } = deps;
  ipc.handle(IPC.boardCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async () => {
      if (op === "board.get") {
        const flowId = args["flowId"];
        return typeof flowId === "string"
          ? readBoard(deps, flowId)
          : refused("gone", "flows.refused.gone");
      }
      if (op === "board.save") {
        return notAvailable(); // WI-0022-12: the board store
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
