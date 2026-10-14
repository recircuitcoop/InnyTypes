// The registered catalogue sources (plan 0006 F1, F2; helper/plugin_lists.py, replaced;
// WI-0018-17), read from the settings.
//
// Any publisher can be a source: a name, the HTTPS URL of its catalogue, and optionally the
// minisign public key its catalogue and archives are signed with. Sources are kept in the
// settings file; since the 0.3.0 cutover nothing in the window registers, removes or switches
// one. They are read with domain/packages/catalogue.ts parseCatalogueSources.

import { parseCatalogueSources, type CatalogueSource } from "../domain/packages/catalogue";
import type { PackageSettingsStore } from "../ports/settings-store";

/** The registered sources, in the settings' order; throws when the settings cannot be read. */
export function readSources(settings: PackageSettingsStore): CatalogueSource[] {
  const table = settings.readSources();
  return table === undefined ? [] : parseCatalogueSources(table);
}
