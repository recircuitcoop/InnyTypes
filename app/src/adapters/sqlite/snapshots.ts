// Snapshots on SQLite (spec 8.3), beside the journal and opened the same way: WAL, every
// commit synced, one JSON row per record. A snapshot is kept after its view leaves the flow.

import { DatabaseSync, type StatementSync } from "node:sqlite";

import { isSnapshotRecord, type SnapshotRecord } from "../../domain/views/views";
import type { SnapshotStore } from "../../ports/snapshot-store";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS snapshots (
    id          TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    body        TEXT NOT NULL
  );
`;

/** Open (or create) the snapshot store at `file`. */
export function openSqliteSnapshots(file: string): SnapshotStore {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;");
  db.exec(SCHEMA);
  return new Snapshots(db);
}

function parsed(body: string, id: string): SnapshotRecord {
  const value: unknown = JSON.parse(body);
  if (!isSnapshotRecord(value)) {
    throw new Error(`the snapshot store holds a row that is not a snapshot: ${id}`);
  }
  return value;
}

class Snapshots implements SnapshotStore {
  readonly #db: DatabaseSync;
  readonly #put: StatementSync;
  readonly #get: StatementSync;
  readonly #list: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#put = db.prepare(
      "INSERT OR REPLACE INTO snapshots (id, instance_id, body) VALUES (?, ?, ?)",
    );
    this.#get = db.prepare("SELECT body FROM snapshots WHERE id = ?");
    // The newest by insertion: rowid grows with every put of a new id.
    this.#list = db.prepare("SELECT body FROM snapshots ORDER BY rowid DESC LIMIT ?");
  }

  put(record: SnapshotRecord): void {
    this.#put.run(record.id, record.instanceId, JSON.stringify(record));
  }

  get(id: string): SnapshotRecord | null {
    const row = this.#get.get(id) as { body: string } | undefined;
    if (row === undefined) {
      return null;
    }
    return parsed(row.body, id);
  }

  list(limit: number): SnapshotRecord[] {
    const rows = this.#list.all(limit) as { body: string }[];
    return rows.map((row) => parsed(row.body, "in the list"));
  }

  close(): void {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }
}
