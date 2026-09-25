// Where the application keeps its own credentials (plan 0018 §2.2, §4.1; WI-0018-06).
//
// Two adapters implement it: the keychain one (Electron safeStorage, main process only) and
// the owner-only file one (0600 file, 0700 directory, as addons/secrets.py:93-109). A node's
// own secrets are Node-RED credentials (spec 2.5) and never pass through here.

/**
 * Every secret the application holds, by name. The Anytype key and the proxy token stay in
 * owner-only files at their old paths (§4.1); Node-RED's credential secret is the keychain's.
 */
export type SecretName = "anytype-api-key" | "mcp-proxy-token" | "node-red-credential-secret";

export interface SecretStore {
  /** The secret held under `name`, without surrounding whitespace, or null when none is. */
  read(name: SecretName): string | null;
  /** Keep `value` under `name`, replacing what was there. An empty value is refused. */
  write(name: SecretName, value: string): void;
}
