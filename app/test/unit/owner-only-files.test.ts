// The owner-only file adapter of SecretStore (WI-0018-06): 0600 files in a 0700 directory
// (addons/secrets.py:93-109), the Anytype key and the proxy token at their existing paths, and
// a legacy key file that is read and never written (anytype_mcp/config.py:47-48).
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anytypeSecretFiles,
  credentialSecretCiphertextFile,
  credentialSecretFile,
  credentialsDirectory,
  legacyConfigDirectory,
  OwnerOnlyFileStore,
  readOwnerOnly,
  SECRET_DIRECTORY_MODE,
  SECRET_FILE_MODE,
  SecretFileError,
  writeOwnerOnly,
} from "../../src/adapters/fs/owner-only-files";

const KEY = "fake-anytype-key-for-owner-only-tests";
const OTHER_KEY = "fake-anytype-key-a-second-one";
const TOKEN = "fake-proxy-token-for-owner-only-tests";

// POSIX modes; Windows has none to check (and needs privileges for symbolic links).
const posix = process.platform !== "win32";

const modeOf = (target: string): number => fs.statSync(target).mode & 0o777;

let scratch: string;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-secrets-")));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A store over the Anytype files of a home inside the scratch directory. */
function anytypeStore(env: Record<string, string> = {}) {
  const home = path.join(scratch, "home");
  const location = { platform: process.platform, home, env };
  const files = anytypeSecretFiles(location);
  return { home, files, store: new OwnerOnlyFileStore(files) };
}

/** Every file below `root`, with its bytes. */
function everyFile(root: string): { file: string; bytes: Buffer }[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((relative) => path.join(root, relative))
    .filter((file) => fs.lstatSync(file).isFile())
    .map((file) => ({ file, bytes: fs.readFileSync(file) }));
}

describe("the existing paths (plan 0018 §4.1)", () => {
  it("keeps the key and the proxy token in ~/.config/innytypes, as the old app did", () => {
    const files = anytypeSecretFiles({ platform: "darwin", home: "/Users/a", env: {} });
    expect(files["anytype-api-key"]?.file).toBe("/Users/a/.config/innytypes/anytype_api_key");
    expect(files["mcp-proxy-token"]).toEqual({
      file: "/Users/a/.config/innytypes/mcp_proxy_token",
    });
    expect(credentialsDirectory("C:\\Users\\a", "win32")).toBe("C:\\Users\\a\\.config\\innytypes");
  });

  it("reads the legacy key where platformdirs' user_config_path put it", () => {
    expect(legacyConfigDirectory({ platform: "darwin", home: "/Users/a", env: {} })).toBe(
      "/Users/a/Library/Application Support/innytypes",
    );
    expect(legacyConfigDirectory({ platform: "linux", home: "/home/a", env: {} })).toBe(
      "/home/a/.config/innytypes",
    );
    expect(
      legacyConfigDirectory({ platform: "linux", home: "/home/a", env: { XDG_CONFIG_HOME: "/x" } }),
    ).toBe("/x/innytypes");
    expect(
      legacyConfigDirectory({ platform: "linux", home: "/home/a", env: { XDG_CONFIG_HOME: " " } }),
    ).toBe("/home/a/.config/innytypes");
    expect(
      legacyConfigDirectory({
        platform: "win32",
        home: "C:\\Users\\a",
        env: { LOCALAPPDATA: "D:\\Local" },
      }),
    ).toBe("D:\\Local\\innytypes");
    expect(legacyConfigDirectory({ platform: "win32", home: "C:\\Users\\a", env: {} })).toBe(
      "C:\\Users\\a\\AppData\\Local\\innytypes",
    );
    const files = anytypeSecretFiles({ platform: "darwin", home: "/Users/a", env: {} });
    expect(files["anytype-api-key"]?.legacy).toBe(
      "/Users/a/Library/Application Support/innytypes/anytype_api_key",
    );
  });

  it("keeps Node-RED's credential secret in userData/secrets: ciphertext, or the file fallback", () => {
    expect(credentialSecretCiphertextFile("/ud")["node-red-credential-secret"]?.file).toBe(
      path.join("/ud", "secrets", "node-red-credential-secret.enc"),
    );
    expect(credentialSecretFile("/ud")["node-red-credential-secret"]?.file).toBe(
      path.join("/ud", "secrets", "node-red-credential-secret"),
    );
  });
});

describe.runIf(posix)("owner-only modes", () => {
  it("makes the file 0600 and its directory 0700 the moment it exists", () => {
    const { files, store } = anytypeStore();
    store.write("anytype-api-key", KEY);
    const file = files["anytype-api-key"]?.file ?? "";
    expect(modeOf(file)).toBe(SECRET_FILE_MODE);
    expect(modeOf(path.dirname(file))).toBe(SECRET_DIRECTORY_MODE);
    expect(SECRET_FILE_MODE).toBe(0o600);
    expect(SECRET_DIRECTORY_MODE).toBe(0o700);
  });

  it("tightens a directory somebody widened, and a file somebody widened, on the next write", () => {
    const { files, store } = anytypeStore();
    store.write("mcp-proxy-token", TOKEN);
    const file = files["mcp-proxy-token"]?.file ?? "";
    fs.chmodSync(path.dirname(file), 0o755);
    fs.chmodSync(file, 0o644);
    store.write("mcp-proxy-token", TOKEN);
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(path.dirname(file))).toBe(0o700);
  });

  it("is 0600 even under a umask that would allow more", () => {
    const previous = process.umask(0o000);
    try {
      const file = path.join(scratch, "wide", "secret");
      writeOwnerOnly(file, TOKEN);
      expect(modeOf(file)).toBe(0o600);
      expect(modeOf(path.dirname(file))).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  });

  it("the mode check can fail: a file written the ordinary way is not 0600", () => {
    const file = path.join(scratch, "ordinary");
    fs.writeFileSync(file, TOKEN, { mode: 0o644 });
    expect(modeOf(file)).not.toBe(0o600);
  });
});

describe("reading and writing", () => {
  it("round-trips a value, without the whitespace around it", () => {
    const { files, store } = anytypeStore();
    store.write("anytype-api-key", `  ${KEY}\n`);
    expect(store.read("anytype-api-key")).toBe(KEY);
    expect(fs.readFileSync(files["anytype-api-key"]?.file ?? "", "utf8")).toBe(KEY);
  });

  it("reads nothing stored as null: no file, or an empty one", () => {
    const { files, store } = anytypeStore();
    expect(store.read("mcp-proxy-token")).toBeNull();
    const file = files["mcp-proxy-token"]?.file ?? "";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, " \n");
    expect(store.read("mcp-proxy-token")).toBeNull();
  });

  it("replaces the file whole and leaves no scratch file behind", () => {
    const { files, store } = anytypeStore();
    store.write("anytype-api-key", `${KEY}-a-longer-first-value`);
    store.write("anytype-api-key", OTHER_KEY);
    const file = files["anytype-api-key"]?.file ?? "";
    expect(fs.readFileSync(file, "utf8")).toBe(OTHER_KEY);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["anytype_api_key"]);
  });

  it("refuses an empty value and a name it keeps no file for, without writing", () => {
    const { home, store } = anytypeStore();
    expect(() => {
      store.write("anytype-api-key", "   ");
    }).toThrow(SecretFileError);
    expect(() => store.read("node-red-credential-secret")).toThrow(/does not keep/);
    expect(() => {
      store.write("node-red-credential-secret", KEY);
    }).toThrow(SecretFileError);
    expect(fs.existsSync(home)).toBe(false);
  });
});

describe("failures", () => {
  it("an interrupted write leaves the old secret intact, and no scratch copy behind", () => {
    const { files, store } = anytypeStore();
    store.write("mcp-proxy-token", TOKEN);
    const file = files["mcp-proxy-token"]?.file ?? "";
    // The rename is what makes the write atomic, so a failure there must be a write that
    // did not happen, not half of one.
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated"), { code: "EIO" });
    });
    try {
      let message = "";
      try {
        store.write("mcp-proxy-token", `${TOKEN}-replacement`);
      } catch (error) {
        expect(error).toBeInstanceOf(SecretFileError);
        message = (error as Error).message;
      }
      expect(message).toContain("EIO");
      expect(message).not.toContain(TOKEN);
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(file, "utf8")).toBe(TOKEN);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["mcp_proxy_token"]);
  });

  it("refuses a file that is not text, without repeating its bytes", () => {
    const file = path.join(scratch, "binary");
    const bytes = Buffer.from([0x66, 0x61, 0x6b, 0x65, 0xff, 0xfe, 0x00, 0x80]);
    fs.writeFileSync(file, bytes);
    expect(() => readOwnerOnly(file)).toThrow(`${file} does not hold text`);
  });
});

describe("the legacy key file (config.py:48): read-only", () => {
  // On Linux without XDG_CONFIG_HOME the two paths are the same file; a separate legacy
  // directory is named so the test means the same thing on every platform.
  const legacyEnv = () => ({
    XDG_CONFIG_HOME: path.join(scratch, "xdg"),
    LOCALAPPDATA: path.join(scratch, "local"),
  });

  function withLegacyKey(value: string) {
    const setup = anytypeStore(legacyEnv());
    const legacy = setup.files["anytype-api-key"]?.legacy ?? "";
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, `${value}\n`);
    return { ...setup, legacy, canonical: setup.files["anytype-api-key"]?.file ?? "" };
  }

  it("is read when the canonical file holds nothing", () => {
    const { store, legacy, canonical } = withLegacyKey(KEY);
    expect(legacy).not.toBe(canonical);
    expect(store.read("anytype-api-key")).toBe(KEY);
  });

  it("is not read when the canonical file has a key", () => {
    const { store } = withLegacyKey(KEY);
    store.write("anytype-api-key", OTHER_KEY);
    expect(store.read("anytype-api-key")).toBe(OTHER_KEY);
  });

  it("is never written: a new key writes only the canonical file", () => {
    const { store, legacy, canonical } = withLegacyKey(KEY);
    const before = fs.statSync(legacy);
    store.write("anytype-api-key", OTHER_KEY);
    expect(fs.readFileSync(legacy, "utf8")).toBe(`${KEY}\n`);
    expect(fs.statSync(legacy).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readdirSync(path.dirname(legacy))).toEqual(["anytype_api_key"]);
    expect(fs.readFileSync(canonical, "utf8")).toBe(OTHER_KEY);
  });

  it("the check can fail: a store whose canonical path is the legacy one changes it", () => {
    const { legacy } = withLegacyKey(KEY);
    new OwnerOnlyFileStore({ "anytype-api-key": { file: legacy } }).write(
      "anytype-api-key",
      OTHER_KEY,
    );
    expect(fs.readFileSync(legacy, "utf8")).not.toBe(`${KEY}\n`);
  });

  it("is not consulted twice where it is the canonical file (Linux, no XDG_CONFIG_HOME)", () => {
    const file = path.join(scratch, "same", "anytype_api_key");
    const store = new OwnerOnlyFileStore({ "anytype-api-key": { file, legacy: file } });
    expect(store.read("anytype-api-key")).toBeNull();
  });
});

describe.runIf(posix)("links and things that are not files", () => {
  it("never reads a secret through a symbolic link", () => {
    const target = path.join(scratch, "elsewhere");
    fs.writeFileSync(target, KEY);
    const file = path.join(scratch, "dir", "secret");
    fs.mkdirSync(path.dirname(file));
    fs.symlinkSync(target, file);
    expect(() => readOwnerOnly(file)).toThrow(/symbolic link/);
  });

  it("replaces a link where the file belongs, and leaves its target alone", () => {
    const target = path.join(scratch, "elsewhere");
    fs.writeFileSync(target, "untouched");
    const file = path.join(scratch, "dir", "secret");
    fs.mkdirSync(path.dirname(file));
    fs.symlinkSync(target, file);
    writeOwnerOnly(file, TOKEN);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(TOKEN);
    expect(fs.readFileSync(target, "utf8")).toBe("untouched");
  });

  it("refuses a directory where a secret file belongs, for a read and for a write", () => {
    const file = path.join(scratch, "dir", "secret");
    fs.mkdirSync(path.join(file, "inside"), { recursive: true });
    expect(() => readOwnerOnly(file)).toThrow(/not a file/);
    expect(() => {
      writeOwnerOnly(file, TOKEN);
    }).toThrow(SecretFileError);
    // The failed write left no scratch file, so no copy of the value, behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["secret"]);
  });

  it("reports a directory it cannot make without the value", () => {
    const blocker = path.join(scratch, "blocker");
    fs.writeFileSync(blocker, "a file in the way");
    const error = (() => {
      try {
        writeOwnerOnly(path.join(blocker, "secret"), TOKEN);
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error).toBeInstanceOf(SecretFileError);
    expect(error?.message).toContain(blocker);
    expect(error?.message).not.toContain(TOKEN);
  });

  it("reports an unreadable file without the value", () => {
    const file = path.join(scratch, "locked");
    fs.writeFileSync(file, TOKEN, { mode: 0o000 });
    if (process.getuid?.() === 0) {
      return; // root reads anything
    }
    expect(() => readOwnerOnly(file)).toThrow(SecretFileError);
    try {
      readOwnerOnly(file);
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });
});

describe("nothing but the store's own files", () => {
  it("writes the value only into the file it names", () => {
    const { home, store } = anytypeStore();
    store.write("anytype-api-key", KEY);
    store.write("mcp-proxy-token", TOKEN);
    const holding = everyFile(home).filter(({ bytes }) => bytes.includes(KEY));
    expect(holding.map(({ file }) => path.relative(home, file))).toEqual([
      path.join(".config", "innytypes", "anytype_api_key"),
    ]);
  });
});
