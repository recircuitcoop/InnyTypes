// The content hash of every package shipped inside this app build (plan 0022 §F): written at
// build time (`npm run build:packages`, shell/shipped-manifest-build.ts) into the app bundle,
// which the app's signature and asar integrity protect, and checked at every start against the
// shipped folders as they are. A shipped package's version never moves between releases, so
// the reference is THIS build's manifest, never a hash this machine recorded on its own: a
// folder changed before the first start fails its check, and an app update brings its own.

import type { Installation } from "../domain/packages/states";
import { folderHash } from "./package-facets";
import type { PackageEnvironmentPorts } from "./package-environment";

/** The manifest's name, beside the bundled processes in `dist/`. */
export const SHIPPED_MANIFEST = "shipped-packages.json";

/** Each shipped package's content hash, by name. */
export type ShippedManifest = Readonly<Record<string, string>>;

/** The manifest of `packages`, each folder hashed as a start checks it. */
export async function shippedManifest(
  packages: readonly { readonly name: string; readonly folder: string }[],
  ports: Pick<PackageEnvironmentPorts, "source" | "sha256">,
): Promise<ShippedManifest> {
  const manifest: Record<string, string> = {};
  for (const { name, folder } of packages) {
    manifest[name] = await folderHash(folder, ports);
  }
  return manifest;
}

/** A manifest as written; anything else is no manifest, against which nothing passes. */
export function parseShippedManifest(text: string): ShippedManifest {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${SHIPPED_MANIFEST} is not an object of package hashes`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, hash]) => typeof hash === "string")) {
    throw new Error(`${SHIPPED_MANIFEST} holds a hash that is not text`);
  }
  return Object.fromEntries(entries) as ShippedManifest;
}

/**
 * A shipped package's folder against `expected`, its hash in this build's manifest: installed
 * when they agree; failed its check when they do not, when the manifest has none for it, or
 * when the folder cannot be read.
 */
export async function shippedCheck(
  folder: string,
  expected: string | undefined,
  ports: Pick<PackageEnvironmentPorts, "source" | "sha256">,
  now: number,
): Promise<Installation> {
  const verifiedAt = new Date(now);
  if (expected === undefined) {
    return { state: "failed-check", reason: "files", verifiedAt };
  }
  try {
    return (await folderHash(folder, ports)) === expected
      ? { state: "installed", verifiedAt }
      : { state: "failed-check", reason: "content-moved", verifiedAt };
  } catch {
    return { state: "failed-check", reason: "unreadable", verifiedAt };
  }
}
