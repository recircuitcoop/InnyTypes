// The application's own settings (plan 0018 §2.3 SettingsStore). WI-0018-19 needs only the MCP
// endpoint; the other settings, and the one-time import of the old config.toml, arrive with
// WI-0018-09 and WI-0018-25.

import type { StoredEndpoint } from "../domain/endpoint/address";

export interface SettingsStore {
  /** The stored MCP endpoint; an empty object when nothing is stored. Throws when unreadable. */
  readEndpoint(): StoredEndpoint;
  /** Store the MCP endpoint, leaving every other setting as it was. */
  writeEndpoint(endpoint: StoredEndpoint): void;
}
