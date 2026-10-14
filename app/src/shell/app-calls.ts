// AppApi v2's shell side (plan 0022 §N), wired in one place: the runs', flows', board's, Setup's,
// update's, packages' and General's calls, each in its own *-calls.ts, and the coalesced push
// events. main.ts constructs the parts and hands them in.
import type { Dialog, IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import type { BoardStore } from "../ports/board-store";
import type { Clock } from "../ports/clock";
import type { EditorPresence, EditorWindow } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type {
  RunRetentionSetting,
  SetupSetting,
  UpdateHistoryStore,
  UpdateSettingsStore,
} from "../ports/settings-store";
import type { TelemetrySetting } from "../ports/telemetry";
import { wireBoard } from "./board";
import { wireFlowCalls } from "./flow-calls";
import { wireGeneralCalls } from "./general-calls";
import { wirePackageCalls } from "./package-calls";
import { wireRunCalls } from "./run-calls";
import { wireSetup } from "./setup";
import { wireUpdateCalls, type UpdateCalls } from "./update-calls";
import type { PendingQuestions } from "./views";

export interface AppCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  /** Node-RED's flows file: Setup reads whether a 0.2.1 installation has flows from it. */
  readonly flowsFile: string;
  readonly runtime: Supervisor;
  readonly services: Supervisor;
  /** boards.json: every flow's board (plan 0022 §C). */
  readonly boards: BoardStore;
  readonly editor: EditorWindow & EditorPresence;
  readonly dialog: Pick<Dialog, "showSaveDialog" | "showOpenDialog">;
  /**
   * shell-settings.json: Setup's place, Run history's retention, the telemetry answer, and
   * InnyTypes' own install record and "Check automatically" switch.
   */
  readonly settings: SetupSetting &
    RunRetentionSetting &
    Pick<TelemetrySetting, "readTelemetry"> &
    UpdateHistoryStore &
    UpdateSettingsStore;
  /** The once-only notice board: the crash-loop offer's one notice. */
  readonly notifier: Notifier;
  /** Open a release's notes, by its tag, in the browser. */
  readonly openReleaseNotes: (tag: string) => void;
  readonly pending: PendingQuestions;
  /** The push events (PushEvents.toPage). */
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  readonly currentVersion: () => string;
  readonly quit: () => void;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
}

/** Wires every v2 call; the answer feeds InnyTypes' own update checks into General's line. */
export function wireAppCalls(deps: AppCallsDeps): UpdateCalls {
  const { ipc, runtime, services, editor, dialog, settings, toPage, logger } = deps;
  wireRunCalls({ ipc, runtime, logger });
  wireFlowCalls({ ipc, runtime, editor, dialog, logger });
  wireBoard({ ipc, runtime, boards: deps.boards, toPage, logger });
  wireSetup({ ipc, flowsFile: deps.flowsFile, settings, toPage, logger });
  wirePackageCalls({ ipc, runtime, dialog, logger });
  wireGeneralCalls({
    ipc,
    children: [runtime, services],
    runtime,
    services,
    pending: deps.pending,
    retention: settings,
    toPage,
    logger,
  });
  return wireUpdateCalls({
    ipc,
    toPage,
    currentVersion: deps.currentVersion,
    clock: deps.clock,
    settings,
    runtime,
    notifier: deps.notifier,
    openReleaseNotes: deps.openReleaseNotes,
    quit: deps.quit,
    logger,
  });
}
