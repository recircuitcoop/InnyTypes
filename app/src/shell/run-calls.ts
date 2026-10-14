// The runs' calls from the app page (plan 0022 §C, §E): the runtime's runs read model answers
// list, get, "Clear done" and its undo; its re-runs and deletes answer re-run, re-run many and
// delete, each refusal by its sentence's key.
import type { IpcMain } from "electron";
import { GONE_SENTENCE, NO_STEP_SENTENCE } from "../application/flows";
import { FLOW_OFF_SENTENCE, NOT_REACHED_SENTENCE } from "../application/run-actions";
import { NOTHING_TO_UNDO_SENTENCE, RUN_GONE_SENTENCE } from "../application/runs";
import type { Supervisor } from "../application/supervisor";
import { cardTitle, cardVariant, donePills, stepLine } from "../domain/runs/card";
import { currentStep, type Run } from "../domain/runs/run";
import type { Logger } from "../ports/logger";
import type { RunCardView, RunRecord } from "../ui/run-contract";
import { fromChild, guarded, opOf, unknownOp, type KnownRefusals } from "./answer";
import { IPC } from "./ipc";

/** The ops the runtime answers. */
const RUNTIME_OPS = [
  "run.list",
  "run.get",
  "run.clearDone",
  "run.undoClear",
  "run.rerun",
  "run.rerunMany",
  "run.delete",
  "run.deleteMany",
] as const;

const KNOWN: KnownRefusals = {
  [RUN_GONE_SENTENCE]: ["gone", "history.runGone"],
  [NOTHING_TO_UNDO_SENTENCE]: ["gone", "card.nothingToUndo"],
  [GONE_SENTENCE]: ["gone", "flows.refused.gone"],
  [NO_STEP_SENTENCE]: ["no-step", "flows.refused.noStep"],
  [NOT_REACHED_SENTENCE]: ["no-step", "history.refused.notReached"],
  [FLOW_OFF_SENTENCE]: ["flow-off", "history.refused.flowOff"],
};

export interface RunCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Pick<Supervisor, "call">;
  readonly logger: Logger;
}

/** A run's card values, from the run alone (domain/runs/card). */
export function cardOf(run: Run): RunCardView {
  const step = run.state === "waiting" ? currentStep(run) : null;
  return {
    variant: cardVariant(run),
    title: cardTitle(run),
    line: stepLine(run),
    pills: donePills(run),
    waiting:
      step?.state === "waiting" && step.inputId !== undefined
        ? {
            viewId: step.inputId,
            instanceId: step.instanceId,
            step: step.name,
            since: step.startedAt,
          }
        : null,
  };
}

/** `run.list`'s page or `run.get`'s run, each run with its card. */
function withCards(op: string, value: unknown): unknown {
  const card = (run: RunRecord): RunRecord => ({ ...run, card: cardOf(run) });
  if (op === "run.get") {
    return card(value as RunRecord);
  }
  const page = value as { runs: RunRecord[]; next: string | null };
  return { ...page, runs: page.runs.map(card) };
}

export function wireRunCalls({ ipc, runtime, logger }: RunCallsDeps): void {
  ipc.handle(IPC.runCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async () => {
      const known = RUNTIME_OPS.find((each) => each === op);
      if (known === undefined) {
        return unknownOp(op, "run", logger);
      }
      const answer = fromChild(await runtime.call(known, args), op, logger, KNOWN);
      return answer.ok && (known === "run.list" || known === "run.get")
        ? { ok: true, value: withCards(known, answer.value) }
        : answer;
    });
  });
}
