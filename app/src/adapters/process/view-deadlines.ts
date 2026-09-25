// The timers of one instance's action-view timeouts (plan 0017 Views, WI-0018-10), apart from
// node-process.ts so that file stays under the 600-line limit (plan 0018 §2.3).
//
// The deadline itself is journaled with the view's first presentation (domain/journal
// `presented`); a timer here only says when to look at it again. A restart loses the timer
// and keeps the deadline: the re-presentation arms a new timer for the time that is left, and
// a deadline that passed while the app was down fires at once.

import type { Cancel, Clock } from "../../ports/clock";

export class ViewDeadlines {
  readonly #clock: Clock;
  readonly #due: (inputId: string) => void;
  readonly #timers = new Map<string, Cancel>();

  constructor(clock: Clock, due: (inputId: string) => void) {
    this.#clock = clock;
    this.#due = due;
  }

  /** Call `due(inputId)` at `deadline` (epoch ms); null disarms. Re-arming replaces. */
  arm(inputId: string, deadline: number | null): void {
    this.disarm(inputId);
    if (deadline === null) {
      return;
    }
    const wait = Math.max(0, deadline - this.#clock.now());
    this.#timers.set(
      inputId,
      this.#clock.after(wait, () => {
        this.#timers.delete(inputId);
        this.#due(inputId);
      }),
    );
  }

  disarm(inputId: string): void {
    this.#timers.get(inputId)?.();
    this.#timers.delete(inputId);
  }

  disarmAll(): void {
    for (const cancel of this.#timers.values()) {
      cancel();
    }
    this.#timers.clear();
  }
}
