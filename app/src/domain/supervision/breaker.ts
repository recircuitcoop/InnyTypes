// Whether a crashed child should be restarted at all (plan 0018 §3, `helper/breaker.py`).
//
// The backoff answers *when*; this answers *whether any more*. A child that crashes on a
// corrupt file would otherwise be restarted for as long as the machine is on: a loop that
// burns a laptop and tells nobody anything.
//
// The rule is N crashes inside a window (defaults 5 in 2 minutes). Counting inside a window
// rather than for all time is what tells "this is broken" from "this had a bad day": a child
// that fails once a week is never stopped, one that fails five times in a minute is.
//
// Tripping is a state, not a punishment: the supervisor stops restarting and tells the
// person, who can start the child again. `reset` is that start, and it forgets the counted
// crashes too, or the next hiccup would trip it again at once.

/** The crash-loop limit's two numbers. */
export interface CrashLoopSettings {
  /** This many crashes inside the window trips the breaker. */
  readonly maxCrashes: number;
  /** How far back a crash still counts. */
  readonly windowMs: number;
}

export const DEFAULT_CRASH_LOOP: CrashLoopSettings = { maxCrashes: 5, windowMs: 120_000 };

export class CrashLoopBreaker {
  readonly #settings: CrashLoopSettings;
  readonly #now: () => number;
  #crashes: number[] = [];
  #tripped = false;

  /** `now` is the supervisor's clock, injected, so a test moves through a window. */
  constructor(settings: CrashLoopSettings, now: () => number) {
    this.#settings = settings;
    this.#now = now;
  }

  /**
   * Count one crash. True while restarting is still allowed; false once the limit is reached.
   *
   * Counting and asking are one call on purpose: a caller that counted without asking, or
   * asked without counting, is the bug this shape prevents.
   */
  recordCrash(): boolean {
    if (this.#tripped) {
      return false;
    }
    const at = this.#now();
    this.#crashes = [...this.#recent(at), at];
    if (this.#crashes.length >= this.#settings.maxCrashes) {
      this.#tripped = true;
      return false;
    }
    return true;
  }

  /** Whether the limit was reached, so restarting has stopped. */
  get tripped(): boolean {
    return this.#tripped;
  }

  /** The crashes still inside the window. */
  crashesInWindow(): number {
    return this.#recent(this.#now()).length;
  }

  /** A person started the child again: restarting resumes and the counted crashes go. */
  reset(): void {
    this.#tripped = false;
    this.#crashes = [];
  }

  /** Old crashes are dropped on every read, not on a timer: the window is a fact about time. */
  #recent(at: number): number[] {
    const cutoff = at - this.#settings.windowMs;
    return this.#crashes.filter((crash) => crash > cutoff);
  }
}
