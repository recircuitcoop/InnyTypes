// The MCP child's heartbeat (plan 0018 §3, the heartbeat.py row; host.py:250-354 ported).
//
// The owner's plan 0010 ruling: "mcp can promise a heartbeat -> make it so". The child is
// pinged over MCP at its declared interval, and a beat is recorded ONLY for a ping it answered
// (host.py:331). A refusal, a timeout, a closed session: every way a ping can fail means the
// same thing, no evidence the child is working, so nothing is recorded.
//
// After each ping settles, one pass is judged (domain/supervision/staleness.ts). A child that
// stays silent past its window is stale, and `onStale` is told once; the service restarts it
// with a notice. The rules that keep the verdict honest:
// * The schedule moves whether or not the child answered: a failed ping is not a reason to ask
//   again at once. The child has its whole window.
// * A ping is bounded by the session's request timeout and by the interval: an answer that has
//   not come before the next ping is due is a missed beat.
// * A pass that runs long after it was due is slow (the machine slept, the event loop was
//   held): it defers and starts the window again, and never reads the gap as silence.
// * A pass that finds the previous ping still waiting defers too: no ping, no verdict.

import {
  staleWindow,
  StalenessJudge,
  type StabilityProfile,
} from "../domain/supervision/staleness";
import type { McpSession } from "../ports/anytype";
import type { Cancel, Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";

export interface McpHeartbeatDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** The child's declared profile; its interval is the ping cadence. */
  readonly profile: StabilityProfile;
  /** Told once when the child is judged stale, with how long it has been silent. */
  readonly onStale: (silentForMs: number) => void;
}

export class McpHeartbeat {
  readonly #deps: McpHeartbeatDeps;
  readonly #interval: number;
  #judge: StalenessJudge;
  #session: McpSession | null = null;
  #cancel: Cancel | null = null;
  #waiting = false;
  #beats = 0;
  #lastBeatAt: number | null = null;
  #silentSince = 0;

  constructor(deps: McpHeartbeatDeps) {
    this.#deps = deps;
    if (deps.profile.heartbeatIntervalMs === null) {
      throw new RangeError("the MCP child's profile must declare a heartbeat interval");
    }
    this.#interval = deps.profile.heartbeatIntervalMs;
    this.#judge = new StalenessJudge(deps.profile);
  }

  /** Beats recorded for the current child: only answered pings. */
  get beats(): number {
    return this.#beats;
  }

  /** When the current child last answered a ping, on the clock; null before it ever did. */
  get lastBeatAt(): number | null {
    return this.#lastBeatAt;
  }

  /** Watch a newly validated child: its window starts now, and the first ping goes at once. */
  start(session: McpSession): void {
    this.stop();
    this.#session = session;
    this.#judge = new StalenessJudge(this.#deps.profile);
    this.#beats = 0;
    this.#lastBeatAt = null;
    const now = this.#deps.clock.now();
    this.#silentSince = now;
    this.#judge.observe(null, now, true);
    this.#schedule(0);
  }

  /** Stop pinging. A ping still waiting settles into nothing. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#session = null;
    this.#waiting = false;
  }

  #schedule(delay: number): void {
    const dueAt = this.#deps.clock.now() + delay;
    this.#cancel = this.#deps.clock.after(delay, () => {
      this.#pass(dueAt);
    });
  }

  #pass(dueAt: number): void {
    const session = this.#session;
    if (session === null) {
      return;
    }
    if (this.#waiting) {
      this.#deps.logger.warn(
        "the previous ping to the Anytype MCP child is still waiting; deferred",
      );
      this.#schedule(this.#interval);
      return;
    }
    this.#waiting = true;
    // Sent before the next pass is scheduled, so a ping that times out at the interval is
    // settled, and judged, before the next pass looks at it.
    const ping = session.ping(this.#interval);
    this.#schedule(this.#interval);
    ping
      .then(
        () => {
          if (session === this.#session) {
            this.#beats += 1;
            this.#lastBeatAt = this.#deps.clock.now();
            this.#silentSince = this.#lastBeatAt;
          }
        },
        (error: unknown) => {
          if (session === this.#session) {
            this.#deps.logger.warn(
              `the Anytype MCP child did not answer a ping, so no beat: ${String(error)}`,
            );
          }
        },
      )
      .finally(() => {
        if (session !== this.#session) {
          return; // stopped, or a new child, while this ping was out
        }
        this.#waiting = false;
        this.#judgeNow(dueAt);
      });
  }

  #judgeNow(dueAt: number): void {
    const now = this.#deps.clock.now();
    // A ping settles within one interval of being sent (its own bound), and it is sent when
    // its pass is due. Anything later than that means the clock jumped: a slow pass.
    const onTime = now - dueAt <= 2 * this.#interval;
    const verdict = this.#judge.observe(this.#lastBeatAt, now, onTime);
    if (verdict === "deferred" && !onTime) {
      this.#deps.logger.warn(
        "the heartbeat pass ran late (the machine may have slept); the Anytype MCP child's " +
          "window starts again rather than reading the gap as silence",
      );
      return;
    }
    if (verdict !== "stale") {
      return;
    }
    const silentFor = now - this.#silentSince;
    this.stop();
    this.#deps.logger.warn(
      `the Anytype MCP child answered no ping for ${String(Math.round(silentFor))} ms ` +
        `(its window is ${String(staleWindow(this.#deps.profile))} ms): judged stale`,
    );
    this.#deps.onStale(silentFor);
  }
}
