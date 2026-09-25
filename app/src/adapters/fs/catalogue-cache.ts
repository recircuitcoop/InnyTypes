// The CatalogueCacheStore over files (catalogue.py CatalogueCache; WI-0018-14): one
// `<source name>.json` per source in one directory. The directory is chosen by the composition
// root that wires the catalogue reader.
//
// The source name is the one place a registered name becomes a path, so it is checked here,
// not trusted from the settings: a name with a separator or `..` in it would be a path
// somewhere else. A read of anything unreadable is "nothing kept"; a forget that cannot remove
// is not an error. A write goes to a scratch file and is renamed over the entry.

import fs from "node:fs";
import * as path from "node:path";
import { CatalogueDocumentError, isAddonId } from "../../domain/packages/catalogue";
import type { CatalogueCacheStore } from "../../ports/catalogue-cache";

let scratchCounter = 0;

export class FileCatalogueCache implements CatalogueCacheStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  /** Where one source's catalogue is kept, refusing a name that is not a name. */
  pathFor(name: string): string {
    if (!isAddonId(name)) {
      throw new CatalogueDocumentError(
        "invalid",
        `"${name}" is not a well-formed source name, so it names no cache file: expected ` +
          "lowercase letters and digits joined by single hyphens",
      );
    }
    return path.join(this.#directory, `${name}.json`);
  }

  read(name: string): string | null {
    try {
      return fs.readFileSync(this.pathFor(name), "utf8");
    } catch {
      return null;
    }
  }

  write(name: string, text: string): void {
    const file = this.pathFor(name);
    fs.mkdirSync(this.#directory, { recursive: true });
    scratchCounter += 1;
    const scratch = `${file}.${String(process.pid)}.${String(scratchCounter)}.tmp`;
    try {
      fs.writeFileSync(scratch, text, "utf8");
      fs.renameSync(scratch, file);
    } catch (error) {
      fs.rmSync(scratch, { force: true });
      throw error;
    }
  }

  forget(name: string): void {
    try {
      fs.rmSync(this.pathFor(name), { force: true });
    } catch {
      // The caller is already on its way to the server, and a stale copy is refused again.
    }
  }
}
