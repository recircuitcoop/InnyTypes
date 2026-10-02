// The runs' part of the AppApi contract (plan 0022 §A, §C, §E): a run as it crosses IPC, the
// list query, and what the run calls answer. Apart from contract.ts, which re-exports it.
import type { Answer } from "./answer";

/** A step of a run (plan 0022 §A), as the runtime's runs read model answers it. */
export interface RunStepRecord {
  readonly instanceId: string;
  /** The journal input this step is, when known. */
  readonly inputId?: string;
  readonly name: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly state: "running" | "waiting" | "done" | "failed";
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly etaSeconds: number | null;
  readonly statusText: string | null;
  readonly question: string | null;
}

/** A note or a warning, with the step that wrote it. */
export interface RunLineRecord {
  readonly step: string;
  readonly text: string;
}

/** One source event through one flow (plan 0022 §A): the domain's Run, as it crosses IPC. */
export interface RunRecord {
  readonly flowId: string;
  readonly runId: string;
  readonly title: string;
  readonly durationSeconds: number | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly state: "copying" | "running" | "waiting" | "failed" | "done";
  readonly resumed: boolean;
  readonly copyText: string | null;
  readonly copied: boolean;
  readonly steps: readonly RunStepRecord[];
  readonly notes: readonly RunLineRecord[];
  readonly warnings: readonly RunLineRecord[];
  readonly results: readonly (RunLineRecord & {
    readonly sink: "anytype" | "file" | "scheduled" | "plain";
    readonly anytype: { readonly spaceId: string; readonly objectId: string } | null;
    readonly folder: string | null;
    readonly due: string | null;
  })[];
  readonly failure: (RunLineRecord & { readonly instanceId: string }) | null;
  readonly rerunOf: string | null;
  readonly rerunFrom: string | null;
  readonly cleared: boolean;
}

/** `run.list`: a flow's runs, newest first; `cursor` is the `next` of the page before. */
export interface RunListQuery {
  readonly flowId: string;
  readonly state?: RunRecord["state"];
  /** Only runs started at or after this (epoch ms). */
  readonly since?: number;
  readonly search?: string;
  readonly cursor?: string;
  /** 1 to 200; 50 when absent. */
  readonly limit?: number;
}

/** One page of `runs`: newest first, and the cursor of the next page (null: the last). */
export interface RunPage {
  readonly runs: readonly RunRecord[];
  readonly next: string | null;
}

/** "Clear done" and its undo: how many runs left (or came back to) the board. */
export interface ClearedCount {
  readonly count: number;
}

/** A re-run (plan 0022 §E): the new run it started. */
export interface RerunStarted {
  readonly runId: string;
}

export type RunAnswer<T> = Promise<Answer<T>>;

/** The `runs` signal: a run of this flow changed. */
export interface RunsChanged {
  readonly flowId: string;
}
