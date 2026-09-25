// The channel's typed errors (spec 10.3).
//
// The spike answered a call to a child that was not up with a sentence (arch_pivot P11 §6.3).
// The UI cannot branch on a sentence, so every failure the channel itself produces carries a
// `code` as well: `restarting`, `down`, `timeout` or `stopped`. A failure the child reports
// about its own operation is an `OpResult` without a code; the two never mix.

import type { ChildName, ChildState } from "../supervision/child-state";
import type { OpResult } from "./messages";

export type ChannelErrorCode = "restarting" | "down" | "timeout" | "stopped";

export interface ChannelError {
  readonly ok: false;
  readonly code: ChannelErrorCode;
  readonly error: string;
}

/** What a call to a child resolves to: the child's own answer, or a channel failure. */
export type CallResult = OpResult | ChannelError;

export function isChannelError(result: CallResult): result is ChannelError {
  return !result.ok && "code" in result;
}

const WORDING: Readonly<Record<ChannelErrorCode, (child: ChildName) => string>> = {
  restarting: (child) => `the InnyTypes ${child} is restarting; try again in a moment`,
  down: (child) => `the InnyTypes ${child} stopped unexpectedly and is not back yet`,
  timeout: (child) => `the InnyTypes ${child} did not answer in time`,
  stopped: (child) => `the InnyTypes ${child} stopped before it answered`,
};

export function channelError(code: ChannelErrorCode, child: ChildName): ChannelError {
  return { ok: false, code, error: WORDING[code](child) };
}

/**
 * The code a call answers with at once, without being sent, in a state that is not `running`;
 * null in `running`, when the call goes to the child.
 */
export function refusalFor(state: ChildState): ChannelErrorCode | null {
  switch (state) {
    case "running":
      return null;
    case "starting":
    case "restarting-planned":
    case "restarting":
      return "restarting";
    case "down":
    case "recovering":
    case "down-for-good":
      return "down";
    case "stopped":
      return "stopped";
  }
}
