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

import { entryFor, OFFICIAL_SOURCE_NAME, type CatalogueEntry } from "../domain/packages/catalogue";
import { PackageRefusal } from "../domain/packages/archive";
import type { Declaration } from "../domain/packages/declaration";
import type { UpdateMode } from "../domain/packages/versions";
import type { Logger } from "../ports/logger";
import type { InstalledOrigin, InstalledRecord } from "../ports/package-roots";
import {
  PackageCatalogues,
  packageNameOf,
  type CatalogueOffer,
  type CatalogueReads,
  type SourceListing,
} from "./package-catalogues";
import {
  buildPackageEnvironment,
  type BuiltPackage,
  type PackageEnvironmentPorts,
  type PackageOrigin,
} from "./package-environment";

export { MAX_ARCHIVE_BYTES, packageNameOf } from "./package-catalogues";
export type { CatalogueOffer, SourceListing } from "./package-catalogues";

/** What an install or a removal came to, in words for a person. */
export type PackageOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: string; readonly needsConfirmation?: true };

/** What the last update check says about one installed package (WI-0018-17). */
export interface UpdateLine {
  /**
   * `newer`: a newer version waits; `moved`: its content changed under the same version, and
   * is refused (plan 0013); `failed`: the update to `version` was rolled back, and is held;
   * `unchecked`: it could not be checked.
   */
  readonly kind: "newer" | "moved" | "failed" | "unchecked";
  /** The version at stake; null for `unchecked`. */
  readonly version: string | null;
  /** Why, in words for a person; null for a plain `newer`. */
  readonly detail: string | null;
  /** The person may press Apply: a newer version, not held, in `manual` mode. */
  readonly apply: boolean;
}

/** A package on the Packages page. */
export interface ListedPackage {
  readonly name: string;
  readonly version: string;
  readonly kind: "shipped" | "installed";
  /** False only for an installed package no publisher signed. */
  readonly signed: boolean;
  /** Where it was installed from, in words: `official`, a source's name, or a path. */
  readonly from: string | null;
  /** Its update mode in force; null for a shipped package, which updates with the app. */
  readonly mode: UpdateMode | null;
  /** What the last check found; null when it found nothing to say (or none has run). */
  readonly update: UpdateLine | null;
}

export interface PackagesState {
  readonly packages: readonly ListedPackage[];
  /** The official catalogue's offers. */
  readonly catalogue: readonly CatalogueOffer[];
  /** Why no catalogue could be listed; null when it was. */
  readonly catalogueProblem: string | null;
  /** The registered sources, in the settings' order, each with its offers or its problem. */
  readonly sources: readonly SourceListing[];
  /** Why the registered sources could not be read; null when they were. */
  readonly sourcesProblem: string | null;
  /** When the last update check ran (epoch ms); null when none has. */
  readonly checkedAt: number | null;
}

/**
 * The runtime restarted for new types, as the shell's supervisor does it: resolves with how
 * long it took, stop to running, or null when the runtime was not running to restart (it reads
 * the packages at its next start).
 */
export type RestartRuntime = (reason: string) => Promise<number | null>;

export interface PackageInstallerPorts extends CatalogueReads {
  readonly environment: PackageEnvironmentPorts;
  /** The packages shipped with the app, whose names an install never takes. */
  readonly shipped: () => readonly { readonly name: string; readonly version: string }[];
  readonly restartRuntime: RestartRuntime;
  readonly logger: Logger;
}

/** Where a package was installed from, as the Packages page says it. */
export function describeOrigin(origin: InstalledOrigin | undefined): string | null {
  if (origin === undefined) {
    return null;
  }
  return origin.kind === "catalogue" ? origin.source : origin.path;
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
  readonly #catalogues: PackageCatalogues;

  constructor(ports: PackageInstallerPorts, one: OneAtATime) {
    this.#ports = ports;
    this.#one = one;
    this.#catalogues = new PackageCatalogues(ports);
  }

  /**
   * What the Packages page lists: every package here, the official catalogue's offers and each
   * registered source's, in the settings' order. The update lines are the update check's
   * (application/update-package.ts), which fills `mode` and `update`.
   */
  async state(): Promise<PackagesState> {
    const installed = this.#ports.environment.roots.list();
    const packages: ListedPackage[] = [
      ...this.#ports.shipped().map(({ name, version }): ListedPackage => ({
        name,
        version,
        kind: "shipped",
        signed: true,
        from: null,
        mode: null,
        update: null,
      })),
      ...installed.map(({ record }): ListedPackage => ({
        name: record.package,
        version: record.version,
        kind: "installed",
        signed: record.signed,
        from: describeOrigin(record.origin),
        mode: null,
        update: null,
      })),
    ];
    const listings = await this.#catalogues.listings(
      new Set(packages.map((listed) => listed.name)),
    );
    return {
      packages,
      catalogue: listings.official,
      catalogueProblem: listings.officialProblem,
      sources: listings.sources,
      sourcesProblem: listings.sourcesProblem,
      checkedAt: null,
    };
  }

  /** Install the official catalogue's entry `id` from its signed archive. */
  installFromCatalogue(id: string): Promise<PackageOutcome> {
    return this.installFromSource(OFFICIAL_SOURCE_NAME, id, false);
  }

  /**
   * Install the entry `id` of the catalogue `source` (`official`, or a registered source's
   * name). A source registered with a key has its archive verified with it; a keyless one's is
   * unsigned, so it is refused unless `unverifiedConfirmed`, like a file. The official entry
   * wins: a registered source's entry for a package the official catalogue offers is refused.
   */
  installFromSource(
    source: string,
    id: string,
    unverifiedConfirmed: boolean,
  ): Promise<PackageOutcome> {
    return this.#one.run(`The install of ${id}`, async () => {
      const name = packageNameOf(id);
      const early = this.#refusedName(name);
      if (early !== null) {
        return this.#refused(id, early);
      }
      const official = source === OFFICIAL_SOURCE_NAME;
      if (!official && (await this.#catalogues.officialOffers(id))) {
        return this.#refused(
          id,
          `the official catalogue offers ${id} too, and its entry is the one installed`,
        );
      }
      let entry: CatalogueEntry | null;
      let key: string | null;
      try {
        const resolved = await this.#catalogues.resolve(source);
        entry = entryFor(resolved.catalogue, id);
        key = resolved.key;
      } catch (error) {
        return this.#refused(id, `the catalogue could not be read: ${(error as Error).message}`);
      }
      if (entry === null) {
        return this.#refused(id, "the catalogue does not list it");
      }
      if (official && (!entry.verified || key === null)) {
        // Every package from the official catalogue is verified against its key; with none,
        // nothing is.
        return this.#refused(id, "the catalogue is not signed, so nothing it offers is verified");
      }
      if (key === null && !unverifiedConfirmed) {
        return {
          ok: false,
          error:
            `${id} comes from ${source}, a source registered with no public key: nobody vouches ` +
            "for its code. It is installed only once you confirm that you want it anyway.",
          needsConfirmation: true,
        };
      }
      let saved: string;
      try {
        saved = await this.#catalogues.download(name, entry);
      } catch (error) {
        return this.#refused(id, (error as Error).message);
      }
      if (key === null) {
        this.#ports.logger.warn(`an unverified package is installed from ${source}, as confirmed`);
      }
      return this.#install({ kind: "archive", path: saved, publicKey: key }, name, {
        kind: "catalogue",
        source,
        id,
      });
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
      return this.#install(origin, null, { kind: "file", path: file });
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

  async #install(
    origin: PackageOrigin,
    expected: string | null,
    from: InstalledOrigin,
  ): Promise<PackageOutcome> {
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
      built = await buildPackageEnvironment(origin, this.#ports.environment, admit, from);
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
