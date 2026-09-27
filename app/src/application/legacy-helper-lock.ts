// Whether the old helper is still running, by its lock (WI-0018-25 §4.1: "if the old helper is
// still running, the new app asks the person to quit it before serving the endpoint").

import type { ProcessLiveness } from "../ports/process-liveness";

export interface LegacyHelperLockDeps {
  /** The pid the old lock file names, or null when there is none to read. */
  readonly readLockPid: () => number | null;
  readonly liveness: ProcessLiveness;
}

export function legacyHelperIsRunning(deps: LegacyHelperLockDeps): boolean {
  const pid = deps.readLockPid();
  return pid !== null && deps.liveness.isAlive(pid);
}
