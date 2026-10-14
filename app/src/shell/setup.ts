// Setup's calls (plan 0022 §H; Welcome, Reports, Connect Anytype, Source folder, the starter's step
// forms, Ready): where the walkthrough is, a move through it, closing it, Source folder's chooser
// and Try with a sample. The state lives in shell-settings.json and is written at every move, so a
// quit resumes at the same step; domain/setup decides every move and judges what is read back.
//
// The starter flow (shell/setup-starter.ts) is installed once Setup reaches Source folder, in the
// background: a read or a move that finds it needed starts the install (one at a time), and its
// id and form count are stored and pushed once it is made. A runtime not up yet fails the
// install; the next read starts it again. Moving into Ready switches the starter on once its
// health is Ready.
//
// A 0.2.1 installation never sees Setup: the first read, with nothing stored, marks it completed
// when flows exist or the reports question was already answered, and stores that. Whether flows
// exist is read from Node-RED's flows file on disk (a flow is a tab), never asked of the runtime:
// the window asks as it opens, before the runtime is up. A flows file that cannot be read decides
// nothing, and nothing is stored, so the next read judges again.
import fs from "node:fs";
import type { Dialog, IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import { typesNamedIn } from "../application/deploy-guard";
import {
  back,
  finish,
  FIRST_SETUP,
  needsStarter,
  next,
  resume,
  setupForExistingInstall,
  withStarter,
  withStarterForms,
  type SetupState,
} from "../domain/setup/setup";
import type { EditorPresence, EditorWindow } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type { SetupSetting } from "../ports/settings-store";
import type { TelemetrySetting } from "../ports/telemetry";
import type { Answer } from "../ui/answer";
import type { ChosenFolder } from "../ui/general-contract";
import { guarded, opOf, refused, unknownOp } from "./answer";
import { IPC } from "./ipc";
import { SetupStarter } from "./setup-starter";

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
  readonly runtime: Pick<Supervisor, "call">;
  readonly editor: EditorWindow & EditorPresence;
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  /** The bundled sample, and where the runtime keeps each node instance's data folder. */
  readonly files: { readonly sampleFile: string; readonly instancesDir: string };
  readonly logger: Logger;
  /** A pause; a test passes one that does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
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
  const starter = new SetupStarter({
    runtime: deps.runtime,
    editor: deps.editor,
    dialog: deps.dialog,
    sampleFile: deps.files.sampleFile,
    instancesDir: deps.files.instancesDir,
    logger,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
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
  /** The starter's install under way, so a burst of reads installs it once. */
  let installing: Promise<void> | null = null;
  const installStarter = async (): Promise<void> => {
    const installed = await starter.install();
    if (!installed.ok) {
      logger.info(`Setup: the starter flow is not installed yet (${installed.refused.reason})`);
      return;
    }
    // Recorded on the state as it is now: the person may have moved meanwhile.
    const { flowId, formCount } = installed.value;
    store(withStarter(current(), flowId, formCount));
  };
  /** The state, with the starter's install started when Setup needs it and none is under way. */
  const withStarterStarted = (state: SetupState): SetupState => {
    if (needsStarter(state) && installing === null) {
      installing = installStarter()
        .catch((error: unknown) => {
          logger.error(`Setup: installing the starter flow failed: ${String(error)}`);
        })
        .finally(() => {
          installing = null;
        });
    }
    return state;
  };
  const move = async (args: Readonly<Record<string, unknown>>): Promise<SetupState> => {
    const before = current();
    const after = store(applyMove(before, args));
    if (after.step === "ready" && before.step !== "ready" && after.starterFlowId !== null) {
      // Ready says the flow is on: switched on here, once its health is Ready.
      await starter.switchOnWhenReady(after.starterFlowId);
    }
    return withStarterStarted(after);
  };
  /** The installed starter's id, or why Setup cannot act on it yet. */
  const starterId = (): Answer<string> => {
    const flowId = current().starterFlowId;
    return flowId === null
      ? refused("loading", "flows.refused.loading")
      : { ok: true, value: flowId };
  };
  ipc.handle(IPC.setupCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async (): Promise<Answer<SetupState | ChosenFolder | null>> => {
      switch (op) {
        case "setup.get":
          return { ok: true, value: withStarterStarted(current()) };
        case "setup.move":
          return { ok: true, value: await move(args) };
        case "setup.complete":
          return { ok: true, value: store({ ...current(), completed: true }) };
        case "setup.chooseFolder": {
          const flowId = starterId();
          return flowId.ok ? starter.chooseFolder(flowId.value) : flowId;
        }
        case "setup.trySample": {
          const flowId = starterId();
          return flowId.ok ? starter.trySample(flowId.value) : flowId;
        }
        default:
          return unknownOp(op, "setup", logger);
      }
    });
  });
}
