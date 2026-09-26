// Registering catalogue sources from the Packages page (plan 0006 F1, F2; helper/plugin_lists.py,
// replaced; WI-0018-17).
//
// Any publisher can be a source: a name, the HTTPS URL of its catalogue, and optionally the
// minisign public key its catalogue and archives are signed with. The page registers one,
// removes one, and switches its auto-update on or off; every outcome, a refusal included, is a
// message for the person, never an exception.
//
// Nothing is written unless the whole new table passes: the rules are domain/packages/catalogue.ts
// parseCatalogueSources (the ones the settings are read with), plus the key itself, which must
// be a minisign key and not merely one line. A mistyped key is refused before anything is
// written, rather than kept and failing every read of that source from then on.

import {
  CatalogueSettingsError,
  parseCatalogueSources,
  type CatalogueSource,
} from "../domain/packages/catalogue";
import { MinisignError, parsePublicKey } from "../domain/signature/minisign";
import type { Logger } from "../ports/logger";
import type { PackageSettingsStore } from "../ports/settings-store";
import type { PackageOutcome } from "./install-package";

/** The registered sources, in the settings' order; throws when the settings cannot be read. */
export function readSources(settings: PackageSettingsStore): CatalogueSource[] {
  const table = settings.readSources();
  return table === undefined ? [] : parseCatalogueSources(table);
}

/** A source as the settings store it. */
function stored(source: CatalogueSource): Record<string, unknown> {
  return {
    url: source.url,
    ...(source.publicKey === null ? {} : { public_key: source.publicKey }),
    ...(source.autoUpdate === null ? {} : { auto_update: source.autoUpdate }),
  };
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class PackageSources {
  readonly #settings: PackageSettingsStore;
  readonly #logger: Logger;

  constructor(settings: PackageSettingsStore, logger: Logger) {
    this.#settings = settings;
    this.#logger = logger;
  }

  /** Register `name` at `url`, with `publicKey` (empty: none, and its entries are unverified). */
  register(name: string, url: string, publicKey: string): PackageOutcome {
    const key = publicKey.trim();
    if (key !== "") {
      try {
        parsePublicKey(key);
      } catch (error) {
        if (error instanceof MinisignError) {
          return this.#refused(
            name,
            `the public key is not a minisign public key (${error.message}); paste the second ` +
              "line of the publisher's .pub file",
          );
        }
        throw error;
      }
    }
    return this.#change(name, "registered", (sources) => {
      if (sources.some((source) => source.name === name)) {
        throw new CatalogueSettingsError(`a source named ${name} is already registered`);
      }
      return [
        ...sources,
        { name, url: url.trim(), publicKey: key === "" ? null : key, autoUpdate: null },
      ];
    });
  }

  remove(name: string): PackageOutcome {
    return this.#change(name, "removed", (sources) => {
      if (!sources.some((source) => source.name === name)) {
        throw new CatalogueSettingsError(`no source named ${name} is registered`);
      }
      return sources.filter((source) => source.name !== name);
    });
  }

  /** Switch the source's auto-update on or off; it takes effect at the next check. */
  setAutoUpdate(name: string, on: boolean): PackageOutcome {
    return this.#change(
      name,
      on ? "set to update automatically" : "set to wait for Apply",
      (sources) => {
        if (!sources.some((source) => source.name === name)) {
          throw new CatalogueSettingsError(`no source named ${name} is registered`);
        }
        return sources.map((source) =>
          source.name === name ? { ...source, autoUpdate: on } : source,
        );
      },
    );
  }

  /** Read, change, judge the whole new table, and only then write it. */
  #change(
    name: string,
    done: string,
    change: (sources: readonly CatalogueSource[]) => CatalogueSource[],
  ): PackageOutcome {
    let table: Record<string, unknown>;
    try {
      const next = change(readSources(this.#settings));
      table = Object.fromEntries(next.map((source) => [source.name, stored(source)]));
      // The rules the settings are read with, applied before the write.
      parseCatalogueSources(table);
    } catch (error) {
      return this.#refused(name, reasonOf(error));
    }
    try {
      this.#settings.writeSources(table);
    } catch (error) {
      return this.#refused(name, `the settings could not be written: ${reasonOf(error)}`);
    }
    this.#logger.info(`sources: ${name} was ${done}`);
    return { ok: true, message: `The source ${name} is ${done}.` };
  }

  #refused(name: string, why: string): PackageOutcome {
    this.#logger.warn(`sources: ${name} was refused: ${why}`);
    return { ok: false, error: `Not changed: ${why}.` };
  }
}
