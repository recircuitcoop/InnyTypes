// The app page's calls that the runtime answers (WI-0018-10, -11, -12): the view and snapshot
// calls, the lists and the Jobs page's cancel, and the editor sync. Each op is checked against
// its channel's own list before it reaches the runtime. Moved here from shell/main.ts, unchanged,
// to keep the composition root under its 600 lines (WI-0018-16).

import type { IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import type { EditorWindow } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type * as Contract from "../ui/contract";
import { IPC } from "./ipc";

export interface RuntimeCallsOptions {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Supervisor;
  readonly editor: EditorWindow;
  readonly logger: Logger;
}

/** Wire the calls; the answer switches the editor sync's runtime-event path (the e2e gate's). */
export function wireRuntimeCalls(options: RuntimeCallsOptions): {
  editorEvents(on: boolean): void;
} {
  const { ipc, runtime, editor, logger } = options;
  // ── the editor sync (WI-0018-12): the page compares; the runtime raises Node-RED's events ──
  ipc.handle(IPC.editorPalette, (): Promise<Contract.EditorPalette | null> => editor.palette());
  let editorEvents = true;
  ipc.handle(IPC.editorCall, async (_event, call: unknown) => {
    const { op, args } = (call ?? {}) as { op?: unknown; args?: unknown };
    if (op !== "editor.nodes" && op !== "editor.sync") {
      return { ok: false, error: `${String(op)} is not an editor call` };
    }
    if (op === "editor.sync" && !editorEvents) {
      // The e2e gate's way to break the runtime-event path, so the fallback is what acts.
      logger.warn("editor sync: the runtime-event path is disabled; nothing is raised");
      return { ok: true, value: null };
    }
    return runtime.call(op, args);
  });
  ipc.handle(IPC.listCall, async (_event, call: unknown) => {
    const { op, args } = (call ?? {}) as { op?: unknown; args?: unknown };
    if (op !== "snapshot.list" && op !== "job.list" && op !== "job.cancel") {
      return { ok: false, error: `${String(op)} is not a list call` };
    }
    return runtime.call(op, args);
  });
  ipc.handle(IPC.viewCall, async (_event, call: unknown): Promise<Contract.ViewResult> => {
    const { op, args } = (call ?? {}) as { op?: unknown; args?: unknown };
    if (
      op !== "view.get" &&
      op !== "view.submit" &&
      op !== "snapshot.get" &&
      op !== "snapshot.action"
    ) {
      return { ok: false, error: `${String(op)} is not a view call` };
    }
    return runtime.call(op, args);
  });
  return {
    editorEvents: (on) => {
      editorEvents = on;
    },
  };
}
