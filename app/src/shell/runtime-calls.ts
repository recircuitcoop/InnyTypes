// The app page's calls that the runtime answers (WI-0018-10, -11, -12): the view and snapshot
// calls, the lists and the Jobs page's cancel, the editor sync, and the runs (plan 0022 §C). Each op is checked against
// its channel's own list before it reaches the runtime. Moved here from shell/main.ts, unchanged,
// to keep the composition root under its 600 lines (WI-0018-16).

import type { Dialog, IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import type { EditorPresence, EditorWindow } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type * as Contract from "../ui/contract";
import { exportFlow } from "./flow-export";
import { IPC } from "./ipc";

/**
 * Flow administration's reads (plan 0022 §D), and a step's dynamic options (§B), which the
 * runtime asks of the services process: passed on as they are.
 */
const FLOW_READS: readonly string[] = [
  "flow.list",
  "flow.templates",
  "flow.node.form",
  "node.options",
];
/**
 * Its writes: each is told whether the canvas has unsaved changes, by the shell, which alone
 * sees the editor; whatever the page said is replaced. The runtime refuses the write if so.
 */
const FLOW_WRITES: readonly string[] = [
  "flow.setOn",
  "flow.rename",
  "flow.duplicate",
  "flow.delete",
  "flow.fromTemplate",
  "flow.node.configure",
];

/**
 * What a flow write is told about the canvas. No editor loaded: nothing unsaved. An editor
 * loaded whose palette cannot be read (still loading, navigating, slow to answer) may hold
 * unsaved changes, so it counts as dirty, and says it is loading.
 */
export async function canvasState(
  editor: EditorWindow & EditorPresence,
): Promise<{ canvasDirty: boolean; canvasLoading?: true }> {
  const palette = await editor.palette();
  if (palette !== null) {
    return { canvasDirty: palette.dirty };
  }
  return editor.loaded() ? { canvasDirty: true, canvasLoading: true } : { canvasDirty: false };
}

export interface RuntimeCallsOptions {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Supervisor;
  readonly editor: EditorWindow & EditorPresence;
  readonly logger: Logger;
  /** "Export flow…"'s save dialog. */
  readonly dialog: Pick<Dialog, "showSaveDialog">;
}

/** Wire the calls; the answer switches the editor sync's runtime-event path (the e2e gate's). */
export function wireRuntimeCalls(options: RuntimeCallsOptions): {
  editorEvents(on: boolean): void;
} {
  const { ipc, runtime, editor, logger, dialog } = options;
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
  // The runs read model (plan 0022 §C): Live and Run history.
  ipc.handle(IPC.runCall, async (_event, call: unknown) => {
    const { op, args } = (call ?? {}) as { op?: unknown; args?: unknown };
    if (op !== "run.list" && op !== "run.get" && op !== "run.clearDone" && op !== "run.undoClear") {
      return { ok: false, error: `${String(op)} is not a run call` };
    }
    return runtime.call(op, args);
  });
  // Flow administration (plan 0022 §D): the runtime owns every flow write.
  ipc.handle(IPC.flowCall, async (_event, call: unknown) => {
    const { op, args } = (call ?? {}) as { op?: unknown; args?: unknown };
    if (op === "flow.export") {
      return exportFlow({ runtime, dialog, logger }, args);
    }
    if (typeof op === "string" && FLOW_READS.includes(op)) {
      return runtime.call(op as "flow.list", args);
    }
    if (typeof op !== "string" || !FLOW_WRITES.includes(op)) {
      return { ok: false, error: `${String(op)} is not a flow call` };
    }
    const given = typeof args === "object" && args !== null ? args : {};
    return runtime.call(op as "flow.setOn", { ...given, ...(await canvasState(editor)) });
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
