// The e2e gate's hooks on the shell (INNYTYPES_E2E_HOOKS=1), apart from main.ts so the
// composition root keeps only adapter construction (plan 0018 §2.3).

/**
 * The e2e gate's hooks, never set in an ordinary run: a planned restart the way a type change
 * will (WI-0018-18's independence test), the pop-outs open now (WI-0018-11), and editor.sync
 * switched off, as if Node-RED changed the convention (WI-0018-12).
 */
export function exposeE2eHooks(hooks: {
  readonly restart: (child: "runtime" | "services", reason: "types" | "restart") => boolean;
  readonly popouts: () => unknown;
  readonly editorEvents: (on: boolean) => void;
}): void {
  Object.assign(globalThis, { innytypesE2E: hooks });
}
