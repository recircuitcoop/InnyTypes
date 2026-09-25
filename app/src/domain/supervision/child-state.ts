// The supervised children and what the shell says about each (spec 10.8, plan 0018 §2.2).

import { DEFAULT_BACKOFF, type BackoffSettings } from "./backoff";
import { DEFAULT_CRASH_LOOP, type CrashLoopSettings } from "./breaker";

/** The two utilityProcess children the shell supervises. */
export type ChildName = "runtime" | "services";

export const CHILD_NAMES: readonly ChildName[] = ["runtime", "services"];

export function isChildName(value: unknown): value is ChildName {
  return value === "runtime" || value === "services";
}

/**
 * `childState`, pushed by the shell to the app page (spec 10.8).
 *
 * `down-for-good` is the crash-loop limit's state (plan 0018 §7): the shell has stopped
 * restarting the child and shows an error with a Restart button.
 */
export type ChildState =
  | "starting" // the first fork, or a fork a person asked for after down-for-good
  | "running" // the child sent `ready`
  | "restarting-planned" // the shell has sent `stop` for a restart
  | "restarting" // forking the next generation after a planned stop
  | "recovering" // forking after a crash
  | "down" // crashed, waiting for the backoff
  | "down-for-good" // crashed too often: no more restarts until a person asks
  | "stopped"; // quit

/** One child's state, as the app page sees it. */
export interface ChildStatus {
  readonly child: ChildName;
  readonly state: ChildState;
  /** Which fork this is; every fork, planned or not, is the next generation. */
  readonly generation: number;
  /** The pid the child reported in `ready`; null until then. */
  readonly pid: number | null;
  /** The loopback port the child reported it was given; null for a child without one. */
  readonly port: number | null;
  /** What a person is told when the state is down-for-good; null otherwise. */
  readonly error: string | null;
}

/** Every number the supervisor works by, so a test or a settings file can set them. */
export interface SupervisionSettings {
  readonly backoff: BackoffSettings;
  readonly crashLoop: CrashLoopSettings;
  /** Every call to a child times out after this (spec 10.3). */
  readonly callTimeoutMs: number;
  /** A child still alive this long after `stop` is killed (spec 10.7). */
  readonly stopDeadlineMs: number;
}

export const DEFAULT_SUPERVISION: SupervisionSettings = {
  backoff: DEFAULT_BACKOFF,
  crashLoop: DEFAULT_CRASH_LOOP,
  callTimeoutMs: 5_000,
  stopDeadlineMs: 10_000,
};

/** The words for a child that crashed too often, for the page and for the notice. */
export function crashLoopMessage(child: ChildName, settings: CrashLoopSettings): string {
  const minutes = settings.windowMs / 60_000;
  const window = Number.isInteger(minutes)
    ? `${String(minutes)} minute${minutes === 1 ? "" : "s"}`
    : `${String(settings.windowMs / 1000)} seconds`;
  return (
    `The InnyTypes ${child} stopped unexpectedly ${String(settings.maxCrashes)} times in ` +
    `${window}, so it is no longer restarted. Press Restart to try again.`
  );
}
