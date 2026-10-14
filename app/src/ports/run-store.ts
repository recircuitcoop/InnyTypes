// The runs read model's store (plan 0022 §C, decision D15): tables `runs`, `run_steps` and
// `run_lines` beside the journal, in `journal.sqlite` (adapters/sqlite/journal.ts). The journal's
// own writes keep it in step (ports/journal-store.ts RunChange); this port is everything else:
// a source starting a run, a step's progress, a run settling, the lists, "Clear done", and
// retention.
//
// Every value handed out is a domain Run (domain/runs/run.ts), folded by its rules: the store
// keeps the folded state, never a second set of rules.

import type { JournaledMessage } from "../domain/journal/entry";
import type { ResultLine, Run, RunKey, RunState, StepLine } from "../domain/runs/run";
import type { StepStatus } from "../domain/runs/step-report";

/** A source emitted a new run (spec 5.4.2): its run id is the event's id. `at` is epoch ms. */
export interface RunStart extends RunKey {
  readonly title: string;
  readonly durationSeconds?: number;
  readonly at: number;
  /** A re-run (plan 0022 §E): the run it re-runs, and the step it starts from. */
  readonly rerunOf?: string;
  readonly rerunFrom?: string;
  /** When the run it re-runs started (epoch ms): the re-run's caption. */
  readonly rerunOfStartedAt?: number;
  /** A re-run from a step: the earlier steps' results, kept; and the re-run's own notes. */
  readonly results?: readonly ResultLine[];
  readonly notes?: readonly StepLine[];
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
   * 0.3.0), whether or not a run changed: a run card follows the inputs in hand by it.
   */
  onJournalWrite(listener: (flowId: string) => void): void;
}

/** What re-running and deleting runs needs of the store beyond RunStore (plan 0022 §E). */
export interface RunInputs {
  /**
   * Each step's input message as kept for re-runs, by step position: null where it was larger
   * than the bound, or the step was kept from an earlier run.
   */
  keptInputs(runId: string): readonly (JournaledMessage | null)[];
  /**
   * Delete these runs of the flow, in progress or not, with their steps, lines and the journal
   * entries still of them, and keep them as deleted at `at` (epoch ms): a step of one that comes
   * later, a restart included, never records it again. How many.
   */
  deleteRuns(flowId: string, runIds: readonly string[], at: number): number;
  /**
   * Keep these runs as deleted at `at`, before anything of them is cancelled or deleted: from
   * now on no input of them is admitted (JournalStore `runDeleted`).
   */
  markDeleted(runIds: readonly string[], at: number): void;
}
