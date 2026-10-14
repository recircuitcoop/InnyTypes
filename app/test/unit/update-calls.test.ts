// InnyTypes' own update calls (plan 0022 §G, D4), without Electron: the install record at start,
// Go back verified then installed at quit, a refused Go back that installs nothing, the crash-loop
// offer (one notice, never applied), Check now, the "Check automatically" switch and Release notes.
import type { IpcMain } from "electron";
import { describe, expect, it } from "vitest";
import type { UpdateOutcome } from "../../src/application/update-check";
import type { ChildStatus } from "../../src/domain/supervision/child-state";
import { ROLLBACK_WINDOW_MS, type UpdateEvent } from "../../src/domain/updates/machine";
import { IPC } from "../../src/shell/ipc";
import { wireUpdateCalls } from "../../src/shell/update-calls";
import type { UpdateView } from "../../src/ui/general-contract";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

type Handler = (event: unknown, call: unknown) => Promise<unknown>;

const OLD = "1.0.0";
const NEW = "1.1.0";
const T0 = new Date(2026, 9, 14, 9, 0).getTime();
const MINUTE = 60_000;

function harness(options: { stored?: Record<string, unknown>; version?: string } = {}) {
  let handler: Handler | null = null;
  const ipc = {
    handle: (channel: string, h: Handler) => {
      expect(channel).toBe(IPC.updateCall);
      handler = h;
    },
  } as unknown as Pick<IpcMain, "handle">;
  const stored: Record<string, unknown> = { ...(options.stored ?? {}) };
  const settings = {
    readUpdateHistory: () => stored["appUpdate"],
    writeUpdateHistory: (record: Readonly<Record<string, unknown>>) => {
      stored["appUpdate"] = JSON.parse(JSON.stringify(record)) as unknown;
    },
    readUpdate: () => stored["update"],
    writeUpdate: (update: Readonly<Record<string, unknown>>) => {
      stored["update"] = update;
    },
  };
  const statusListeners: ((status: ChildStatus) => void)[] = [];
  const pushed: UpdateView[] = [];
  const quits: number[] = [];
  const notes: string[] = [];
  const notifier = new RecordingNotifier();
  const clock = { at: T0, now: () => clock.at };
  const calls = wireUpdateCalls({
    ipc,
    toPage: (_channel, view) => pushed.push(view as UpdateView),
    currentVersion: () => options.version ?? NEW,
    clock,
    settings,
    runtime: { onStatus: (listener) => statusListeners.push(listener) },
    notifier,
    openReleaseNotes: (tag) => notes.push(tag),
    quit: () => quits.push(1),
    logger: new RecordingLogger(),
  });
  const call = (op: string, args: unknown = null) =>
    (handler as unknown as Handler)({}, { op, args }) as Promise<{
      ok: boolean;
      value?: UpdateView;
      refused?: { sentence: string };
    }>;
  const runtimeIs = (state: ChildStatus["state"]) => {
    for (const listener of statusListeners) listener({ child: "runtime", state } as ChildStatus);
  };
  return { calls, call, stored, pushed, quits, notes, notifier, clock, runtimeIs };
}

/** A start on NEW after OLD ran last: the install is recorded, and Go back offered. */
const afterUpdate = () => harness({ stored: { appUpdate: { lastVersion: OLD } } });

/** A Go back whose verification answers `outcome`, its failure events sent as UpdateCheck sends them. */
function goBackAnswers(
  h: ReturnType<typeof harness>,
  outcome: UpdateOutcome,
  events: UpdateEvent[] = [],
) {
  const asked: { version: string; tag: string }[] = [];
  h.calls.attach({
    check: () => Promise.resolve({ ok: true, message: "checked" }),
    goBack: (to) => {
      asked.push(to);
      for (const event of events) h.calls.onEvent(event);
      return Promise.resolve(outcome);
    },
  });
  return asked;
}

describe("InnyTypes' own update calls", () => {
  it("the first start on a new version records the previous release and offers Go back for seven days", async () => {
    const h = afterUpdate();
    expect(h.stored["appUpdate"]).toEqual({
      lastVersion: NEW,
      lastCheckedAt: null,
      previous: { version: OLD, tag: `v${OLD}`, updatedAt: new Date(T0).toISOString() },
      goingBackTo: null,
    });
    const state = await h.call("update.state");
    expect(state.value).toEqual({
      state: {
        kind: "updated",
        version: NEW,
        at: new Date(T0),
        previous: OLD,
        rollbackUntil: new Date(T0 + ROLLBACK_WINDOW_MS),
      },
      goBack: { to: OLD, because: "recent-update", until: new Date(T0 + ROLLBACK_WINDOW_MS) },
      autoCheck: false,
    });
    // A later start on the same version keeps the offer; after seven days it is gone.
    const later = harness({ stored: h.stored });
    expect((await later.call("update.state")).value?.goBack?.to).toBe(OLD);
    later.clock.at = T0 + ROLLBACK_WINDOW_MS;
    expect((await later.call("update.state")).value?.goBack).toBeNull();
  });

  it("go back verifies the old release, records it, and quits to install it", async () => {
    const h = afterUpdate();
    const asked = goBackAnswers(h, { ok: true, message: "verified" });
    const answer = await h.call("update.goBack");
    expect(asked).toEqual([{ version: OLD, tag: `v${OLD}` }]);
    expect(answer.value?.state).toEqual({ kind: "rolling-back", to: OLD });
    expect(h.pushed.at(-1)?.state).toEqual({ kind: "rolling-back", to: OLD });
    expect(h.stored["appUpdate"]).toMatchObject({ goingBackTo: OLD });
    expect(h.quits).toEqual([1]);
    // The start on the older version offers nothing: the version it left is an update again.
    const back = harness({ stored: h.stored, version: OLD });
    const view = (await back.call("update.state")).value;
    expect(view?.state).toMatchObject({ kind: "updated", version: OLD, rollbackUntil: null });
    expect(view?.goBack).toBeNull();
  });

  it("a tampered old release is refused: nothing is installed, InnyTypes does not quit", async () => {
    const h = afterUpdate();
    goBackAnswers(h, { ok: false, error: "Refused." }, [
      { kind: "failed", reason: "safety-check" },
    ]);
    const answer = await h.call("update.goBack");
    expect(answer.value?.state).toEqual({
      kind: "install-failed",
      version: OLD,
      reason: "safety-check",
    });
    expect(h.quits).toEqual([]);
    expect(h.stored["appUpdate"]).toMatchObject({ goingBackTo: null });
  });

  it("go back is refused when nothing is offered, and not available without a self-updater", async () => {
    const fresh = harness();
    expect(await fresh.call("update.goBack")).toMatchObject({ ok: false });
    goBackAnswers(fresh, { ok: true, message: "verified" });
    expect(await fresh.call("update.goBack")).toMatchObject({
      ok: false,
      refused: { sentence: "update.goBackGone" },
    });
    expect(fresh.quits).toEqual([]);
  });

  it("a crash loop within ten minutes offers Go back with one notice, and never applies it", async () => {
    const h = afterUpdate();
    const asked = goBackAnswers(h, { ok: true, message: "verified" });
    h.clock.at = T0 + 3 * MINUTE;
    h.runtimeIs("down-for-good");
    h.runtimeIs("down-for-good");
    expect(h.notifier.notices).toEqual([
      { kind: "core-crash-loop", subject: "InnyTypes", version: OLD },
    ]);
    expect((await h.call("update.state")).value?.goBack?.because).toBe("crash-loop");
    expect(asked).toEqual([]);
    expect(h.quits).toEqual([]);
    // Going back clears the notice.
    await h.call("update.goBack");
    expect(h.notifier.cleared).toContain("core-crash-loop InnyTypes");
  });

  it("a crash loop later than ten minutes, or with nothing to go back to, offers nothing", () => {
    const h = afterUpdate();
    h.clock.at = T0 + 11 * MINUTE;
    h.runtimeIs("down-for-good");
    expect(h.notifier.notices).toEqual([]);
    const fresh = harness();
    fresh.runtimeIs("down-for-good");
    fresh.runtimeIs("running");
    expect(fresh.notifier.notices).toEqual([]);
  });

  it("check now checks by hand; its time is kept for the next start", async () => {
    const h = harness();
    expect(await h.call("update.checkNow")).toMatchObject({ ok: false });
    const manual: unknown[] = [];
    h.calls.attach({
      check: (options) => {
        manual.push(options);
        h.calls.onEvent({ kind: "check" });
        h.calls.onEvent({ kind: "found", version: null, at: new Date(T0) });
        return Promise.resolve({ ok: true, message: "checked" });
      },
      goBack: () => Promise.resolve({ ok: true, message: "" }),
    });
    const answer = await h.call("update.checkNow");
    expect(manual).toEqual([{ manual: true }]);
    expect(answer.value?.state).toEqual({
      kind: "up-to-date",
      version: NEW,
      checkedAt: new Date(T0),
    });
    const next = harness({ stored: h.stored });
    expect((await next.call("update.state")).value?.state).toEqual({
      kind: "up-to-date",
      version: NEW,
      checkedAt: new Date(T0),
    });
  });

  it("the Check automatically switch keeps the channel; Release notes opens this version's tag", async () => {
    const h = harness({ stored: { update: { channel: "beta" } } });
    const on = await h.call("update.setAutoCheck", { on: true });
    expect(on.value?.autoCheck).toBe(true);
    expect(h.stored["update"]).toEqual({ auto_check: true, channel: "beta" });
    expect(h.pushed.at(-1)?.autoCheck).toBe(true);
    expect(await h.call("update.setAutoCheck", { on: "yes" })).toMatchObject({ ok: false });
    expect(await h.call("update.releaseNotes")).toEqual({ ok: true, value: null });
    expect(h.notes).toEqual([`v${NEW}`]);
  });

  it("an unreadable install record or update setting is read as unset", async () => {
    const h = harness({ stored: { update: "not an object", appUpdate: [1] } });
    expect((await h.call("update.state")).value).toMatchObject({
      state: { kind: "unchecked", version: NEW },
      goBack: null,
      autoCheck: false,
    });
  });
});
