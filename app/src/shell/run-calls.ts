// The runs' calls from the app page (plan 0022 §C, §E): the runtime's runs read model answers
// list, get, "Clear done" and its undo. Re-run, re-run many and delete are declared in AppApi v2
// and answered not-available here until WI-0022-15 adds the runtime's run.rerun and
// run.deleteMany.
import type { IpcMain } from "electron";
import { NOTHING_TO_UNDO_SENTENCE, RUN_GONE_SENTENCE } from "../application/runs";
import type { Supervisor } from "../application/supervisor";
import type { Logger } from "../ports/logger";
import { fromChild, guarded, notAvailable, opOf, unknownOp, type KnownRefusals } from "./answer";
import { IPC } from "./ipc";

/** The ops the runtime answers, and the ones declared before WI-0022-15. */
const RUNTIME_OPS = ["run.list", "run.get", "run.clearDone", "run.undoClear"] as const;
const NOT_YET_OPS = ["run.rerun", "run.rerunMany", "run.deleteMany"];

const KNOWN: KnownRefusals = {
  [RUN_GONE_SENTENCE]: ["gone", "history.runGone"],
  [NOTHING_TO_UNDO_SENTENCE]: ["gone", "card.nothingToUndo"],
};

export interface RunCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Pick<Supervisor, "call">;
  readonly logger: Logger;
}

export function wireRunCalls({ ipc, runtime, logger }: RunCallsDeps): void {
  ipc.handle(IPC.runCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async () => {
      if (NOT_YET_OPS.includes(op)) {
        return notAvailable();
      }
      const known = RUNTIME_OPS.find((each) => each === op);
      if (known === undefined) {
        return unknownOp(op, "run", logger);
      }
      return fromChild(await runtime.call(known, args), op, logger, KNOWN);
    });
  });
}
