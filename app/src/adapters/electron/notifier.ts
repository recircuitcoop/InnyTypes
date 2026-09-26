// Notices through Electron's Notification (plan 0018 §3 `notification.py`: replace delivery).
// The kinds, the words and the once-only rule are domain/notices and application/notices.ts;
// this is only the showing.
//
// In the e2e gate's hidden runs nothing is shown: a test must never put a notification on this
// user's desktop. The NoticeBoard has already logged and recorded the notice by then.

import type { Message } from "../../domain/notices/notices";

/**
 * The application's identity on Windows (plan 0018 §3 windows.py): the AppUserModelId the
 * installer's shortcuts carry, which a toast must be raised under or Windows shows none. The
 * same string names the macOS bundle and the Linux desktop entry: the old helper's bundle
 * identifier (helper/config.py BUNDLE_IDENTIFIER), unchanged, which WI-0018-23's appId keeps.
 */
export const APP_USER_MODEL_ID = "it.l1nx.innytypes.helper";

/** Electron's Notification class, as far as showing one goes. */
export interface NotificationClass {
  isSupported(): boolean;
  new (options: { title: string; body: string; silent?: boolean }): {
    show(): void;
    on(event: "click", listener: () => void): unknown;
  };
}

/**
 * Show one message on the desktop, when showing is on and the desktop supports it. A click on it
 * opens the application's window (notification.py: clicking a notification opens the window),
 * once per click. The text is handed to Electron as data: nothing is built into a script.
 */
export function electronDelivery(
  Notification: NotificationClass,
  show: boolean,
  onClick: () => void,
): (message: Message) => void {
  return (message) => {
    if (show && Notification.isSupported()) {
      const notification = new Notification({ title: message.title, body: message.body });
      notification.on("click", onClick);
      notification.show();
    }
  };
}

/** Name the application to Windows before any notification is raised. */
export function setAppUserModelId(
  app: { setAppUserModelId(id: string): void },
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
}
