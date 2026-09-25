// Where pop-out placements are remembered, per view type (WI-0018-11): a JSON file in the
// app's user data (adapters/fs/placement-store.ts).

import type { Bounds } from "../domain/views/popout";

export interface PlacementStore {
  /** The bounds last left for `key` (domain/views/popout `placementKey`); null when none. */
  get(key: string): Bounds | null;
  /** Remember `bounds` for `key`; durable when it returns. */
  set(key: string, bounds: Bounds): void;
}
