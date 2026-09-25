// Where installed packages and their environments live, and how a new one is swapped in
// (helper/environments.py, ported; plan 0018 §3; WI-0018-15).
//
// Three sibling roots, never one inside another: `packages` (live), `staging` (being built)
// and `previous` (what the last swap replaced). One package is one folder in each, holding
// `package/` (its verified files), `environment/` (what the builder made) and `installed.json`
// (the record, written last). A swap is two renames on one filesystem, and a folder with no
// record is a half-built one that is never swapped in.

/** What an install records beside the package, last, once everything else is built. */
export interface InstalledRecord {
  readonly package: string;
  readonly version: string;
  readonly contentHash: string;
  readonly environment: "uv-python" | "node" | "executable";
  /** `{python}` for a uv-python package, relative to the package's folder (`/` separators). */
  readonly python?: string;
}

/** One package's folder in one of the roots. */
export interface PackageFolder {
  readonly root: string;
  /** `{package}`: the verified files. */
  readonly packageDir: string;
  readonly environmentDir: string;
}

/** The outcome of a swap: where the package now lives, and where its old folder went. */
export interface Swapped {
  readonly live: string;
  /** null when there was nothing to replace, which is the one swap that cannot be rolled back. */
  readonly previous: string | null;
}

export interface PackageRoots {
  /**
   * A fresh staging folder for `name`, empty but for `package/` and `environment/`. A staged
   * build left behind by an abandoned install is scrap and is replaced.
   */
  stage(name: string): PackageFolder;
  /** Write verified files under `packageDir`. */
  writeFiles(packageDir: string, files: ReadonlyMap<string, Uint8Array>): void;
  /** Write the record that marks a staged folder complete. */
  writeRecord(folder: PackageFolder, record: InstalledRecord): void;
  /**
   * Make the staged `name` live, keeping the one it replaced. Refuses, touching nothing, when
   * nothing complete is staged.
   */
  swapIn(name: string): Swapped;
  /** Put back what the last swap replaced. Refuses when nothing is kept. */
  rollBack(name: string): string;
  /** The live record of `name`, or undefined when it is not installed. */
  installed(name: string): InstalledRecord | undefined;
}
