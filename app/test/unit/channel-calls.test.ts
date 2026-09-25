// Calls to a child (spec 10.3): every call times out after 5 s, and a call while the child is
// not running answers at once, without being sent, with code restarting, down or stopped.
import { describe, expect, it } from "vitest";
import { CallTable } from "../../src/application/call-table";
import {
  channelError,
  isChannelError,
  refusalFor,
  type CallResult,
} from "../../src/domain/channel/errors";
import { DEFAULT_SUPERVISION, type ChildState } from "../../src/domain/supervision/child-state";
import { deaf, exitsAtOnce, obedient, type Behaviour } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import { supervised } from "../fakes/supervised";

/** The value a promise has settled to by now, or "pending". */
async function settled<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([
    promise,
    new Promise<"pending">((r) =>
      setTimeout(() => {
        r("pending");
      }, 0),
    ),
  ]);
}

const callsSent = (posted: { t: string }[]) => posted.filter((m) => m.t === "call").length;

describe("the call timeout", () => {
  it("is 5 s by default", () => {
    expect(DEFAULT_SUPERVISION.callTimeoutMs).toBe(5_000);
  });

  it("answers timeout at 5 s and not a millisecond before", async () => {
    const { clock, supervisor, launcher } = supervised(deaf);
    supervisor.start();
    clock.advance(1);
    expect(supervisor.status().state).toBe("running");

    const call = supervisor.call("view.get", { id: "v1" });
    expect(callsSent(launcher.current.posted)).toBe(1);
    clock.advance(4_999);
    expect(await settled(call)).toBe("pending");
    clock.advance(1);
    expect(await settled(call)).toEqual({
      ok: false,
      code: "timeout",
      error: "the InnyTypes runtime did not answer in time",
    });
  });

  it("applies to every call, each on its own clock", async () => {
    const { clock, supervisor } = supervised(deaf);
    supervisor.start();
    clock.advance(1);
    const first = supervisor.call("view.get", {});
    clock.advance(2_000);
    const second = supervisor.call("snapshot.get", {});
    clock.advance(3_000);
    expect(await settled(first)).toMatchObject({ code: "timeout" });
    expect(await settled(second)).toBe("pending");
    clock.advance(2_000);
    expect(await settled(second)).toMatchObject({ code: "timeout" });
  });

  it("does not fire once the child has answered", async () => {
    const { clock, supervisor } = supervised(obedient);
    supervisor.start();
    clock.advance(1);
    const call = supervisor.call("view.get", {});
    clock.advance(1);
    expect(await call).toEqual({ ok: true, value: "view.get" });
    expect(clock.pending).toBe(0);
  });
});

describe("a call while the child is not running", () => {
  async function refusedIn(
    behaviour: Behaviour,
    reach: (s: ReturnType<typeof supervised>) => void,
  ) {
    const harness = supervised(behaviour);
    reach(harness);
    const sentBefore = harness.launcher.children.flatMap((c) => c.posted).length;
    const result = await settled(harness.supervisor.call("view.get", {}));
    const sentAfter = harness.launcher.children.flatMap((c) => c.posted).length;
    return { state: harness.supervisor.status().state, result, sent: sentAfter - sentBefore };
  }

  it("answers restarting at once while the child is starting", async () => {
    const { state, result, sent } = await refusedIn(obedient, ({ supervisor }) => {
      supervisor.start();
    });
    expect(state).toBe("starting");
    expect(result).toMatchObject({ ok: false, code: "restarting" });
    expect(sent).toBe(0);
  });

  it("answers restarting at once during a planned restart", async () => {
    const { state, result, sent } = await refusedIn(deaf, ({ supervisor, clock }) => {
      supervisor.start();
      clock.advance(1);
      supervisor.restart("types");
    });
    expect(state).toBe("restarting-planned");
    expect(result).toMatchObject({ ok: false, code: "restarting" });
    expect(sent).toBe(0);
  });

  it("answers down at once after a crash", async () => {
    const { state, result, sent } = await refusedIn(obedient, ({ supervisor, clock, launcher }) => {
      supervisor.start();
      clock.advance(1);
      launcher.current.exit(1);
    });
    expect(state).toBe("down");
    expect(result).toMatchObject({ ok: false, code: "down" });
    expect(sent).toBe(0);
  });

  it("answers down at once after the crash-loop limit", async () => {
    const { state, result } = await refusedIn(exitsAtOnce, ({ supervisor, clock }) => {
      supervisor.start();
      clock.advance(60_000);
    });
    expect(state).toBe("down-for-good");
    expect(result).toMatchObject({ ok: false, code: "down" });
  });

  it("answers stopped at once after quit", async () => {
    const { state, result } = await refusedIn(obedient, ({ supervisor, clock }) => {
      supervisor.start();
      clock.advance(1);
      void supervisor.stop();
      clock.advance(1);
    });
    expect(state).toBe("stopped");
    expect(result).toMatchObject({ ok: false, code: "stopped" });
  });
});

describe("a call outstanding when the child exits", () => {
  it("answers stopped at once, and the timeout never fires", async () => {
    const { clock, supervisor, launcher } = supervised(deaf);
    supervisor.start();
    clock.advance(1);
    const call = supervisor.call("view.submit", { id: "v", values: {} });
    launcher.current.exit(137);
    expect(await settled(call)).toMatchObject({ ok: false, code: "stopped" });
  });
});

describe("the typed errors", () => {
  it("map every state that is not running to a code", () => {
    const expected: Record<ChildState, string | null> = {
      running: null,
      starting: "restarting",
      "restarting-planned": "restarting",
      restarting: "restarting",
      recovering: "down",
      down: "down",
      "down-for-good": "down",
      stopped: "stopped",
    };
    for (const [state, code] of Object.entries(expected)) {
      expect(refusalFor(state as ChildState), state).toBe(code);
    }
  });

  it("carry a code that tells them from a child's own failure", () => {
    const own: CallResult = { ok: false, error: "no such view" };
    expect(isChannelError(own)).toBe(false);
    expect(isChannelError({ ok: true, value: 1 })).toBe(false);
    for (const code of ["restarting", "down", "timeout", "stopped"] as const) {
      const error = channelError(code, "services");
      expect(isChannelError(error)).toBe(true);
      expect(error).toMatchObject({ ok: false, code });
      expect(error.error).toContain("services");
    }
  });
});

describe("CallTable", () => {
  it("drops a reply that arrives after its call ended", async () => {
    const clock = new FakeClock();
    const table = new CallTable(clock, "runtime", 5_000);
    const call = table.open("r1");
    clock.advance(5_000);
    expect(await call).toMatchObject({ code: "timeout" });
    expect(table.settle("r1", { ok: true, value: 1 })).toBe(false);
    expect(table.size).toBe(0);
  });

  it("ends every waiting call with one code", async () => {
    const clock = new FakeClock();
    const table = new CallTable(clock, "runtime", 5_000);
    const calls = [table.open("a"), table.open("b")];
    table.failAll("stopped");
    expect(await Promise.all(calls)).toEqual([
      channelError("stopped", "runtime"),
      channelError("stopped", "runtime"),
    ]);
    expect(clock.pending).toBe(0);
  });
});
