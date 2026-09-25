// Installed packages on disk: build in staging, then swap (helper/environments.py, ported;
// ports/package-roots.ts; WI-0018-15).
//
// Three siblings under one base folder, so every swap is a rename within one filesystem, where
// it is atomic: `packages/<name>` (live), `staging/<name>`, `previous/<name>`. Staging is never
// inside the live root, so a half-built package is never found by whatever lists the live one.
// A swap that cannot complete puts the live package back; a folder with no `installed.json`
// is half-built and is refused before the first rename.

import * as fs from "node:fs";
import * as path from "node:path";

import type {
  InstalledRecord,
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
    fs.rmSync(folder.root, { recursive: true, force: true });
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
    fs.mkdirSync(this.live, { recursive: true });
    fs.mkdirSync(this.previous, { recursive: true });
    // The previous one from an earlier swap is spent: one is kept, the one this swap replaces.
    fs.rmSync(kept, { recursive: true, force: true });
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
    fs.rmSync(discarded, { recursive: true, force: true });
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
    fs.rmSync(discarded, { recursive: true, force: true });
    return live;
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
