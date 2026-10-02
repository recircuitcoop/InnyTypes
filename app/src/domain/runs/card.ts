// What a run card shows (ux-writing "Live: the board", design-system "Run card"), as values.
//
// Every value here is derived from the Run; nothing on a card is stored apart from it. None of
// it is worded: ui/strings.ts (WI-0022-10, plan 0022 §O) turns each value into ux-writing's
// sentence, and app/test/unit/domain/wording.fixture.test.ts lists those sentences for it.
// Text that comes from a node (its status words, its question, its failure, its result lines)
// is passed through as the node wrote it.

import { currentStep, type ResultLine, type Run, type RunStep, type StepProgress } from "./run";

/**
 * The card's six variants (design-system "Run card"): the run's state, with Resumed shown in
 * place of the state while the run has done nothing since a restart.
 */
export type CardVariant = "copying" | "running" | "waiting" | "failed" | "done" | "resumed";

export function cardVariant(run: Run): CardVariant {
  if (run.resumed && run.state !== "waiting") {
    return "resumed";
  }
  return run.state;
}

/** The card's title: the event's name, and its length in whole minutes when the source knows it. */
export interface CardTitle {
  readonly name: string;
  readonly minutes: number | null;
}

/** Whole minutes for a length or a time left, never less than one. */
export function wholeMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

export function cardTitle(run: Run): CardTitle {
  return {
    name: run.title,
    minutes: run.durationSeconds === null ? null : wholeMinutes(run.durationSeconds),
  };
}

/**
 * What the card's step line says, one kind per line of ux-writing:
 * * `copying` — the source copies off the recorder, with its words ("from BOYA…").
 * * `copying-no-text` — the same, when the source said nothing.
 * * `safe-to-unplug` — the copy finished and no step has started yet.
 * * `between-steps` — running, with no step in progress.
 * * `running` — the step's name, its words, its count and the minutes left, each when sent.
 * * `waiting` — the question the waiting step asks.
 * * `failed` — the failing step's name and its own sentence.
 * * `resumed` — picked up after a restart, nothing since.
 * * `done` — what the run did: its result lines (from `done.results`, WI-0022-04).
 */
export type StepLine =
  | { readonly kind: "copying"; readonly text: string }
  | { readonly kind: "copying-no-text" }
  | { readonly kind: "safe-to-unplug" }
  | { readonly kind: "between-steps" }
  | {
      readonly kind: "running";
      readonly step: string;
      readonly text: string | null;
      readonly progress: StepProgress | null;
      readonly timeLeftMinutes: number | null;
    }
  | { readonly kind: "waiting"; readonly question: string }
  | { readonly kind: "failed"; readonly step: string; readonly reason: string }
  | { readonly kind: "resumed" }
  | { readonly kind: "done"; readonly results: readonly ResultLine[] };

export function stepLine(run: Run): StepLine {
  switch (run.state) {
    case "failed": {
      // The failure is kept for good once the run failed (run.ts), so it is always there.
      const failure = run.failure ?? { step: "", text: "" };
      return { kind: "failed", step: failure.step, reason: failure.text };
    }
    case "done":
      return { kind: "done", results: run.results };
    case "waiting":
      return { kind: "waiting", question: currentStep(run)?.question ?? "" };
    case "copying":
      if (run.resumed) {
        return { kind: "resumed" };
      }
      return run.copyText === null
        ? { kind: "copying-no-text" }
        : { kind: "copying", text: run.copyText };
    case "running":
      return runningLine(run);
  }
}

/** The running line: the step in progress, or what happens between steps. */
function runningLine(run: Run): StepLine {
  if (run.resumed) {
    return { kind: "resumed" };
  }
  const step = currentStep(run);
  if (step === null) {
    // Between the copy and the first step the recorder may be unplugged.
    return run.copied ? { kind: "safe-to-unplug" } : { kind: "between-steps" };
  }
  return runningStep(step);
}

function runningStep(step: RunStep): StepLine {
  return {
    kind: "running",
    step: step.name,
    text: step.statusText === null || step.statusText === "" ? null : step.statusText,
    progress: step.progress,
    timeLeftMinutes: step.etaSeconds === null ? null : wholeMinutes(step.etaSeconds),
  };
}

/** The Done badge row: the Done pill, then the notes and warnings pills only when non-zero. */
export type DonePill =
  | { readonly kind: "done" }
  | { readonly kind: "notes"; readonly count: number }
  | { readonly kind: "warnings"; readonly count: number };

/** Empty for a run that is not done: a failed run has its failure, not a badge. */
export function donePills(run: Run): DonePill[] {
  if (run.state !== "done") {
    return [];
  }
  const pills: DonePill[] = [{ kind: "done" }];
  if (run.notes.length > 0) {
    pills.push({ kind: "notes", count: run.notes.length });
  }
  if (run.warnings.length > 0) {
    pills.push({ kind: "warnings", count: run.warnings.length });
  }
  return pills;
}

/** Run history's line under a failed row: the step and its own sentence; null if not failed. */
export interface FailureLine {
  readonly step: string;
  readonly reason: string;
}

export function failureLine(run: Run): FailureLine | null {
  if (run.failure === null) {
    return null;
  }
  return { step: run.failure.step, reason: run.failure.text };
}
