// Setup's calls (plan 0022 §H; Welcome, Reports, Connect Anytype, Source folder, the starter's step
// forms, Ready): where the walkthrough is, a move through it, closing it, and Try
// with a sample (declared; not available until WI-0022-16). The state lives in shell-settings.json
// and is written at every move, so a quit resumes at the same step; domain/setup decides every
// move and judges what is read back.
//
// A 0.2.1 installation never sees Setup: the first read, with nothing stored, marks it completed
// when flows exist or the reports question was already answered, and stores that.
import type { IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import {
  back,
  finish,
  next,
  resume,
  setupForExistingInstall,
  withStarterForms,
  type SetupState,
} from "../domain/setup/setup";
import type { Logger } from "../ports/logger";
import type { SetupSetting } from "../ports/settings-store";
import type { TelemetrySetting } from "../ports/telemetry";
import type { Answer } from "../ui/answer";
import { guarded, notAvailable, opOf, unknownOp } from "./answer";
import { IPC } from "./ipc";

export interface SetupDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Pick<Supervisor, "call">;
  readonly settings: SetupSetting & Pick<TelemetrySetting, "readTelemetry">;
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  readonly logger: Logger;
}

/** Applies a move the page sent; anything that is not one leaves the state as it is. */
export function applyMove(state: SetupState, move: Readonly<Record<string, unknown>>): SetupState {
  switch (move["kind"]) {
    case "next":
      return next(state);
    case "back":
      return back(state);
    case "finish":
      return finish(state);
    case "starterForms": {
      const forms = move["formCount"];
      return typeof forms === "number" ? withStarterForms(state, forms) : state;
    }
    default:
      return state;
  }
}

export function wireSetup(deps: SetupDeps): void {
  const { ipc, runtime, settings, toPage, logger } = deps;
  const store = (state: SetupState): SetupState => {
    settings.writeSetup({ ...state });
    toPage(IPC.setupChanged, state);
    return state;
  };
  /** The state stored; on a first read, a 0.2.1 installation's, stored. */
  const current = async (): Promise<SetupState> => {
    const saved = settings.readSetup();
    if (saved !== undefined) {
      return resume(saved);
    }
    const flows = await runtime.call("flow.list", null);
    const flowsExist = flows.ok && Array.isArray(flows.value) && flows.value.length > 0;
    const reportsAnswered = settings.readTelemetry() !== "unset";
    const state = setupForExistingInstall({ flowsExist, reportsAnswered });
    settings.writeSetup({ ...state });
    return state;
  };
  ipc.handle(IPC.setupCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async (): Promise<Answer<SetupState | null>> => {
      switch (op) {
        case "setup.get":
          return { ok: true, value: await current() };
        case "setup.move":
          return { ok: true, value: store(applyMove(await current(), args)) };
        case "setup.complete":
          return { ok: true, value: store({ ...(await current()), completed: true }) };
        case "setup.trySample":
          return notAvailable(); // WI-0022-16: the bundled sample where the starter watches
        default:
          return unknownOp(op, "setup", logger);
      }
    });
  });
}
