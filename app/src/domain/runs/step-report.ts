// What a step tells about its own run, as protocol 2.1 carries it (spec 4.2.1, 4.2.2; plan
// 0022 §B), and the run events it becomes.
//
// The runtime's process adapter reads `done.notes`, `done.results` and a `status` with `in`
// from a node and hands them to that input's delivery as a StepOutcome or a StepStatus. Whoever
// records runs (the read model) knows the flow and the run the input belongs to, and turns them
// into the RunEvents `fold` takes with the two functions below. Nothing here is worded for a
// person: the card composes its words from these values.
//
// Pure: no I/O, no clock.

import type { DoneNote, DoneResult, RunEvent, RunKey, StepProgress } from "./run";

/** A step's `done` carried notes or results (decisions D3, D16). */
export interface StepOutcome {
  readonly notes: readonly DoneNote[];
  readonly results: readonly DoneResult[];
}

/** A copy phase a source reports while it copies a recording (`status.phase`). */
export type CopyPhase = "copying" | "copied";

/** A `status` with `in`: what that input's step line shows. */
export interface StepStatus {
  /** The node's own words ("in Renaissance…"). */
  readonly text: string;
  readonly progress?: StepProgress;
  /** The time left, in seconds, as the node estimated it. */
  readonly etaSeconds?: number;
  readonly phase?: CopyPhase;
}

/** The event a finished step makes: its notes and results, when it sent any. */
export function stepDoneEvent(
  key: RunKey,
  instanceId: string,
  at: Date,
  outcome?: StepOutcome,
): RunEvent {
  const event: RunEvent = { ...keyOf(key), at, kind: "stepDone", instanceId };
  if (outcome === undefined) {
    return event;
  }
  return { ...event, notes: outcome.notes, results: outcome.results };
}

/**
 * The event a `status` with `in` makes. A copy phase is the run's, not the step's: `copying`
 * (with the node's words) and `copied` move the run; anything else is the step's line.
 */
export function stepStatusEvent(
  key: RunKey,
  instanceId: string,
  at: Date,
  status: StepStatus,
): RunEvent {
  const base = { ...keyOf(key), at };
  if (status.phase === "copying") {
    return { ...base, kind: "copying", text: status.text };
  }
  if (status.phase === "copied") {
    return { ...base, kind: "copied" };
  }
  const event: { -readonly [K in keyof StatusEvent]: StatusEvent[K] } = {
    ...base,
    kind: "status",
    instanceId,
    text: status.text,
  };
  if (status.progress !== undefined) {
    event.progress = status.progress;
  }
  if (status.etaSeconds !== undefined) {
    event.etaSeconds = status.etaSeconds;
  }
  return event;
}

type StatusEvent = Extract<RunEvent, { kind: "status" }>;

/** Only the key's two fields: a Run passed as the key must not leak its other fields. */
function keyOf(key: RunKey): RunKey {
  return { flowId: key.flowId, runId: key.runId };
}
