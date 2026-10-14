// Notices through Electron's Notification (plan 0018 §3 `notification.py`: replace delivery).
// The kinds, the words and the once-only rule are domain/notices and application/notices.ts;
// this is only the showing.
//
// In the e2e gate's hidden runs nothing is shown: a test must never put a notification on this
// user's desktop. The NoticeBoard has already logged and recorded the notice by then.

import type { Message, NoticeAction } from "../../domain/notices/notices";

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
  new (options: {
    title: string;
    body: string;
    silent?: boolean;
    actions?: { type: "button"; text: string }[];
  }): {
    show(): void;
    on(event: "click", listener: () => void): unknown;
    on(event: "action", listener: (event: unknown, index: number) => void): unknown;
  };
}

/** What a click on a notification, or a press of one of its buttons, asks the shell to do. */
export interface NotificationHandlers {
  /** The notification itself: open the window (on the run's flow, when it has one). */
  readonly onClick: (message: Message) => void;
  /** One of its buttons, bound to its own run (plan 0022 §I). */
  readonly onAction: (action: NoticeAction) => void;
}

/**
 * Show one message on the desktop, when showing is on and the desktop supports it. A click on it
 * opens the application's window (notification.py: clicking a notification opens the window),
 * once per click. Its buttons are Electron's notification `actions`, shown by macOS only; a
 * press hands the shell that button's own binding, never another's. The text is handed to
 * Electron as data: nothing is built into a script.
 */
export function electronDelivery(
  Notification: NotificationClass,
  show: boolean,
  handlers: NotificationHandlers,
): (message: Message) => void {
  return (message) => {
    if (!show || !Notification.isSupported()) {
      return;
    }
    const actions = message.actions ?? [];
    const notification = new Notification({
      title: message.title,
      body: message.body,
      ...(actions.length === 0
        ? {}
        : { actions: actions.map((action) => ({ type: "button" as const, text: action.label })) }),
    });
    notification.on("click", () => {
      handlers.onClick(message);
    });
    notification.on("action", (_event, index) => {
      const action = actions[index];
      if (action !== undefined) {
        handlers.onAction(action);
      }
    });
    notification.show();
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
