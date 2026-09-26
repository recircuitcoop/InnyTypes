// One verified environment per package (spec 2.3.3, 2.3.5; plan 0013; WI-0018-15).
//
// The spike ran every package on one shared Python. Here a package is taken from its signed
// archive or from a folder (a path install), judged, and built into its own environment:
//
// 1. archive: the signature over files.json, before files.json is parsed;
// 2. archive: every file against its hash in files.json, and no file that is not listed;
// 3. the declaration, by the spec's schema;
// 4. the content hash, against the one recorded for the same version (plan 0013);
// 5. the environment plan (Python version, lock, no npm, the binary's sha256);
// 6. build in staging, write the record last, swap in, then record the content hash.
//
// A refusal at any step leaves the live package untouched: nothing is written before step 6,
// and a build that fails leaves only staging scrap, which the next stage() replaces. Every
// refusal is reported to the log as well as thrown.
//
// Asking a person, and refusing a second install of the same name, are WI-0018-16's (install,
// remove, hot-add), which calls this with `admit`: judged on the verified declaration, before
// anything is written.

import {
  DECLARATION_FILE,
  FILES_MANIFEST,
  FILES_SIGNATURE,
  PackageRefusal,
  contentHash,
  judgeContent,
  manifestOf,
  parseFileManifest,
  verifyFiles,
  type FileManifest,
  type Sha256,
} from "../domain/packages/archive";
import { parseDeclaration, type Declaration } from "../domain/packages/declaration";
import { planEnvironment, type Target } from "../domain/packages/environment";
import type { ContentHashes } from "../ports/content-hashes";
import type { BuiltEnvironment, EnvironmentBuilder } from "../ports/environment-builder";
import type { Logger } from "../ports/logger";
import type { InstalledOrigin, InstalledRecord, PackageRoots } from "../ports/package-roots";
import type { PackageSource } from "../ports/package-source";
import type { SchemaValidator } from "../ports/schema-validator";
import type { SignatureVerifier } from "../ports/signature-verifier";

/**
 * Where a package comes from: an archive and its publisher's key, or a folder. An archive with
 * no key is unsigned (a developer's file, WI-0018-16): its files are taken as they are, like a
 * folder's, and its record says it is unsigned.
 */
export type PackageOrigin =
  | { readonly kind: "archive"; readonly path: string; readonly publicKey: string | null }
  | { readonly kind: "path"; readonly folder: string };

/** Whether a publisher's signature is checked for this origin. */
export function isSigned(origin: PackageOrigin): boolean {
  return origin.kind === "archive" && origin.publicKey !== null;
}

export interface PackageEnvironmentPorts {
  readonly source: PackageSource;
  readonly verifier: SignatureVerifier;
  readonly validator: SchemaValidator;
  readonly contentHashes: ContentHashes;
  readonly roots: PackageRoots;
  readonly builder: EnvironmentBuilder;
  readonly logger: Logger;
  readonly sha256: Sha256;
  /** The platform and CPU this runtime runs on, for an executable package's binary. */
  readonly target: Target;
}

/** A package whose environment is built and live. */
export interface BuiltPackage {
  readonly record: InstalledRecord;
  readonly live: string;
  readonly previous: string | null;
}

function describe(origin: PackageOrigin): string {
  return origin.kind === "archive" ? origin.path : origin.folder;
}

/** Steps 1 and 2 for an archive; the files as they are for a path install. */
function verifiedManifest(
  origin: PackageOrigin,
  files: ReadonlyMap<string, Uint8Array>,
  ports: Pick<PackageEnvironmentPorts, "verifier" | "sha256">,
): FileManifest {
  if (origin.kind === "path" || origin.publicKey === null) {
    return manifestOf(files, ports.sha256);
  }
  const listing = files.get(FILES_MANIFEST);
  const signature = files.get(FILES_SIGNATURE);
  if (listing === undefined || signature === undefined) {
    throw new PackageRefusal(
      "signature",
      `the archive holds no ${listing === undefined ? FILES_MANIFEST : FILES_SIGNATURE}, so ` +
        "nothing in it is signed",
    );
  }
  try {
    ports.verifier.verify(listing, new TextDecoder().decode(signature), origin.publicKey);
  } catch (error) {
    throw new PackageRefusal(
      "signature",
      `${FILES_MANIFEST} is not signed by this source's key: ${(error as Error).message}`,
    );
  }
  const manifest = parseFileManifest(listing);
  verifyFiles(files, manifest, ports.sha256);
  return manifest;
}

/** Step 3: the declaration, by the spec's schema and the rules beyond it. */
function declarationOf(
  files: ReadonlyMap<string, Uint8Array>,
  validator: SchemaValidator,
): Declaration {
  const bytes = files.get(DECLARATION_FILE);
  if (bytes === undefined) {
    throw new PackageRefusal("declaration", `the package has no ${DECLARATION_FILE}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new PackageRefusal(
      "declaration",
      `${DECLARATION_FILE} is not JSON: ${(error as Error).message}`,
    );
  }
  const parsed = parseDeclaration(document, (value) => validator.declaration(value));
  if (!parsed.ok) {
    throw new PackageRefusal("declaration", `${DECLARATION_FILE}: ${parsed.problems.join("; ")}`);
  }
  return parsed.declaration;
}

/** Judged on the verified declaration before anything is written; throws a PackageRefusal. */
export type Admit = (declaration: Declaration) => void;

async function readVerified(
  origin: PackageOrigin,
  ports: Pick<PackageEnvironmentPorts, "source" | "verifier" | "validator" | "sha256">,
): Promise<{
  files: ReadonlyMap<string, Uint8Array>;
  manifest: FileManifest;
  declaration: Declaration;
}> {
  let files: ReadonlyMap<string, Uint8Array>;
  try {
    files =
      origin.kind === "archive"
        ? await ports.source.readArchive(origin.path)
        : await ports.source.readFolder(origin.folder);
  } catch (error) {
    throw new PackageRefusal("unreadable", `it cannot be read: ${(error as Error).message}`);
  }
  const manifest = verifiedManifest(origin, files, ports);
  return { files, manifest, declaration: declarationOf(files, ports.validator) };
}

/**
 * Steps 1 to 3 and the content hash, with nothing written: what a package's folder or archive
 * holds now, for the update check (WI-0018-17). Rejects with a PackageRefusal.
 */
export async function inspectPackage(
  origin: PackageOrigin,
  ports: Pick<PackageEnvironmentPorts, "source" | "verifier" | "validator" | "sha256">,
): Promise<{ declaration: Declaration; contentHash: string }> {
  const { manifest, declaration } = await readVerified(origin, ports);
  return { declaration, contentHash: contentHash(manifest, ports.sha256) };
}

async function judgeAndBuild(
  origin: PackageOrigin,
  ports: PackageEnvironmentPorts,
  admit: Admit,
  from: InstalledOrigin | undefined,
): Promise<BuiltPackage> {
  const { files, manifest, declaration } = await readVerified(origin, ports);
  admit(declaration);
  const hash = contentHash(manifest, ports.sha256);
  judgeContent(
    declaration.package,
    declaration.version,
    hash,
    ports.contentHashes.recorded(declaration.package, declaration.version),
  );
  const plan = planEnvironment(declaration, files, ports.target, ports.sha256);

  // Step 6. Only the package's own files go into the environment's package folder, never the
  // two that describe the archive.
  const staged = ports.roots.stage(declaration.package);
  const packageFiles = new Map([...files].filter(([file]) => manifest.has(file)));
  ports.roots.writeFiles(staged.packageDir, packageFiles);
  let built: BuiltEnvironment;
  try {
    built = await ports.builder.build(plan, staged.packageDir, staged.environmentDir);
  } catch (error) {
    throw new PackageRefusal(
      "environment",
      `${declaration.package}: its environment could not be built: ${(error as Error).message}`,
    );
  }
  const record: InstalledRecord = {
    package: declaration.package,
    version: declaration.version,
    contentHash: hash,
    environment: plan.kind,
    signed: isSigned(origin),
    ...(from === undefined ? {} : { origin: from }),
    // Relative to the package's folder, which moves when it is swapped in.
    ...(built.python === undefined ? {} : { python: `environment/${built.python}` }),
  };
  ports.roots.writeRecord(staged, record);
  const swapped = ports.roots.swapIn(declaration.package);
  ports.contentHashes.record(declaration.package, declaration.version, hash);
  return { record, live: swapped.live, previous: swapped.previous };
}

/**
 * Verify a package and build its environment, then swap it in. Rejects with a PackageRefusal
 * naming the step that refused it, which is also logged; the live package is then untouched.
 * `from` is recorded as where it came from, for the update check (WI-0018-17).
 */
export async function buildPackageEnvironment(
  origin: PackageOrigin,
  ports: PackageEnvironmentPorts,
  admit: Admit = () => undefined,
  from?: InstalledOrigin,
): Promise<BuiltPackage> {
  try {
    const built = await judgeAndBuild(origin, ports, admit, from);
    ports.logger.info(
      `package ${built.record.package} ${built.record.version} is installed in its own ` +
        `${built.record.environment} environment (content ${built.record.contentHash})`,
    );
    return built;
  } catch (error) {
    const refusal =
      error instanceof PackageRefusal
        ? error
        : new PackageRefusal("environment", (error as Error).message);
    ports.logger.warn(
      `package ${describe(origin)} was refused (${refusal.reason}): ${refusal.message}`,
    );
    throw refusal;
  }
}
