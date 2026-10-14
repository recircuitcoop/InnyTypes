// The facets of a package's row in General (plan 0022 §F; domain/packages/states.ts), each from
// what InnyTypes verified and when: registration from the running runtime's types, installation
// from a content hash re-checked against the recorded one, and the update from the last answer
// of where the package came from, a recent update's Go back, or the version a Go back left.
// application/package-board.ts gathers the facts; these turn them into states.

import { contentHash, manifestOf, PackageRefusal } from "../domain/packages/archive";
import {
  rollbackOffered,
  ROLLBACK_WINDOW_MS,
  type Installation,
  type PackageUpdate,
  type Registration,
} from "../domain/packages/states";
import type { VersionFinding } from "../domain/packages/versions";
import type { InstalledRecord } from "../ports/package-roots";
import type { ListedPackage } from "./install-package";
import { inspectPackage, type PackageEnvironmentPorts } from "./package-environment";

/** Registered while the running runtime holds one of its types; null while it is not running. */
export function registrationOf(
  name: string,
  types: readonly string[] | null,
  at: Date,
): Registration | null {
  if (types === null) {
    return null;
  }
  const loaded = types.some((type) => type.startsWith(`inny-${name}-`));
  return { state: loaded ? "registered" : "not-registered", verifiedAt: at };
}

/**
 * A package folder's files now against `recorded`, the hash recorded for its version: installed
 * when they agree, failed its check when they do not or cannot be read.
 */
export async function contentCheck(
  folder: string,
  recorded: string,
  environment: Pick<PackageEnvironmentPorts, "source" | "verifier" | "validator" | "sha256">,
  at: Date,
): Promise<Installation> {
  try {
    const now = await inspectPackage({ kind: "path", folder }, environment);
    return now.contentHash === recorded
      ? { state: "installed", verifiedAt: at }
      : { state: "failed-check", reason: "content-moved", verifiedAt: at };
  } catch (error) {
    const reason = error instanceof PackageRefusal ? error.reason : "unreadable";
    return { state: "failed-check", reason, verifiedAt: at };
  }
}

/**
 * A package folder's content hash: its files as they are, hashed as an install hashes them, with
 * no declaration read. What a shipped package is checked by (application/shipped-manifest.ts).
 */
export async function folderHash(
  folder: string,
  ports: Pick<PackageEnvironmentPorts, "source" | "sha256">,
): Promise<string> {
  const files = new Map(
    [...(await ports.source.readFolder(folder))].filter(([file]) => !NOT_SHIPPED.test(file)),
  );
  return contentHash(manifestOf(files, ports.sha256), ports.sha256);
}

/** What packaging leaves out of a shipped package (packaging/electron-builder.yml's filter). */
const NOT_SHIPPED = /(^|\/)(node_modules|__pycache__)\/|\.pyc$/;

/** What asking the package's source found, as its update facet; null when it could not tell. */
export function findingFacet(finding: VersionFinding, at: Date): PackageUpdate | null {
  switch (finding.kind) {
    case "current":
      return { state: "up-to-date", verifiedAt: at };
    case "newer":
      return { state: "available", version: finding.version, verifiedAt: at };
    case "moved":
      return { state: "changed", version: finding.version, verifiedAt: at };
    case "unchecked":
      return null;
  }
}

/** A catalogue package's facet from the scheduled update check; null before any check. */
export function checkFacet(
  listed: ListedPackage | undefined,
  checkedAt: number | null,
): PackageUpdate | null {
  if (checkedAt === null || listed === undefined) {
    return null;
  }
  const at = new Date(checkedAt);
  const line = listed.update;
  if (line === null) {
    return { state: "up-to-date", verifiedAt: at };
  }
  if (line.kind === "unchecked" || line.version === null) {
    return null;
  }
  switch (line.kind) {
    case "moved":
      return { state: "changed", version: line.version, verifiedAt: at };
    case "failed":
      // Rolled back and blocked: said with its reason, never offered (update-package.ts `#lineFor`).
      return {
        state: "blocked",
        version: line.version,
        reason: line.detail ?? "",
        verifiedAt: at,
      };
    case "newer":
      return { state: "available", version: line.version, verifiedAt: at };
  }
}

/** The version a Go back left, as the record it put back says: offered again (D5). */
export function leftFacet(record: InstalledRecord): PackageUpdate | null {
  return record.left === undefined
    ? null
    : { state: "available", version: record.left.version, verifiedAt: new Date(record.left.at) };
}

/** Go back while what the last update replaced is kept, for seven days from the update (D5). */
export function goBackOffer(
  record: InstalledRecord,
  kept: InstalledRecord | undefined,
  now: Date,
): Extract<PackageUpdate, { state: "updated" }> | null {
  const at = record.installedAt;
  if (kept === undefined || at === undefined) {
    return null;
  }
  const offer = {
    state: "updated" as const,
    version: record.version,
    previous: kept.version,
    at: record.updatedAtUnknown === true ? null : new Date(at),
    rollbackUntil: new Date(at + ROLLBACK_WINDOW_MS),
    verifiedAt: new Date(at),
  };
  return rollbackOffered(offer, now) ? offer : null;
}

/** What asking a package's source found: its update facet, and whether its folder was unreadable. */
export interface Asked {
  readonly update: PackageUpdate | null;
  readonly unreadable: boolean;
}

/**
 * What the latest asking of a package's source found: the board's own (`mine`, at start or on
 * a press) or the scheduled update check's (`listed` at `checkedAt`), whichever is newer. So a
 * folder that comes back is offered Check for changes again at the next check, not only at the
 * next start.
 */
export function latestAsked(
  record: InstalledRecord,
  mine: { readonly at: number; readonly value: Asked } | undefined,
  listed: ListedPackage | undefined,
  checkedAt: number | null,
): Asked {
  // A blocked version is said whoever asked last: the line reads the latest finding, the
  // board's or the check's, against the record of failed updates, so it is never older than
  // `mine`, which would still offer the version as available.
  if (listed?.update?.kind === "failed") {
    const times = [checkedAt, mine?.at].filter((at): at is number => at != null);
    return {
      update: checkFacet(listed, times.length === 0 ? null : Math.max(...times)),
      unreadable: false,
    };
  }
  if (checkedAt !== null && (mine === undefined || checkedAt > mine.at)) {
    const line = listed?.update ?? null;
    const origin = record.origin;
    return {
      update: checkFacet(listed, checkedAt),
      unreadable:
        origin?.kind === "file" &&
        line?.kind === "unchecked" &&
        (line.detail ?? "").startsWith(`${origin.path} cannot be read`),
    };
  }
  return mine?.value ?? { update: null, unreadable: false };
}
