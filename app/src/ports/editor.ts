// The Node-RED editor open in the app window, as the shell reaches it (WI-0018-12): what its
// palette holds, whether it holds undeployed edits, and its own Deploy.

import type { NodeSetSummary } from "./node-red-engine";

export interface EditorPalette {
  /** The node sets the editor's palette holds now: its registry's node list. */
  readonly sets: readonly NodeSetSummary[];
  /** The editor holds edits not yet deployed (`RED.nodes.dirty()`). */
  readonly dirty: boolean;
}

export interface EditorWindow {
  /** The palette now; null when no editor is loaded (no window, or the editor still loading). */
  palette(): Promise<EditorPalette | null>;
  /** Deploy as the editor's Deploy button does. Null once deployed; otherwise why not. */
  deploy(): Promise<string | null>;
}
