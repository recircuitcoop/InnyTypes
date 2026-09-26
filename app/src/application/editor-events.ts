// The runtime's half of the editor sync (arch_pivot P11b, WI-0018-12).
//
// After a runtime restart the editor keeps its page and its undeployed edits; only its
// websocket reconnects. It does not know the node types added or removed meanwhile. The app
// page compares the editor's node sets with the runtime's (`editor.nodes`) and asks for what
// differs (`editor.sync`); the runtime raises Node-RED's own `node/added` and `node/removed`,
// and the editor handles them as it does after a palette install.

import type { OpResult } from "../domain/channel/messages";
import type { Logger } from "../ports/logger";
import type { NodeRedEditorEvents, NodeSetSummary } from "../ports/node-red-engine";

/** What the page asks the runtime to raise: set ids to add, sets to remove. */
export interface PaletteChange {
  readonly added: readonly string[];
  readonly removed: readonly NodeSetSummary[];
}

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isNodeSetSummary(value: unknown): value is NodeSetSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { id, types } = value as Record<string, unknown>;
  return typeof id === "string" && id !== "" && isStringList(types);
}

/** The change `editor.sync` carries, or null when it is not one. */
export function parsePaletteChange(args: unknown): PaletteChange | null {
  if (typeof args !== "object" || args === null) {
    return null;
  }
  const { added, removed } = args as Record<string, unknown>;
  if (!isStringList(added) || !Array.isArray(removed) || !removed.every(isNodeSetSummary)) {
    return null;
  }
  return { added, removed };
}

/** Answer `editor.nodes` and `editor.sync`. */
export async function answerEditorCall(
  op: "editor.nodes" | "editor.sync",
  args: unknown,
  engine: NodeRedEditorEvents,
  logger: Logger,
): Promise<OpResult> {
  if (op === "editor.nodes") {
    // Every set, as the editor's own `/nodes` load holds them: one with no types too (the form
    // code's set is one), or the editor's copy of it would count as one the runtime lacks.
    const sets = (await engine.nodeSets()).map((set) => ({ id: set.id, types: [...set.types] }));
    return { ok: true, value: sets };
  }
  const change = parsePaletteChange(args);
  if (change === null) {
    return { ok: false, error: "editor.sync needs {added: string[], removed: {id, types}[]}" };
  }
  // Removed first: a set whose types changed is removed and added again, in that order.
  engine.raiseNodeRemoved(change.removed);
  const added = await engine.raiseNodeAdded(change.added);
  const removed = change.removed.map((set) => set.id);
  logger.info(
    `editor sync: node/added for [${added.join(", ")}], node/removed for [${removed.join(", ")}]`,
  );
  return { ok: true, value: { added, removed } };
}
