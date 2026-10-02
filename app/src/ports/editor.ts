// The Node-RED editor open in the app window, as the shell reaches it (WI-0018-12): what its
// palette holds, whether it holds undeployed edits, and its own Deploy; and the nodes on its
// canvas, which a created event type's deletion is judged against (WI-0018-13).

import type { NodeSetSummary } from "./node-red-engine";

export interface EditorPalette {
  /** The node sets the editor's palette holds now: its registry's node list. */
  readonly sets: readonly NodeSetSummary[];
  /** The editor holds edits not yet deployed (`RED.nodes.dirty()`). */
  readonly dirty: boolean;
}

/** A node on the editor's canvas, deployed or not: its id and its type (WI-0018-13). */
export interface EditorNode {
  readonly id: string;
  readonly type: string;
}

/** Every node the editor holds now, undeployed edits included; null with no editor loaded. */
export interface EditorNodes {
  nodes(): Promise<readonly EditorNode[] | null>;
}

/**
 * Whether an editor frame is there at all (WI-0022-08): a frame that is there but cannot be read
 * (loading, navigating, slow to answer) may hold unsaved changes, so a flow write is refused.
 */
export interface EditorPresence {
  loaded(): boolean;
}

export interface EditorWindow {
  /** The palette now; null when no editor is loaded (no window, or the editor still loading). */
  palette(): Promise<EditorPalette | null>;
  /** Deploy as the editor's Deploy button does. Null once deployed; otherwise why not. */
  deploy(): Promise<string | null>;
}
