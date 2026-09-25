// The crash backoff (spec 10.6): 250 ms × n after the n-th crash in a row, capped at 5 s.
import { describe, expect, it } from "vitest";
import { crashRestartDelay, DEFAULT_BACKOFF } from "../../src/domain/supervision/backoff";
import { obedient, type Behaviour } from "../fakes/children";
import { supervised } from "../fakes/supervised";

/** A child that never answers anything, so it never becomes ready. */
const silent: Behaviour = {};

describe("crashRestartDelay", () => {
  it("waits 250 ms times the crash count", () => {
    expect([1, 2, 3, 4, 5].map((n) => crashRestartDelay(n))).toEqual([250, 500, 750, 1000, 1250]);
  });

  it("never waits more than 5 s", () => {
    expect(crashRestartDelay(20)).toBe(5_000);
    expect(crashRestartDelay(21)).toBe(5_000);
    expect(crashRestartDelay(1_000)).toBe(5_000);
  });

  it("takes its numbers from settings", () => {
    expect(DEFAULT_BACKOFF).toEqual({ stepMs: 250, capMs: 5_000 });
    expect(crashRestartDelay(3, { stepMs: 100, capMs: 250 })).toBe(250);
  });

  it("refuses a crash count that is not a positive whole number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => crashRestartDelay(bad)).toThrow(RangeError);
    }
  });
});

describe("the supervisor's crash restarts", () => {
  it("forks again after exactly 250 ms × n on the fake clock, and not a moment before", () => {
    const { clock, launcher, supervisor, states } = supervised(obedient);
    supervisor.start();
    clock.advance(1);

    // Four crashes in a row, none reaching ready, so n climbs 1..4.
    launcher.behaviour = silent;
    for (const [n, delay] of [
      [1, 250],
      [2, 500],
      [3, 750],
      [4, 1000],
    ] as const) {
      launcher.current.exit(1);
      expect(supervisor.status().state).toBe("down");
      const before = launcher.children.length;
      clock.advance(delay - 1);
      expect(launcher.children.length, `crash ${String(n)}: too early`).toBe(before);
      clock.advance(1);
      expect(launcher.children.length, `crash ${String(n)}: on time`).toBe(before + 1);
      expect(supervisor.status().state).toBe("recovering");
    }
    expect(states()).toContain("recovering");
  });

  it("starts counting again from 1 once the child was ready", () => {
    const { clock, launcher, supervisor } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    launcher.current.exit(1);
    clock.advance(250);
    clock.advance(1); // the new generation is ready
    expect(supervisor.status().state).toBe("running");

    launcher.current.exit(1);
    const before = launcher.children.length;
    clock.advance(250);
    expect(launcher.children.length).toBe(before + 1);
  });
});
