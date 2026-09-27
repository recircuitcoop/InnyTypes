// Node-RED's own examples-folder rejection, silenced rather than restored (plan 0018 §8.3
// WI-0018-23; arch_pivot §5 finding 9, §9 packaging item 8).
//
// @node-red/registry's addExamplesDir (node_modules/@node-red/registry/lib/library.js) is
// called fire-and-forget from registry.js, with no `.then`/`.catch` at its call site, for the
// examples folder under @node-red/nodes. In development that folder exists (readdir succeeds);
// in a packaged app electron-builder's own file pruning drops it. Measured against a real
// packaged build (WI-0018-23), the failure is Electron's own asar-aware `fs`, not plain
// Node ENOENT: it throws (not rejects) an Error whose message is
// `ENOENT, node_modules/@node-red/nodes/examples not found in <asar path>`, with no
// standard `.code`/`.path` fields to match on — so this is caught as an uncaughtException,
// and matched by its message text, which is stable across dev and every packaged target. The
// spike tried an explicit `files` include and it did not survive packaging either, so the plan
// accepts silencing this one, specific, known-benign failure as equally correct — nothing in
// Node-RED's own core is patched or forked to work around it.

/** The relative path @node-red/nodes' own examples folder is found (or not) at. */
const EXAMPLES_RELATIVE_PATH = "@node-red/nodes/examples";

/** Whether `reason` is exactly the missing-examples failure this file exists to recognise. */
export function isMissingExamplesFailure(reason: unknown): boolean {
  if (!(reason instanceof Error)) {
    return false;
  }
  return reason.message.includes("ENOENT") && reason.message.includes(EXAMPLES_RELATIVE_PATH);
}

/**
 * Installs the one process-wide listener, on both `uncaughtException` (a synchronous throw,
 * which is what a packaged app's asar-aware `fs` produces) and `unhandledRejection` (a plain
 * Node `fs.promises` ENOENT, which is what development's real filesystem produces), that
 * recognises it. Any other failure is logged and re-raised the way it would have crashed the
 * process with no listener installed at all: a real bug still crashes.
 */
export function guardMissingExamplesFailure(onSilenced: () => void): void {
  const handle = (reason: unknown, rethrow: () => void): void => {
    if (isMissingExamplesFailure(reason)) {
      onSilenced();
      return;
    }
    rethrow();
  };
  process.on("uncaughtException", (error) => {
    handle(error, () => {
      throw error;
    });
  });
  process.on("unhandledRejection", (reason) => {
    handle(reason, () => {
      // Re-raised on the next tick: this handler has already told Node the rejection was
      // handled, so throwing synchronously here would not reach the process the same way.
      process.nextTick(() => {
        throw reason instanceof Error ? reason : new Error(String(reason));
      });
    });
  });
}
