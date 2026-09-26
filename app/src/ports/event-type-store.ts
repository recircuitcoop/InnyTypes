// The created event types (spec §9, plan 0018 §2.3 EventTypeStore; WI-0018-13).
//
// A version, once stored, is never changed (spec 5.2.2): the store has no update, and adding a
// version that is already there is refused. A schema change is a new version, added beside.

import type { EventTypeRecord } from "../domain/events/event-types";

export interface EventTypeStore {
  /** Every stored version. */
  list(): readonly EventTypeRecord[];
  /** Store a new version. Throws when that version is already stored: versions are immutable. */
  add(record: EventTypeRecord): void;
  /** Remove one version; false when it was not stored. */
  remove(type: string): boolean;
}
