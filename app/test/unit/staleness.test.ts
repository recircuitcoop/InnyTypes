// The staleness judgement the MCP child keeps (plan 0018 §3; detection.py:364-395 and
// _stale_after, heartbeat.py's deadline rules), as the domain rule.
import { describe, expect, it } from "vitest";
import {
  MCP_HEARTBEAT_INTERVAL_MS,
  MCP_STABILITY,
  STALE_INTERVALS,
  staleWindow,
  StalenessJudge,
} from "../../src/domain/supervision/staleness";

const PROMISED = { heartbeatIntervalMs: 1_000, staleAfterMs: null };

describe("staleWindow", () => {
  it("is three heartbeat intervals when the profile names only an interval", () => {
    expect(STALE_INTERVALS).toBe(3);
    expect(staleWindow(PROMISED)).toBe(3_000);
  });

  it("is the profile's own stale window when it names one", () => {
    expect(staleWindow({ heartbeatIntervalMs: 1_000, staleAfterMs: 10_000 })).toBe(10_000);
  });

  it("is null without a profile, or for a profile that promised no heartbeat", () => {
    expect(staleWindow(null)).toBeNull();
    expect(staleWindow({ heartbeatIntervalMs: null, staleAfterMs: null })).toBeNull();
  });

  it("is 90 s for the MCP child: a 30 s interval, three of them", () => {
    expect(MCP_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(MCP_STABILITY.staleAfterMs).toBeNull();
    expect(staleWindow(MCP_STABILITY)).toBe(90_000);
  });
});

describe("StalenessJudge", () => {
  it.each([0, 1, 60, 3_600, 86_400, 1_000_000_000])(
    "never judges a child that promised no heartbeat stale, %i s on",
    (seconds) => {
      for (const profile of [null, { heartbeatIntervalMs: null, staleAfterMs: null }]) {
        const judge = new StalenessJudge(profile);
        expect(judge.observe(null, 0, true)).toBe("never");
        expect(judge.observe(null, seconds * 1_000, true)).toBe("never");
      }
    },
  );

  it("gives a child it has just seen its whole window before saying anything", () => {
    const judge = new StalenessJudge(PROMISED);
    expect(judge.observe(null, 0, true)).toBe("deferred");
    expect(judge.observe(null, 3_000, true)).toBe("fresh"); // exactly the window: still inside
  });

  it("judges a child that never beat at all stale once its window has passed", () => {
    const judge = new StalenessJudge(PROMISED);
    judge.observe(null, 0, true);
    expect(judge.observe(null, 3_001, true)).toBe("stale");
  });

  it("keeps a child whose marker keeps moving fresh, for as long as it moves", () => {
    const judge = new StalenessJudge(PROMISED);
    judge.observe(null, 0, true);
    for (let at = 1_000; at <= 60_000; at += 1_000) {
      expect(judge.observe(at, at, true)).toBe("fresh");
    }
  });

  it("judges a child whose beats stopped stale: silence and a frozen marker are one thing", () => {
    const judge = new StalenessJudge(PROMISED);
    judge.observe(null, 0, true);
    expect(judge.observe(500, 1_000, true)).toBe("fresh");
    expect(judge.observe(500, 3_000, true)).toBe("fresh");
    expect(judge.observe(500, 4_001, true)).toBe("stale");
  });

  it("defers a slow pass and starts the window again instead of reading the gap as silence", () => {
    const judge = new StalenessJudge(PROMISED);
    judge.observe(500, 1_000, true);
    // The machine slept for an hour: this pass cannot tell silence from nobody asking.
    expect(judge.observe(500, 3_601_000, false)).toBe("deferred");
    expect(judge.observe(500, 3_603_000, true)).toBe("fresh");
    expect(judge.observe(500, 3_604_001, true)).toBe("stale");
  });

  it("forgets everything about the previous child on reset", () => {
    const judge = new StalenessJudge(PROMISED);
    judge.observe(null, 0, true);
    judge.reset();
    expect(judge.observe(null, 10_000, true)).toBe("deferred");
  });
});
