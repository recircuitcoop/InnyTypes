// The MCP heartbeat (plan 0018 §3, the heartbeat.py row; the owner's plan 0010 ruling): pinged
// every interval, a beat only for an answered ping, stale past the window, slow passes defer.
import { describe, expect, it } from "vitest";
import { McpHeartbeat } from "../../src/application/mcp-heartbeat";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger } from "../fakes/children";
import { FakeSession, flush } from "../fakes/anytype";

const PROFILE = { heartbeatIntervalMs: 30_000, staleAfterMs: null };

function beating(mode: FakeSession["pingMode"] = "answer") {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const stale: number[] = [];
  const heartbeat = new McpHeartbeat({
    clock,
    logger,
    profile: PROFILE,
    onStale: (silentFor) => stale.push(silentFor),
  });
  const session = new FakeSession();
  session.pingMode = mode;
  heartbeat.start(session);
  /** Move the clock, letting every ping settle as it goes. */
  const advance = async (ms: number, step = 1_000) => {
    let moved = 0;
    do {
      const by = Math.min(step, ms - moved);
      clock.advance(by);
      moved += by;
      await flush();
    } while (moved < ms);
  };
  return { clock, logger, stale, heartbeat, session, advance };
}

describe("McpHeartbeat", () => {
  it("pings at once, then every 30 s on the injected clock, not on every pass", async () => {
    const { session, advance } = beating();
    await advance(0, 1);
    await advance(1);
    expect(session.pings).toBe(1);
    await advance(29_998);
    expect(session.pings).toBe(1);
    await advance(2);
    expect(session.pings).toBe(2);
    await advance(60_000);
    expect(session.pings).toBe(4);
  });

  it("records a beat only for a ping the child answered", async () => {
    const answered = beating("answer");
    await answered.advance(60_001);
    expect(answered.heartbeat.beats).toBe(3);
    expect(answered.heartbeat.lastBeatAt).toBe(60_000);

    const refused = beating("refuse");
    await refused.advance(60_001);
    expect(refused.session.pings).toBe(3);
    expect(refused.heartbeat.beats).toBe(0);
    expect(refused.heartbeat.lastBeatAt).toBeNull();
    expect(refused.logger.lines.join("\n")).toContain("did not answer a ping, so no beat");
  });

  it("never judges a child that keeps answering stale", async () => {
    const { stale, advance } = beating("answer");
    await advance(30 * 60_000, 5_000);
    expect(stale).toEqual([]);
  });

  it("judges a child that stops answering but stays alive stale, once, and stops pinging it", async () => {
    const { session, stale, heartbeat, advance } = beating("answer");
    await advance(60_001);
    expect(heartbeat.beats).toBe(3);
    session.pingMode = "silent";
    // Its window is 90 s from the last answered beat; each silent ping times out at 30 s.
    const timeOut = async () => {
      for (let i = 0; i < 10; i++) {
        await advance(30_000);
        session.timeOutPings();
        await flush();
      }
    };
    await timeOut();
    expect(stale).toHaveLength(1);
    expect(stale[0]).toBeGreaterThan(90_000);
    const pingsAtVerdict = session.pings;
    await advance(120_000);
    expect(session.pings).toBe(pingsAtVerdict);
  });

  it("does not judge a slow pass: the machine slept, and the window starts again", async () => {
    // A clock that can jump without firing anything, as a machine waking from sleep sees it.
    const fake = new FakeClock();
    let slept = 0;
    const clock = { now: () => fake.now() + slept, after: fake.after.bind(fake) };
    const logger = new RecordingLogger();
    const stale: number[] = [];
    const heartbeat = new McpHeartbeat({
      clock,
      logger,
      profile: PROFILE,
      onStale: (silentFor) => stale.push(silentFor),
    });
    const session = new FakeSession();
    heartbeat.start(session);
    fake.advance(0);
    await flush();
    expect(heartbeat.beats).toBe(1);
    session.pingMode = "silent";
    fake.advance(30_000);
    await flush();
    // The ping went out, then the lid closed for an hour; its timeout fires on waking.
    slept = 3_600_000;
    session.timeOutPings();
    await flush();
    expect(stale).toEqual([]);
    expect(logger.lines.join("\n")).toContain("ran late");
    // Silence after waking is judged again, from a window that started on waking.
    for (let i = 0; i < 5; i++) {
      fake.advance(30_000);
      await flush();
      session.timeOutPings();
      await flush();
    }
    expect(stale).toHaveLength(1);
  });

  it("defers a pass that finds the previous ping still waiting: no second ping, no verdict", async () => {
    const { session, stale, logger, advance } = beating("silent");
    await advance(0, 1);
    expect(session.pings).toBe(1);
    // A ping whose own timeout never fires (a fake that holds it): every later pass defers.
    await advance(300_000, 10_000);
    expect(session.pings).toBe(1);
    expect(stale).toEqual([]);
    expect(logger.lines.join("\n")).toContain("still waiting; deferred");
  });

  it("stops: nothing is pinged after stop, and a late answer records nothing", async () => {
    const { heartbeat, session, advance } = beating("silent");
    await advance(0, 1);
    heartbeat.stop();
    session.timeOutPings();
    await advance(300_000, 30_000);
    expect(session.pings).toBe(1);
    expect(heartbeat.beats).toBe(0);
  });

  it("refuses a profile that promised no heartbeat", () => {
    expect(
      () =>
        new McpHeartbeat({
          clock: new FakeClock(),
          logger: new RecordingLogger(),
          profile: { heartbeatIntervalMs: null, staleAfterMs: null },
          onStale: () => undefined,
        }),
    ).toThrow(RangeError);
  });
});
