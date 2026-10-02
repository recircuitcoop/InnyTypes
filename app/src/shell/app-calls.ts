// AppApi v2's shell side (plan 0022 §N), wired in one place: the runs', flows', board's, Setup's,
// update's, packages' and General's calls, each in its own *-calls.ts, and the coalesced push
// events. main.ts constructs the parts and hands them in.
import type { Dialog, IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import type { Clock } from "../ports/clock";
import type { EditorPresence, EditorWindow } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type { RunRetentionSetting, SetupSetting } from "../ports/settings-store";
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
  readonly runtime: Supervisor;
  readonly services: Supervisor;
  readonly editor: EditorWindow & EditorPresence;
  readonly dialog: Pick<Dialog, "showSaveDialog" | "showOpenDialog">;
  /** shell-settings.json: Setup's place, Run history's retention, the telemetry answer. */
  readonly settings: SetupSetting & RunRetentionSetting & Pick<TelemetrySetting, "readTelemetry">;
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
  wireBoard({ ipc, runtime, toPage, logger });
  wireSetup({ ipc, runtime, settings, toPage, logger });
  wirePackageCalls({ ipc, runtime, dialog, logger });
  wireGeneralCalls({
    ipc,
    children: [runtime, services],
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
    quit: deps.quit,
    logger,
  });
}
