// Where journal entries are kept (spec §7, plan 0018 §1): SQLite in WAL mode in the app
// (adapters/sqlite/journal.ts). The port is what makes swapping `node:sqlite` for
// `better-sqlite3` one file.
//
// Synchronous on purpose: "journal before send" means the entry is on disk when `put`
// returns, and the `input` frame is written only after that.

import type { JournalEntry } from "../domain/journal/entry";

export interface JournalStore {
  /** Insert or replace the entry of `entry.inputId`; durable (fsynced) when it returns. */
  put(entry: JournalEntry): void;
  get(inputId: string): JournalEntry | null;
  /** Remove the entry; a missing one is not an error. */
  clear(inputId: string): void;
  /** One instance's entries, oldest first. */
  forInstance(instanceId: string): JournalEntry[];
  /** Every entry, oldest first. */
  all(): JournalEntry[];
  close(): void;
}
