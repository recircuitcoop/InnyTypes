// The created event types in one JSON file, `event-types.json` in the user's data (WI-0018-13),
// and the synthetic `user-events` package's declaration beside it (spec 9.5).
//
// Written whole on every change through a temporary file and a rename, so a crash mid-write
// leaves the old file. A missing file is an empty store. A file that cannot be read is left as
// it is: the store then lists nothing and refuses every change, rather than overwriting the
// types it could not read.

import * as fs from "node:fs";
import * as path from "node:path";

import type { EventTypeRecord } from "../../domain/events/event-types";
import type { Declaration } from "../../domain/packages/declaration";
import type { EventTypeStore } from "../../ports/event-type-store";
import { DECLARATION } from "./declared-package-store";

/** The file's format version. */
const FORMAT = 1;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isEventTypeRecord(value: unknown): value is EventTypeRecord {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["version"] === "number" &&
    typeof value["type"] === "string" &&
    typeof value["label"] === "string" &&
    isRecord(value["schema"]) &&
    typeof value["createdAt"] === "number"
  );
}

/** Freeze a record all the way down: nothing that holds one can change a stored version. */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) {
      frozen(inner);
    }
    Object.freeze(value);
  }
  return value;
}

/** Write `text` to `file` through a temporary file and a rename. */
function writeWhole(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

export class JsonEventTypeStore implements EventTypeStore {
  readonly #file: string;
  readonly #records: EventTypeRecord[] = [];
  /** Why the file could not be read; changes are then refused. */
  readonly #unreadable: string | null = null;

  constructor(file: string) {
    this.#file = file;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#unreadable = String(error);
      }
      return;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      const types = isRecord(parsed) && parsed["format"] === FORMAT ? parsed["types"] : null;
      if (!Array.isArray(types) || !types.every(isEventTypeRecord)) {
        throw new Error(`it is not format ${String(FORMAT)} of the event types`);
      }
      this.#records.push(...types.map(frozen));
    } catch (error) {
      this.#unreadable = (error as Error).message;
    }
  }

  /** Why the file could not be read, or null when it was (or was not there). */
  get problem(): string | null {
    return this.#unreadable === null ? null : `${this.#file} cannot be read: ${this.#unreadable}`;
  }

  list(): readonly EventTypeRecord[] {
    return [...this.#records];
  }

  add(record: EventTypeRecord): void {
    this.#writable();
    if (this.#records.some((stored) => stored.type === record.type)) {
      throw new Error(`${record.type} is already stored; a version is never changed`);
    }
    this.#records.push(frozen(structuredClone(record)));
    this.#save();
  }

  remove(type: string): boolean {
    this.#writable();
    const index = this.#records.findIndex((stored) => stored.type === type);
    if (index < 0) {
      return false;
    }
    this.#records.splice(index, 1);
    this.#save();
    return true;
  }

  #writable(): void {
    const problem = this.problem;
    if (problem !== null) {
      throw new Error(`${problem}; it is left as it is, and nothing is changed`);
    }
  }

  #save(): void {
    writeWhole(this.#file, JSON.stringify({ format: FORMAT, types: this.#records }, null, 2));
  }
}

/** Write the `user-events` package's declaration into `folder` (regenerated on every start). */
export function writeDeclaration(folder: string, declaration: Declaration): void {
  writeWhole(path.join(folder, DECLARATION), JSON.stringify(declaration, null, 2));
}
