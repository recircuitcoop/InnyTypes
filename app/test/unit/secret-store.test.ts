// The keychain adapter over a fake safeStorage, the choice between it and the file adapter, and
// the credential secret: generated once, kept, never on disk in plaintext, and registered with
// the redactor on every read (WI-0018-06).
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KeychainError,
  KeychainSecretStore,
  type SafeStorage,
} from "../../src/adapters/electron/safe-storage-store";
import {
  credentialSecretCiphertextFile,
  credentialSecretFile,
  OwnerOnlyFileStore,
} from "../../src/adapters/fs/owner-only-files";
import {
  BASIC_TEXT_REASON,
  chooseSecretStorage,
  NO_KEYCHAIN_REASON,
  openSecretStore,
  readOrCreate,
  registering,
  type KeychainFacts,
} from "../../src/application/secrets";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import type { SecretSink } from "../../src/ports/logger";
import type { SecretName, SecretStore } from "../../src/ports/secret-store";
import { RecordingLogger } from "../fakes/children";

const SECRET = "fake-credential-secret-for-the-keychain-tests";

/**
 * safeStorage as Electron's main process has it, with a toy cipher: a version prefix and the
 * bytes XORed, so a ciphertext never contains its plaintext and a foreign blob is refused.
 */
class FakeSafeStorage implements SafeStorage {
  encrypted = 0;
  decrypted = 0;
  encryptString(plainText: string): Buffer {
    this.encrypted += 1;
    const body = Buffer.from(plainText, "utf8").map((byte) => byte ^ 0x5a);
    return Buffer.concat([Buffer.from("v10"), body]);
  }
  decryptString(encrypted: Buffer): string {
    this.decrypted += 1;
    if (encrypted.subarray(0, 3).toString() !== "v10") {
      throw new Error(
        "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
      );
    }
    return Buffer.from(encrypted.subarray(3).map((byte) => byte ^ 0x5a)).toString("utf8");
  }
}

/** A SecretStore in memory, recording every write. */
class MemoryStore implements SecretStore {
  readonly values = new Map<SecretName, string>();
  readonly writes: [SecretName, string][] = [];
  read(name: SecretName): string | null {
    return this.values.get(name) ?? null;
  }
  write(name: SecretName, value: string): void {
    this.writes.push([name, value]);
    this.values.set(name, value.trim());
  }
}

/** The shell's side of the redactor: a registry behind the SecretSink port. */
function redactor(): { registry: SecretRegistry; sink: SecretSink } {
  const registry = new SecretRegistry();
  return { registry, sink: { protect: (secret) => registry.protect(secret) } };
}

let userData: string;

beforeEach(() => {
  userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-keychain-")));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

/** Every file below `root` whose bytes hold `needle`, relative to root. */
function filesHolding(root: string, needle: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((relative) => fs.lstatSync(path.join(root, relative)).isFile())
    .filter((relative) => fs.readFileSync(path.join(root, relative)).includes(needle));
}

const keychainOver = (safeStorage: SafeStorage) =>
  new KeychainSecretStore(
    safeStorage,
    new OwnerOnlyFileStore(credentialSecretCiphertextFile(userData)),
  );

describe("the keychain adapter", () => {
  it("keeps only ciphertext on disk, in the owner-only file, and reads the secret back", () => {
    const safeStorage = new FakeSafeStorage();
    const store = keychainOver(safeStorage);
    store.write("node-red-credential-secret", SECRET);

    expect(filesHolding(userData, SECRET)).toEqual([]);
    const file = credentialSecretCiphertextFile(userData)["node-red-credential-secret"]?.file ?? "";
    const blob = Buffer.from(fs.readFileSync(file, "utf8"), "base64");
    expect(safeStorage.decryptString(blob)).toBe(SECRET);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(keychainOver(safeStorage).read("node-red-credential-secret")).toBe(SECRET);
  });

  it("the plaintext scan can fail: the file adapter alone does write the secret as it is", () => {
    new OwnerOnlyFileStore(credentialSecretFile(userData)).write(
      "node-red-credential-secret",
      SECRET,
    );
    expect(filesHolding(userData, SECRET)).toEqual([
      path.join("secrets", "node-red-credential-secret"),
    ]);
  });

  it("reads nothing stored as null, without asking the keychain", () => {
    const safeStorage = new FakeSafeStorage();
    expect(keychainOver(safeStorage).read("node-red-credential-secret")).toBeNull();
    expect(safeStorage.decrypted).toBe(0);
  });

  it("refuses an empty secret, and never encrypts it", () => {
    const safeStorage = new FakeSafeStorage();
    expect(() => {
      keychainOver(safeStorage).write("node-red-credential-secret", " ");
    }).toThrow(KeychainError);
    expect(safeStorage.encrypted).toBe(0);
  });

  it("reads a blob that decrypts to nothing as nothing stored", () => {
    const safeStorage = new FakeSafeStorage();
    const ciphertexts = new MemoryStore();
    ciphertexts.values.set(
      "node-red-credential-secret",
      safeStorage.encryptString("  ").toString("base64"),
    );
    expect(
      new KeychainSecretStore(safeStorage, ciphertexts).read("node-red-credential-secret"),
    ).toBeNull();
  });

  it("says so when the keychain cannot decrypt, and never repeats what was stored", () => {
    const ciphertexts = new MemoryStore();
    ciphertexts.values.set("node-red-credential-secret", Buffer.from(SECRET).toString("base64"));
    const store = new KeychainSecretStore(new FakeSafeStorage(), ciphertexts);
    expect(() => store.read("node-red-credential-secret")).toThrow(KeychainError);
    try {
      store.read("node-red-credential-secret");
    } catch (error) {
      expect((error as Error).message).toContain(
        "could not decrypt the stored node-red-credential-secret",
      );
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});

describe("choosing the store", () => {
  const facts = (overrides: Partial<KeychainFacts>): KeychainFacts => ({
    platform: "darwin",
    encryptionAvailable: true,
    linuxBackend: null,
    ...overrides,
  });

  it("uses the keychain where there is one", () => {
    expect(chooseSecretStorage(facts({}))).toEqual({ backend: "keychain", reason: null });
    expect(chooseSecretStorage(facts({ platform: "win32" }))).toEqual({
      backend: "keychain",
      reason: null,
    });
    for (const linuxBackend of ["gnome_libsecret", "kwallet5", "kwallet6"]) {
      expect(chooseSecretStorage(facts({ platform: "linux", linuxBackend })).backend).toBe(
        "keychain",
      );
    }
  });

  it("uses owner-only files on Linux without a keyring (basic_text), and says why", () => {
    expect(chooseSecretStorage(facts({ platform: "linux", linuxBackend: "basic_text" }))).toEqual({
      backend: "file",
      reason: BASIC_TEXT_REASON,
    });
    expect(BASIC_TEXT_REASON).toContain("basic_text");
  });

  it("uses owner-only files where encryption is not available at all", () => {
    expect(chooseSecretStorage(facts({ encryptionAvailable: false }))).toEqual({
      backend: "file",
      reason: NO_KEYCHAIN_REASON,
    });
  });
});

describe("openSecretStore", () => {
  function open(factsGiven: KeychainFacts) {
    const logger = new RecordingLogger();
    const { registry, sink } = redactor();
    const built: string[] = [];
    const safeStorage = new FakeSafeStorage();
    const opened = openSecretStore({
      facts: factsGiven,
      keychain: () => {
        built.push("keychain");
        return keychainOver(safeStorage);
      },
      file: () => {
        built.push("file");
        return new OwnerOnlyFileStore(credentialSecretFile(userData));
      },
      sink,
      logger,
    });
    return { ...opened, logger, registry, built, safeStorage };
  }

  it("on Linux with basic_text: the file store, said once in the log, and the keychain untouched", () => {
    const { status, logger, built, safeStorage, store } = open({
      platform: "linux",
      encryptionAvailable: true,
      linuxBackend: "basic_text",
    });
    expect(status).toEqual({ backend: "file", reason: BASIC_TEXT_REASON });
    expect(built).toEqual(["file"]);
    expect(logger.lines).toEqual([`WARN ${BASIC_TEXT_REASON}`]);

    readOrCreate(store, "node-red-credential-secret", () => SECRET);
    readOrCreate(store, "node-red-credential-secret", () => "another");
    expect(safeStorage.encrypted + safeStorage.decrypted).toBe(0);
    // Said once: reading and writing secrets does not repeat it.
    expect(logger.lines).toHaveLength(1);
    const file = credentialSecretFile(userData)["node-red-credential-secret"]?.file ?? "";
    expect(fs.readFileSync(file, "utf8")).toBe(SECRET);
  });

  it("with a keychain: the keychain store, and nothing plain on disk", () => {
    const { status, logger, built, store } = open({
      platform: "darwin",
      encryptionAvailable: true,
      linuxBackend: null,
    });
    expect(status).toEqual({ backend: "keychain", reason: null });
    expect(built).toEqual(["keychain"]);
    expect(logger.lines).toEqual([
      "INFO the application's secrets are kept in the system keychain",
    ]);
    const secret = readOrCreate(store, "node-red-credential-secret", () => SECRET);
    expect(secret).toBe(SECRET);
    expect(filesHolding(userData, SECRET)).toEqual([]);
  });

  it("registers every secret it reads or writes with the redactor", () => {
    const first = open({ platform: "darwin", encryptionAvailable: true, linuxBackend: null });
    readOrCreate(first.store, "node-red-credential-secret", () => SECRET);
    expect(first.registry.redact(`x ${SECRET} y`)).toBe(`x ${REDACTED} y`);

    // A second start reads the stored one, and registers it there too.
    const second = open({ platform: "darwin", encryptionAvailable: true, linuxBackend: null });
    expect(second.registry.size).toBe(0);
    expect(second.store.read("node-red-credential-secret")).toBe(SECRET);
    expect(second.registry.redact(SECRET)).toBe(REDACTED);
  });
});

describe("registering", () => {
  it("registers a value read, and a value written before it is written", () => {
    const inner = new MemoryStore();
    const { registry, sink } = redactor();
    const order: string[] = [];
    const store = registering(
      {
        read: (name) => inner.read(name),
        write: (name, value) => {
          order.push(registry.redact(value));
          inner.write(name, value);
        },
      },
      sink,
    );
    store.write("mcp-proxy-token", ` ${SECRET} `);
    expect(order).toEqual([` ${REDACTED} `]);

    inner.values.set("anytype-api-key", "fake-anytype-key-read-back");
    expect(store.read("anytype-api-key")).toBe("fake-anytype-key-read-back");
    expect(registry.redact("fake-anytype-key-read-back")).toBe(REDACTED);
  });

  it("registers nothing for a secret that is not there", () => {
    const { registry, sink } = redactor();
    expect(registering(new MemoryStore(), sink).read("anytype-api-key")).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("the registration check can fail: a store read without it leaves the value readable", () => {
    const inner = new MemoryStore();
    inner.values.set("anytype-api-key", "fake-anytype-key-read-back");
    const { registry } = redactor();
    expect(inner.read("anytype-api-key")).toBe("fake-anytype-key-read-back");
    expect(registry.redact("fake-anytype-key-read-back")).toBe("fake-anytype-key-read-back");
  });
});

describe("readOrCreate: the credential secret is generated once", () => {
  it("generates and stores a secret the first time, and returns the stored one after", () => {
    const store = new MemoryStore();
    let generated = 0;
    const generate = () => {
      generated += 1;
      return `${SECRET}-${String(generated)}`;
    };
    const first = readOrCreate(store, "node-red-credential-secret", generate);
    const second = readOrCreate(store, "node-red-credential-secret", generate);
    expect(first).toBe(`${SECRET}-1`);
    expect(second).toBe(first);
    expect(generated).toBe(1);
    expect(store.writes).toEqual([["node-red-credential-secret", `${SECRET}-1`]]);
  });

  it("does not make a new secret when the stored one cannot be decrypted", () => {
    const ciphertexts = new MemoryStore();
    ciphertexts.values.set("node-red-credential-secret", "bm90LWEtYmxvYg==");
    const store = new KeychainSecretStore(new FakeSafeStorage(), ciphertexts);
    expect(() => readOrCreate(store, "node-red-credential-secret", () => SECRET)).toThrow(
      KeychainError,
    );
    expect(ciphertexts.writes).toEqual([]);
  });
});
