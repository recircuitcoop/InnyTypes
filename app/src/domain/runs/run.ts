// A run: one source event going through one flow (plan 0022 §A, ux-writing "One card per source
// event, per flow").
//
// A run is keyed by `{flowId, runId}`, and `runId` is the source event's id, the one the journal
// already stamps on every input the event caused (spec §5.5). The same event reaching two flows
// is two runs; two events reaching one flow are two runs; nothing ever merges them.
//
// `fold(events)` is the only way to make a Run: the read model (WI-0022-06) hands it the events
// it recorded, in the order they happened, and every rule about what may follow what lives here.
//
// States and transitions:
//
//   started ─► running ─┬─► copying ─► (copied) ─► running
//                       ├─► waiting ─► (submitted) ─► running
//                       ├─► failed   (terminal)
//                       └─► done     (terminal)
//
// * `resumed` is NOT a state. It is a flag on a copying, running or waiting run that the runtime
//   picked up again after a restart (the journal replayed its inputs). The run keeps the state it
//   had; the card says "Resumed after restart." until the next step activity clears the flag.
//   That keeps "what the run is doing" one value, and lets a waiting run that survived a restart
//   go on showing its question.
// * `failed` and `done` are terminal. Activity from a step that arrives after a run ended (a
//   parallel branch finishing late) changes nothing: a failed run keeps its first failure.
// * A step that could not finish makes the run failed. A warning is a line on a finished step and
//   never changes the state: a failure is never a warning.
// * Nothing here is worded for a person: the card's words are composed from these values by
//   ui/strings.ts (WI-0022-10). Error messages are for the log only.
// * `cleared` is the "Clear done" flag of the board. It is never a delete: Run history still
//   lists the run. Only a done run can be cleared, and clearing is undone the same way.

/** What a run is doing. `resumed` is a flag beside it, not a state (see the header). */
export type RunState = "copying" | "running" | "waiting" | "failed" | "done";

export const RUN_STATES: readonly RunState[] = ["copying", "running", "waiting", "failed", "done"];

/** The two states a run never leaves. */
export function isFinished(state: RunState): boolean {
  return state === "failed" || state === "done";
}

/** What identifies a run: its flow, and the source event's id. */
export interface RunKey {
  readonly flowId: string;
  readonly runId: string;
}

/** The key's one string form, for maps and sets; neither id may contain a newline. */
export function runKeyString(key: RunKey): string {
  return `${key.flowId}\n${key.runId}`;
}

/** What one step of a run is doing. */
export type StepState = "running" | "waiting" | "done" | "failed";

/** "2 of 3", as a node reports it in `status.progress`. */
export interface StepProgress {
  readonly done: number;
  readonly total: number;
}

/** One step of a run: one journaled input to one node instance. */
export interface RunStep {
  /** The node instance's id on the canvas; a view node's slot on the board has the same id. */
  readonly instanceId: string;
  /** The node's name on the canvas, never its type. */
  readonly name: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly state: StepState;
  /** The last `status.progress` the node sent for this run; null when it sent none. */
  readonly progress: StepProgress | null;
  /** The last `status.eta_s` the node sent for this run; null when it sent none. */
  readonly etaSeconds: number | null;
  /** The node's own status words for this run ("in Renaissance…"); null when it sent none. */
  readonly statusText: string | null;
  /** The question the step asks while it waits ("who spoke?"); null for a step that never asked. */
  readonly question: string | null;
}

/** A note or a warning, with the name of the step that wrote it. */
export interface StepLine {
  readonly step: string;
  readonly text: string;
}

/** Why a run failed: the step, its instance (for the board), and the step's own sentence. */
export interface RunFailure extends StepLine {
  readonly instanceId: string;
}

/** Where a result ended, as protocol 2.1 `done.results[].kind` names it (plan 0022 §B). */
export type ResultSink = "anytype" | "file" | "scheduled" | "plain";

export const RESULT_SINKS: readonly ResultSink[] = ["anytype", "file", "scheduled", "plain"];

/** One thing a run did, in the node's own words, with what its link opens. */
export interface ResultLine {
  /** The step that did it. */
  readonly step: string;
  readonly sink: ResultSink;
  /** "Meeting notes → Renaissance", "Moved recording to Archive". */
  readonly text: string;
  /** The Anytype object the line opens; only for the anytype sink. */
  readonly anytype: { readonly spaceId: string; readonly objectId: string } | null;
  /** The folder the line shows in the file manager; only for the file sink. */
  readonly folder: string | null;
  /** When a scheduled thing is due, as the node wrote it; only for the scheduled sink. */
  readonly due: string | null;
}

export interface Run extends RunKey {
  /** The recording's or the file's name, as the source named the event. */
  readonly title: string;
  /** The recording's length, when the source knows it. */
  readonly durationSeconds: number | null;
  readonly startedAt: Date;
  /** When the run became failed or done; null while it is in progress. */
  readonly endedAt: Date | null;
  readonly state: RunState;
  /** Picked up again after a restart, and nothing has happened since (see the header). */
  readonly resumed: boolean;
  /** What the source says while copying ("from BOYA…"); null when it said nothing. */
  readonly copyText: string | null;
  /** The copy finished: the recorder is safe to unplug. */
  readonly copied: boolean;
  /** One per journaled input, in the order they started. */
  readonly steps: readonly RunStep[];
  readonly notes: readonly StepLine[];
  readonly warnings: readonly StepLine[];
  /**
   * What the run did, one line per thing, from the steps' `done.results`. Its producer is
   * WI-0022-04 (protocol 2.1, `results` on `done`); the Done card shows these.
   */
  readonly results: readonly ResultLine[];
  /** The first failure, kept for good once the run failed. */
  readonly failure: RunFailure | null;
  /** The run this one re-runs, when it is a re-run (plan 0022 §E). */
  readonly rerunOf: string | null;
  /** The step a re-run started from; null for a re-run from the start. */
  readonly rerunFrom: string | null;
  /** Hidden from the board by "Clear done"; never a delete. */
  readonly cleared: boolean;
}

/** A note or a warning as protocol 2.1 carries it on `done` (decision D3). */
export interface DoneNote {
  readonly level: "note" | "warning";
  readonly text: string;
}

/** A result as protocol 2.1 carries it on `done` (decision D16). */
export interface DoneResult {
  readonly kind: ResultSink;
  readonly text: string;
  readonly anytype?: { readonly spaceId: string; readonly objectId: string };
  readonly folder?: string;
  readonly due?: string;
}

interface EventBase extends RunKey {
  readonly at: Date;
}

/**
 * What can happen to a run, as the read model records it. Every event carries the run's key, so
 * `foldAll` can sort a mixed stream into runs.
 */
export type RunEvent =
  /** The source fired: the run exists. Always the first event, and only ever the first. */
  | (EventBase & {
      readonly kind: "started";
      readonly title: string;
      readonly durationSeconds?: number;
      readonly rerunOf?: string;
      readonly rerunFrom?: string;
    })
  /** The source is copying the recording off the recorder (`status.phase` "copying"). */
  | (EventBase & { readonly kind: "copying"; readonly text?: string })
  /** The copy finished (`status.phase` "copied"). */
  | (EventBase & { readonly kind: "copied" })
  /** An input of this run was journaled for a node instance: a step starts. */
  | (EventBase & {
      readonly kind: "stepStarted";
      readonly instanceId: string;
      readonly name: string;
    })
  /** A `status` with `in` for this run: the step's words, progress and time left. */
  | (EventBase & {
      readonly kind: "status";
      readonly instanceId: string;
      readonly text?: string;
      readonly progress?: StepProgress;
      readonly etaSeconds?: number;
    })
  /** A question step was presented and now waits for the person. */
  | (EventBase & {
      readonly kind: "presented";
      readonly instanceId: string;
      readonly question: string;
    })
  /** The person answered the question. */
  | (EventBase & { readonly kind: "submitted"; readonly instanceId: string })
  /** A step finished, with its notes, warnings and results. */
  | (EventBase & {
      readonly kind: "stepDone";
      readonly instanceId: string;
      readonly notes?: readonly DoneNote[];
      readonly results?: readonly DoneResult[];
    })
  /** A step could not finish: the run fails, with the step's own sentence. */
  | (EventBase & {
      readonly kind: "stepFailed";
      readonly instanceId: string;
      readonly text: string;
    })
  /** The flow has nothing left to do for this run. */
  | (EventBase & { readonly kind: "finished" })
  /** The runtime restarted and replayed this run's inputs. */
  | (EventBase & { readonly kind: "resumed" })
  /** "Clear done" (`cleared: true`), or its undo (`cleared: false`). */
  | (EventBase & { readonly kind: "cleared"; readonly cleared: boolean });

export type RunEventKind = RunEvent["kind"];

/** An event that does not fit the run's state, or a stream that is not one run's. */
export class RunTransitionError extends Error {
  override readonly name = "RunTransitionError";
}

/** The events a step sends; after a run ended they are late, and change nothing. */
const STEP_ACTIVITY: ReadonlySet<RunEventKind> = new Set<RunEventKind>([
  "copying",
  "copied",
  "stepStarted",
  "status",
  "presented",
  "submitted",
  "stepDone",
  "stepFailed",
]);

/** The states each later event may arrive in; anything else is a RunTransitionError. */
const ALLOWED_IN: Readonly<Record<Exclude<RunEventKind, "started">, readonly RunState[]>> = {
  copying: ["running", "copying"],
  copied: ["copying"],
  stepStarted: ["running", "waiting"],
  status: ["running", "waiting"],
  presented: ["running", "waiting"],
  submitted: ["waiting"],
  stepDone: ["running", "waiting"],
  stepFailed: ["copying", "running", "waiting"],
  finished: ["running"],
  resumed: ["copying", "running", "waiting"],
  cleared: ["done"],
};

/** Builds a run from its events, oldest first. Throws RunTransitionError on a wrong stream. */
export function fold(events: readonly RunEvent[]): Run {
  const [first, ...rest] = events;
  if (first === undefined) {
    throw new RunTransitionError("A run needs at least its started event.");
  }
  if (first.kind !== "started") {
    throw new RunTransitionError(`A run starts with "started", not "${first.kind}".`);
  }
  let run: Run = {
    flowId: first.flowId,
    runId: first.runId,
    title: first.title,
    durationSeconds: first.durationSeconds ?? null,
    startedAt: first.at,
    endedAt: null,
    state: "running",
    resumed: false,
    copyText: null,
    copied: false,
    steps: [],
    notes: [],
    warnings: [],
    results: [],
    failure: null,
    rerunOf: first.rerunOf ?? null,
    rerunFrom: first.rerunFrom ?? null,
    cleared: false,
  };
  for (const event of rest) {
    run = applyEvent(run, event);
  }
  return run;
}

/** One more event on a run already folded; the read model's incremental path. */
export function applyEvent(run: Run, event: RunEvent): Run {
  if (event.flowId !== run.flowId || event.runId !== run.runId) {
    throw new RunTransitionError("An event of another run cannot change this one.");
  }
  if (event.kind === "started") {
    throw new RunTransitionError("A run starts only once.");
  }
  // Late activity from a step after the run ended: the run keeps what it ended with.
  if (isFinished(run.state) && STEP_ACTIVITY.has(event.kind)) {
    return run;
  }
  if (!ALLOWED_IN[event.kind].includes(run.state)) {
    throw new RunTransitionError(`"${event.kind}" cannot happen to a ${run.state} run.`);
  }
  switch (event.kind) {
    case "copying":
      return { ...run, state: "copying", resumed: false, copyText: event.text ?? run.copyText };
    case "copied":
      return { ...run, state: "running", resumed: false, copied: true };
    case "stepStarted":
      return {
        ...run,
        resumed: false,
        steps: [
          ...run.steps,
          {
            instanceId: event.instanceId,
            name: event.name,
            startedAt: event.at,
            endedAt: null,
            state: "running",
            progress: null,
            etaSeconds: null,
            statusText: null,
            question: null,
          },
        ],
      };
    case "status":
      return updateOpenStep({ ...run, resumed: false }, event.instanceId, (step) => ({
        ...step,
        statusText: event.text ?? step.statusText,
        progress: event.progress ?? step.progress,
        etaSeconds: event.etaSeconds ?? step.etaSeconds,
      }));
    case "presented":
      return updateOpenStep(
        { ...run, state: "waiting", resumed: false },
        event.instanceId,
        (step) => ({ ...step, state: "waiting", question: event.question }),
      );
    case "submitted": {
      const answered = updateOpenStep({ ...run, resumed: false }, event.instanceId, (step) => {
        if (step.state !== "waiting") {
          throw new RunTransitionError(`The step "${step.name}" is not waiting for an answer.`);
        }
        return { ...step, state: "running" };
      });
      // A run waits while any of its steps waits (a flow may ask two questions at once).
      const stillWaiting = answered.steps.some((step) => step.state === "waiting");
      return { ...answered, state: stillWaiting ? "waiting" : "running" };
    }
    case "stepDone":
      return finishStep(run, event);
    case "stepFailed": {
      const { step } = openStep(run, event.instanceId);
      const failed = replaceOpenStep(run, event.instanceId, {
        ...step,
        state: "failed",
        endedAt: event.at,
      });
      return {
        ...failed,
        state: "failed",
        resumed: false,
        endedAt: event.at,
        failure: { step: step.name, instanceId: event.instanceId, text: event.text },
      };
    }
    case "finished":
      return { ...run, state: "done", endedAt: event.at };
    case "resumed":
      return { ...run, resumed: true };
    case "cleared":
      return { ...run, cleared: event.cleared };
  }
}

/** A step finished: its notes split into notes and warnings, its results appended. */
function finishStep(run: Run, event: Extract<RunEvent, { kind: "stepDone" }>): Run {
  const { step } = openStep(run, event.instanceId);
  const name = step.name;
  const finished = replaceOpenStep({ ...run, resumed: false }, event.instanceId, {
    ...step,
    state: "done",
    endedAt: event.at,
  });
  const notes = (event.notes ?? []).filter((note) => note.level === "note");
  const warnings = (event.notes ?? []).filter((note) => note.level === "warning");
  const results = (event.results ?? []).map((result): ResultLine => ({
    step: name,
    sink: result.kind,
    text: result.text,
    anytype: result.kind === "anytype" ? (result.anytype ?? null) : null,
    folder: result.kind === "file" ? (result.folder ?? null) : null,
    due: result.kind === "scheduled" ? (result.due ?? null) : null,
  }));
  // The run may have been waiting on another step; it stays waiting until that one is answered.
  const stillWaiting = finished.steps.some((step) => step.state === "waiting");
  return {
    ...finished,
    state: stillWaiting ? "waiting" : "running",
    notes: [...run.notes, ...notes.map((note) => ({ step: name, text: note.text }))],
    warnings: [...run.warnings, ...warnings.map((note) => ({ step: name, text: note.text }))],
    results: [...run.results, ...results],
  };
}

/** The latest step of `instanceId` that has not ended; throws when there is none. */
function openStep(run: Run, instanceId: string): { index: number; step: RunStep } {
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const step = run.steps[index];
    if (step !== undefined && step.instanceId === instanceId && step.endedAt === null) {
      return { index, step };
    }
  }
  throw new RunTransitionError(`No step of "${instanceId}" is in progress in this run.`);
}

/** The run with the open step of `instanceId` replaced by `next`. */
function replaceOpenStep(run: Run, instanceId: string, next: RunStep): Run {
  const { index } = openStep(run, instanceId);
  const steps = [...run.steps];
  steps[index] = next;
  return { ...run, steps };
}

/** Changes the open step of `instanceId` through `change`. */
function updateOpenStep(run: Run, instanceId: string, change: (step: RunStep) => RunStep): Run {
  return replaceOpenStep(run, instanceId, change(openStep(run, instanceId).step));
}

/**
 * Sorts a mixed stream of events into runs: one per `{flowId, runId}`, in the order their events
 * first arrived. The same event in two flows is two runs; nothing is ever merged.
 */
export function foldAll(events: readonly RunEvent[]): Run[] {
  const byKey = new Map<string, RunEvent[]>();
  for (const event of events) {
    const key = runKeyString(event);
    const list = byKey.get(key);
    if (list === undefined) {
      byKey.set(key, [event]);
    } else {
      list.push(event);
    }
  }
  return [...byKey.values()].map((list) => fold(list));
}

/** The step a card talks about: the waiting one, else the latest still running; null if none. */
export function currentStep(run: Run): RunStep | null {
  const open = run.steps.filter((step) => step.endedAt === null);
  const waiting = open.filter((step) => step.state === "waiting");
  return waiting.at(-1) ?? open.at(-1) ?? null;
}
