// Whether the old helper is still running, by its lock (WI-0018-25).

import { describe, expect, it } from "vitest";
import { legacyHelperIsRunning } from "../../src/application/legacy-helper-lock";

describe("legacyHelperIsRunning", () => {
  it("is true when the lock names a pid the liveness check says is alive", () => {
    expect(
      legacyHelperIsRunning({ readLockPid: () => 4242, liveness: { isAlive: () => true } }),
    ).toBe(true);
  });

  it("is false when the lock names a pid that is not alive", () => {
    expect(
      legacyHelperIsRunning({ readLockPid: () => 4242, liveness: { isAlive: () => false } }),
    ).toBe(false);
  });

  it("is false when there is no lock to read: it protects nobody", () => {
    const liveness = { isAlive: () => true };
    expect(legacyHelperIsRunning({ readLockPid: () => null, liveness })).toBe(false);
  });
});
