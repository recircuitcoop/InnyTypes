// Every catalogue the Packages page lists, and the one a package is fetched from (plan 0006 F1;
// helper/plugin_lists.py, replaced; WI-0018-17).
//
// Three lists, in the order the settings hold them: what is installed, the official catalogue,
// then each registered source (the page draws the first; this file reads the other two). Each
// source is read on its own: one that is down, unsigned or lying is listed with what went wrong,
// and every other list is drawn as it is (plugin_lists.py's one failed group).
//
// The official entry wins over a same-named one elsewhere, without hiding it: a registered
// source's entry for a package the official catalogue also offers is listed, named as its
// source's, and not installable, saying the official one is the one installed. A shadow is
// never silently dropped: a person who registered a source should see what it offers, and why
// one of its entries is not the one this machine would install.
//
// Only a keyless source is unverified. A source registered with a key has its catalogue and its
// archives checked against that key, as the official one is against the key shipped with the app.

import {
  entryFor,
  OFFICIAL_SOURCE_NAME,
  type CatalogueEntry,
  type CatalogueSource,
  type PackageCatalogue,
} from "../domain/packages/catalogue";
import type { HttpClient } from "../ports/http-client";

/** The largest package archive fetched from a catalogue; one byte more and it is abandoned. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** A catalogue id (`my-package`) as the package name it installs as (`my_package`). */
export function packageNameOf(id: string): string {
  return id.replace(/-/g, "_");
}

export interface CatalogueReads {
  /** The official catalogue, read (cache first); rejects with the reason it could not be. */
  readonly catalogue: () => Promise<PackageCatalogue>;
  /** The key the official catalogue and its packages are verified with; null in a build with none. */
  readonly catalogueKey: string | null;
  /** The registered sources, in the settings' order; throws when the settings cannot be read. */
  readonly sources: () => readonly CatalogueSource[];
  /** One registered source's catalogue; rejects with the reason it could not be read. */
  readonly registered: (source: CatalogueSource) => Promise<PackageCatalogue>;
  readonly http: HttpClient;
  /** Keep a fetched archive on disk, and answer where; the installer reads it from there. */
  readonly saveDownload: (name: string, bytes: Uint8Array) => string;
}

/** One catalogue, resolved: its entries, and the key its archives are verified with. */
export interface ResolvedCatalogue {
  readonly catalogue: PackageCatalogue;
  /** null: a keyless source, whose archives nobody vouches for. */
  readonly key: string | null;
}

/** One entry as the page offers it. */
export interface CatalogueOffer {
  readonly id: string;
  /** The package name it installs as. */
  readonly name: string;
  readonly summary: string;
  /** The catalogue it came from: `official` or a registered source's name. */
  readonly source: string;
  /** The version its entry names; null when it names none. */
  readonly version: string | null;
  /** It names an archive this build can install. */
  readonly installable: boolean;
  readonly installed: boolean;
  /** The catalogue carried a signature that checked out. */
  readonly verified: boolean;
  /** Why it cannot be installed from here although it names an archive; null when it can. */
  readonly shadowedBy: string | null;
}

/** A registered source as the page lists it. */
export interface SourceListing {
  readonly name: string;
  readonly url: string;
  /** Who publishes it: the host its catalogue is served from. */
  readonly publisher: string;
  /** Whether a public key was registered with it; a keyless source is unverified. */
  readonly keyed: boolean;
  /** Its auto-update switch: true, false, or null (no opinion: the default decides). */
  readonly autoUpdate: boolean | null;
  readonly offers: readonly CatalogueOffer[];
  /** Why its catalogue could not be listed; null when it was. */
  readonly problem: string | null;
}

export interface CatalogueListings {
  readonly official: readonly CatalogueOffer[];
  readonly officialProblem: string | null;
  readonly sources: readonly SourceListing[];
  /** Why the registered sources could not be read from the settings; null when they were. */
  readonly sourcesProblem: string | null;
}

function offersOf(
  catalogue: PackageCatalogue,
  installed: ReadonlySet<string>,
  official: ReadonlySet<string>,
): CatalogueOffer[] {
  return catalogue.entries.map((entry) => {
    const shadowed = catalogue.name !== OFFICIAL_SOURCE_NAME && official.has(entry.packageId);
    return {
      id: entry.packageId,
      name: packageNameOf(entry.packageId),
      summary: entry.summary,
      source: catalogue.name,
      version: entry.version ?? null,
      installable: entry.archive !== undefined && !shadowed,
      installed: installed.has(packageNameOf(entry.packageId)),
      verified: entry.verified,
      shadowedBy: shadowed ? OFFICIAL_SOURCE_NAME : null,
    };
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class PackageCatalogues {
  readonly #reads: CatalogueReads;

  constructor(reads: CatalogueReads) {
    this.#reads = reads;
  }

  /** The official list and every registered one, each read on its own. */
  async listings(installed: ReadonlySet<string>): Promise<CatalogueListings> {
    let official: PackageCatalogue | null = null;
    let officialProblem: string | null = null;
    try {
      official = await this.#reads.catalogue();
    } catch (error) {
      officialProblem = reasonOf(error);
    }
    const officialIds = new Set(official?.entries.map((entry) => entry.packageId) ?? []);

    let sources: readonly CatalogueSource[] = [];
    let sourcesProblem: string | null = null;
    try {
      sources = this.#reads.sources();
    } catch (error) {
      sourcesProblem = `the registered sources cannot be read: ${reasonOf(error)}`;
    }
    const listings = await Promise.all(
      sources.map(async (source): Promise<SourceListing> => {
        const listed = {
          name: source.name,
          url: source.url,
          publisher: hostOf(source.url),
          keyed: source.publicKey !== null,
          autoUpdate: source.autoUpdate,
        };
        try {
          const catalogue = await this.#reads.registered(source);
          return { ...listed, offers: offersOf(catalogue, installed, officialIds), problem: null };
        } catch (error) {
          return { ...listed, offers: [], problem: reasonOf(error) };
        }
      }),
    );
    return {
      official: official === null ? [] : offersOf(official, installed, officialIds),
      officialProblem,
      sources: listings,
      sourcesProblem,
    };
  }

  /** The registered source `name`, or null. Throws when the settings cannot be read. */
  source(name: string): CatalogueSource | null {
    return this.#reads.sources().find((source) => source.name === name) ?? null;
  }

  /** The catalogue called `name` (`official` or a registered source); rejects with why not. */
  async resolve(name: string): Promise<ResolvedCatalogue> {
    if (name === OFFICIAL_SOURCE_NAME) {
      return { catalogue: await this.#reads.catalogue(), key: this.#reads.catalogueKey };
    }
    const source = this.source(name);
    if (source === null) {
      throw new Error(`no source named ${name} is registered`);
    }
    return { catalogue: await this.#reads.registered(source), key: source.publicKey };
  }

  /** Whether the official catalogue offers `id`; false when it cannot be read. */
  async officialOffers(id: string): Promise<boolean> {
    try {
      return entryFor(await this.#reads.catalogue(), id) !== null;
    } catch {
      return false;
    }
  }

  /** Fetch the archive an entry names and keep it; resolves with where, or rejects with why. */
  async download(name: string, entry: CatalogueEntry): Promise<string> {
    if (entry.archive === undefined) {
      throw new Error(
        `its catalogue entry names only "${entry.installSource}", and this build installs ` +
          "packages from an archive only",
      );
    }
    const fetched = await this.#reads.http.get(entry.archive, { maxBytes: MAX_ARCHIVE_BYTES });
    if (!fetched.ok) {
      throw new Error(`its archive could not be fetched: ${fetched.detail}`);
    }
    return this.#reads.saveDownload(name, fetched.body);
  }
}
