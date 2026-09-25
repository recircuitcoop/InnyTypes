// The crash-loop breaker (plan 0018 §3, helper/breaker.py): N crashes inside a window stop
// restarting; defaults 5 in 2 minutes.
import { describe, expect, it } from "vitest";
import { CrashLoopBreaker, DEFAULT_CRASH_LOOP } from "../../src/domain/supervision/breaker";
import { FakeClock } from "../fakes/clock";

function breaker(settings = DEFAULT_CRASH_LOOP) {
  const clock = new FakeClock();
  return { clock, breaker: new CrashLoopBreaker(settings, () => clock.now()) };
}

describe("CrashLoopBreaker", () => {
  it("defaults to 5 crashes in 2 minutes", () => {
    expect(DEFAULT_CRASH_LOOP).toEqual({ maxCrashes: 5, windowMs: 120_000 });
  });

  it("allows four crashes inside the window and trips on the fifth", () => {
    const { clock, breaker: b } = breaker();
    for (let crash = 1; crash <= 4; crash++) {
      expect(b.recordCrash(), `crash ${String(crash)}`).toBe(true);
      clock.advance(1_000);
    }
    expect(b.tripped).toBe(false);
    expect(b.recordCrash()).toBe(false);
    expect(b.tripped).toBe(true);
  });

  it("stays tripped: every later crash is refused, however late", () => {
    const { clock, breaker: b } = breaker();
    for (let crash = 0; crash < 5; crash++) {
      b.recordCrash();
    }
    clock.advance(3_600_000);
    expect(b.recordCrash()).toBe(false);
    expect(b.tripped).toBe(true);
  });

  it("forgets crashes older than the window, so a slow trickle never trips it", () => {
    const { clock, breaker: b } = breaker();
    // One crash every 30 s: at most four fall inside any 2-minute window.
    for (let crash = 0; crash < 50; crash++) {
      expect(b.recordCrash(), `crash ${String(crash)}`).toBe(true);
      clock.advance(30_000);
    }
    expect(b.tripped).toBe(false);
  });

  it("counts a crash exactly at the window's edge as outside it", () => {
    const { clock, breaker: b } = breaker({ maxCrashes: 2, windowMs: 1_000 });
    b.recordCrash();
    clock.advance(1_000);
    expect(b.crashesInWindow()).toBe(0);
    expect(b.recordCrash()).toBe(true);
    clock.advance(999);
    expect(b.crashesInWindow()).toBe(1);
    expect(b.recordCrash()).toBe(false);
  });

  it("reports the crashes still inside the window", () => {
    const { clock, breaker: b } = breaker();
    b.recordCrash();
    clock.advance(60_000);
    b.recordCrash();
    expect(b.crashesInWindow()).toBe(2);
    clock.advance(60_001);
    expect(b.crashesInWindow()).toBe(1);
  });

  it("reset resumes restarting and forgets the counted crashes", () => {
    const { breaker: b } = breaker();
    for (let crash = 0; crash < 5; crash++) {
      b.recordCrash();
    }
    b.reset();
    expect(b.tripped).toBe(false);
    expect(b.crashesInWindow()).toBe(0);
    // Four more are allowed again, not one.
    for (let crash = 0; crash < 4; crash++) {
      expect(b.recordCrash()).toBe(true);
    }
    expect(b.recordCrash()).toBe(false);
  });

  it("takes N and the window from settings", () => {
    const { clock, breaker: b } = breaker({ maxCrashes: 3, windowMs: 10_000 });
    expect(b.recordCrash()).toBe(true);
    clock.advance(4_000);
    expect(b.recordCrash()).toBe(true);
    clock.advance(4_000);
    expect(b.recordCrash()).toBe(false);
  });
});
