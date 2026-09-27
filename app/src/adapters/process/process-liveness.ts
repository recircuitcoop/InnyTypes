// Whether a pid is alive, by signalling it with signal 0 (no signal is actually delivered):
// ESRCH means nothing has that pid; any other outcome (including EPERM, a pid another account
// owns) means something does (WI-0018-25's helper.lock check).

import type { ProcessLiveness } from "../../ports/process-liveness";

export function signalProcessLiveness(
  signal: (pid: number, code: 0) => void = (pid, code) => {
    process.kill(pid, code);
  },
): ProcessLiveness {
  return {
    isAlive: (pid: number): boolean => {
      try {
        signal(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    },
  };
}
