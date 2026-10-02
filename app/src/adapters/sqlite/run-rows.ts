// The run records' rows (plan 0022 §C): the tables of `user_version` 1, and how a row becomes
// a domain value and back. The statements that read and write them are in run-tables.ts.

import type { JournalEntry } from "../../domain/journal/entry";
import {
  RUN_STATES,
  type ResultLine,
  type ResultSink,
  type Run,
  type RunState,
  type RunStep,
  type StepLine,
  type StepState,
} from "../../domain/runs/run";

/** The tables and indexes of `user_version` 1. Only adds: the journal table is untouched. */
export const RUN_TABLES = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id           TEXT PRIMARY KEY,
    flow_id          TEXT NOT NULL,
    title            TEXT NOT NULL,
    duration_s       REAL,
    state            TEXT NOT NULL,
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER,
    resumed          INTEGER NOT NULL DEFAULT 0,
    copy_text        TEXT,
    copied           INTEGER NOT NULL DEFAULT 0,
    failure_step     TEXT,
    failure_instance TEXT,
    failure_text     TEXT,
    rerun_of         TEXT,
    rerun_from       TEXT,
    cleared          INTEGER NOT NULL DEFAULT 0,
    cleared_at       INTEGER
  );
  CREATE INDEX IF NOT EXISTS runs_by_flow ON runs (flow_id, started_at DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS runs_by_end ON runs (state, ended_at);
  CREATE TABLE IF NOT EXISTS run_steps (
    input_id       TEXT PRIMARY KEY,
    run_id         TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    instance_id    TEXT NOT NULL,
    label          TEXT NOT NULL,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    state          TEXT NOT NULL,
    status_text    TEXT,
    progress_done  REAL,
    progress_total REAL,
    eta_s          REAL,
    phase          TEXT,
    question       TEXT,
    message        TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS run_steps_by_run ON run_steps (run_id, seq);
  CREATE TABLE IF NOT EXISTS run_lines (
    run_id    TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    sink      TEXT,
    step      TEXT NOT NULL,
    text      TEXT NOT NULL,
    space_id  TEXT,
    object_id TEXT,
    folder    TEXT,
    due       TEXT,
    PRIMARY KEY (run_id, seq)
  );
`;

/** A step keeps its input message for re-runs (plan 0022 §E) up to this size, as JSON. */
export const MAX_KEPT_MESSAGE_BYTES = 1024 * 1024;

export interface RunRow {
  run_id: string;
  flow_id: string;
  title: string;
  duration_s: number | null;
  state: string;
  started_at: number;
  ended_at: number | null;
  resumed: number;
  copy_text: string | null;
  copied: number;
  failure_step: string | null;
  failure_instance: string | null;
  failure_text: string | null;
  rerun_of: string | null;
  rerun_from: string | null;
  cleared: number;
}

export interface StepRow {
  input_id: string;
  instance_id: string;
  label: string;
  started_at: number;
  ended_at: number | null;
  state: string;
  status_text: string | null;
  progress_done: number | null;
  progress_total: number | null;
  eta_s: number | null;
  question: string | null;
}

export interface LineRow {
  kind: string;
  sink: string | null;
  step: string;
  text: string;
  space_id: string | null;
  object_id: string | null;
  folder: string | null;
  due: string | null;
}

export const date = (ms: number): Date => new Date(ms);
export const dateOrNull = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));
export const msOrNull = (value: Date | null): number | null =>
  value === null ? null : value.getTime();
export const flag = (value: boolean): number => (value ? 1 : 0);

function runState(value: string): RunState {
  const state = RUN_STATES.find((known) => known === value);
  if (state === undefined) {
    throw new Error(`the run records hold a run in an unknown state: ${value}`);
  }
  return state;
}

const STEP_STATES: readonly StepState[] = ["running", "waiting", "done", "failed"];

function stepState(value: string): StepState {
  const state = STEP_STATES.find((known) => known === value);
  if (state === undefined) {
    throw new Error(`the run records hold a step in an unknown state: ${value}`);
  }
  return state;
}

function stepOf(row: StepRow): RunStep {
  return {
    instanceId: row.instance_id,
    inputId: row.input_id,
    name: row.label,
    startedAt: date(row.started_at),
    endedAt: dateOrNull(row.ended_at),
    state: stepState(row.state),
    progress:
      row.progress_done === null || row.progress_total === null
        ? null
        : { done: row.progress_done, total: row.progress_total },
    etaSeconds: row.eta_s,
    statusText: row.status_text,
    question: row.question,
  };
}

function resultOf(row: LineRow): ResultLine {
  return {
    step: row.step,
    sink: (row.sink ?? "plain") as ResultSink,
    text: row.text,
    anytype:
      row.space_id === null || row.object_id === null
        ? null
        : { spaceId: row.space_id, objectId: row.object_id },
    folder: row.folder,
    due: row.due,
  };
}

/** The input message as kept: its JSON, or null when larger than the bound. */
export function keptMessage(entry: JournalEntry): string | null {
  const json = JSON.stringify(entry.message);
  return Buffer.byteLength(json, "utf8") <= MAX_KEPT_MESSAGE_BYTES ? json : null;
}

/** `LIKE` text for `words` anywhere, with the pattern characters taken literally. */
export function likeAnywhere(words: string): string {
  return `%${words.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** The keyset cursor of a run: its start and its id. */
export function cursorOf(run: Run): string {
  return `${String(run.startedAt.getTime())}:${run.runId}`;
}

export function parseCursor(cursor: string): { startedAt: number; runId: string } {
  const colon = cursor.indexOf(":");
  const startedAt = Number(cursor.slice(0, colon));
  if (colon <= 0 || !Number.isInteger(startedAt)) {
    throw new Error(`not a run list cursor: ${cursor}`);
  }
  return { startedAt, runId: cursor.slice(colon + 1) };
}

/** The run its three tables' rows hold. */
export function runOf(row: RunRow, steps: readonly StepRow[], lines: readonly LineRow[]): Run {
  const said = (kind: string): StepLine[] =>
    lines.filter((line) => line.kind === kind).map(({ step, text }) => ({ step, text }));
  return {
    flowId: row.flow_id,
    runId: row.run_id,
    title: row.title,
    durationSeconds: row.duration_s,
    startedAt: date(row.started_at),
    endedAt: dateOrNull(row.ended_at),
    state: runState(row.state),
    resumed: row.resumed === 1,
    copyText: row.copy_text,
    copied: row.copied === 1,
    steps: steps.map(stepOf),
    notes: said("note"),
    warnings: said("warning"),
    results: lines.filter((line) => line.kind === "result").map(resultOf),
    failure:
      row.failure_step === null
        ? null
        : {
            step: row.failure_step,
            instanceId: row.failure_instance ?? "",
            text: row.failure_text ?? "",
          },
    rerunOf: row.rerun_of,
    rerunFrom: row.rerun_from,
    cleared: row.cleared === 1,
  };
}
