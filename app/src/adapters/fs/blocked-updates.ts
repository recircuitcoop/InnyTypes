// The blocked package versions in one JSON file (ports/blocked-updates.ts; WI-0018-17). Written
// whole to a temporary file and renamed over the old one, as the content hashes are. A file that
// is not a record of versions is an error naming it, never an empty record: an empty one would
// let a machine apply, again, a version that already failed here.

import * as fs from "node:fs";
import * as path from "node:path";

import type { BlockedUpdates } from "../../ports/blocked-updates";

type Blocked = Record<string, Record<string, string>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class FsBlockedUpdates implements BlockedUpdates {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  reason(name: string, version: string): string | null {
    return this.#read()[name]?.[version] ?? null;
  }

  block(name: string, version: string, reason: string): void {
    const all = this.#read();
    all[name] = { ...all[name], [version]: reason };
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ blocked: all }, null, 2) + "\n");
    fs.renameSync(temporary, this.#file);
  }

  #read(): Blocked {
    let text: string;
    try {
      text = fs.readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw new Error(`${this.#file} is not JSON, so which updates failed here cannot be told`);
    }
    const blocked = isObject(document) ? document["blocked"] : undefined;
    if (
      !isObject(blocked) ||
      !Object.values(blocked).every(
        (versions) =>
          isObject(versions) && Object.values(versions).every((why) => typeof why === "string"),
      )
    ) {
      throw new Error(`${this.#file} is not a record of blocked versions`);
    }
    return blocked as Blocked;
  }
}
