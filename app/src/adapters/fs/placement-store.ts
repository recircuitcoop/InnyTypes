// Pop-out placements in one JSON file (WI-0018-11): `{"view:<type>": {x, y, width, height}}`.
// Read once, written whole on every change through a temporary file and a rename, so a crash
// mid-write leaves the old file. A file that is missing or unreadable is an empty one.

import * as fs from "node:fs";
import * as path from "node:path";

import { parsePlacements, type Bounds } from "../../domain/views/popout";
import type { PlacementStore } from "../../ports/placement-store";

/** The file's text, or null when it cannot be read (it is not there yet). */
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export class JsonPlacementStore implements PlacementStore {
  readonly #file: string;
  readonly #placements: Map<string, Bounds>;

  constructor(file: string) {
    this.#file = file;
    this.#placements = parsePlacements(readText(file));
  }

  get(key: string): Bounds | null {
    return this.#placements.get(key) ?? null;
  }

  set(key: string, bounds: Bounds): void {
    this.#placements.set(key, { ...bounds });
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.#placements), null, 2));
    fs.renameSync(temporary, this.#file);
  }
}
