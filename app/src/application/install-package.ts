// Installing a node package, only because a person asked (addons/install.py, ported and
// reshaped; plan 0018 §3; WI-0018-16).
//
// Two ways in, both from the Packages page:
//
// - from the catalogue: the entry's signed archive is fetched over HTTPS and verified against
//   the key the catalogue was verified with;
// - from a file, for developers: a package folder or a `.tgz`, unsigned. Nobody vouches for
//   its code, so it is refused unless the person confirmed exactly that, and it is recorded
//   unsigned and marked so wherever it is listed.
//
// Either way the package is verified whole in memory (application/package-environment.ts), and
// only then written: to staging, built, then swapped into the live root the runtime reads
// (spec 11.4). A second install of an installed name is refused (install.py: remove it first;
// updating is WI-0018-17's), as is the name of a package shipped with the app. Then only the
// runtime restarts (arch_pivot P9f, P11a), and its time is logged; the editor's palette catches
// up by itself (WI-0018-12).
//
// One install or removal at a time: a second one asked for while one runs is refused, never
// queued behind it.

import { entryFor, type PackageCatalogue } from "../domain/packages/catalogue";
import { PackageRefusal } from "../domain/packages/archive";
import type { Declaration } from "../domain/packages/declaration";
import type { HttpClient } from "../ports/http-client";
import type { Logger } from "../ports/logger";
import type { InstalledRecord } from "../ports/package-roots";
import {
  buildPackageEnvironment,
  type BuiltPackage,
  type PackageEnvironmentPorts,
  type PackageOrigin,
} from "./package-environment";

/** The largest package archive fetched from a catalogue; one byte more and it is abandoned. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** What an install or a removal came to, in words for a person. */
export type PackageOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: string; readonly needsConfirmation?: true };

/** A package on the Packages page. */
export interface ListedPackage {
  readonly name: string;
  readonly version: string;
  readonly kind: "shipped" | "installed";
  /** False only for an installed package no publisher signed. */
  readonly signed: boolean;
}

/** One catalogue entry on the Packages page. */
export interface CatalogueOffer {
  readonly id: string;
  /** The package name it installs as. */
  readonly name: string;
  readonly summary: string;
  /** It names an archive this build can install. */
  readonly installable: boolean;
  readonly installed: boolean;
  /** The catalogue carried a signature that checked out. */
  readonly verified: boolean;
}

export interface PackagesState {
  readonly packages: readonly ListedPackage[];
  readonly catalogue: readonly CatalogueOffer[];
  /** Why no catalogue could be listed; null when it was. */
  readonly catalogueProblem: string | null;
}

/**
 * The runtime restarted for new types, as the shell's supervisor does it: resolves with how
 * long it took, stop to running, or null when the runtime was not running to restart (it reads
 * the packages at its next start).
 */
export type RestartRuntime = (reason: string) => Promise<number | null>;

export interface PackageInstallerPorts {
  readonly environment: PackageEnvironmentPorts;
  /** The official catalogue, read (cache first); rejects with the reason it could not be. */
  readonly catalogue: () => Promise<PackageCatalogue>;
  /** The key the official catalogue and its packages are verified with; null in a build with none. */
  readonly catalogueKey: string | null;
  readonly http: HttpClient;
  /** Keep a fetched archive on disk, and answer where; the installer reads it from there. */
  readonly saveDownload: (name: string, bytes: Uint8Array) => string;
  /** The packages shipped with the app, whose names an install never takes. */
  readonly shipped: () => readonly { readonly name: string; readonly version: string }[];
  readonly restartRuntime: RestartRuntime;
  readonly logger: Logger;
}

/** A catalogue id (`my-package`) as the package name it installs as (`my_package`). */
export function packageNameOf(id: string): string {
  return id.replace(/-/g, "_");
}

/** Whether a file names a package archive rather than a package folder. */
export function isArchiveFile(file: string): boolean {
  return /\.(tgz|tar\.gz)$/i.test(file);
}

/** One install or removal at a time, across both use cases. */
export class OneAtATime {
  #running: string | null = null;

  async run(what: string, work: () => Promise<PackageOutcome>): Promise<PackageOutcome> {
    if (this.#running !== null) {
      return {
        ok: false,
        error: `${this.#running} is still going on; try again once it has finished.`,
      };
    }
    this.#running = what;
    try {
      return await work();
    } finally {
      this.#running = null;
    }
  }
}

export class PackageInstaller {
  readonly #ports: PackageInstallerPorts;
  readonly #one: OneAtATime;

  constructor(ports: PackageInstallerPorts, one: OneAtATime) {
    this.#ports = ports;
    this.#one = one;
  }

  /** What the Packages page lists: every package here, and what the catalogue offers. */
  async state(): Promise<PackagesState> {
    const installed = this.#ports.environment.roots.list();
    const packages: ListedPackage[] = [
      ...this.#ports.shipped().map(({ name, version }): ListedPackage => ({
        name,
        version,
        kind: "shipped",
        signed: true,
      })),
      ...installed.map(({ record }): ListedPackage => ({
        name: record.package,
        version: record.version,
        kind: "installed",
        signed: record.signed,
      })),
    ];
    const names = new Set(packages.map((listed) => listed.name));
    let catalogue: PackageCatalogue;
    try {
      catalogue = await this.#ports.catalogue();
    } catch (error) {
      return { packages, catalogue: [], catalogueProblem: (error as Error).message };
    }
    return {
      packages,
      catalogue: catalogue.entries.map((entry) => ({
        id: entry.packageId,
        name: packageNameOf(entry.packageId),
        summary: entry.summary,
        installable: entry.archive !== undefined,
        installed: names.has(packageNameOf(entry.packageId)),
        verified: entry.verified,
      })),
      catalogueProblem: null,
    };
  }

  /** Install the catalogue's entry `id` from its signed archive. */
  installFromCatalogue(id: string): Promise<PackageOutcome> {
    return this.#one.run(`The install of ${id}`, async () => {
      const name = packageNameOf(id);
      const early = this.#refusedName(name);
      if (early !== null) {
        return this.#refused(id, early);
      }
      let catalogue: PackageCatalogue;
      try {
        catalogue = await this.#ports.catalogue();
      } catch (error) {
        return this.#refused(id, `the catalogue could not be read: ${(error as Error).message}`);
      }
      const entry = entryFor(catalogue, id);
      if (entry === null) {
        return this.#refused(id, "the catalogue does not list it");
      }
      if (entry.archive === undefined) {
        return this.#refused(
          id,
          `its catalogue entry names only "${entry.installSource}", and this build installs ` +
            "packages from a signed archive only",
        );
      }
      const key = this.#ports.catalogueKey;
      if (!entry.verified || key === null) {
        // Every package from the catalogue is verified against its key; with none, nothing is.
        return this.#refused(id, "the catalogue is not signed, so nothing it offers is verified");
      }
      const fetched = await this.#ports.http.get(entry.archive, { maxBytes: MAX_ARCHIVE_BYTES });
      if (!fetched.ok) {
        return this.#refused(id, `its archive could not be fetched: ${fetched.detail}`);
      }
      const saved = this.#ports.saveDownload(name, fetched.body);
      return this.#install({ kind: "archive", path: saved, publicKey: key }, name);
    });
  }

  /**
   * Install a package folder or `.tgz` a developer chose. It is unsigned, so it is refused
   * unless `unsignedConfirmed`: the person was told nobody vouches for it, and went ahead.
   */
  installFromFile(file: string, unsignedConfirmed: boolean): Promise<PackageOutcome> {
    if (!unsignedConfirmed) {
      return Promise.resolve({
        ok: false,
        error:
          `${file} is not signed: nobody vouches for its code. It is installed only once you ` +
          "confirm that you want it anyway.",
        needsConfirmation: true,
      });
    }
    return this.#one.run(`The install of ${file}`, () => {
      this.#ports.logger.warn(`an unsigned package is installed from ${file}, as confirmed`);
      const origin: PackageOrigin = isArchiveFile(file)
        ? { kind: "archive", path: file, publicKey: null }
        : { kind: "path", folder: file };
      return this.#install(origin, null);
    });
  }

  /** Why `name` cannot be installed now, or null. */
  #refusedName(name: string): string | null {
    if (this.#ports.shipped().some((shipped) => shipped.name === name)) {
      return `${name} is the name of a package shipped with InnyTypes`;
    }
    let installed: InstalledRecord | undefined;
    try {
      installed = this.#ports.environment.roots.installed(name);
    } catch (error) {
      // A record nobody can read is still an installation: refusing is what protects it.
      return `${name} is installed, and its record cannot be read (${(error as Error).message}); remove it first`;
    }
    if (installed !== undefined) {
      return `${name} ${installed.version} is already installed; remove it first`;
    }
    return null;
  }

  async #install(origin: PackageOrigin, expected: string | null): Promise<PackageOutcome> {
    // Judged on the verified declaration, before anything is written.
    const admit = (declaration: Declaration): void => {
      if (expected !== null && declaration.package !== expected) {
        throw new PackageRefusal(
          "declaration",
          `the catalogue offers ${expected}, and the archive declares ${declaration.package}`,
        );
      }
      const refused = this.#refusedName(declaration.package);
      if (refused !== null) {
        throw new PackageRefusal(
          refused.endsWith("remove it first") ? "installed" : "reserved",
          refused,
        );
      }
    };
    let built: BuiltPackage;
    try {
      built = await buildPackageEnvironment(origin, this.#ports.environment, admit);
    } catch (error) {
      // buildPackageEnvironment has logged the refusal with its reason.
      return { ok: false, error: `Not installed: ${(error as Error).message}` };
    }
    const { package: name, version, signed } = built.record;
    const took = await this.#ports.restartRuntime(`${name} was installed`);
    const restart =
      took === null
        ? "the runtime was not running, and loads it when it starts"
        : `only the runtime restarted, in ${String(took)} ms`;
    this.#ports.logger.info(
      `install: ${name} ${version} is live${signed ? "" : " (unsigned)"}; ${restart} (P11a)`,
    );
    return {
      ok: true,
      message: `${name} ${version} is installed${signed ? "" : ", unsigned"}. Its types are in the editor's palette.`,
    };
  }

  #refused(what: string, why: string): PackageOutcome {
    this.#ports.logger.warn(`install: ${what} was refused: ${why}`);
    return { ok: false, error: `Not installed: ${why}.` };
  }
}
