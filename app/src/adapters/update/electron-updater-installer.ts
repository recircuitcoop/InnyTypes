// The SelfUpdater over electron-updater (plan 0018 §1, §3 swap.py/windows.py: Replace;
// WI-0018-24): the platform-specific download and install, once
// application/update-check.ts's own minisign check of the feed has already passed.
//
// electron-updater is asked nothing until `checkForUpdates` is called (this class makes no
// call in its constructor), and application/update-check.ts calls it only after its own
// verification of `latest-*.yml` and its signature succeeded — never on its own.
//
// What electron-updater downloads is bound to what InnyTypes verified. electron-updater reads the
// feed again on its own fetch, which a server can answer differently, so `autoDownload` is off:
// each check first compares what electron-updater found with the verified release
// (domain/update/release-metadata.ts's releaseMismatch: the same version, and only files the
// signed metadata names, with their signed sha512), and only then is the download started.
// electron-updater refuses, as it downloads them, any bytes that do not hash to that sha512 (its
// DigestTransform; a cached or differential download is checked against the same sha512). The
// comparison must come BEFORE the download: on macOS electron-updater hands a finished download
// to Squirrel.Mac at once, which installs it at quit whatever happens next.
//
// `autoInstallOnAppQuit` is set explicitly so the rule (install at quit; plan 0003 D11's
// apply-at-quit, kept) is read from this file rather than assumed from a library default.
// `allowDowngrade` is false at all times but during a verified Go back's own check: setting
// `channel` turns it on inside electron-updater, so it is turned off again right after.
//
// One operation at a time: electron-updater shares one feed and one in-flight check between all
// callers, so a scheduled check never runs inside a Go back's pinned feed, nor the reverse.
//
// electron-updater supports auto-update only for a macOS zip (Squirrel.Mac) and a Linux
// AppImage; the Linux deb target this application also ships is updated by the system's own
// package manager, never by this class.

import type { AppUpdater } from "electron-updater";
import { releaseMismatch, type ReleaseMetadata } from "../../domain/update/release-metadata";
import { ReleaseMismatchError, type SelfUpdater } from "../../ports/self-updater";

export interface UpdaterLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** `repoSlug` is `"owner/repo"`, exactly as GitHub Releases and package.json's own placeholder
 * name it; this is the one place it is split for electron-updater's GitHub provider config. */
function parseRepoSlug(repoSlug: string): { owner: string; repo: string } {
  const slash = repoSlug.indexOf("/");
  if (slash < 1 || slash === repoSlug.length - 1) {
    throw new Error(`"${repoSlug}" is not an "owner/repo" GitHub slug`);
  }
  return { owner: repoSlug.slice(0, slash), repo: repoSlug.slice(slash + 1) };
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ElectronUpdaterInstaller implements SelfUpdater {
  readonly #updater: AppUpdater;
  readonly #logger: UpdaterLogger;
  /** The normal feed: this build's own GitHub releases. */
  readonly #feed: { readonly provider: "github"; readonly owner: string; readonly repo: string };
  /** The operation running now; the next one waits for it. */
  #queue: Promise<void> = Promise.resolve();

  constructor(updater: AppUpdater, repoSlug: string, channel: string, logger: UpdaterLogger) {
    this.#updater = updater;
    this.#logger = logger;
    this.#feed = { provider: "github", ...parseRepoSlug(repoSlug) };
    updater.logger = logger;
    // Started by #stage alone, once what electron-updater found is the verified release.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.channel = channel;
    // electron-updater's channel setter allows downgrades; this build never does, but for Go back.
    updater.allowDowngrade = false;
    updater.setFeedURL(this.#feed);
  }

  checkForUpdates(verified: ReleaseMetadata): Promise<void> {
    return this.#exclusive(async () => {
      this.#restoreFeed();
      try {
        await this.#stage(verified);
      } finally {
        this.#restoreFeed();
      }
    });
  }

  downloadRelease(releaseUrl: string, verified: ReleaseMetadata): Promise<void> {
    // electron-updater has no rollback (plan 0022 risk 2): an older release is installed as an
    // update from a feed pinned to that release's tag, with downgrades allowed for it alone.
    return this.#exclusive(async () => {
      this.#updater.setFeedURL({ provider: "generic", url: releaseUrl });
      this.#updater.allowDowngrade = true;
      this.#logger.info(`electron-updater: pinned to ${releaseUrl}, downgrade allowed`);
      try {
        await this.#stage(verified);
      } finally {
        // Whatever happened: a failed Go back must not leave the next check on the old feed.
        this.#restoreFeed();
        this.#logger.info("electron-updater: back on the normal feed, downgrade not allowed");
      }
    });
  }

  quitAndInstall(): void {
    try {
      this.#updater.quitAndInstall();
    } catch (error) {
      this.#logger.warn(`electron-updater could not install at quit: ${reasonOf(error)}`);
    }
  }

  /** Check the feed set now; download only when it found exactly `verified`. */
  async #stage(verified: ReleaseMetadata): Promise<void> {
    const result = await this.#updater.checkForUpdates();
    if (result === null) {
      // electron-updater is inactive in a build that is not installed: it fetched nothing, and
      // has nothing to install.
      this.#logger.info("electron-updater: inactive in this build; nothing is downloaded");
      return;
    }
    const why = releaseMismatch(result.updateInfo, verified);
    if (why !== null) {
      throw new ReleaseMismatchError(`electron-updater's feed is not the verified release: ${why}`);
    }
    if (!result.isUpdateAvailable) {
      throw new Error(`electron-updater does not offer ${verified.version} to this machine`);
    }
    await this.#updater.downloadUpdate(result.cancellationToken);
  }

  #restoreFeed(): void {
    this.#updater.setFeedURL(this.#feed);
    this.#updater.allowDowngrade = false;
  }

  #exclusive(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
