// The Clock port on the process's own timers.

import type { Cancel, Clock } from "../../ports/clock";

export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms: number, callback: () => void): Cancel {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};
