// Which store keeps the application's own secrets, and how they are read (WI-0018-06).
//
// * The keychain when there is one. On Linux with no keyring, safeStorage's backend is
//   `basic_text`, which "encrypts" with a password written into Chromium's source: that is
//   not a keychain, so the owner-only file store is used instead, and that is said once in the
//   log and on the page (AppApi `secretStorage`) rather than pretended away.
// * Every secret read or written is registered with the redactor where it is held, so no line
//   of the one log can carry it (spec 11.1).
// * Node-RED's credential secret is generated once and kept; the same value is handed to every
//   runtime generation in `init`.

import type { Logger, SecretSink } from "../ports/logger";
import type { SecretName, SecretStore } from "../ports/secret-store";

export type SecretBackend = "keychain" | "file";

/** What the page is told about where the application's secrets are. */
export interface SecretStorageStatus {
  readonly backend: SecretBackend;
  /** Why the keychain is not used; null when it is. */
  readonly reason: string | null;
}

/** What the shell knows about the keychain once Electron is ready. */
export interface KeychainFacts {
  readonly platform: NodeJS.Platform;
  /** `safeStorage.isEncryptionAvailable()`. */
  readonly encryptionAvailable: boolean;
  /** `safeStorage.getSelectedStorageBackend()` on Linux; null elsewhere. */
  readonly linuxBackend: string | null;
}

export const NO_KEYCHAIN_REASON =
  "no system keychain is available, so InnyTypes keeps its secrets in owner-only files " +
  "(0600, in a 0700 directory) instead";

export const BASIC_TEXT_REASON =
  "no keyring was found (Electron's safeStorage backend is basic_text), so InnyTypes keeps " +
  "its secrets in owner-only files (0600, in a 0700 directory) instead";

export function chooseSecretStorage(facts: KeychainFacts): SecretStorageStatus {
  if (!facts.encryptionAvailable) {
    return { backend: "file", reason: NO_KEYCHAIN_REASON };
  }
  if (facts.platform === "linux" && facts.linuxBackend === "basic_text") {
    return { backend: "file", reason: BASIC_TEXT_REASON };
  }
  return { backend: "keychain", reason: null };
}

/** `store`, with every value it reads or writes registered with the redactor first. */
export function registering(store: SecretStore, sink: SecretSink): SecretStore {
  return {
    read: (name) => {
      const value = store.read(name);
      if (value !== null) {
        sink.protect(value);
      }
      return value;
    },
    write: (name, value) => {
      // Before the write, so a failure that repeats it somewhere is already covered.
      sink.protect(value.trim());
      store.write(name, value);
    },
  };
}

export interface OpenSecretStoreDeps {
  readonly facts: KeychainFacts;
  /** Built only when it is chosen: safeStorage is not touched on the file path. */
  readonly keychain: () => SecretStore;
  readonly file: () => SecretStore;
  readonly sink: SecretSink;
  readonly logger: Logger;
}

export interface OpenedSecretStore {
  readonly store: SecretStore;
  readonly status: SecretStorageStatus;
}

/** Choose the store for the application's own secrets, say which once, and register reads. */
export function openSecretStore(deps: OpenSecretStoreDeps): OpenedSecretStore {
  const status = chooseSecretStorage(deps.facts);
  if (status.reason !== null) {
    deps.logger.warn(status.reason);
  } else {
    deps.logger.info("the application's secrets are kept in the system keychain");
  }
  const store = status.backend === "keychain" ? deps.keychain() : deps.file();
  return { store: registering(store, deps.sink), status };
}

/** The secret under `name`; when there is none yet, `generate()`'s value, stored first. */
export function readOrCreate(store: SecretStore, name: SecretName, generate: () => string): string {
  const existing = store.read(name);
  if (existing !== null) {
    return existing;
  }
  const created = generate().trim();
  store.write(name, created);
  return created;
}
