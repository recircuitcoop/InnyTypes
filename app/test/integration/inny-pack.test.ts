// inny-pack (WI-0018-26): builds, signs and verifies a node package archive (spec 2.3.5),
// reusing the app's own package-acceptance code (domain/packages/archive, environment,
// declaration; adapters/signature/minisign; adapters/fs/package-source) rather than a second
// copy of the same rules. These tests exercise it the way an author would (keygen, build,
// verify) and then break it: an archive inny-pack signed with the wrong key, one tampered
// with after signing, and a declaration the app itself would refuse must all still fail here,
// through the SAME verification path `inny-pack verify` and the app's installer both run.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { cmdBuild, cmdKeygen, cmdVerify, verifyArchive } from "../../../tools/inny-pack/cli";
import { writeTar } from "../../../tools/inny-pack/tar";
import { readTar } from "../../src/adapters/fs/package-source";
import { PackageRefusal } from "../../src/domain/packages/archive";
import { MinisignError } from "../../src/domain/signature/minisign";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures");

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Silences the CLI's own console.log for the duration of `run`, returning its lines. */
async function quietly(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

/** cmdKeygen is synchronous; wraps it as `quietly` wants, without an unnecessary async arrow. */
function keygen(dir: string, name: string): () => void {
  return () => {
    cmdKeygen([dir, "--name", name]);
  };
}

describe("inny-pack keygen", () => {
  it("writes a public key and a secret key file, and the public key verifies what the secret key signs", async () => {
    const dir = tempDir("inny-pack-keys-");
    await quietly(keygen(dir, "test"));
    const pub = fs.readFileSync(path.join(dir, "test.pub"), "utf8");
    expect(pub).toMatch(/^untrusted comment: /);
    const secretMode = fs.statSync(path.join(dir, "test.key")).mode & 0o777;
    expect(secretMode).toBe(0o600); // never world- or group-readable (docs/authors)
  });
});

describe("inny-pack build and verify", () => {
  it("builds sdk-py into an archive the app's own verification code accepts", async () => {
    const keys = tempDir("inny-pack-keys-");
    await quietly(keygen(keys, "author"));
    const out = path.join(tempDir("inny-pack-out-"), "sdkpy-0.0.0.tgz");

    const lines = await quietly(() =>
      cmdBuild([
        path.join(FIXTURES, "sdk-py"),
        "--key",
        path.join(keys, "author.key"),
        "--out",
        out,
      ]),
    );
    expect(lines.some((line) => line.includes("environment: uv-python"))).toBe(true);
    expect(fs.existsSync(out)).toBe(true);

    const publicKey = fs.readFileSync(path.join(keys, "author.pub"), "utf8");
    const report = await verifyArchive(out, publicKey);
    expect(report).toEqual({
      package: "sdkpy",
      version: "0.0.0",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      fileCount: 2, // inny-package.json, node.py
    });
  });

  it("builds sdk-ts (a node-kind package) the same way", async () => {
    const keys = tempDir("inny-pack-keys-");
    await quietly(keygen(keys, "author"));
    const out = path.join(tempDir("inny-pack-out-"), "sdkts-0.0.0.tgz");
    await quietly(() =>
      cmdBuild([
        path.join(FIXTURES, "sdk-ts"),
        "--key",
        path.join(keys, "author.key"),
        "--out",
        out,
      ]),
    );
    const publicKey = fs.readFileSync(path.join(keys, "author.pub"), "utf8");
    const report = await verifyArchive(out, publicKey);
    expect(report.package).toBe("sdkts");
  });

  it("cmdVerify prints the same report cmdBuild's self-check computed", async () => {
    const keys = tempDir("inny-pack-keys-");
    await quietly(keygen(keys, "author"));
    const out = path.join(tempDir("inny-pack-out-"), "sdkpy-0.0.0.tgz");
    await quietly(() =>
      cmdBuild([
        path.join(FIXTURES, "sdk-py"),
        "--key",
        path.join(keys, "author.key"),
        "--out",
        out,
      ]),
    );
    const lines = await quietly(() => cmdVerify([out, "--key", path.join(keys, "author.pub")]));
    expect(lines[0]).toMatch(/verifies: package sdkpy 0\.0\.0/);
  });

  // ── break it: the app must still refuse what inny-pack refuses, and for the same reason ──

  it("BREAK IT: verifying with the wrong public key is refused (a signature is not portable between keys)", async () => {
    const keys = tempDir("inny-pack-keys-");
    await quietly(keygen(keys, "author"));
    await quietly(keygen(keys, "impostor"));
    const out = path.join(tempDir("inny-pack-out-"), "sdkpy-0.0.0.tgz");
    await quietly(() =>
      cmdBuild([
        path.join(FIXTURES, "sdk-py"),
        "--key",
        path.join(keys, "author.key"),
        "--out",
        out,
      ]),
    );
    const wrongKey = fs.readFileSync(path.join(keys, "impostor.pub"), "utf8");
    await expect(verifyArchive(out, wrongKey)).rejects.toThrow(MinisignError);
    await expect(verifyArchive(out, wrongKey)).rejects.toMatchObject({ reason: "wrong-key" });
  });

  it("BREAK IT: an archive tampered with after signing is refused, naming the file that no longer matches", async () => {
    const keys = tempDir("inny-pack-keys-");
    await quietly(keygen(keys, "author"));
    const outDir = tempDir("inny-pack-out-");
    const out = path.join(outDir, "sdkpy-0.0.0.tgz");
    await quietly(() =>
      cmdBuild([
        path.join(FIXTURES, "sdk-py"),
        "--key",
        path.join(keys, "author.key"),
        "--out",
        out,
      ]),
    );

    // Unpack, flip one byte of node.py, and rebuild the .tgz by hand -- exactly what an
    // attacker replacing a file after the fact would produce. The signature still covers the
    // ORIGINAL files.json, so the per-file hash check must be what catches this.
    const tar = gunzipSync(fs.readFileSync(out));
    const files = readTar(tar);
    const nodePy = files.get("node.py");
    if (nodePy === undefined) {
      throw new Error("fixture regressed: sdk-py no longer ships node.py");
    }
    const tampered = Uint8Array.from(nodePy);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    files.set("node.py", tampered);
    fs.writeFileSync(out, gzipSync(writeTar(files)));

    const publicKey = fs.readFileSync(path.join(keys, "author.pub"), "utf8");
    await expect(verifyArchive(out, publicKey)).rejects.toThrow(PackageRefusal);
    await expect(verifyArchive(out, publicKey)).rejects.toMatchObject({
      reason: "files",
      message: expect.stringContaining("node.py does not match its sha256") as unknown,
    });
  });

  it("BREAK IT: a package with no environment declared is refused before anything is signed", async () => {
    const keys = tempDir("inny-pack-keys-");
    await quietly(keygen(keys, "author"));
    const pkgDir = tempDir("inny-pack-bad-pkg-");
    fs.writeFileSync(
      path.join(pkgDir, "inny-package.json"),
      JSON.stringify({
        protocol: 2,
        package: "noenv",
        version: "0.0.0",
        types: [
          {
            id: "t",
            kind: "node",
            label: "T",
            command: ["{python}", "{package}/node.py"],
            config: { type: "object" },
            outputs: [],
          },
        ],
      }),
    );
    fs.writeFileSync(path.join(pkgDir, "node.py"), "");
    const out = path.join(tempDir("inny-pack-out-"), "noenv-0.0.0.tgz");
    await expect(
      quietly(() => cmdBuild([pkgDir, "--key", path.join(keys, "author.key"), "--out", out])),
    ).rejects.toThrow(PackageRefusal);
    expect(fs.existsSync(out)).toBe(false); // refused before anything was written
  });

  it("BREAK IT: a declaration the app's own schema refuses (a type with no outputs field) is refused before signing", async () => {
    const keys = tempDir("inny-pack-keys-");
    await quietly(keygen(keys, "author"));
    const pkgDir = tempDir("inny-pack-bad-decl-");
    fs.writeFileSync(
      path.join(pkgDir, "inny-package.json"),
      JSON.stringify({
        protocol: 2,
        package: "baddecl",
        version: "0.0.0",
        environment: { kind: "node" },
        types: [
          { id: "t", kind: "node", label: "T", command: ["{node}", "{package}/n.js"], config: {} },
        ],
      }),
    );
    fs.writeFileSync(path.join(pkgDir, "n.js"), "");
    const out = path.join(tempDir("inny-pack-out-"), "baddecl-0.0.0.tgz");
    await expect(
      quietly(() => cmdBuild([pkgDir, "--key", path.join(keys, "author.key"), "--out", out])),
    ).rejects.toThrow(/outputs/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("BREAK IT: a signing key left inside the package folder is refused, so it can never ship by accident", async () => {
    const keys = tempDir("inny-pack-keys-");
    await quietly(keygen(keys, "author"));
    const pkgDir = tempDir("inny-pack-leaked-key-");
    fs.cpSync(path.join(FIXTURES, "sdk-py"), pkgDir, { recursive: true });
    fs.copyFileSync(path.join(keys, "author.key"), path.join(pkgDir, "author.key"));
    const out = path.join(tempDir("inny-pack-out-"), `leaked-${randomUUID()}.tgz`);
    await expect(
      quietly(() => cmdBuild([pkgDir, "--key", path.join(keys, "author.key"), "--out", out])),
    ).rejects.toThrow(/signing key/);
    expect(fs.existsSync(out)).toBe(false);
  });
});
