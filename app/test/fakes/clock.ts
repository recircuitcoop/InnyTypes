// A clock a test moves by hand: nothing scheduled on it runs until `advance` reaches it.

import type { Cancel, Clock } from "../../src/ports/clock";

interface Timer {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  #now = 0;
  #order = 0;
  #timers: Timer[] = [];

  now(): number {
    return this.#now;
  }

  after(ms: number, callback: () => void): Cancel {
    const timer: Timer = { at: this.#now + ms, order: this.#order++, callback, cancelled: false };
    this.#timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** Move time forward by `ms`, running every callback that falls due, in time order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (due === undefined) {
        break;
      }
      this.#timers = this.#timers.filter((timer) => timer !== due);
      this.#now = due.at;
      due.callback();
    }
    this.#now = target;
  }

  /** Callbacks scheduled and neither run nor cancelled. */
  get pending(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }
}
