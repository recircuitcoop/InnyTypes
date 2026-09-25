// The journal on SQLite (spec §7, plan 0018 §1 and §7), with `node:sqlite`: built into the
// Node that Electron bundles, so there is no native module to rebuild per architecture.
//
// The spike rewrote one JSON file on every change (`runtime/hub.js:57-62`). Here each change
// is one row written in one transaction, in WAL mode with `synchronous = FULL`, which syncs
// the WAL on every commit: an entry is on disk when `put` returns. `fullfsync` makes that sync
// reach the platter on macOS too, where a plain fsync stops at the drive's cache.

import { DatabaseSync, type StatementSync } from "node:sqlite";

import { isJournalEntry, type JournalEntry } from "../../domain/journal/entry";
import type { JournalStore } from "../../ports/journal-store";

export interface SqliteJournal extends JournalStore {
  /** The SQLite library's version, for the log line that says which journal is in use. */
  readonly sqliteVersion: string;
  readonly file: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS journal (
    input_id    TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    body        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS journal_instance ON journal (instance_id);
`;

/** Open (or create) the journal at `file`, in WAL mode with every commit synced. */
export function openSqliteJournal(file: string): SqliteJournal {
  const db = new DatabaseSync(file);
  const mode = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string };
  if (mode.journal_mode !== "wal") {
    db.close();
    throw new Error(
      `the journal at ${file} could not use WAL mode (got ${String(mode.journal_mode)})`,
    );
  }
  db.exec("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON;");
  db.exec(SCHEMA);
  const version = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  return new Journal(db, file, version.v);
}

class Journal implements SqliteJournal {
  readonly #db: DatabaseSync;
  readonly #put: StatementSync;
  readonly #get: StatementSync;
  readonly #clear: StatementSync;
  readonly #forInstance: StatementSync;
  readonly #all: StatementSync;
  readonly sqliteVersion: string;
  readonly file: string;

  constructor(db: DatabaseSync, file: string, sqliteVersion: string) {
    this.#db = db;
    this.file = file;
    this.sqliteVersion = sqliteVersion;
    // An upsert keeps the row id, so "oldest first" stays the order entries were created in.
    this.#put = db.prepare(
      "INSERT INTO journal (input_id, instance_id, body) VALUES (?, ?, ?) " +
        "ON CONFLICT (input_id) DO UPDATE SET instance_id = excluded.instance_id, body = excluded.body",
    );
    this.#get = db.prepare("SELECT body FROM journal WHERE input_id = ?");
    this.#clear = db.prepare("DELETE FROM journal WHERE input_id = ?");
    this.#forInstance = db.prepare("SELECT body FROM journal WHERE instance_id = ? ORDER BY rowid");
    this.#all = db.prepare("SELECT body FROM journal ORDER BY rowid");
  }

  put(entry: JournalEntry): void {
    this.#put.run(entry.inputId, entry.instanceId, JSON.stringify(entry));
  }

  get(inputId: string): JournalEntry | null {
    const row = this.#get.get(inputId) as { body: string } | undefined;
    return row === undefined ? null : parse(row.body);
  }

  clear(inputId: string): void {
    this.#clear.run(inputId);
  }

  forInstance(instanceId: string): JournalEntry[] {
    return (this.#forInstance.all(instanceId) as { body: string }[]).map((row) => parse(row.body));
  }

  all(): JournalEntry[] {
    return (this.#all.all() as { body: string }[]).map((row) => parse(row.body));
  }

  close(): void {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }
}

/** A row read back: an entry this code wrote, or a loud failure, never a silent skip. */
function parse(body: string): JournalEntry {
  const value: unknown = JSON.parse(body);
  if (!isJournalEntry(value)) {
    throw new Error(`the journal holds a row that is not an entry: ${body.slice(0, 200)}`);
  }
  return value;
}
