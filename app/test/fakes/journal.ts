// A JournalStore in memory, recording every call in order, for tests that watch what the
// runtime journals and when. Entries are copied in and out, as a real store would.
import type { JournalEntry } from "../../src/domain/journal/entry";
import type { JournalStore, RunChange } from "../../src/ports/journal-store";

export class MemoryJournal implements JournalStore {
  readonly #entries = new Map<string, JournalEntry>();
  /** "put <id>", "clear <id>", in call order. */
  readonly calls: string[] = [];
  /** Every run change a write carried, as `<id> <kind>`, in call order. */
  readonly changes: string[] = [];
  /** Set to make the next writes throw, like a full disk. */
  failWrites = false;

  put(entry: JournalEntry, change?: RunChange): void {
    if (this.failWrites) {
      throw new Error("disk full");
    }
    this.calls.push(`put ${entry.inputId}`);
    this.#change(entry.inputId, change);
    this.#entries.set(entry.inputId, structuredClone(entry));
  }

  get(inputId: string): JournalEntry | null {
    const entry = this.#entries.get(inputId);
    return entry === undefined ? null : structuredClone(entry);
  }

  clear(inputId: string, change?: RunChange): void {
    if (this.failWrites) {
      throw new Error("disk full");
    }
    this.calls.push(`clear ${inputId}`);
    this.#change(inputId, change);
    this.#entries.delete(inputId);
  }

  forInstance(instanceId: string): JournalEntry[] {
    return this.all().filter((entry) => entry.instanceId === instanceId);
  }

  all(): JournalEntry[] {
    return [...this.#entries.values()].map((entry) => structuredClone(entry));
  }

  /** What a runtime killed at this instant leaves behind: a copy the old one cannot touch. */
  snapshot(): MemoryJournal {
    const copy = new MemoryJournal();
    for (const entry of this.all()) {
      copy.put(entry);
    }
    copy.calls.length = 0;
    return copy;
  }

  #change(inputId: string, change: RunChange | undefined): void {
    if (change === undefined) {
      return;
    }
    const detail =
      change.kind === "journaled" || change.kind === "resent"
        ? change.name
        : change.kind === "presented"
          ? change.question
          : change.kind === "failed"
            ? change.reason
            : change.kind === "done"
              ? String(change.outcome?.notes.length ?? "-")
              : "";
    this.changes.push(`${inputId} ${change.kind} ${detail}`.trim());
  }

  close(): void {
    // Nothing to release.
  }
}
