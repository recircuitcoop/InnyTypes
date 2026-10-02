// Flow administration's calls from the app page (plan 0022 §D), and a step's dynamic options
// (§B, D9): the runtime owns every flow write, and asks the services process for the options.
// The shell tells each write whether the canvas has unsaved changes (only it sees the editor),
// saves an export through its own dialog, and answers AppApi v2's Answer: a refusal the runtime
// worded for the canvas is passed on by reason, with its ui/strings.ts key.
import type { Dialog, IpcMain } from "electron";
import type { Supervisor } from "../application/supervisor";
import type { CallResult } from "../domain/channel/errors";
import type { EditorPresence, EditorWindow } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type { Answer, RefusalReason } from "../ui/answer";
import type { StringKey } from "../ui/strings";
import { fromChild, guarded, opOf, refused, unknownOp } from "./answer";
import { exportFlow } from "./flow-export";
import { IPC } from "./ipc";

/** The reads, passed on as they are; `node.options` is answered by the runtime with services. */
const FLOW_READS = ["flow.list", "flow.templates", "flow.node.form", "node.options"] as const;
/**
 * The writes: each is told whether the canvas has unsaved changes, by the shell; whatever the
 * page said is replaced. The runtime refuses the write if so.
 */
const FLOW_WRITES = [
  "flow.setOn",
  "flow.rename",
  "flow.duplicate",
  "flow.delete",
  "flow.fromTemplate",
  "flow.node.configure",
] as const;

/** A refusal's reason, as the runtime gives it, and the line the page shows. */
const REFUSAL_KEYS: Readonly<Record<string, StringKey>> = {
  dirty: "flows.refused.dirty",
  loading: "flows.refused.loading",
  "not-installed": "flows.refused.notInstalled",
  gone: "flows.refused.gone",
  name: "flows.refused.name",
  "no-template": "flows.refused.noTemplate",
  "no-step": "flows.refused.noStep",
  "no-form": "flows.refused.noForm",
  invalid: "error.formIncomplete",
  "not-paired": "form.notPaired",
  unreachable: "form.unreachable",
  unavailable: "form.unavailable",
};

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

/** A runtime answer whose value may be `{refused: {reason, sentence, …}}`, as AppApi v2's Answer. */
export function flowAnswer<T>(result: CallResult, op: string, logger: Logger): Answer<T> {
  const answer = fromChild<unknown>(result, op, logger);
  if (!answer.ok) {
    return answer;
  }
  const value = answer.value as { refused?: Record<string, unknown> } | null;
  const given = value?.refused;
  if (given === undefined) {
    return answer as Answer<T>;
  }
  logger.info(`${op} was refused: ${String(given["sentence"])}`);
  const reason = String(given["reason"]);
  const key = REFUSAL_KEYS[reason];
  if (key === undefined) {
    return refused("failed", "refused.failed");
  }
  const params = given["params"] as Readonly<Record<string, string>> | undefined;
  const problems = given["problems"] as
    readonly { readonly path: string; readonly message: string }[] | undefined;
  return refused(reason as RefusalReason, key, {
    ...(params === undefined ? {} : { params }),
    ...(problems === undefined ? {} : { problems }),
  });
}

export interface FlowCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly runtime: Pick<Supervisor, "call">;
  readonly editor: EditorWindow & EditorPresence;
  readonly logger: Logger;
  /** "Export flow…"'s save dialog. */
  readonly dialog: Pick<Dialog, "showSaveDialog">;
}

export function wireFlowCalls({ ipc, runtime, editor, logger, dialog }: FlowCallsDeps): void {
  ipc.handle(IPC.flowCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async () => {
      if (op === "flow.export") {
        return flowAnswer(await exportFlow({ runtime, dialog, logger }, args), op, logger);
      }
      if (op === "anytype.spaces") {
        // Setup's "Found 8 spaces.": the same resolver a form's space choice uses.
        const spaces = await runtime.call("node.options", { source: "spaces" });
        return flowAnswer(spaces, op, logger);
      }
      const read = FLOW_READS.find((each) => each === op);
      if (read !== undefined) {
        return flowAnswer(await runtime.call(read, args), op, logger);
      }
      const write = FLOW_WRITES.find((each) => each === op);
      if (write === undefined) {
        return unknownOp(op, "flow", logger);
      }
      const told = { ...args, ...(await canvasState(editor)) };
      return flowAnswer(await runtime.call(write, told), op, logger);
    });
  });
}
