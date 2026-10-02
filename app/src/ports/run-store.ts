// The runs read model's store (plan 0022 §C, decision D15): tables `runs`, `run_steps` and
// `run_lines` beside the journal, in `journal.sqlite` (adapters/sqlite/journal.ts). The journal's
// own writes keep it in step (ports/journal-store.ts RunChange); this port is everything else:
// a source starting a run, a step's progress, a run settling, the lists, "Clear done", and
// retention.
//
// Every value handed out is a domain Run (domain/runs/run.ts), folded by its rules: the store
// keeps the folded state, never a second set of rules.

import type { Run, RunKey, RunState } from "../domain/runs/run";
import type { StepStatus } from "../domain/runs/step-report";

/** A source emitted a new run (spec 5.4.2): its run id is the event's id. `at` is epoch ms. */
export interface RunStart extends RunKey {
  readonly title: string;
  readonly durationSeconds?: number;
  readonly at: number;
}

/** `run.list`: newest first, keyset-paginated on `(startedAt, runId)`. */
export interface RunQuery {
  readonly flowId: string;
  readonly state?: RunState;
  /** Only runs started at or after this (epoch ms). */
  readonly since?: number;
  /** Words in the title, a step's name, a note, a warning, a result or the failure. */
  readonly search?: string;
  /** The `next` of the page before. */
  readonly cursor?: string;
  readonly limit: number;
}

/** One `status` with `in`, as the service hands it on, coalesced. `at` is epoch ms. */
export interface StepStatusUpdate {
  readonly inputId: string;
  readonly status: StepStatus;
  readonly at: number;
}

export interface RunPage {
  readonly runs: readonly Run[];
  /** The cursor of the next page; null when this page is the last. */
  readonly next: string | null;
}

export interface RunStore {
  /** A source started a run. A run that already exists is left as it is. */
  started(start: RunStart): void;
  /**
   * `status` frames with `in`, in the order they came, in ONE transaction: each its step's words,
   * progress, time left or copy phase.
   */
  stepStatuses(updates: readonly StepStatusUpdate[]): void;
  /**
   * The run has nothing left in hand: a running run with no step open becomes done. False when
   * the run is not running, or still has an open step.
   */
  settle(runId: string, at: number): boolean;
  /** Every running run with no step open: what a crash between two steps left behind. */
  idle(): RunKey[];
  list(query: RunQuery): RunPage;
  /** One run; named `run`, as `get` is the journal's entry by input id. */
  run(runId: string): Run | null;
  /** "Clear done": every done, not yet cleared run of the flow is cleared. Returns how many. */
  clearDone(flowId: string, at: number): number;
  /** The undo: the flow's runs cleared at or after `since` are shown again. Returns how many. */
  undoClear(flowId: string, since: number): number;
  /** Delete every finished run that ended before `before`, with its steps and lines. */
  prune(before: number): number;
  /**
   * The flow was deleted (plan 0022 §D): every run of it goes, in progress or not, with its steps
   * and lines. Returns how many.
   */
  deleteFlowRuns(flowId: string): number;
  /** Told after each commit that changed a run, once per run per write. */
  onChange(listener: (key: RunKey) => void): void;
  /**
   * Told after EVERY committed journal write, with the entry's flow ("" for one journaled before
   * 0.3.0), whether or not a run changed: the Jobs page follows the inputs in hand by it.
   */
  onJournalWrite(listener: (flowId: string) => void): void;
}
