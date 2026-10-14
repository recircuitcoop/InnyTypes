// The platform-specific half of a self-update (plan 0018 §1, §3 swap.py/windows.py: Replace;
// WI-0018-24): fetching the release artifact and installing it are electron-updater's job, once
// application/update-check.ts has decided the feed itself is trustworthy (plan 0003 D10: this
// application never asks electron-updater to touch the network until ITS OWN minisign check of
// the feed metadata has passed).
//
// The platform updater reads the feed again on its own fetch, which a server can answer
// differently. So each call is handed the release this application verified, and the platform
// updater downloads only when what it found is exactly that release (domain/update/
// release-metadata.ts's releaseMismatch); anything else is a ReleaseMismatchError, never staged.

import type { ReleaseMetadata } from "../domain/update/release-metadata";

/** The platform updater found a release other than the one this application verified. */
export class ReleaseMismatchError extends Error {
  override name = "ReleaseMismatchError";
}

export interface SelfUpdater {
  /**
   * Ask the platform updater to check the normal feed and, when what it finds is `verified`,
   * download it to install at quit. Called only after this application's own check verified the
   * feed's minisign signature and the artifact's sha512; never on its own. Rejects with
   * ReleaseMismatchError when the platform updater found anything else (nothing is downloaded),
   * and with another error when it could not check or download.
   */
  checkForUpdates(verified: ReleaseMetadata): Promise<void>;
  /**
   * Go back (plan 0022 §G, D4): pin the platform updater to the one release published under
   * `releaseUrl` (a tag's download folder), allow it to be older than this version for that one
   * check, and download it to install at quit, only when what it finds there is `verified`. The
   * normal feed and "no downgrade" are restored afterwards, whatever happened. Rejects as
   * checkForUpdates does.
   */
  downloadRelease(releaseUrl: string, verified: ReleaseMetadata): Promise<void>;
  /**
   * Install whatever was downloaded and quit. Called only from the application's own quit flow,
   * and only when a download that this application's check verified is ready; does nothing if
   * none is.
   */
  quitAndInstall(): void;
}
