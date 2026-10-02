// "Export flow…" (plan 0022 §D, ux-writing "Configuration › Flows"): the runtime answers the
// tab's export with no credentials in it; the shell asks where to save it, with its own save
// dialog, and writes it there. The page never sees a path it did not choose.

import * as fs from "node:fs/promises";
import type { Dialog } from "electron";
import type { CallResult } from "../domain/channel/errors";
import type { Supervisor } from "../application/supervisor";
import type { Logger } from "../ports/logger";

export interface FlowExportDeps {
  readonly runtime: Pick<Supervisor, "call">;
  readonly dialog: Pick<Dialog, "showSaveDialog">;
  readonly logger: Logger;
}

/** A file name from a flow's name: no separators, no characters a file system refuses. */
export function exportFileName(name: string): string {
  const safe = Array.from(name, (character) =>
    character < " " || '\\/:*?"<>|'.includes(character) ? " " : character,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return `${safe === "" ? "flow" : safe}.json`;
}

/**
 * The flow's export, saved where the person chooses: `{saved: path}`, or `{saved: null}` when
 * they cancelled. A refusal or a failed call from the runtime is answered as it came.
 */
export async function exportFlow(deps: FlowExportDeps, args: unknown): Promise<CallResult> {
  const answer = await deps.runtime.call("flow.export", args);
  if (!answer.ok) {
    return answer;
  }
  const value = answer.value as { refused?: unknown; name?: unknown; nodes?: unknown };
  if (value.refused !== undefined || !Array.isArray(value.nodes)) {
    return answer;
  }
  const name = typeof value.name === "string" ? value.name : "flow";
  const chosen = await deps.dialog.showSaveDialog({
    title: "Export flow",
    defaultPath: exportFileName(name),
    filters: [{ name: "Node-RED flow", extensions: ["json"] }],
  });
  if (chosen.canceled || chosen.filePath === "") {
    return { ok: true, value: { saved: null } };
  }
  await fs.writeFile(chosen.filePath, `${JSON.stringify(value.nodes, null, 2)}\n`, "utf8");
  deps.logger.info(`a flow was exported (${String(value.nodes.length)} nodes)`);
  return { ok: true, value: { saved: chosen.filePath } };
}
