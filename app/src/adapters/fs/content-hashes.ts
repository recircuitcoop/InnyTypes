// The content hash of every package version installed on this machine, in one JSON file
// (ports/content-hashes.ts; plan 0013; WI-0018-15). Written whole to a temporary file and
// renamed over the old one, so a crash leaves the old record or the new, never half of one.

import * as fs from "node:fs";
import * as path from "node:path";

import type { ContentHashes } from "../../ports/content-hashes";

type Recorded = Record<string, Record<string, string>>;

export class FsContentHashes implements ContentHashes {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  recorded(name: string, version: string): string | undefined {
    return this.#read()[name]?.[version];
  }

  record(name: string, version: string, hash: string): void {
    const all = this.#read();
    const existing = all[name]?.[version];
    if (existing === hash) {
      return;
    }
    if (existing !== undefined) {
      throw new Error(
        `${name} ${version} already has content hash ${existing} recorded; it is never replaced`,
      );
    }
    all[name] = { ...all[name], [version]: hash };
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ packages: all }, null, 2) + "\n");
    fs.renameSync(temporary, this.#file);
  }

  #read(): Recorded {
    let text: string;
    try {
      text = fs.readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
    const document = JSON.parse(text) as { packages?: Recorded };
    return document.packages ?? {};
  }
}
