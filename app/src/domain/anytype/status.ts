// What the Anytype core service says about itself (plan 0018 §4.1): the `Status` model the
// old host's degradations become, shown on the Settings page (WI-0018-11) through AppApi.

/**
 * * `no-key` — no key in the canonical file or the legacy one: pair with Anytype.
 * * `unreachable` — Anytype's local API did not answer; checked again on a timer.
 * * `starting` — the MCP child is spawned and its handshake is running.
 * * `ready` — the handshake passed and tools/list matched the committed surface.
 * * `tool-surface-mismatch` — the child lists other tools than the committed surface: named,
 *   and not restarted, because a restart would list the same tools.
 * * `down` — the child exited or was judged stale, and is restarted after the backoff.
 * * `down-for-good` — too many exits in the window: no more restarts until the next start.
 * * `stopped` — the services process is quitting.
 */
export type AnytypeState =
  | "no-key"
  | "unreachable"
  | "starting"
  | "ready"
  | "tool-surface-mismatch"
  | "down"
  | "down-for-good"
  | "stopped";

export interface AnytypeStatus {
  readonly state: AnytypeState;
  /** What a person is told about the state, in words; null when there is nothing to add. */
  readonly detail: string | null;
  /** The MCP child's pid while one is running. */
  readonly childPid: number | null;
  /** Beats recorded for the current child: pings it answered. */
  readonly beats: number;
  /** A pairing was started and waits for its four-digit code. */
  readonly pairing: boolean;
}
