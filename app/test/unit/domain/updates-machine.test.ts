import { describe, expect, it } from "vitest";
import {
  CRASH_LOOP_WINDOW_MS,
  ROLLBACK_WINDOW_MS,
  rollbackOffer,
  startMachine,
  step,
  type UpdateEvent,
  type UpdateMachine,
} from "../../../src/domain/updates/machine";

const T0 = new Date(2026, 9, 2, 9, 14);
const later = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Applies events in order; every one must be accepted. */
function run(machine: UpdateMachine, ...events: UpdateEvent[]): UpdateMachine {
  let current = machine;
  for (const event of events) {
    const result = step(current, event);
    expect(result.accepted, `${event.kind} from ${current.state.kind}`).toBe(true);
    current = result.machine;
  }
  return current;
}

/** The event is not taken, and the machine is left exactly as it was. */
function refuses(machine: UpdateMachine, event: UpdateEvent): void {
  const result = step(machine, event);
  expect(result.accepted).toBe(false);
  expect(result.machine).toBe(machine);
}

const fresh = () => startMachine({ current: "0.2.1", lastCheckedAt: null, previous: null });
const checked = () => startMachine({ current: "0.2.1", lastCheckedAt: T0, previous: null });

const installed = (at: Date, wentBack = false): UpdateEvent => ({
  kind: "installed",
  version: wentBack ? "0.2.1" : "0.3.0",
  previous: wentBack ? "0.3.0" : "0.2.1",
  at,
  wentBack,
});

describe("the self-update machine", () => {
  it("starts unchecked before any check, up to date after one", () => {
    expect(fresh().state).toEqual({ kind: "unchecked", version: "0.2.1" });
    expect(checked().state).toEqual({ kind: "up-to-date", version: "0.2.1", checkedAt: T0 });
  });

  it("a check that finds nothing is up to date, and remembers when", () => {
    const at = later(MINUTE);
    const machine = run(fresh(), { kind: "check" }, { kind: "found", version: null, at });
    expect(machine.state).toEqual({ kind: "up-to-date", version: "0.2.1", checkedAt: at });
    expect(machine.lastCheckedAt).toBe(at);
  });

  it("checking, downloading with whole percents, ready, quit and update", () => {
    let machine = run(checked(), { kind: "check" });
    expect(machine.state).toEqual({ kind: "checking" });
    machine = run(machine, { kind: "found", version: "0.3.0", at: T0 });
    expect(machine.state).toEqual({ kind: "downloading", version: "0.3.0", percent: 0 });
    machine = run(machine, { kind: "progress", percent: 41.7 });
    expect(machine.state).toEqual({ kind: "downloading", version: "0.3.0", percent: 42 });
    expect(run(machine, { kind: "progress", percent: 120 }).state).toMatchObject({ percent: 100 });
    expect(run(machine, { kind: "progress", percent: -1 }).state).toMatchObject({ percent: 0 });
    machine = run(machine, { kind: "downloaded" });
    expect(machine.state).toEqual({ kind: "ready", version: "0.3.0" });
    expect(run(machine, { kind: "quitAndInstall" })).toBe(machine);
  });

  it("no connection: couldn't check, with the last check kept", () => {
    const machine = run(checked(), { kind: "check" }, { kind: "failed", reason: "no-connection" });
    expect(machine.state).toEqual({
      kind: "check-failed",
      reason: "no-connection",
      lastCheckedAt: T0,
    });
    const midDownload = run(
      checked(),
      { kind: "check" },
      { kind: "found", version: "0.3.0", at: T0 },
      { kind: "failed", reason: "unreadable" },
    );
    expect(midDownload.state).toMatchObject({ kind: "check-failed", reason: "unreadable" });
  });

  it("a download that fails its safety check is not installed", () => {
    const downloading = run(
      checked(),
      { kind: "check" },
      { kind: "found", version: "0.3.0", at: T0 },
    );
    expect(run(downloading, { kind: "failed", reason: "safety-check" }).state).toEqual({
      kind: "install-failed",
      version: "0.3.0",
      reason: "safety-check",
    });
    const ready = run(downloading, { kind: "downloaded" });
    expect(run(ready, { kind: "failed", reason: "safety-check" }).state).toMatchObject({
      kind: "install-failed",
    });
  });

  it("a check may start again from every resting state", () => {
    const failed = run(checked(), { kind: "check" }, { kind: "failed", reason: "no-connection" });
    expect(run(failed, { kind: "check" }).state.kind).toBe("checking");
    const refused = run(
      checked(),
      { kind: "check" },
      { kind: "found", version: "0.3.0", at: T0 },
      { kind: "failed", reason: "safety-check" },
    );
    expect(run(refused, { kind: "check" }).state.kind).toBe("checking");
    expect(run(run(checked(), installed(T0)), { kind: "check" }).state.kind).toBe("checking");
  });

  it("events a state does not take change nothing", () => {
    const machine = checked();
    refuses(machine, { kind: "found", version: null, at: T0 });
    refuses(machine, { kind: "progress", percent: 5 });
    refuses(machine, { kind: "downloaded" });
    refuses(machine, { kind: "quitAndInstall" });
    refuses(machine, { kind: "failed", reason: "no-connection" });
    refuses(machine, { kind: "failed", reason: "safety-check" });
    refuses(machine, { kind: "crashLoopDetected", at: T0 });
    refuses(machine, { kind: "goBack", at: T0 });
    const checking = run(machine, { kind: "check" });
    refuses(checking, { kind: "check" });
    refuses(checking, { kind: "failed", reason: "safety-check" });
    const ready = run(
      checking,
      { kind: "found", version: "0.3.0", at: T0 },
      { kind: "downloaded" },
    );
    refuses(ready, { kind: "failed", reason: "no-connection" });
  });
});

describe("Go back (D4)", () => {
  const afterUpdate = () => run(checked(), installed(T0));

  it("the first start on a new version is Updated, with Go back for seven days", () => {
    const machine = afterUpdate();
    expect(machine.current).toBe("0.3.0");
    expect(machine.state).toEqual({
      kind: "updated",
      version: "0.3.0",
      at: T0,
      previous: "0.2.1",
      rollbackUntil: later(ROLLBACK_WINDOW_MS),
    });
    expect(rollbackOffer(machine, later(DAY))).toEqual({
      to: "0.2.1",
      because: "recent-update",
      until: later(ROLLBACK_WINDOW_MS),
    });
    expect(rollbackOffer(machine, later(7 * DAY))).toBeNull();
  });

  it("checking again after an update keeps the offer for its seven days", () => {
    const machine = run(
      afterUpdate(),
      { kind: "check" },
      { kind: "found", version: null, at: later(DAY) },
    );
    expect(machine.state.kind).toBe("up-to-date");
    expect(rollbackOffer(machine, later(2 * DAY))?.to).toBe("0.2.1");
  });

  it("go back within seven days, not after", () => {
    const machine = afterUpdate();
    expect(run(machine, { kind: "goBack", at: later(6 * DAY) }).state).toEqual({
      kind: "rolling-back",
      to: "0.2.1",
    });
    refuses(machine, { kind: "goBack", at: later(7 * DAY) });
  });

  it("not while downloading or already going back", () => {
    const downloading = run(
      afterUpdate(),
      { kind: "check" },
      { kind: "found", version: "0.3.1", at: T0 },
    );
    refuses(downloading, { kind: "goBack", at: T0 });
    const goingBack = run(afterUpdate(), { kind: "goBack", at: T0 });
    refuses(goingBack, { kind: "goBack", at: T0 });
  });

  it("a tampered old release is refused and not installed", () => {
    const goingBack = run(afterUpdate(), { kind: "goBack", at: T0 });
    expect(run(goingBack, { kind: "failed", reason: "safety-check" }).state).toEqual({
      kind: "install-failed",
      version: "0.2.1",
      reason: "safety-check",
    });
  });

  it("after going back nothing is offered: the version it left is an update again", () => {
    const back = run(afterUpdate(), { kind: "goBack", at: T0 }, installed(later(MINUTE), true));
    expect(back.current).toBe("0.2.1");
    expect(back.state).toMatchObject({ kind: "updated", rollbackUntil: null });
    expect(back.previous).toBeNull();
    expect(rollbackOffer(back, later(2 * MINUTE))).toBeNull();
  });

  it("a crash loop within ten minutes of the first start offers it, and never applies it", () => {
    const machine = afterUpdate();
    const looped = run(machine, { kind: "crashLoopDetected", at: later(9 * MINUTE) });
    expect(looped.state).toEqual(machine.state);
    expect(looped.crashLoopAt).toEqual(later(9 * MINUTE));
    expect(rollbackOffer(looped, later(10 * MINUTE))).toEqual({
      to: "0.2.1",
      because: "crash-loop",
      until: later(ROLLBACK_WINDOW_MS),
    });
    // The window's last moment still counts.
    expect(
      step(machine, { kind: "crashLoopDetected", at: later(CRASH_LOOP_WINDOW_MS) }).accepted,
    ).toBe(true);
  });

  it("a crash-loop offer expires with the seven days: after them Go back is refused", () => {
    const looped = run(afterUpdate(), { kind: "crashLoopDetected", at: later(9 * MINUTE) });
    expect(rollbackOffer(looped, later(8 * DAY))).toBeNull();
    refuses(looped, { kind: "goBack", at: later(8 * DAY) });
    expect(run(looped, { kind: "goBack", at: later(6 * DAY) }).state).toEqual({
      kind: "rolling-back",
      to: "0.2.1",
    });
  });

  it("a crash loop later than ten minutes, or before the first start, offers nothing", () => {
    const machine = afterUpdate();
    refuses(machine, { kind: "crashLoopDetected", at: later(CRASH_LOOP_WINDOW_MS + 1) });
    refuses(machine, { kind: "crashLoopDetected", at: later(-1) });
  });
});
