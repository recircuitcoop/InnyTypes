// A flow's health and its last run, as Configuration › Flows shows them on the flow's row
// (plan 0022 §A, ux-writing "Configuration › Flows"). Values only: ui/strings.ts (WI-0022-10)
// words them ("Ready", "1 step not set up", "Failing since Monday", "Last run: today, 14:20 ·
// done"); app/test/unit/domain/wording.fixture.test.ts lists those sentences.
//
// The rules, in the order they are checked:
// 1. A step that is not set up (its config fails `required`, or a credential is missing) makes
//    the flow "not set up", whatever its runs did: it cannot run as drawn, and that is the thing
//    to fix first.
// 2. Else a flow with no source is "no source": nothing could ever start a run, so it is never
//    Ready, and Setup never switches it on (WI-0022-17: the starter's watch step is a note on
//    the canvas until a shipped package provides a folder source).
// 3. Else, when the latest FINISHED run failed, the flow is "failing since" the day the trailing
//    streak of failures began: the earliest of the latest consecutive failed runs. Runs still in
//    progress say nothing yet, so they neither start nor break a streak.
// 4. Else the flow is ready.

import type { Run, RunState } from "../runs/run";
import { relativeDay, type RelativeDay } from "./days";

/** The flow as health needs it: which runs are its own, and whether anything can start one. */
export interface FlowRef {
  readonly id: string;
  /** Whether the flow holds at least one source node. */
  readonly hasSource: boolean;
}

/** Whether one step of the flow is set up, as `flow.list` reports it. */
export interface StepSetup {
  readonly instanceId: string;
  readonly setUp: boolean;
}

export type FlowHealth =
  | { readonly kind: "ready" }
  | { readonly kind: "steps-not-set-up"; readonly count: number }
  | { readonly kind: "no-source" }
  | { readonly kind: "failing-since"; readonly since: Date };

/** The flow's runs, oldest first by start. */
function runsOf(flow: Pick<FlowRef, "id">, runs: readonly Run[]): Run[] {
  return runs
    .filter((run) => run.flowId === flow.id)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

export function health(
  flow: FlowRef,
  runs: readonly Run[],
  nodesSetup: readonly StepSetup[],
): FlowHealth {
  const notSetUp = nodesSetup.filter((step) => !step.setUp).length;
  if (notSetUp > 0) {
    return { kind: "steps-not-set-up", count: notSetUp };
  }
  if (!flow.hasSource) {
    return { kind: "no-source" };
  }
  const finished = runsOf(flow, runs).filter(
    (run) => run.state === "failed" || run.state === "done",
  );
  // Walk back from the latest finished run while runs keep failing.
  let since: Date | null = null;
  for (let index = finished.length - 1; index >= 0; index -= 1) {
    const run = finished[index];
    if (run === undefined || run.state !== "failed") {
      break;
    }
    since = run.startedAt;
  }
  return since === null ? { kind: "ready" } : { kind: "failing-since", since };
}

/** The health pill's value: the failing day as a relative day, for the view to word. */
export type HealthPhrase =
  | { readonly kind: "ready" }
  | { readonly kind: "steps-not-set-up"; readonly count: number }
  | { readonly kind: "no-source" }
  | { readonly kind: "failing-since"; readonly day: RelativeDay };

export function healthPhrase(value: FlowHealth, now: Date): HealthPhrase {
  switch (value.kind) {
    case "ready":
    case "steps-not-set-up":
    case "no-source":
      return value;
    case "failing-since":
      return { kind: "failing-since", day: relativeDay(value.since, now) };
  }
}

/** The flow's latest run by start, or null when it never ran. */
export function lastRun(flow: Pick<FlowRef, "id">, runs: readonly Run[]): Run | null {
  return runsOf(flow, runs).at(-1) ?? null;
}

/** "Last run: today, 14:20 · done", as values: the start's day, its time, and the state. */
export interface LastRunLine {
  readonly day: RelativeDay;
  readonly startedAt: Date;
  readonly state: RunState;
}

export function lastRunLine(run: Run, now: Date): LastRunLine {
  return { day: relativeDay(run.startedAt, now), startedAt: run.startedAt, state: run.state };
}
