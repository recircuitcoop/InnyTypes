// Notices through Electron's Notification (plan 0018 §3 `notification.py`: replace delivery).
// A minimal delivery for WI-0018-11's "notification on first presentation"; the notice kinds,
// wording and once-only rule are WI-0018-21's (domain/notices).
//
// Every notice is also logged. In the e2e gate's hidden runs nothing is shown: a test must
// never put a notification on this user's desktop.

import type { Logger } from "../../ports/logger";
import type { Notice, Notifier } from "../../ports/notifier";

/** Electron's Notification class, as far as showing one goes. */
export interface NotificationClass {
  isSupported(): boolean;
  new (options: { title: string; body: string; silent?: boolean }): { show(): void };
}

export function electronNotifier(
  Notification: NotificationClass,
  logger: Logger,
  show: boolean,
): Notifier {
  return {
    raise: (notice: Notice) => {
      logger.info(`notice: ${notice.title}: ${notice.body}`);
      if (show && Notification.isSupported()) {
        new Notification({ title: notice.title, body: notice.body }).show();
      }
    },
  };
}
