// Setup's calls (plan 0022 §H; Welcome, Reports, Connect Anytype, Source folder, the starter's step
// forms, Ready): where the walkthrough is, a move through it, closing it, and Try
// with a sample (declared; not available until WI-0022-16). The state lives in shell-settings.json
// and is written at every move, so a quit resumes at the same step; domain/setup decides every
// move and judges what is read back.
//
// A 0.2.1 installation never sees Setup: the first read, with nothing stored, marks it completed
// when flows exist or the reports question was already answered, and stores that. Whether flows
// exist is read from Node-RED's flows file on disk (a flow is a tab), never asked of the runtime:
// the window asks as it opens, before the runtime is up. A flows file that cannot be read decides
// nothing, and nothing is stored, so the next read judges again.
import fs from "node:fs";
import type { IpcMain } from "electron";
import { typesNamedIn } from "../application/deploy-guard";
import {
  back,
  finish,
  FIRST_SETUP,
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

/**
 * Whether Node-RED's saved flows hold a flow (a tab): false when there is no file yet, null when
 * the file cannot be read or is not JSON.
 */
export function savedFlowsExist(flowsFile: string): boolean | null {
  let text: string;
  try {
    text = fs.readFileSync(flowsFile, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
  try {
    return typesNamedIn("flows", JSON.parse(text) as unknown).includes("tab");
  } catch {
    return null;
  }
}

export interface SetupDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  /** Node-RED's flows file (userData/node-red/flows.json), as the runtime loads it. */
  readonly flowsFile: string;
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
  const { ipc, flowsFile, settings, toPage, logger } = deps;
  const store = (state: SetupState): SetupState => {
    settings.writeSetup({ ...state });
    toPage(IPC.setupChanged, state);
    return state;
  };
  /** The state stored; on a first read, a 0.2.1 installation's, stored once it is known. */
  const current = (): SetupState => {
    const saved = settings.readSetup();
    if (saved !== undefined) {
      return resume(saved);
    }
    const flowsExist = savedFlowsExist(flowsFile);
    const reportsAnswered = settings.readTelemetry() !== "unset";
    if (flowsExist === null && !reportsAnswered) {
      // The flows file cannot be judged: Setup for now, and no decision kept.
      logger.warn(`Setup: ${flowsFile} cannot be read; whether flows exist is asked again later`);
      return FIRST_SETUP;
    }
    const state = setupForExistingInstall({ flowsExist: flowsExist === true, reportsAnswered });
    settings.writeSetup({ ...state });
    return state;
  };
  ipc.handle(IPC.setupCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, (): Answer<SetupState | null> => {
      switch (op) {
        case "setup.get":
          return { ok: true, value: current() };
        case "setup.move":
          return { ok: true, value: store(applyMove(current(), args)) };
        case "setup.complete":
          return { ok: true, value: store({ ...current(), completed: true }) };
        case "setup.trySample":
          return notAvailable(); // WI-0022-16: the bundled sample where the starter watches
        default:
          return unknownOp(op, "setup", logger);
      }
    });
  });
}
