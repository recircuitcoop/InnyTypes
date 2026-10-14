// Which files of one folder are new and finished writing (plan 0022 D18, WI-0022-25).
//
// A poll, not fs.watch: fs.watch fired nothing for files copied into a folder on macOS in this
// project's trials, and it differs per platform; a listing every SCAN_MS behaves the same on
// every one (the shape of the e2e fixture source, app/test/fixtures/folderflow/node.ts).
//
// The rules, per scan:
// - Only plain files directly in the folder count; folders inside it, hidden files (a leading
//   dot) and the names a download or an editor gives a file while it is still being written
//   (PARTIAL_NAMES) are never passed on.
// - A name not seen before waits until its size and modification time have not changed for
//   `settleMs` (the debounce): a file still being written or copied is never passed on half done.
// - Each new file is passed on once. Its name, size and time are then remembered in `seen.json`
//   inside the instance's data folder, so a restart passes on only what arrived while it was
//   stopped, never the same file twice. A name that disappears is forgotten, so a file put back
//   under the same name is new again; and a name whose size or time is not the one remembered
//   (a recorder reusing REC001 while this was stopped, or a file replaced under the same name
//   while it runs) is a new file too, passed on once it is quiet, then remembered as it is now.
// - Passed on first, written down after (`persist`), never the other way round: a file is never
//   lost. When `seen.json` cannot be written, the file is still passed on once (this process
//   remembers it), the write is tried again on every scan until it succeeds, and `persist`
//   returns the error meanwhile; only a restart before then can pass it on a second time, which is
//   better than never.
// - Only plain files: a symbolic link is never followed (lstat), so a link cannot pass on what
//   lies outside the folder.
// - The first time an instance runs (no `seen.json` for this folder), the files already there
//   are remembered without being passed on, unless `emitExisting` is set.

import * as fs from "node:fs";
import * as path from "node:path";

/** How often the folder is listed. */
export const SCAN_MS = 500;

/** The file a watcher remembers what it has passed on in, inside the instance's data folder. */
export const SEEN_FILE = "seen.json";

/** Names a file has while it is still being written: browsers, editors, sync tools. */
const PARTIAL_NAMES = [
  /\.part$/i,
  /\.partial$/i,
  /\.crdownload$/i,
  /\.download$/i,
  /\.tmp$/i,
  /\.swp$/i,
  /^~\$/,
  /~$/,
];

/** A text body is included up to this size; a larger or binary file is passed by path only. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface WatchSettings {
  readonly folder: string;
  /** Lower-case endings such as ".m4a"; empty for every file. */
  readonly extensions: readonly string[];
  readonly settleMs: number;
  readonly emitExisting: boolean;
}

/** What `folder.file.created.v1` carries for one new file. */
export interface CreatedFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  /** The file's modification time, ISO 8601. */
  readonly modified: string;
  /** The file's text when it is UTF-8 and at most MAX_BODY_BYTES; absent otherwise. */
  readonly body?: string;
}

interface Stamp {
  readonly size: number;
  readonly mtimeMs: number;
}

interface Pending extends Stamp {
  /** When this size and time were first seen. */
  readonly since: number;
}

interface SeenDocument {
  readonly folder: string;
  readonly files: Record<string, Stamp>;
}

/** The settings from a start frame's config, with the declaration's defaults. */
export function settingsOf(config: Readonly<Record<string, unknown>>): WatchSettings {
  const folder = typeof config["folder"] === "string" ? config["folder"].trim() : "";
  const extensions = Array.isArray(config["extensions"])
    ? config["extensions"]
        .filter((each): each is string => typeof each === "string" && each.trim() !== "")
        .map((each) => {
          const lower = each.trim().toLowerCase();
          return lower.startsWith(".") ? lower : `.${lower}`;
        })
    : [];
  const settleMs =
    typeof config["settle_ms"] === "number" && Number.isFinite(config["settle_ms"])
      ? config["settle_ms"]
      : 2000;
  return { folder, extensions, settleMs, emitExisting: config["emit_existing"] === true };
}

/** Whether a name is one this watcher ever passes on. */
export function wanted(name: string, extensions: readonly string[]): boolean {
  if (name.startsWith(".") || PARTIAL_NAMES.some((pattern) => pattern.test(name))) {
    return false;
  }
  if (extensions.length === 0) {
    return true;
  }
  const lower = name.toLowerCase();
  return extensions.some((ending) => lower.endsWith(ending));
}

/** The text of a small UTF-8 file; undefined for a large or binary one. */
function bodyOf(file: string, size: number): string | undefined {
  if (size > MAX_BODY_BYTES) {
    return undefined;
  }
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) {
      return undefined;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export class FolderWatcher {
  readonly #settings: WatchSettings;
  readonly #seenFile: string;
  readonly #seen: Map<string, Stamp>;
  readonly #pending = new Map<string, Pending>();
  /** True until the first scan of a folder this instance has no record of. */
  #baseline: boolean;
  /** Whether what this process remembers changed since `seen.json` was last written. */
  #dirty = false;

  constructor(settings: WatchSettings, dataDir: string) {
    this.#settings = settings;
    this.#seenFile = path.join(dataDir, SEEN_FILE);
    const remembered = this.#read();
    this.#seen = new Map(Object.entries(remembered?.files ?? {}));
    this.#baseline = remembered === null && !settings.emitExisting;
  }

  /** Whether the folder is there to be listed. */
  folderExists(): boolean {
    try {
      return fs.statSync(this.#settings.folder).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * One scan at `now` (ms): the files that are new and finished, by name; null when the folder
   * cannot be read (its permissions), which forgets nothing and passes nothing on.
   */
  scan(now: number): CreatedFile[] | null {
    const present = this.#list();
    if (present === null) {
      return null;
    }
    // Forget a name that went away, so the same name put back is a new file.
    for (const name of [...this.#seen.keys()]) {
      if (!present.has(name)) {
        this.#seen.delete(name);
        this.#dirty = true;
      }
    }
    for (const name of [...this.#pending.keys()]) {
      if (!present.has(name)) {
        this.#pending.delete(name);
      }
    }
    if (this.#baseline) {
      this.#baseline = false;
      for (const [name, stamp] of present) {
        this.#seen.set(name, stamp);
      }
      this.#dirty = true;
      return [];
    }
    const created: CreatedFile[] = [];
    for (const [name, stamp] of [...present].sort(([a], [b]) => a.localeCompare(b))) {
      // Early out: the very file already passed on, unchanged.
      const known = this.#seen.get(name);
      if (known !== undefined && known.size === stamp.size && known.mtimeMs === stamp.mtimeMs) {
        continue;
      }
      const pending = this.#pending.get(name);
      // First sight, or it changed since: the quiet period starts again.
      if (
        pending === undefined ||
        pending.size !== stamp.size ||
        pending.mtimeMs !== stamp.mtimeMs
      ) {
        this.#pending.set(name, { ...stamp, since: now });
        continue;
      }
      if (now - pending.since < this.#settings.settleMs) {
        continue;
      }
      this.#pending.delete(name);
      this.#seen.set(name, stamp);
      this.#dirty = true;
      created.push(this.#created(name, stamp));
    }
    return created;
  }

  /**
   * Write down what this process remembers, once what `scan` returned has been passed on.
   * Nothing to write is a success; a failed write is tried again on the next call.
   * Returns the error of a failed write, null otherwise.
   */
  persist(): Error | null {
    if (!this.#dirty) {
      return null;
    }
    try {
      this.#write();
    } catch (caught) {
      return caught instanceof Error ? caught : new Error(String(caught));
    }
    this.#dirty = false;
    return null;
  }

  /**
   * The wanted plain files in the folder now, by name; null when it cannot be read whole: the
   * listing fails, or an entry cannot be looked at for any reason but being gone (a folder whose
   * names can be listed but not its entries). A scan of null forgets nothing and writes nothing,
   * so a file it could not see is never taken for gone and passed on again later.
   */
  #list(): Map<string, Stamp> | null {
    const found = new Map<string, Stamp>();
    let names: string[];
    try {
      names = fs.readdirSync(this.#settings.folder);
    } catch {
      return null;
    }
    for (const name of names.filter((each) => wanted(each, this.#settings.extensions))) {
      try {
        // lstat: a symbolic link is not a plain file, and is never followed.
        const stat = fs.lstatSync(path.join(this.#settings.folder, name));
        if (stat.isFile()) {
          found.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
        }
      } catch (caught) {
        // Gone between the listing and the stat: the next scan says so. Anything else (EACCES):
        // the folder cannot be read whole, and this scan says nothing.
        if ((caught as NodeJS.ErrnoException).code !== "ENOENT") {
          return null;
        }
      }
    }
    return found;
  }

  #created(name: string, stamp: Stamp): CreatedFile {
    const file = path.join(this.#settings.folder, name);
    const body = bodyOf(file, stamp.size);
    return {
      name,
      path: file,
      size: stamp.size,
      modified: new Date(stamp.mtimeMs).toISOString(),
      ...(body === undefined ? {} : { body }),
    };
  }

  /** What this instance remembered of this folder; null when it has no record of it. */
  #read(): SeenDocument | null {
    try {
      const document = JSON.parse(fs.readFileSync(this.#seenFile, "utf8")) as SeenDocument;
      return document.folder === this.#settings.folder && typeof document.files === "object"
        ? document
        : null;
    } catch {
      return null;
    }
  }

  #write(): void {
    const document: SeenDocument = {
      folder: this.#settings.folder,
      files: Object.fromEntries(this.#seen),
    };
    // Written beside, then renamed over: a crash mid-write never leaves half a record.
    const partial = `${this.#seenFile}.writing`;
    fs.writeFileSync(partial, JSON.stringify(document));
    fs.renameSync(partial, this.#seenFile);
  }
}
