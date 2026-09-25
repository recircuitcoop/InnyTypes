// Where snapshots are kept (spec 8.3): SQLite in the app (adapters/sqlite/snapshots.ts).
// A snapshot outlives the view that took it, a redeploy and a restart.

import type { SnapshotRecord } from "../domain/views/views";

export interface SnapshotStore {
  /** Keep the record; durable when it returns. */
  put(record: SnapshotRecord): void;
  get(id: string): SnapshotRecord | null;
  /** The newest `limit` records, newest first (the Snapshots page). */
  list(limit: number): SnapshotRecord[];
  close(): void;
}
