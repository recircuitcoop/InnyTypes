// The app page's calls that the runtime answers (WI-0018-10, -12): Skip this step's dismissal of a
// pending view, and the editor's palette. Each op is checked against its channel's own list before
// it reaches the runtime. The runs' and the flows' calls (plan 0022 §N) are run-calls.ts's and
// flow-calls.ts's. An answer over the size bound, or not plain JSON, is refused here, before the
// hop; everything else about it is the runtime's (spec 8.5.7).

import type { IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import { refusedBeforeHop, REFUSED_ANSWER } from "../domain/views/answers";
import type { EditorPresence, EditorWindow } from "../ports/editor";
import type * as Contract from "../ui/contract";
import { IPC } from "./ipc";

export interface RuntimeCallsOptions {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Supervisor;
  readonly editor: EditorWindow & EditorPresence;
}

/** Wire the calls. */
export function wireRuntimeCalls(options: RuntimeCallsOptions): void {
  const { ipc, runtime, editor } = options;
  // The canvas's "Unsaved changes" (WI-0018-12): the editor's palette and its dirty flag.
  ipc.handle(IPC.editorPalette, (): Promise<Contract.EditorPalette | null> => editor.palette());
  ipc.handle(IPC.viewCall, async (_event, call: unknown): Promise<Contract.ViewResult> => {
    const { op, args } = (call ?? {}) as { op?: unknown; args?: unknown };
    if (op !== "view.submit") {
      return { ok: false, error: `${String(op)} is not a view call` };
    }
    const values = (args ?? {}) as { values?: unknown };
    if (refusedBeforeHop(values.values)) {
      return { ok: false, error: REFUSED_ANSWER };
    }
    return runtime.call(op, args);
  });
}
