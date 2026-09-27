// The application's own settings (plan 0018 §2.3 SettingsStore): the MCP endpoint (WI-0018-19)
// and the launch-at-login switch (WI-0018-21); the one-time import of the old config.toml
// arrives with WI-0018-25.

import type { StoredEndpoint } from "../domain/endpoint/address";

/**
 * The package settings (WI-0018-17): the update policy (`packages`) and the registered catalogue
 * sources (`sources`), raw, judged by domain/packages. Read at the moment they are needed, so a
 * change is obeyed at once. Both throw when the file cannot be read.
 */
export interface PackageSettingsStore {
  /** The `packages` setting; undefined when unset. */
  readPackages(): unknown;
  /** The `sources` setting, a table of `name → {url, public_key?, auto_update?}`; undefined when unset. */
  readSources(): unknown;
  /** Store the whole `sources` table, in its order, leaving every other setting as it was. */
  writeSources(sources: Readonly<Record<string, unknown>>): void;
}

export interface SettingsStore {
  /** The stored MCP endpoint; an empty object when nothing is stored. Throws when unreadable. */
  readEndpoint(): StoredEndpoint;
  /** Store the MCP endpoint, leaving every other setting as it was. */
  writeEndpoint(endpoint: StoredEndpoint): void;
}

/**
 * The `update` setting (WI-0018-24): the switch and channel domain/update/policy.ts judges.
 * Read at the moment it is needed, so a change is obeyed at once. Throws when unreadable.
 */
export interface UpdateSettingsStore {
  /** The `update` setting; undefined when unset. */
  readUpdate(): unknown;
}

/** The launch-at-login switch (launcher.py:1450): off until someone turns it on. */
export interface LaunchAtLoginSetting {
  /** Whether the switch is on; false when nothing is stored. Throws when unreadable. */
  readLaunchAtLogin(): boolean;
  /** Store the switch, leaving every other setting as it was. */
  writeLaunchAtLogin(on: boolean): void;
}
