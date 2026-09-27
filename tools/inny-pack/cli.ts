#!/usr/bin/env node
// inny-pack (WI-0018-26): the packaging tool a node package author runs to build, sign and
// verify a distributable archive (spec 2.3.5). It never re-implements the app's own judgment
// of a package: every rule that decides whether InnyTypes would ACCEPT a package -- the
// declaration schema, the "no install step" rule for a node-kind package, the hash-lock rules
// for a uv-python one, the file manifest, the content hash -- is imported straight from
// app/src/domain and run here exactly as the app runs it. Only two things are new, because the
// app never needs them: minisign SIGNING (minisign-sign.ts; the app only ever verifies) and a
// tar WRITER (tar.ts; the app only ever reads one).
//
// build's last step re-reads the archive it just wrote through the app's own verification
// path (FsPackageSource, parseFileManifest, verifyFiles, MinisignVerifier) -- the same code
// `inny-pack verify` runs on any archive -- so a package inny-pack calls built is one the app
// has already, in this run, agreed to accept.
//
// Runs as plain Node (type stripping): `node tools/inny-pack/cli.ts <command> ...`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import { AjvSchemaValidator } from "../../app/src/adapters/schema/ajv-validator.ts";
import { sha256Hex } from "../../app/src/adapters/signature/digest.ts";
import { MinisignVerifier } from "../../app/src/adapters/signature/minisign.ts";
import { FsPackageSource } from "../../app/src/adapters/fs/package-source.ts";
import {
  contentHash,
  DECLARATION_FILE,
  FILES_MANIFEST,
  FILES_SIGNATURE,
  manifestOf,
  parseFileManifest,
  pathProblem,
  verifyFiles,
  type FileManifest,
} from "../../app/src/domain/packages/archive.ts";
import { parseDeclaration, type Declaration } from "../../app/src/domain/packages/declaration.ts";
import { planEnvironment, type Target } from "../../app/src/domain/packages/environment.ts";
import {
  checkPublicKeyDer,
  fromKeyFile,
  generateSigningKey,
  publicKeyText,
  signMinisign,
  toKeyFile,
  type SigningKey,
  type SigningKeyFile,
} from "./minisign-sign.ts";
import { writeTar } from "./tar.ts";

/** Paths never carried into the archive, whatever the package folder happens to hold. */
const DEFAULT_IGNORE = new Set([
  ".git",
  ".DS_Store",
  "node_modules",
  "__pycache__",
  ".venv",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  FILES_MANIFEST,
  FILES_SIGNATURE,
]);

class BuildError extends Error {
  override name = "BuildError";
}

// ── reading a package folder ────────────────────────────────────────────────────────────────

/** Every regular file of `dir`, by package-relative path, skipping DEFAULT_IGNORE. A `.key`
 * file found inside the package is refused outright: it is never something a package ships. */
function readPackageFolder(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const relative = path
      .relative(dir, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
    const top = relative.split("/")[0] ?? relative;
    if (DEFAULT_IGNORE.has(top) || !entry.isFile()) {
      continue;
    }
    if (relative.endsWith(".key")) {
      throw new BuildError(
        `${relative} looks like an inny-pack signing key; it must never be inside the ` +
          "package it signs. Keep keys outside the package folder (docs/authors/packaging.md).",
      );
    }
    const problem = pathProblem(relative);
    if (problem !== null) {
      throw new BuildError(`${relative}: ${problem}`);
    }
    files.set(relative, fs.readFileSync(path.join(dir, relative)));
  }
  if (!files.has(DECLARATION_FILE)) {
    throw new BuildError(`${dir} has no ${DECLARATION_FILE}`);
  }
  return files;
}

function readDeclaration(files: ReadonlyMap<string, Uint8Array>): Declaration {
  const bytes = files.get(DECLARATION_FILE);
  if (bytes === undefined) {
    throw new BuildError(`no ${DECLARATION_FILE}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new BuildError(`${DECLARATION_FILE} is not JSON: ${(error as Error).message}`);
  }
  const validator = new AjvSchemaValidator();
  const parsed = parseDeclaration(value, (declaration) => validator.declaration(declaration));
  if (!parsed.ok) {
    throw new BuildError(
      `${DECLARATION_FILE} is invalid, the way the app would refuse it:\n` +
        parsed.problems.map((problem) => `  - ${problem}`).join("\n"),
    );
  }
  return parsed.declaration;
}

// ── the manifest and its signature ──────────────────────────────────────────────────────────

function buildManifestJson(manifest: FileManifest): Uint8Array {
  const files: Record<string, string> = {};
  for (const [file, digest] of [...manifest].sort(([a], [b]) => a.localeCompare(b))) {
    files[file] = digest;
  }
  return new TextEncoder().encode(JSON.stringify({ files }, null, 2) + "\n");
}

function loadKey(keyPath: string): SigningKey {
  const document = JSON.parse(fs.readFileSync(keyPath, "utf8")) as SigningKeyFile;
  const key = fromKeyFile(document);
  checkPublicKeyDer(key.publicKeyDer);
  return key;
}

// ── self-verification, exactly the app's own path ──────────────────────────────────────────

interface VerifyReport {
  readonly package: string;
  readonly version: string;
  readonly contentHash: string;
  readonly fileCount: number;
}

/** Re-reads `archivePath` through the SAME code the app runs on install (spec 2.3.5): the
 * signature over files.json, every file against its hash, and the content hash. Throws
 * PackageRefusal (or MinisignError) exactly as the app would, naming the same reason. */
async function verifyArchive(archivePath: string, publicKey: string): Promise<VerifyReport> {
  const source = new FsPackageSource();
  const files = await source.readArchive(archivePath);
  const manifestBytes = files.get(FILES_MANIFEST);
  const signatureText = files.get(FILES_SIGNATURE);
  if (manifestBytes === undefined || signatureText === undefined) {
    throw new BuildError(`${archivePath} carries no ${FILES_MANIFEST}/${FILES_SIGNATURE}`);
  }
  const trustedComment = new MinisignVerifier().verify(
    manifestBytes,
    new TextDecoder("utf-8").decode(signatureText),
    publicKey,
  );
  const manifest = parseFileManifest(manifestBytes);
  verifyFiles(files, manifest, sha256Hex);
  const declaration = readDeclaration(files);
  const contentBytes = new Map(
    [...files].filter(([file]) => file !== FILES_MANIFEST && file !== FILES_SIGNATURE),
  );
  const hash = contentHash(manifestOf(contentBytes, sha256Hex), sha256Hex);
  // The trusted comment is trusted only because verify() returned it (its own docstring); use
  // that trust for something: the content hash it names must be the one just recomputed, or
  // the signature covers a claim about DIFFERENT bytes than the files it travelled with.
  const claimed = /\bcontent:([0-9a-f]{64})\b/.exec(trustedComment)?.[1];
  if (claimed !== undefined && claimed !== hash) {
    throw new BuildError(
      `${archivePath}: the signature's trusted comment claims content hash ${claimed}, but ` +
        `the files it travelled with hash to ${hash}`,
    );
  }
  return {
    package: declaration.package,
    version: declaration.version,
    contentHash: hash,
    fileCount: manifest.size,
  };
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────

function cmdKeygen(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { name: { type: "string", default: "inny-pack" } },
  });
  const dir = positionals[0];
  if (dir === undefined) {
    throw new BuildError("usage: inny-pack keygen <dir> [--name <text>]");
  }
  fs.mkdirSync(dir, { recursive: true });
  const key = generateSigningKey();
  const pubPath = path.join(dir, `${values.name}.pub`);
  const keyPath = path.join(dir, `${values.name}.key`);
  fs.writeFileSync(pubPath, publicKeyText(key, `minisign public key for ${values.name}`));
  fs.writeFileSync(keyPath, JSON.stringify(toKeyFile(key), null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600); // writeFileSync's mode is masked by umask; make it explicit
  console.log(`wrote ${pubPath} (share this) and ${keyPath} (never share or commit this)`);
}

async function cmdBuild(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      key: { type: "string" },
      out: { type: "string" },
      target: { type: "string" }, // "<platform>-<arch>", executable packages only
    },
  });
  const packageDir = positionals[0];
  if (packageDir === undefined || values.key === undefined) {
    throw new BuildError(
      "usage: inny-pack build <package-dir> --key <secret-key-file> [--out <archive.tgz>]",
    );
  }
  const files = readPackageFolder(path.resolve(packageDir));
  const declaration = readDeclaration(files);

  const [platform, arch] = (values.target ?? `${process.platform}-${process.arch}`).split("-");
  const target: Target = { platform: platform ?? process.platform, arch: arch ?? process.arch };
  const plan = planEnvironment(declaration, files, target, sha256Hex); // refuses as the app would
  console.log(`environment: ${plan.kind}`);

  const manifest = manifestOf(files, sha256Hex);
  const manifestJson = buildManifestJson(manifest);
  const hash = contentHash(manifest, sha256Hex);
  const key = loadKey(values.key);
  const archiveName = values.out ?? `${declaration.package}-${declaration.version}.tgz`;
  const trustedComment =
    `timestamp:${String(Math.floor(Date.now() / 1000))}\t` +
    `file:${path.basename(archiveName)}\t` +
    `package:${declaration.package}\tversion:${declaration.version}\tcontent:${hash}`;
  const signature = signMinisign(
    manifestJson,
    key,
    trustedComment,
    `signature by inny-pack for ${declaration.package} ${declaration.version}`,
  );

  const archived = new Map(files);
  archived.set(FILES_MANIFEST, manifestJson);
  archived.set(FILES_SIGNATURE, new TextEncoder().encode(signature));
  const tar = writeTar(archived);
  fs.writeFileSync(archiveName, gzipSync(tar));
  console.log(`built ${archiveName} (${String(manifest.size)} files, content hash ${hash})`);

  // Self-check: the archive just written must be one the app would accept, verified through
  // the app's own code, not a second copy of the same rules.
  const publicKey = publicKeyText(key, "inny-pack build's own key");
  const report = await verifyArchive(archiveName, publicKey);
  if (report.contentHash !== hash) {
    throw new BuildError(
      `built ${archiveName} but re-reading it gives content hash ${report.contentHash}, ` +
        `not ${hash} -- the archive does not hold what was just written`,
    );
  }
  console.log(
    `verified ${archiveName}: package ${report.package} ${report.version}, ` +
      `${String(report.fileCount)} files, content hash ${report.contentHash}`,
  );
}

async function cmdVerify(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { key: { type: "string" } },
  });
  const archivePath = positionals[0];
  if (archivePath === undefined || values.key === undefined) {
    throw new BuildError("usage: inny-pack verify <archive.tgz> --key <public-key-file>");
  }
  const publicKey = fs.readFileSync(values.key, "utf8");
  const report = await verifyArchive(path.resolve(archivePath), publicKey);
  console.log(
    `${archivePath} verifies: package ${report.package} ${report.version}, ` +
      `${String(report.fileCount)} files, content hash ${report.contentHash}`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "keygen") {
    cmdKeygen(rest);
  } else if (command === "build") {
    await cmdBuild(rest);
  } else if (command === "verify") {
    await cmdVerify(rest);
  } else {
    console.error("usage: inny-pack <keygen|build|verify> ...");
    process.exitCode = 2;
  }
}

// Whether this module is the entrypoint, either raw (Node's type stripping: import.meta.url)
// or esbuild's --format=cjs bundle (dist/cli.cjs, where import.meta is empty but require.main
// is set): checked both ways so the same source runs identically either way.
declare const require: { main?: unknown } | undefined;
declare const module: unknown;
const isMain =
  typeof require !== "undefined" && typeof module !== "undefined"
    ? require.main === module
    : process.argv[1] !== undefined &&
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error: unknown) => {
    console.error(`inny-pack: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

// Re-exported so tools/inny-pack's own tests can drive build/verify without shelling out.
export { cmdBuild, cmdKeygen, cmdVerify, verifyArchive };
