// The platform-specific half of a self-update (plan 0018 §1, §3 swap.py/windows.py: Replace;
// WI-0018-24): fetching the release artifact, verifying it and installing it are all
// electron-updater's job, once application/update-check.ts has decided the feed itself is
// trustworthy (plan 0003 D10: this application never asks electron-updater to touch the
// network until ITS OWN minisign check of the feed metadata has passed).

export interface SelfUpdater {
  /**
   * Ask the platform updater to check the configured feed and, if it finds something newer,
   * download it in the background. Called only after this application's own check has verified
   * the feed's minisign signature; never on its own. Never throws: a network failure here is
   * logged by the adapter and does not stop the application.
   */
  checkForUpdates(): Promise<void>;
  /**
   * Install whatever was downloaded and quit. Called only from the application's own quit flow,
   * and only when a download that this application's check verified is ready; does nothing if
   * none is.
   */
  quitAndInstall(): void;
}
