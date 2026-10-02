// The journal's schema versions (plan 0022 §C, risk 4), by `PRAGMA user_version`.
//
// 0: the journal of 0.2.x, one table. 1: the run records' tables and indexes beside it
// (run-tables.ts). A migration only ADDS: the journal table and its rows are untouched, so
// 0.2.1 still opens a migrated file (decision D4's go back). Before a journal of 0.2.x is
// migrated, a consistent copy of it is written once to `journal.sqlite.pre-0.3.0`, with
// `VACUUM INTO`, which reads it inside one transaction whatever the WAL holds.
//
// The "pre-0.3.0 copy" of the runs: every entry already in the journal becomes a step of its
// run, so the inputs in hand when 0.3.0 first starts are in Run history from the start. An entry
// awaiting a person becomes a waiting step, asking its view's title. A 0.2.x entry has no flow
// and no step name: they are filled in when the entry is re-sent (run-tables.ts `resent`).

import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { JournalEntry } from "../../domain/journal/entry";
import { titleOf } from "../../domain/views/views";
import { RUN_TABLES } from "./run-rows";
import type { RunTables } from "./run-tables";

/** The version this code writes. */
export const JOURNAL_VERSION = 1;

/** Where the copy of a 0.2.x journal goes before its first migration. */
export function preMigrationCopy(file: string): string {
  return `${file}.pre-0.3.0`;
}

export function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** Whether the file already held a journal table before this open created one. */
export function hasJournal(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'journal'")
    .get();
  return row !== undefined;
}

export interface Migration {
  readonly db: DatabaseSync;
  readonly file: string;
  /** Whether a journal table was there before this open: a 0.2.x journal. */
  readonly existed: boolean;
  readonly entries: () => JournalEntry[];
  /** The run tables' statements, prepared once the tables exist. */
  readonly tables: () => RunTables;
  /** Runs the work in one transaction. */
  readonly transaction: (work: () => void) => void;
}

/** Brings the file to JOURNAL_VERSION. A newer file is left as it is: its tables are a superset. */
export function migrate(migration: Migration): void {
  const { db, file, existed } = migration;
  if (userVersion(db) >= JOURNAL_VERSION) {
    return;
  }
  const copy = preMigrationCopy(file);
  if (existed && !fs.existsSync(copy)) {
    db.prepare("VACUUM INTO ?").run(copy);
  }
  migration.transaction(() => {
    db.exec(RUN_TABLES);
    const tables = migration.tables();
    for (const entry of migration.entries()) {
      tables.journalChange(entry, { kind: "journaled", name: "", at: entry.createdAt });
      if (entry.state === "awaiting" && entry.content !== null) {
        const question = titleOf(entry.content);
        tables.journalChange(entry, { kind: "presented", question, at: entry.updatedAt });
      }
    }
    db.exec(`PRAGMA user_version = ${String(JOURNAL_VERSION)}`);
  });
}
