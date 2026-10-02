// The journal on SQLite (spec §7, plan 0018 §1 and §7), with `node:sqlite`: built into the
// Node that Electron bundles, so there is no native module to rebuild per architecture.
//
// The spike rewrote one JSON file on every change (`runtime/hub.js:57-62`). Here each change
// is one row written in one transaction, in WAL mode with `synchronous = FULL`, which syncs
// the WAL on every commit: an entry is on disk when `put` returns. `fullfsync` makes that sync
// reach the platter on macOS too, where a plain fsync stops at the drive's cache.
//
// The run records (plan 0022 §C, decision D15) live in the same file, and a journal write that
// moves a step writes its run's records in the SAME transaction (`BEGIN IMMEDIATE … COMMIT`):
// either both are on disk or neither is, so a crash never leaves them disagreeing. The tables,
// and why the folded state is what is stored, are in run-tables.ts; the schema versions and the
// pre-0.3.0 copy in migrate.ts.

import { DatabaseSync, type StatementSync } from "node:sqlite";

import { isJournalEntry, type JournalEntry } from "../../domain/journal/entry";
import type { Run, RunKey } from "../../domain/runs/run";
import type { JournalStore, RunChange } from "../../ports/journal-store";
import type {
  RunPage,
  RunQuery,
  RunStart,
  RunStore,
  StepStatusUpdate,
} from "../../ports/run-store";
import { hasJournal, migrate } from "./migrate";
import { RunTables } from "./run-tables";

export interface SqliteJournal extends JournalStore, RunStore {
  /** The SQLite library's version, for the log line that says which journal is in use. */
  readonly sqliteVersion: string;
  readonly file: string;
}

export interface SqliteJournalOptions {
  /**
   * An event the run fold refused: the run is kept as it was and the journal write goes on.
   * Said here so the runtime can log it.
   */
  readonly problem?: (message: string) => void;
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
export function openSqliteJournal(file: string, options: SqliteJournalOptions = {}): SqliteJournal {
  const db = new DatabaseSync(file);
  const mode = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string };
  if (mode.journal_mode !== "wal") {
    db.close();
    throw new Error(
      `the journal at ${file} could not use WAL mode (got ${String(mode.journal_mode)})`,
    );
  }
  db.exec("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON;");
  const existed = hasJournal(db);
  db.exec(SCHEMA);
  const problem = options.problem ?? (() => undefined);
  try {
    migrate({
      db,
      file,
      existed,
      entries: () =>
        (db.prepare("SELECT body FROM journal ORDER BY rowid").all() as { body: string }[]).map(
          (row) => parse(row.body),
        ),
      tables: () => new RunTables(db, problem),
      transaction: (work) => {
        transaction(db, work);
      },
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const version = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  return new Journal(db, file, version.v, new RunTables(db, problem));
}

/** `work` in one transaction: committed when it returns, rolled back when it throws. */
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = work();
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("COMMIT");
  return result;
}

class Journal implements SqliteJournal {
  readonly #db: DatabaseSync;
  readonly #tables: RunTables;
  readonly #put: StatementSync;
  readonly #get: StatementSync;
  readonly #clear: StatementSync;
  readonly #forInstance: StatementSync;
  readonly #all: StatementSync;
  readonly #flowRuns: StatementSync;
  readonly #listeners: ((key: RunKey) => void)[] = [];
  readonly #writeListeners: ((flowId: string) => void)[] = [];
  readonly sqliteVersion: string;
  readonly file: string;

  constructor(db: DatabaseSync, file: string, sqliteVersion: string, tables: RunTables) {
    this.#db = db;
    this.#tables = tables;
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
    this.#flowRuns = db.prepare(
      "SELECT run_id FROM runs WHERE flow_id = ? AND state = 'done' AND cleared = 0",
    );
  }

  // ── the journal ────────────────────────────────────────────────────────────────────────

  put(entry: JournalEntry, change?: RunChange): void {
    this.#write(() => {
      this.#put.run(entry.inputId, entry.instanceId, JSON.stringify(entry));
      return change === undefined ? [] : [this.#tables.journalChange(entry, change)];
    });
    this.#journalWritten(entry.flowId);
  }

  get(inputId: string): JournalEntry | null {
    const row = this.#get.get(inputId) as { body: string } | undefined;
    return row === undefined ? null : parse(row.body);
  }

  clear(inputId: string, change?: RunChange): void {
    let flowId: string | undefined;
    this.#write(() => {
      const entry = this.get(inputId);
      flowId = entry?.flowId;
      this.#clear.run(inputId);
      return entry === null || change === undefined
        ? []
        : [this.#tables.journalChange(entry, change)];
    });
    this.#journalWritten(flowId);
  }

  forInstance(instanceId: string): JournalEntry[] {
    return (this.#forInstance.all(instanceId) as { body: string }[]).map((row) => parse(row.body));
  }

  all(): JournalEntry[] {
    return (this.#all.all() as { body: string }[]).map((row) => parse(row.body));
  }

  // ── the run records ────────────────────────────────────────────────────────────────────

  started(start: RunStart): void {
    this.#write(() => [this.#tables.started(start)]);
  }

  stepStatuses(updates: readonly StepStatusUpdate[]): void {
    if (updates.length === 0) {
      return;
    }
    this.#write(() =>
      updates.map(({ inputId, status, at }) => this.#tables.stepStatus(inputId, status, at)),
    );
  }

  settle(runId: string, at: number): boolean {
    return this.#write(() => [this.#tables.settle(runId, at)]) > 0;
  }

  idle(): RunKey[] {
    return this.#tables.idle();
  }

  list(query: RunQuery): RunPage {
    return this.#tables.list(query);
  }

  run(runId: string): Run | null {
    return this.#tables.load(runId)?.run ?? null;
  }

  clearDone(flowId: string, at: number): number {
    return this.#write(() =>
      (this.#flowRuns.all(flowId) as { run_id: string }[]).map((row) =>
        this.#tables.setCleared(row.run_id, true, at),
      ),
    );
  }

  undoClear(flowId: string, since: number): number {
    return this.#write(() =>
      (
        this.#db
          .prepare("SELECT run_id FROM runs WHERE flow_id = ? AND cleared = 1 AND cleared_at >= ?")
          .all(flowId, since) as { run_id: string }[]
      ).map((row) => this.#tables.setCleared(row.run_id, false, since)),
    );
  }

  prune(before: number): number {
    return this.#write(() => {
      const gone = this.#db
        .prepare(
          "SELECT run_id, flow_id FROM runs WHERE state IN ('done', 'failed') AND ended_at < ?",
        )
        .all(before) as { run_id: string; flow_id: string }[];
      for (const table of ["run_lines", "run_steps", "runs"]) {
        this.#db
          .prepare(
            `DELETE FROM ${table} WHERE run_id IN (SELECT run_id FROM runs WHERE ` +
              "state IN ('done', 'failed') AND ended_at < ?)",
          )
          .run(before);
      }
      return gone.map((row) => ({ flowId: row.flow_id, runId: row.run_id }));
    });
  }

  onChange(listener: (key: RunKey) => void): void {
    this.#listeners.push(listener);
  }

  onJournalWrite(listener: (flowId: string) => void): void {
    this.#writeListeners.push(listener);
  }

  #journalWritten(flowId: string | undefined): void {
    for (const listener of this.#writeListeners) {
      listener(flowId ?? "");
    }
  }

  close(): void {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }

  /**
   * One transaction; then each run it changed is told, after the commit, so a listener never
   * hears of a change that was rolled back. Returns how many runs changed.
   */
  #write(work: () => (RunKey | null)[]): number {
    const changed = transaction(this.#db, work).filter((key): key is RunKey => key !== null);
    for (const key of changed) {
      for (const listener of this.#listeners) {
        listener(key);
      }
    }
    return changed.length;
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
