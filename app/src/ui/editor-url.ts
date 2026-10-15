// Where Node-RED's editor is: the runtime's port, the same for the whole session (plan 0018 §2.2).
// The canvas frame (plan 0022 §M) points its frame here.
import type { ChildStatus } from "./contract";

/** Node-RED's editor on the runtime's port, or null while the runtime has no port. */
export function editorUrl(runtime: ChildStatus | undefined): string | null {
  return runtime?.port == null ? null : `http://127.0.0.1:${String(runtime.port)}/red/`;
}

/** The editor opened on one flow's tab: Node-RED's own `#flow/<id>` address. */
export function flowEditorUrl(runtime: ChildStatus | undefined, flowId: string): string | null {
  const url = editorUrl(runtime);
  return url === null ? null : `${url}#flow/${encodeURIComponent(flowId)}`;
}
