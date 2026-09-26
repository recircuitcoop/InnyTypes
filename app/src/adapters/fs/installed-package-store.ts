// The package store the runtime and the shell read (WI-0018-16): the first-party packages
// shipped with the app, as before, plus every package the installer verified and swapped into
// the live root, each run from its own environment (spec 11.4; plan 0018 §3, the discovery.py
// row: "enumerates installed packages from records written at install").
//
// An installed package is found only by its record, written last at install: a folder with no
// record, or files dropped into the live root by anything but the installer, is not a package.
// A shipped package's name wins; the installer refuses such a name, so a clash is only ever a
// tampered live root, and is said.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../../ports/logger";
import type { PackageRoots } from "../../ports/package-roots";
import type { PackageStore } from "../../ports/package-store";
import {
  DECLARATION,
  type DeclaredDocument,
  type DeclaredPackageStore,
} from "./declared-package-store";

/** A package as the runtime starts it: where its files are, and its own `{python}`. */
export interface StoredPackage extends DeclaredDocument {
  /** The package's own interpreter, for a uv-python package; absent otherwise. */
  readonly python?: string;
  /** Installed by the installer (not shipped with the app). */
  readonly installed: boolean;
  /** For an installed package: whether a publisher's signature covered it. */
  readonly signed: boolean;
}

export class InstalledPackageStore implements PackageStore {
  readonly #shipped: DeclaredPackageStore;
  readonly #roots: PackageRoots;
  readonly #logger: Logger;
  readonly #said = new Set<string>();

  constructor(shipped: DeclaredPackageStore, roots: PackageRoots, logger: Logger) {
    this.#shipped = shipped;
    this.#roots = roots;
    this.#logger = logger;
  }

  packages(): readonly string[] {
    return this.documents().map((stored) => stored.name);
  }

  /** The shipped packages' names: never taken by an install. */
  shippedNames(): readonly string[] {
    return this.#shipped.packages();
  }

  documents(): readonly StoredPackage[] {
    const found = new Map<string, StoredPackage>();
    for (const shipped of this.#shipped.documents()) {
      found.set(shipped.name, { ...shipped, installed: false, signed: true });
    }
    for (const { record, folder } of this.#roots.list()) {
      if (found.has(record.package)) {
        this.#warnOnce(
          `installed package ${record.package} has the name of a package shipped with the app; ` +
            "it is left out",
        );
        continue;
      }
      let document: unknown;
      try {
        document = JSON.parse(fs.readFileSync(path.join(folder.packageDir, DECLARATION), "utf8"));
      } catch (error) {
        this.#warnOnce(`installed package ${record.package} cannot be read: ${String(error)}`);
        continue;
      }
      found.set(record.package, {
        name: record.package,
        folder: folder.packageDir,
        document,
        installed: true,
        signed: record.signed,
        ...(record.python === undefined
          ? {}
          : { python: path.join(folder.root, ...record.python.split("/")) }),
      });
    }
    return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  #warnOnce(message: string): void {
    if (!this.#said.has(message)) {
      this.#said.add(message);
      this.#logger.warn(message);
    }
  }
}
