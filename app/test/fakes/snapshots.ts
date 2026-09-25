// A SnapshotStore in memory; records are copied in and out, as a real store would.
import type { SnapshotRecord } from "../../src/domain/views/views";
import type { SnapshotStore } from "../../src/ports/snapshot-store";

export class MemorySnapshots implements SnapshotStore {
  readonly #records = new Map<string, SnapshotRecord>();
  /** Set to make the next writes throw, like a full disk. */
  failWrites = false;

  put(record: SnapshotRecord): void {
    if (this.failWrites) {
      throw new Error("disk full");
    }
    this.#records.set(record.id, structuredClone(record));
  }

  get(id: string): SnapshotRecord | null {
    const record = this.#records.get(id);
    return record === undefined ? null : structuredClone(record);
  }

  all(): SnapshotRecord[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  close(): void {
    // Nothing to release.
  }
}
