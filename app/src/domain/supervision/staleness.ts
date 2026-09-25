// Whether a child that is alive has stopped working (plan 0018 §3, the detection.py and
// heartbeat.py rows): the MCP child keeps the staleness judgement of plan 0010.
//
// The owner's ruling was "mcp can promise a heartbeat -> make it so". The MCP child declares a
// stability profile with a heartbeat interval; the services process pings it over MCP at that
// interval and records a beat only for an answered ping. This file is the judgement over those
// beats, and it is kept from detection.py:364-395 and _stale_after (488-502) exactly:
//
// * A process that never promised heartbeats is never judged stale. Its silence is not a
//   broken promise. This is the rule the whole judgement can get wrong.
// * The window is the profile's own `staleAfterMs` when it names one, else three intervals.
// * The judgement is made on the judge's own clock, from the marker CHANGING, never from the
//   value it holds: a beat that never came and a marker that did not move are the same thing.
// * The first sight of a process starts its window, so a child that has just come up gets its
//   whole window before anything is said about it.
// * A slow pass defers and never fabricates a verdict (helper/config.py:507-514). A pass that
//   runs long after it was due (the machine slept, the event loop was held) cannot tell a child
//   that went quiet from a child that was never asked, so it starts the window again instead of
//   reading the gap as silence.

/** What a child declares about how it is watched (the MCP child's part of manifest.py). */
export interface StabilityProfile {
  /** How often the child promises to answer; null for a child that promised nothing. */
  readonly heartbeatIntervalMs: number | null;
  /** How long it may go without a beat; null means STALE_INTERVALS × the interval. */
  readonly staleAfterMs: number | null;
}

/** Missed beats that make a child stale when its profile names no window (plan 0003 D4). */
export const STALE_INTERVALS = 3;

/**
 * The MCP child's interval (anytype_mcp/supervisor.py:61): long enough to outlast the pass
 * that reads it, short enough that silence means something within about two minutes, and
 * cheap: two round trips a minute on the pipes a tools/call already uses.
 */
export const MCP_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The MCP child's declared profile (supervisor.py:105-111). `staleAfterMs` is left unnamed on
 * purpose, so the three-interval rule decides it: 90 s. The resource limits the old profile
 * also declared are not carried: the plan keeps only the staleness judgement for this child.
 */
export const MCP_STABILITY: StabilityProfile = {
  heartbeatIntervalMs: MCP_HEARTBEAT_INTERVAL_MS,
  staleAfterMs: null,
};

/** The window a child may go without progress, or null when it is never judged stale. */
export function staleWindow(profile: StabilityProfile | null): number | null {
  if (profile === null) {
    return null;
  }
  if (profile.staleAfterMs !== null) {
    return profile.staleAfterMs;
  }
  if (profile.heartbeatIntervalMs !== null) {
    return STALE_INTERVALS * profile.heartbeatIntervalMs;
  }
  return null;
}

/**
 * One pass's verdict:
 * * `never` — the child promised no heartbeat, so it is not judged at all;
 * * `fresh` — within its window, or its marker moved;
 * * `deferred` — this pass could not judge (first sight, or a slow pass), so the window started;
 * * `stale` — alive, silent past its window, and every pass that saw it ran on time.
 */
export type StaleVerdict = "never" | "fresh" | "deferred" | "stale";

export class StalenessJudge {
  readonly #window: number | null;
  /** The marker the previous pass saw, and when it last changed; null before the first pass. */
  #seen: { readonly marker: number | null; readonly changedAt: number } | null = null;

  constructor(profile: StabilityProfile | null) {
    this.#window = staleWindow(profile);
  }

  /**
   * Judge one pass. `marker` is the latest answered beat's time (null when none was ever
   * answered); `now` is the judge's clock; `onTime` is false for a pass that ran long after
   * it was due.
   */
  observe(marker: number | null, now: number, onTime: boolean): StaleVerdict {
    if (this.#window === null) {
      return "never";
    }
    const seen = this.#seen;
    if (seen === null || !onTime) {
      this.#seen = { marker, changedAt: now };
      return "deferred";
    }
    if (marker !== null && marker !== seen.marker) {
      this.#seen = { marker, changedAt: now };
      return "fresh";
    }
    return now - seen.changedAt > this.#window ? "stale" : "fresh";
  }

  /** A new child: nothing seen of the old one carries over, not even its window. */
  reset(): void {
    this.#seen = null;
  }
}
