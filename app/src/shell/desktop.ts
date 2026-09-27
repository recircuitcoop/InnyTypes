// The shell's desktop promises (WI-0018-21): the one NoticeBoard every notice is told once by,
// the launch-at-login switch on the Settings page, and where the Anytype desktop app is. Apart
// from main.ts so the composition root keeps only adapter construction (plan 0018 §2.3): main.ts
// builds the adapters and hands them in.
//
// The rest of the desktop promises live where they act: quitting Anytype in the quit flow's
// stop, and the window rules in main.ts itself (closing is not quitting; no tray icon on any
// OS, checked by test/unit/no-tray.test.ts).

import type { IpcMain } from "electron";
import {
  LaunchAtLogin,
  unpackagedLoginItem,
  type LaunchAtLoginStatus,
} from "../application/launch-at-login";
import { NoticeBoard } from "../application/notices";
import type { Message } from "../domain/notices/notices";
import type { Logger } from "../ports/logger";
import type { LoginItem } from "../ports/login-item";
import type { NoticeStore } from "../ports/notifier";
import type { LaunchAtLoginSetting } from "../ports/settings-store";
import { IPC } from "./ipc";

export interface DesktopWiring {
  readonly ipc: Pick<IpcMain, "handle">;
  /** Show one notice on the desktop (Electron's Notification). */
  readonly deliver: (message: Message) => void;
  readonly noticeFile: NoticeStore;
  /** The OS's login item; null for a run that is not the installed app, which refuses. */
  readonly loginItem: LoginItem | null;
  /** Where the switch is stored: a file only the shell writes. */
  readonly setting: LaunchAtLoginSetting;
  readonly logger: Logger;
}

export interface DesktopWired {
  readonly notices: NoticeBoard;
  /** Handed on to WI-0018-25's migration: the one instance the switch and the page agree on. */
  readonly launchAtLogin: LaunchAtLogin;
}

/** Build the NoticeBoard and the launch-at-login switch, and answer the page's switch calls. */
export function wireDesktop(deps: DesktopWiring): DesktopWired {
  const { ipc, logger } = deps;
  const launchAtLogin = new LaunchAtLogin({
    item: deps.loginItem ?? unpackagedLoginItem,
    setting: deps.setting,
    logger,
  });
  wireLaunchAtLogin(ipc, launchAtLogin);
  const notices = new NoticeBoard({ deliver: deps.deliver, store: deps.noticeFile, logger });
  return { notices, launchAtLogin };
}

export function wireLaunchAtLogin(
  ipc: Pick<IpcMain, "handle">,
  launchAtLogin: LaunchAtLogin,
): void {
  ipc.handle(IPC.launchAtLogin, (): LaunchAtLoginStatus => launchAtLogin.status());
  ipc.handle(IPC.setLaunchAtLogin, (_event, on: unknown): LaunchAtLoginStatus =>
    typeof on === "boolean" ? launchAtLogin.set(on) : launchAtLogin.status(),
  );
}

/**
 * Where the Anytype desktop app is, for this run: the INNYTYPES_ANYTYPE_APP override when set
 * ("none" for no Anytype at all, which is also how a test says so), else the installed one.
 */
export function anytypeAppPath(
  override: string | undefined,
  installed: () => string | null,
): string | null {
  if (override === undefined || override === "") {
    return installed();
  }
  return override === "none" ? null : override;
}
