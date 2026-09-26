// The one place notices are told, once (plan 0018 §3 notification.py: the once-only rule and the
// notice file, notification.py:526 and 602).
//
// The shell holds one NoticeBoard. Every notice reaches it: the shell's own (a child's crash
// loop), and the runtime's and the services process's, which travel over the channel (the
// `notice` and `notice-clear` messages). So "once" holds across a child's restarts, which a
// notifier in the child could not promise.
//
// The rule, as the old Announcer kept it: a notification per change of state, never per repeat.
// * A notice equal to the one current for its kind and subject is not told again.
// * A notice for the same kind and subject in different words (a new reason, a new version) is
//   told: a different sentence is a different thing to say.
// * A condition cleared and raised again is told again: it is news the second time too.
// The conditions true now are written to the notice file BEFORE anything is shown, so a desktop
// that shows nothing still leaves the record telling the truth.

import {
  compose,
  noticeKey,
  sameNotice,
  type Message,
  type Notice,
  type NoticeKind,
} from "../domain/notices/notices";
import type { Logger } from "../ports/logger";
import type { NoticeStore, Notifier } from "../ports/notifier";

export interface NoticeBoardDeps {
  /** Show one message on the desktop (Electron's Notification in the app). */
  readonly deliver: (message: Message) => void;
  /** Where the current conditions are recorded; null keeps them in memory only. */
  readonly store: NoticeStore | null;
  readonly logger: Logger;
}

export class NoticeBoard implements Notifier {
  readonly #deps: NoticeBoardDeps;
  readonly #current = new Map<string, Notice>();

  constructor(deps: NoticeBoardDeps) {
    this.#deps = deps;
  }

  /** Every condition true now, in the order each was first raised. */
  current(): readonly Notice[] {
    return [...this.#current.values()];
  }

  raise(notice: Notice): void {
    const key = noticeKey(notice.kind, notice.subject);
    const was = this.#current.get(key);
    if (was !== undefined && sameNotice(was, notice)) {
      // Already told, and still true: said once, and not in the log again either.
      return;
    }
    this.#current.set(key, notice);
    this.#write();
    const message = compose(notice);
    this.#deps.logger.info(`notice: ${message.title}: ${message.body}`);
    try {
      this.#deps.deliver(message);
    } catch (error) {
      // Nothing fails because a message did not show; the notice file still says it.
      this.#deps.logger.warn(`the desktop would not show a notice: ${String(error)}`);
    }
  }

  clear(kind: NoticeKind, subject: string): void {
    if (this.#current.delete(noticeKey(kind, subject))) {
      this.#write();
    }
  }

  #write(): void {
    try {
      this.#deps.store?.write(this.current());
    } catch (error) {
      this.#deps.logger.warn(`the notice file could not be written: ${String(error)}`);
    }
  }
}
