// The package archive and the package's content hash (plan 0018 §3; WI-0018-15; plan 0013).
//
// A package is published as a `.tgz` holding its files, `inny-package.json` among them, plus:
//
// - `files.json`: `{"files": {"<relative path>": "<sha256 hex>", ...}}`, one entry for every
//   file of the package and for nothing else;
// - `files.json.minisig`: the publisher's detached minisign signature of `files.json`.
//
// The archive is judged in one order, and each step trusts only what the one before it proved:
//
// 1. the signature, over the bytes of `files.json`, before `files.json` is even parsed;
// 2. the per-file hashes: every file listed is present with its hash, and every file present
//    is listed (an unlisted file is unsigned code);
// 3. the content hash, against the one recorded for the same package and version.
//
// The content hash answers plan 0013: a version whose content moved while its number did not.
// It is the sha256 of the sorted `<sha256>  <path>` lines of the package's files (the output
// of `sha256sum`, sorted by path), so an archive and the same files in a folder have the same
// hash, and a path install is compared by it exactly as an archive is.
//
// Pure: the sha256 primitive is handed in.

/** The listing of every file's hash, which the signature covers. */
export const FILES_MANIFEST = "files.json";
/** The detached minisign signature of `files.json`, minisign's own default name. */
export const FILES_SIGNATURE = "files.json.minisig";
/** The declaration every package holds at its root (spec 2.1). */
export const DECLARATION_FILE = "inny-package.json";

/** The lowercase hex sha256 of some bytes. */
export type Sha256 = (bytes: Uint8Array) => string;

/** What a package is refused for; the step of the order above, or what came after it. */
export type RefusalReason =
  | "unreadable"
  | "signature"
  | "files"
  | "declaration"
  | "content-moved"
  | "environment"
  // WI-0018-16: an install refused before anything is built.
  | "installed"
  | "reserved"
  | "unconfirmed";

/**
 * A package refused. There is no softer outcome: a package accepted with complaints is one
 * nobody can rely on. `reason` names the step for the report and for tests.
 */
export class PackageRefusal extends Error {
  override name = "PackageRefusal";
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** A package's files and their hashes, by relative path with `/` separators. */
export type FileManifest = ReadonlyMap<string, string>;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * What is wrong with a path inside a package, or null. A package path is relative, uses `/`,
 * and never leaves the package: no `..`, no absolute path, no drive, no empty segment.
 */
export function pathProblem(file: string): string | null {
  if (file === "" || file.startsWith("/") || /^[A-Za-z]:/.test(file)) {
    return `${JSON.stringify(file)} is not a relative path`;
  }
  if (file.includes("\\") || file.includes("\0")) {
    return `${JSON.stringify(file)} holds a character a package path may not`;
  }
  if (file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${JSON.stringify(file)} leaves the package or names no file`;
  }
  return null;
}

/** Whether a path is one of the two files that describe the package rather than belong to it. */
function describesThePackage(file: string): boolean {
  return file === FILES_MANIFEST || file === FILES_SIGNATURE;
}

/** Parse `files.json` (already covered by the signature), or refuse it. */
export function parseFileManifest(bytes: Uint8Array): FileManifest {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new PackageRefusal("files", `${FILES_MANIFEST} is not JSON: ${(error as Error).message}`);
  }
  const files =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>)["files"]
      : undefined;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new PackageRefusal("files", `${FILES_MANIFEST}: "files" must be an object`);
  }
  const manifest = new Map<string, string>();
  const problems: string[] = [];
  for (const [file, digest] of Object.entries(files as Record<string, unknown>)) {
    const problem = pathProblem(file);
    if (problem !== null) {
      problems.push(problem);
    } else if (describesThePackage(file)) {
      problems.push(`${JSON.stringify(file)} cannot list itself`);
    } else if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      problems.push(`${JSON.stringify(file)}: its hash is not 64 lowercase hex characters`);
    } else {
      manifest.set(file, digest);
    }
  }
  if (problems.length > 0) {
    throw new PackageRefusal("files", `${FILES_MANIFEST}: ${problems.join("; ")}`);
  }
  if (!manifest.has(DECLARATION_FILE)) {
    throw new PackageRefusal("files", `${FILES_MANIFEST} does not list ${DECLARATION_FILE}`);
  }
  return manifest;
}

/**
 * Check every file of an archive against the signed manifest: each listed file is there with
 * its hash, and nothing is there that is not listed. Every problem is named, not only the first.
 */
export function verifyFiles(
  files: ReadonlyMap<string, Uint8Array>,
  manifest: FileManifest,
  sha256: Sha256,
): void {
  const problems: string[] = [];
  for (const [file, digest] of manifest) {
    const bytes = files.get(file);
    if (bytes === undefined) {
      problems.push(`${file} is listed but not in the package`);
    } else if (sha256(bytes) !== digest) {
      problems.push(`${file} does not match its sha256 in ${FILES_MANIFEST}`);
    }
  }
  for (const file of files.keys()) {
    if (!describesThePackage(file) && !manifest.has(file)) {
      problems.push(`${file} is in the package but not listed, so nothing signed it`);
    }
  }
  if (problems.length > 0) {
    throw new PackageRefusal("files", problems.sort().join("; "));
  }
}

/** The manifest of files as they are: what a path install is judged by. */
export function manifestOf(files: ReadonlyMap<string, Uint8Array>, sha256: Sha256): FileManifest {
  const manifest = new Map<string, string>();
  for (const [file, bytes] of files) {
    if (!describesThePackage(file)) {
      manifest.set(file, sha256(bytes));
    }
  }
  return manifest;
}

/** The package's content hash: the sha256 of its sorted `<sha256>  <path>` lines. */
export function contentHash(manifest: FileManifest, sha256: Sha256): string {
  const text = [...manifest.keys()]
    .sort()
    .map((file) => `${manifest.get(file) ?? ""}  ${file}\n`)
    .join("");
  return sha256(new TextEncoder().encode(text));
}

/**
 * Plan 0013: one version, one content. Refuses a package whose content hash is not the one
 * recorded for the same package at the same version; a version never seen before is accepted.
 */
export function judgeContent(
  name: string,
  version: string,
  hash: string,
  recorded: string | undefined,
): void {
  if (recorded === undefined || recorded === hash) {
    return;
  }
  throw new PackageRefusal(
    "content-moved",
    `${name} ${version} is not the ${name} ${version} installed before: its content hash is ` +
      `${hash}, and ${recorded} was recorded for that version. A package's content cannot ` +
      "change under the same version; the publisher must release a new version.",
  );
}
