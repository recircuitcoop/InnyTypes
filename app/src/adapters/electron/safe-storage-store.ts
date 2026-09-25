// The keychain adapter of SecretStore (plan 0018 §2.2, WI-0018-06): Electron's safeStorage,
// which encrypts with a key the operating system's keychain holds (Keychain on macOS, DPAPI on
// Windows, the Secret Service or KWallet on Linux).
//
// safeStorage exists only in Electron's main process, so only the shell constructs this. The
// ciphertext is kept by another SecretStore, the owner-only file one, as base64: what reaches
// the disk is never the secret, and the file it is in is still 0600.

import type { SecretName, SecretStore } from "../../ports/secret-store";

/** The part of Electron's `safeStorage` this adapter uses; the shell passes the real one. */
export interface SafeStorage {
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The keychain could not decrypt what it stored. The message never carries a value. */
export class KeychainError extends Error {
  override name = "KeychainError";
}

export class KeychainSecretStore implements SecretStore {
  readonly #safeStorage: SafeStorage;
  readonly #ciphertexts: SecretStore;

  constructor(safeStorage: SafeStorage, ciphertexts: SecretStore) {
    this.#safeStorage = safeStorage;
    this.#ciphertexts = ciphertexts;
  }

  read(name: SecretName): string | null {
    const stored = this.#ciphertexts.read(name);
    if (stored === null) {
      return null;
    }
    let plain: string;
    try {
      plain = this.#safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch (error) {
      // A keychain that was reset, or access refused. Never "generate a new one" silently:
      // every credential Node-RED encrypted with the old secret would be lost with it.
      throw new KeychainError(
        `the keychain could not decrypt the stored ${name}: ${(error as Error).message}`,
      );
    }
    const trimmed = plain.trim();
    return trimmed === "" ? null : trimmed;
  }

  write(name: SecretName, value: string): void {
    const trimmed = value.trim();
    if (trimmed === "") {
      throw new KeychainError(`an empty ${name} is not stored`);
    }
    this.#ciphertexts.write(name, this.#safeStorage.encryptString(trimmed).toString("base64"));
  }
}
