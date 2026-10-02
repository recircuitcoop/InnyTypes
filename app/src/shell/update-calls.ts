// InnyTypes' own update, as General shows it (plan 0022 §G): domain/updates' state machine, fed by
// every check UpdateCheck makes (Check now and the scheduled ones alike), and pushed to the page
// at each step. "Quit and update" quits when an update is ready; the quit installs it
// (QuitFlow's exit calls UpdateCheck.installAtQuit). Go back is declared and not available until
// WI-0022-20, which also records the previous release at install; until then nothing is offered.
import type { IpcMain } from "electron";
import type { UpdateCheck } from "../application/update-check";
import {
  rollbackOffer,
  startMachine,
  step,
  type UpdateEvent,
  type UpdateMachine,
} from "../domain/updates/machine";
import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Answer } from "../ui/answer";
import type { UpdateView } from "../ui/general-contract";
import { guarded, notAvailable, opOf, refused, unknownOp } from "./answer";
import { IPC } from "./ipc";

export interface UpdateCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  /** The version running now. */
  readonly currentVersion: () => string;
  readonly clock: Pick<Clock, "now">;
  /** Quit InnyTypes; the quit installs a ready update. */
  readonly quit: () => void;
  readonly logger: Logger;
}

export interface UpdateCalls {
  /** UpdateCheck's `onEvent`: each step of a check moves the state, and the page is told. */
  onEvent(event: UpdateEvent): void;
  /** The check itself, once built; null on a platform that does not self-update. */
  attach(updates: Pick<UpdateCheck, "check"> | null): void;
}

export function wireUpdateCalls(deps: UpdateCallsDeps): UpdateCalls {
  const { ipc, toPage, clock, logger } = deps;
  let machine: UpdateMachine = startMachine({
    current: deps.currentVersion(),
    lastCheckedAt: null,
    previous: null,
  });
  let updates: Pick<UpdateCheck, "check"> | null = null;
  const view = (): UpdateView => ({
    state: machine.state,
    goBack: rollbackOffer(machine, new Date(clock.now())),
  });
  const onEvent = (event: UpdateEvent): void => {
    const result = step(machine, event);
    if (!result.accepted) {
      logger.info(`update: ${event.kind} does not apply in ${machine.state.kind}; ignored`);
      return;
    }
    machine = result.machine;
    toPage(IPC.updateStateChanged, view());
  };
  ipc.handle(IPC.updateCall, (_event, call: unknown) => {
    const { op } = opOf(call);
    return guarded(op, logger, async (): Promise<Answer<UpdateView | null>> => {
      switch (op) {
        case "update.state":
          return { ok: true, value: view() };
        case "update.checkNow":
          if (updates === null) {
            return notAvailable(); // this platform does not self-update (WI-0018-30)
          }
          await updates.check();
          return { ok: true, value: view() };
        case "update.quit":
          if (machine.state.kind !== "ready") {
            return refused("nothing-to-do", "update.notReady");
          }
          onEvent({ kind: "quitAndInstall" });
          deps.quit();
          return { ok: true, value: null };
        case "update.goBack":
          return notAvailable(); // WI-0022-20: Go back to the previous signed release
        default:
          return unknownOp(op, "update", logger);
      }
    });
  });
  return {
    onEvent,
    attach: (check) => {
      updates = check;
    },
  };
}
