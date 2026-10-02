// Where journal entries are kept (spec §7, plan 0018 §1): SQLite in WAL mode in the app
// (adapters/sqlite/journal.ts). The port is what makes swapping `node:sqlite` for
// `better-sqlite3` one file.
//
// Synchronous on purpose: "journal before send" means the entry is on disk when `put`
// returns, and the `input` frame is written only after that.
//
// Run records (plan 0022 §C, decision D15). Every write that moves a step of a run says so with
// a RunChange, and the store writes the run's records in the SAME transaction as the journal
// row: a crash never leaves the journal and the runs disagreeing. A write without a change (a
// close marking an entry `planned`) leaves the runs as they are.

import type { JournalEntry } from "../domain/journal/entry";
import type { StepOutcome } from "../domain/runs/step-report";

/** What a journal write did to its step, as the run records follow it. `at` is epoch ms. */
export type RunChange =
  /** A new entry: the step starts. `name` is the instance's name on the canvas. */
  | { readonly kind: "journaled"; readonly name: string; readonly at: number }
  /** A replayed entry was re-sent after a restart: the run is resumed. */
  | { readonly kind: "resent"; readonly name: string; readonly at: number }
  /** An action view presented: the step waits for the person. */
  | { readonly kind: "presented"; readonly question: string; readonly at: number }
  /** The person answered (or dismissed) the view: the step is with the node again. */
  | { readonly kind: "submitted"; readonly at: number }
  /** `done`: the step finished, with the notes and results its `done` carried. */
  | { readonly kind: "done"; readonly outcome?: StepOutcome; readonly at: number }
  /** `error`, a cancel, a step given up after its attempts, or a node removed: the run fails. */
  | { readonly kind: "failed"; readonly reason: string; readonly at: number };

export interface JournalStore {
  /**
   * Insert or replace the entry of `entry.inputId`; durable (fsynced) when it returns. With a
   * change, the entry's run records are written in the same transaction.
   */
  put(entry: JournalEntry, change?: RunChange): void;
  get(inputId: string): JournalEntry | null;
  /** Remove the entry; a missing one is not an error. With a change, as for `put`. */
  clear(inputId: string, change?: RunChange): void;
  /** One instance's entries, oldest first. */
  forInstance(instanceId: string): JournalEntry[];
  /** Every entry, oldest first. */
  all(): JournalEntry[];
  close(): void;
}
