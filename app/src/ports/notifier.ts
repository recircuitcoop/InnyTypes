// How a part of the application tells a person something that needs them. The kinds, the words
// and the once-only rule are domain/notices and application/notices.ts; this port is only the
// raising, and the clearing of a condition that went away (so it is told again if it comes back).

import type { Notice, NoticeKind } from "../domain/notices/notices";

export type { Notice } from "../domain/notices/notices";

export interface Notifier {
  /** Tell the person, unless this very notice is already current. */
  raise(notice: Notice): void;
  /** The condition went away: the next notice of this kind and subject is news again. */
  clear(kind: NoticeKind, subject: string): void;
}

/** Where the conditions true right now are recorded (notification.py NoticeFile). */
export interface NoticeStore {
  write(notices: readonly Notice[]): void;
}
