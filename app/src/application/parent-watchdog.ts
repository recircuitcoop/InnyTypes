// The ppid watchdog (spec 6.6): a child exits when the shell that started it is gone.
//
// On macOS Electron's utilityProcess semantics end the child with the shell on their own, and
// in the spike this watchdog never fired (arch_pivot P11e). It stays for a platform where the
// semantics differ: when the parent dies the child is re-parented, so its ppid changes.

import type { Cancel, Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { ProcessHost } from "../ports/shell-link";

export const WATCHDOG_INTERVAL_MS = 1_000;

/** Check the parent pid every `intervalMs`, and exit when it changes. Returns a stop. */
export function watchParent(
  host: ProcessHost,
  clock: Clock,
  logger: Logger,
  intervalMs: number = WATCHDOG_INTERVAL_MS,
): Cancel {
  const parent = host.parentPid();
  let cancel: Cancel = () => undefined;
  let stopped = false;

  const check = (): void => {
    if (stopped) {
      return;
    }
    const now = host.parentPid();
    if (now !== parent) {
      logger.warn(`parent ${String(parent)} is gone (ppid now ${String(now)}); exiting`);
      host.exit(0);
      return;
    }
    cancel = clock.after(intervalMs, check);
  };
  cancel = clock.after(intervalMs, check);

  return () => {
    stopped = true;
    cancel();
  };
}
