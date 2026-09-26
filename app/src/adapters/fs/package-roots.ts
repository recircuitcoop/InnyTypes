// Installed packages on disk: build in staging, then swap (helper/environments.py, ported;
// ports/package-roots.ts; WI-0018-15).
//
// Three siblings under one base folder, so every swap is a rename within one filesystem, where
// it is atomic: `packages/<name>` (live), `staging/<name>`, `previous/<name>`. Staging is never
// inside the live root, so a half-built package is never found by whatever lists the live one.
// A swap that cannot complete puts the live package back; a folder with no `installed.json`
// is half-built and is refused before the first rename.
//
// The live root is sealed (WI-0018-16, spec 11.4): every folder in it is 0555 and every file
// loses its write bits, so a node process, which runs as the same user, cannot write into the
// folder the runtime reads packages from, nor into its own package. Only the installer unseals
// what it is about to change, and seals it again at once. On Windows only files are made
// read-only; a folder's mode is not enforced there.

import * as fs from "node:fs";
import * as path from "node:path";

import type {
  InstalledRecord,
  LivePackage,
  PackageFolder,
  PackageRoots,
  Swapped,
} from "../../ports/package-roots";

export const LIVE_DIRNAME = "packages";
export const STAGING_DIRNAME = "staging";
export const PREVIOUS_DIRNAME = "previous";
export const RECORD_FILENAME = "installed.json";
const PACKAGE_DIRNAME = "package";
const ENVIRONMENT_DIRNAME = "environment";

/** Spec 2.1: the package name, which is also a folder name here. */
const PACKAGE_NAME = /^[a-z][a-z0-9_]{1,39}$/;

/** A swap or rollback that did not happen; the live package is where it was. */
export class SwapError extends Error {
  override name = "SwapError";
}

function folderIn(root: string): PackageFolder {
  return {
    root,
    packageDir: path.join(root, PACKAGE_DIRNAME),
    environmentDir: path.join(root, ENVIRONMENT_DIRNAME),
  };
}

/** One path's mode changed; links are left alone (chmod would follow them). */
function chmodOne(target: string, sealed: boolean): void {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    fs.chmodSync(target, sealed ? 0o555 : 0o755);
    return;
  }
  const mode = stat.mode & 0o777;
  fs.chmodSync(target, sealed ? mode & ~0o222 : mode | 0o200);
}

/** A whole tree sealed (read-only) or unsealed (owner-writable again). */
function chmodTree(root: string, sealed: boolean): void {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink()) {
    return;
  }
  if (!sealed) {
    // Top down: a folder is made writable before what is in it is looked at.
    chmodOne(root, false);
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) {
      chmodTree(path.join(root, entry), sealed);
    }
  }
  if (sealed) {
    // Bottom up: a folder is sealed after what is in it.
    chmodOne(root, true);
  }
}

/** Make a sealed tree removable again; tests and the remover call it before deleting. */
export function unsealTree(root: string): void {
  chmodTree(root, false);
}

/** Delete a tree that may be sealed. */
function removeTree(root: string): void {
  unsealTree(root);
  fs.rmSync(root, { recursive: true, force: true });
}

export class FsPackageRoots implements PackageRoots {
  readonly live: string;
  readonly staging: string;
  readonly previous: string;

  constructor(base: string) {
    this.live = path.join(base, LIVE_DIRNAME);
    this.staging = path.join(base, STAGING_DIRNAME);
    this.previous = path.join(base, PREVIOUS_DIRNAME);
  }

  stage(name: string): PackageFolder {
    const folder = folderIn(this.#in(this.staging, name));
    // A staged build left behind is scrap: refusing to replace it would strand the package on
    // a build nobody asked to keep.
    removeTree(folder.root);
    fs.mkdirSync(folder.packageDir, { recursive: true });
    fs.mkdirSync(folder.environmentDir, { recursive: true });
    return folder;
  }

  writeFiles(packageDir: string, files: ReadonlyMap<string, Uint8Array>): void {
    for (const [file, bytes] of files) {
      const target = path.join(packageDir, ...file.split("/"));
      if (!target.startsWith(packageDir + path.sep)) {
        throw new Error(`${file} would be written outside the package`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { mode: 0o644 });
    }
  }

  writeRecord(folder: PackageFolder, record: InstalledRecord): void {
    fs.writeFileSync(
      path.join(folder.root, RECORD_FILENAME),
      JSON.stringify(record, null, 2) + "\n",
    );
  }

  swapIn(name: string): Swapped {
    const staged = this.#in(this.staging, name);
    const live = this.#in(this.live, name);
    const kept = this.#in(this.previous, name);
    if (!fs.existsSync(path.join(staged, RECORD_FILENAME))) {
      throw new SwapError(
        `nothing complete is staged for ${name} at ${staged}: a folder with no ` +
          `${RECORD_FILENAME} is half-built, and swapping it in would replace a working package`,
      );
    }
    fs.mkdirSync(this.previous, { recursive: true });
    return this.#unsealedLive(name, () => {
      // The previous one from an earlier swap is spent: one is kept, the one this swap replaces.
      removeTree(kept);
      const replaced = fs.existsSync(live);
      if (replaced) {
        this.#rename(live, kept, name);
      }
      try {
        this.#rename(staged, live, name);
      } catch (error) {
        // The first rename happened and the second did not: put the old package back.
        if (replaced) {
          this.#rename(kept, live, name);
        }
        throw error;
      }
      return { live, previous: replaced ? kept : null };
    });
  }

  rollBack(name: string): string {
    const kept = this.#in(this.previous, name);
    const live = this.#in(this.live, name);
    if (!fs.existsSync(kept)) {
      throw new SwapError(
        `${name} cannot be rolled back: nothing is kept for it at ${kept}; no swap replaced one`,
      );
    }
    const discarded = `${kept}.rolled-back`;
    removeTree(discarded);
    return this.#unsealedLive(name, () => {
      // A folder moved to another parent needs its own write bit (its `..` changes).
      chmodOne(kept, false);
      const moved = fs.existsSync(live);
      if (moved) {
        this.#rename(live, discarded, name);
      }
      try {
        this.#rename(kept, live, name);
      } catch (error) {
        if (moved) {
          this.#rename(discarded, live, name);
        }
        throw error;
      }
      removeTree(discarded);
      return live;
    });
  }

  installed(name: string): InstalledRecord | undefined {
    try {
      const text = fs.readFileSync(path.join(this.#in(this.live, name), RECORD_FILENAME), "utf8");
      return JSON.parse(text) as InstalledRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  list(): readonly LivePackage[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.live).filter((name) => PACKAGE_NAME.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const found: LivePackage[] = [];
    for (const name of names.sort()) {
      let record: InstalledRecord | undefined;
      try {
        record = this.installed(name);
      } catch {
        // A record that cannot be read lists nothing; the installer still refuses the name.
        continue;
      }
      // A folder with no record is not an installed package, whatever else it holds.
      if (record !== undefined) {
        found.push({ record, folder: folderIn(path.join(this.live, name)) });
      }
    }
    return found;
  }

  remove(name: string): void {
    const live = this.#in(this.live, name);
    const kept = this.#in(this.previous, name);
    removeTree(kept);
    if (!fs.existsSync(live)) {
      return;
    }
    this.#unsealedLive(name, () => {
      // The record first: a removal cut short leaves a folder nothing lists or starts.
      fs.rmSync(path.join(live, RECORD_FILENAME), { force: true });
      removeTree(live);
    });
  }

  /**
   * Run `change` with the live root and `name`'s live folder writable, then seal the live root
   * and whatever `name` now is in it, whether `change` succeeded or not.
   */
  #unsealedLive<T>(name: string, change: () => T): T {
    const live = this.#in(this.live, name);
    fs.mkdirSync(this.live, { recursive: true });
    chmodOne(this.live, false);
    chmodOne(live, false);
    try {
      return change();
    } finally {
      chmodTree(live, true);
      chmodOne(this.live, true);
    }
  }

  /** One package's folder under a root; the name is judged, so it cannot leave the root. */
  #in(root: string, name: string): string {
    if (!PACKAGE_NAME.test(name)) {
      throw new Error(`${JSON.stringify(name)} is not a package name`);
    }
    return path.join(root, name);
  }

  #rename(source: string, destination: string, name: string): void {
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      throw new SwapError(
        `${name}: ${source} could not be moved to ${destination}: ${String(error)}. A package ` +
          "is swapped by renaming it, which needs both paths on one filesystem.",
      );
    }
  }
}
