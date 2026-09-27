// The SelfUpdater over electron-updater (plan 0018 §1, §3 swap.py/windows.py: Replace;
// WI-0018-24): the platform-specific download and install, once
// application/update-check.ts's own minisign check of the feed has already passed.
//
// electron-updater is asked nothing until `checkForUpdates` is called (this class makes no
// call in its constructor), and application/update-check.ts calls it only after its own
// verification of `latest-*.yml` and its signature succeeded — never on its own. Both
// `autoDownload` and `autoInstallOnAppQuit` default to true in electron-updater itself; they
// are set explicitly here so the rule (download in the background, install at quit; plan 0003
// D11's apply-at-quit, kept) is read from this file rather than assumed from a library default.
//
// electron-updater supports auto-update only for a macOS zip (Squirrel.Mac) and a Linux
// AppImage; the Linux deb target this application also ships is updated by the system's own
// package manager, never by this class.

import type { AppUpdater } from "electron-updater";
import type { SelfUpdater } from "../../ports/self-updater";

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

export class ElectronUpdaterInstaller implements SelfUpdater {
  readonly #updater: AppUpdater;
  readonly #logger: UpdaterLogger;

  constructor(updater: AppUpdater, repoSlug: string, channel: string, logger: UpdaterLogger) {
    this.#updater = updater;
    this.#logger = logger;
    updater.logger = logger;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.channel = channel;
    updater.setFeedURL({ provider: "github", ...parseRepoSlug(repoSlug) });
  }

  async checkForUpdates(): Promise<void> {
    // Never rejects the caller: a network problem here is the platform updater's own to log,
    // not a reason for application/update-check.ts's already-verified check to look failed.
    try {
      await this.#updater.checkForUpdates();
    } catch (error) {
      this.#logger.warn(
        `electron-updater could not check for updates: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  quitAndInstall(): void {
    try {
      this.#updater.quitAndInstall();
    } catch (error) {
      this.#logger.warn(
        `electron-updater could not install at quit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
