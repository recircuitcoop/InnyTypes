// The old installation's cutover (plan 0018 §10 risk 4; WI-0018-25): the one-time config.toml
// import, the old login item removed only once the new one is confirmed working, and the old
// plugin environments told about in one notice with a delete button. Apart from main.ts so the
// composition root keeps only adapter construction (plan 0018 §2.3): main.ts builds the
// adapters and hands them in.

import type { IpcMain } from "electron";
import type { LaunchAtLogin } from "../application/launch-at-login";
import { runLegacyImport, type ShellSettings } from "../application/legacy-import";
import type { NoticeBoard } from "../application/notices";
import type { LegacyImportReportStore } from "../ports/legacy-import";
import type { LegacyLoginItem } from "../ports/legacy-login-item";
import type { LegacyPackageEnvironments } from "../ports/legacy-packages";
import type { Logger } from "../ports/logger";
import type { SettingsStore } from "../ports/settings-store";
import { IPC } from "./ipc";

/** The one subject every legacy-installation notice is about: there is only ever one. */
export const LEGACY_SUBJECT = "old-installation";

export interface MigrationWiring {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly readLegacyConfig: () => string | null;
  readonly reportStore: LegacyImportReportStore;
  readonly shellSettings: ShellSettings;
  /** The services process's own settings file: the only one that holds the mcp endpoint. */
  readonly mcpSettings: SettingsStore;
  /** The very LaunchAtLogin instance wireDesktop wired, so this and the Settings page agree. */
  readonly launchAtLogin: LaunchAtLogin;
  /** null when this platform or run has no old login item to remove (e.g. Windows, or a run
   * that is not the installed application). */
  readonly legacyLoginItem: LegacyLoginItem | null;
  readonly legacyPackages: LegacyPackageEnvironments;
  readonly notices: NoticeBoard;
  readonly logger: Logger;
}

export function wireMigration(deps: MigrationWiring): void {
  const report = runLegacyImport({
    readLegacyConfig: deps.readLegacyConfig,
    reportStore: deps.reportStore,
    shellSettings: deps.shellSettings,
    mcpSettings: deps.mcpSettings,
    logger: deps.logger,
  });

  // The old login item is removed only once the new one is confirmed working (plan 0018 §10
  // risk 4): the very same ask-the-OS-first, write-the-setting-only-on-success ordering the
  // Settings page's own switch uses (application/launch-at-login.ts), so a refusal here leaves
  // both the new switch and the old login item exactly as they were.
  if (report !== null && report.launchAtLoginWanted) {
    const status = deps.launchAtLogin.set(true);
    if (status.problem === null) {
      if (deps.legacyLoginItem?.present() === true) {
        deps.legacyLoginItem.remove();
        deps.logger.info("legacy import: the old login item was removed");
      }
    } else {
      deps.logger.warn(
        `legacy import: the new login item could not be set (${status.problem}); ` +
          "the old one, if any, was left in place",
      );
    }
  }

  raiseLegacyPackagesNotice(deps.legacyPackages, deps.notices);

  deps.ipc.handle(IPC.legacyPackages, (): readonly string[] => deps.legacyPackages.list());
  deps.ipc.handle(IPC.deleteLegacyPackages, (): readonly string[] => {
    const ids = deps.legacyPackages.list();
    deps.legacyPackages.deleteAll();
    deps.notices.clear("legacy-packages-found", LEGACY_SUBJECT);
    return ids;
  });
}

function raiseLegacyPackagesNotice(
  packages: LegacyPackageEnvironments,
  notices: NoticeBoard,
): void {
  const ids = packages.list();
  if (ids.length === 0) {
    return;
  }
  const count =
    ids.length === 1 ? "1 plugin environment" : `${String(ids.length)} plugin environments`;
  notices.raise({
    kind: "legacy-packages-found",
    subject: LEGACY_SUBJECT,
    detail: `${count} from the old installation: ${ids.join(", ")}`,
  });
}
