// When a crashed child comes back (plan 0018 §3, `helper/restart.py`; spec 10.6).
//
// The old policy was a delay list whose last entry repeated. The spike measured the rule the
// new app keeps: 250 ms × n after the n-th crash in a row, capped at 5 s (arch_pivot P11 §6.6).
// A delay is a number the supervisor schedules on its clock, never a sleep.

/** The backoff rule's two numbers; settings, so neither lives as a literal in the supervisor. */
export interface BackoffSettings {
  /** The step: the n-th consecutive crash waits n steps. */
  readonly stepMs: number;
  /** The most any restart waits. */
  readonly capMs: number;
}

export const DEFAULT_BACKOFF: BackoffSettings = { stepMs: 250, capMs: 5_000 };

/**
 * The wait before restarting after the n-th crash in a row (n starts at 1).
 *
 * "In a row" is the supervisor's count of crashes since the child was last `ready`; a child
 * that came up and ran resets it.
 */
export function crashRestartDelay(
  consecutiveCrashes: number,
  settings: BackoffSettings = DEFAULT_BACKOFF,
): number {
  if (!Number.isInteger(consecutiveCrashes) || consecutiveCrashes < 1) {
    throw new RangeError(`a crash count starts at 1, not ${String(consecutiveCrashes)}`);
  }
  return Math.min(settings.capMs, settings.stepMs * consecutiveCrashes);
}
