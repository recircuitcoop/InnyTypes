// The self-update check in the shell (WI-0018-24): scheduled, settings-driven, and installed
// at quit. shell/main.ts builds the adapters and hands them in; this file imports none
// (plan 0018 §2.3), which keeps the composition root under its 600 lines. `process.platform`
// and `process.arch` are read here, not passed in: shell/telemetry.ts reads them the same way,
// and only `process.env` is reserved for the composition roots (eslint.architecture.config.mjs).

import { UpdateCheck, type UpdateCheckPorts } from "../application/update-check";
import type { ReleasePlatform } from "../domain/update/release-metadata";

/** The first check, soon after the start; then once a day (application/update-check.ts). */
const FIRST_CHECK_MS = 60_000;

export type WireUpdateOptions = Omit<UpdateCheckPorts, "platform" | "arch">;

function releasePlatform(): ReleasePlatform | null {
  if (process.platform === "darwin") {
    return "mac";
  }
  return process.platform === "linux" ? "linux" : null;
}

/**
 * Where a project's releases live, as GitHub Releases lays them out under `releases` (its
 * `…/releases` page): the newest release's files, one tagged release's files (Go back, D4), and
 * a release's notes page.
 */
export function releaseUrls(releases: string): {
  readonly feedBaseUrl: string;
  readonly tagBaseUrl: (tag: string) => string;
  readonly notesUrl: (tag: string) => string;
} {
  const base = releases.replace(/\/+$/, "");
  return {
    feedBaseUrl: `${base}/latest/download`,
    tagBaseUrl: (tag) => `${base}/download/${encodeURIComponent(tag)}`,
    notesUrl: (tag) => `${base}/tag/${encodeURIComponent(tag)}`,
  };
}

/** Where this build's own updates come from, and the key that must have signed them. */
export interface UpdateSource {
  /** `owner/repo` on GitHub Releases: electron-updater's normal feed. */
  readonly repo: string;
  /** The minisign public key; null when this build ships none (every update is refused). */
  readonly publicKey: string | null;
  /** The `…/releases` page the feed, the tags and the release notes are found under. */
  readonly releases: string;
}

/**
 * The update source: what the build was released with (package.json's "innytypes"). The
 * INNYTYPES_UPDATE_REPO and INNYTYPES_UPDATE_KEY variables, and the e2e gate's
 * INNYTYPES_TEST_UPDATE_RELEASES (with INNYTYPES_E2E_HOOKS), point it elsewhere for development
 * and the e2e gate only: an installed build (`packaged`) ignores them all, so nothing in its
 * environment can change the key it trusts or where it fetches from (plan 0003 D10).
 */
export function updateSource(options: {
  readonly packaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly built: { readonly updateRepo: string; readonly updatePublicKey: string | null };
}): UpdateSource {
  const { packaged, env, built } = options;
  if (packaged) {
    const repo = built.updateRepo;
    return {
      repo,
      publicKey: built.updatePublicKey,
      releases: `https://github.com/${repo}/releases`,
    };
  }
  const repo = env["INNYTYPES_UPDATE_REPO"] ?? built.updateRepo;
  const testReleases =
    env["INNYTYPES_E2E_HOOKS"] === "1" ? env["INNYTYPES_TEST_UPDATE_RELEASES"] : undefined;
  return {
    repo,
    publicKey: env["INNYTYPES_UPDATE_KEY"] ?? built.updatePublicKey,
    releases: testReleases ?? `https://github.com/${repo}/releases`,
  };
}

/** Null on a platform this application does not self-update on (Windows: WI-0025-01). */
export function wireUpdate(options: WireUpdateOptions): UpdateCheck | null {
  const platform = releasePlatform();
  if (platform === null) {
    return null;
  }
  const updates = new UpdateCheck({ ...options, platform, arch: process.arch });
  updates.schedule(FIRST_CHECK_MS);
  return updates;
}
