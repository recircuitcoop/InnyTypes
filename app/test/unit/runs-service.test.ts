// application/runs.ts against an in-memory RunStore: the run ops and their refusals, the
// `runs` signal coalesced per flow, settling after a quiet wait, "Clear done" and its minute,
// and retention's reading of its setting. The SQLite store itself is test/integration/
// run-records.test.ts.
import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  DEFAULT_PAGE,
  isRunOp,
  listQuery,
  RunService,
  runDuration,
  runTitle,
  SETTLE_MS,
  STATUS_MS,
  UNDO_CLEAR_MS,
} from "../../src/application/runs";
import type { CallOp } from "../../src/domain/channel/messages";
import type { Run, RunKey } from "../../src/domain/runs/run";
import type {
  RunPage,
  RunQuery,
  RunStart,
  RunStore,
  StepStatusUpdate,
} from "../../src/ports/run-store";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

/** A RunStore that records what it is asked, answers from a script, and can be made to fail. */
class ScriptedStore implements RunStore {
  readonly calls: string[] = [];
  readonly listeners: ((key: RunKey) => void)[] = [];
  readonly writeListeners: ((flowId: string) => void)[] = [];
  readonly runs = new Map<string, Run>();
  idleKeys: RunKey[] = [];
  cleared = 0;
  undone = 0;
  pruned = 0;
  fail: Error | null = null;

  #act(call: string): void {
    this.calls.push(call);
    if (this.fail !== null) {
      throw this.fail;
    }
  }
  started(start: RunStart): void {
    this.#act(`started ${start.runId} ${start.title} ${String(start.durationSeconds)}`);
  }
  stepStatuses(updates: readonly StepStatusUpdate[]): void {
    this.#act(
      `statuses ${updates
        .map(
          ({ inputId, status, at }) =>
            `${inputId}:${status.text}${status.phase ?? ""}@${String(at)}`,
        )
        .join(" ")}`,
    );
  }
  settle(runId: string, at: number): boolean {
    this.#act(`settle ${runId} ${String(at)}`);
    return true;
  }
  idle(): RunKey[] {
    return this.idleKeys;
  }
  list(query: RunQuery): RunPage {
    this.#act(`list ${JSON.stringify(query)}`);
    return { runs: [], next: null };
  }
  run(runId: string): Run | null {
    this.#act(`run ${runId}`);
    return this.runs.get(runId) ?? null;
  }
  clearDone(flowId: string, at: number): number {
    this.#act(`clearDone ${flowId} ${String(at)}`);
    return this.cleared;
  }
  undoClear(flowId: string, since: number): number {
    this.#act(`undoClear ${flowId} ${String(since)}`);
    return this.undone;
  }
  prune(before: number): number {
    this.#act(`prune ${String(before)}`);
    return this.pruned;
  }
  deleteFlowRuns(flowId: string): number {
    this.#act(`deleteFlowRuns ${flowId}`);
    return 0;
  }
  onChange(listener: (key: RunKey) => void): void {
    this.listeners.push(listener);
  }
  onJournalWrite(listener: (flowId: string) => void): void {
    this.writeListeners.push(listener);
  }
  written(flowId: string): void {
    for (const listener of this.writeListeners) {
      listener(flowId);
    }
  }
  tell(key: RunKey): void {
    for (const listener of this.listeners) {
      listener(key);
    }
  }
}

function service(retention: () => number | null | undefined = () => undefined) {
  const store = new ScriptedStore();
  const clock = new FakeClock();
  clock.advance(1_000 * DAY_MS);
  const logger = new RecordingLogger();
  const signals: string[] = [];
  const runs = new RunService({
    store,
    clock,
    logger,
    signal: (flowId) => signals.push(flowId),
    retentionDays: retention,
  });
  return { store, clock, logger, signals, runs };
}

describe("the run ops", () => {
  it("knows its four ops", () => {
    const ops: CallOp[] = ["run.list", "run.get", "run.clearDone", "run.undoClear"];
    expect(ops.every((op) => isRunOp(op))).toBe(true);
    expect(isRunOp("job.list")).toBe(false);
  });

  it("lists with the defaults, and refuses each wrong argument with what is wrong", () => {
    expect(listQuery({ flowId: "tab1" })).toEqual({ flowId: "tab1", limit: DEFAULT_PAGE });
    expect(
      listQuery({ flowId: "t", state: "done", since: 5, search: "x", cursor: "1:a", limit: 9 }),
    ).toEqual({ flowId: "t", state: "done", since: 5, search: "x", cursor: "1:a", limit: 9 });
    const { runs } = service();
    const refusal = (args: unknown) => runs.call("run.list", args);
    expect(refusal(null)).toEqual({ ok: false, error: "flowId is required" });
    expect(refusal({ flowId: "" })).toEqual({ ok: false, error: "flowId is required" });
    expect(refusal({ flowId: "t", state: "resumed" })).toMatchObject({ error: /^state must/ });
    expect(refusal({ flowId: "t", since: "today" })).toMatchObject({ error: /^since must/ });
    expect(refusal({ flowId: "t", since: Number.NaN })).toMatchObject({ error: /^since must/ });
    expect(refusal({ flowId: "t", search: 3 })).toMatchObject({ error: /^search must/ });
    expect(refusal({ flowId: "t", cursor: 3 })).toMatchObject({ error: /^cursor must/ });
    for (const limit of [0, 201, 1.5, "9"]) {
      expect(refusal({ flowId: "t", limit })).toMatchObject({ error: /^limit must/ });
    }
    expect(runs.call("run.list", { flowId: "t" })).toEqual({
      ok: true,
      value: { runs: [], next: null },
    });
  });

  it("gets one run, or says it is no longer kept", () => {
    const { runs, store } = service();
    const run = { runId: "r1" } as Run;
    store.runs.set("r1", run);
    expect(runs.call("run.get", { runId: "r1" })).toEqual({ ok: true, value: run });
    expect(runs.call("run.get", { runId: "r2" })).toEqual({
      ok: false,
      error: "This run is no longer kept.",
    });
    expect(runs.call("run.get", "r1")).toEqual({ ok: false, error: "runId is required" });
  });

  it("clears done, and undoes within the minute only", () => {
    const { runs, store, clock } = service();
    store.cleared = 2;
    expect(runs.call("run.clearDone", { flowId: "tab1" })).toEqual({
      ok: true,
      value: { count: 2 },
    });
    expect(store.calls.at(-1)).toBe(`clearDone tab1 ${String(clock.now())}`);
    store.undone = 2;
    expect(runs.call("run.undoClear", { flowId: "tab1" })).toEqual({
      ok: true,
      value: { count: 2 },
    });
    expect(store.calls.at(-1)).toBe(`undoClear tab1 ${String(clock.now() - UNDO_CLEAR_MS)}`);
    store.undone = 0;
    expect(runs.call("run.undoClear", { flowId: "tab1" })).toEqual({
      ok: false,
      error: "Nothing was cleared in the last minute.",
    });
  });

  it("answers a store failure as a failed op, logged, never a rejection", () => {
    const { runs, store, logger } = service();
    store.fail = new Error("database is locked");
    expect(runs.call("run.clearDone", { flowId: "tab1" })).toEqual({
      ok: false,
      error: "run.clearDone failed: database is locked",
    });
    expect(logger.lines).toContainEqual("ERROR run.clearDone failed: Error: database is locked");
  });
});

describe("what instances report", () => {
  it("names a run after its event, and takes its length when the source says it", () => {
    expect(runTitle("t", { title: "Weekly sync", name: "x" })).toBe("Weekly sync");
    expect(runTitle("t", { title: " ", name: "Standup" })).toBe("Standup");
    expect(runTitle("t", { file: "/Volumes/BOYA/REC_0042.wav" })).toBe("REC_0042.wav");
    expect(runTitle("t", { file: "C:\\rec\\a.wav" })).toBe("a.wav");
    expect(runTitle("user.ping.v1", { minutes: 3 })).toBe("user.ping.v1");
    expect(runTitle("user.ping.v1", "text")).toBe("user.ping.v1");
    expect(runDuration({ durationSeconds: 90 })).toBe(90);
    expect(runDuration({ duration_s: 12.5 })).toBe(12.5);
    expect(runDuration({ durationSeconds: -1 })).toBeUndefined();
    expect(runDuration({ durationSeconds: "90" })).toBeUndefined();
    expect(runDuration(null)).toBeUndefined();
  });

  it("records a source's new run and a step's status, and logs a store that fails", () => {
    const { runs, store, logger, clock } = service();
    runs.emitted({ flowId: "tab1", runId: "e1", type: "t", data: { title: "A", duration_s: 60 } });
    runs.emitted({ flowId: "tab1", runId: "e2", type: "t", data: {} });
    runs.stepStatus("in-1", { text: "copying" });
    expect(store.calls).toEqual([
      "started e1 A 60",
      "started e2 t undefined",
      `statuses in-1:copying@${String(clock.now())}`,
    ]);
    store.fail = new Error("disk full");
    runs.emitted({ flowId: "tab1", runId: "e3", type: "t", data: {} });
    runs.stepStatus("in-2", { text: "x" });
    clock.advance(STATUS_MS);
    expect(logger.lines).toEqual([
      "ERROR run e3 could not be recorded: Error: disk full",
      "ERROR the status of in-2 could not be recorded: Error: disk full",
    ]);
  });
});

describe("a step's status writes", () => {
  it("writes at most once per window, every status since in order, one step's run merged", () => {
    const { runs, store, clock } = service();
    const writes = () => store.calls.filter((call) => call.startsWith("statuses"));
    const t0 = clock.now();
    runs.stepStatus("a", { text: "1" }); // nothing written lately: at once
    runs.stepStatus("a", { text: "2" });
    runs.stepStatus("a", { text: "3", progress: { done: 1, total: 2 } });
    runs.stepStatus("b", { text: "copy", phase: "copying" });
    runs.stepStatus("b", { text: "copied", phase: "copied" }); // phases are never merged
    clock.advance(STATUS_MS - 1);
    expect(writes()).toEqual([`statuses a:1@${String(t0)}`]);
    clock.advance(1);
    expect(writes()).toEqual([
      `statuses a:1@${String(t0)}`,
      `statuses a:3@${String(t0)} b:copycopying@${String(t0)} b:copiedcopied@${String(t0)}`,
    ]);
    // The window after that write: one more waits for it, and stop writes what waits.
    runs.stepStatus("a", { text: "4" });
    expect(writes()).toHaveLength(2);
    runs.stop();
    expect(writes().at(-1)).toBe(`statuses a:4@${String(clock.now())}`);
    runs.stop(); // nothing waits: nothing written
    expect(writes()).toHaveLength(3);
  });
});

describe("the runs signal and settling", () => {
  it("tells the flow on every journal write, a run changed or not, for the Jobs page", async () => {
    const { store, signals } = service();
    store.written("tab1");
    store.written("");
    await Promise.resolve();
    expect(signals).toEqual(["tab1", ""]);
  });

  it("never settles a run while an instance holds an input of it, then settles after", () => {
    const { runs, store, clock } = service();
    const settles = () => store.calls.filter((call) => call.startsWith("settle"));
    runs.held("a");
    runs.held("a");
    store.tell({ flowId: "tab1", runId: "a" });
    clock.advance(10 * SETTLE_MS);
    expect(settles()).toEqual([]);
    runs.released("a");
    clock.advance(10 * SETTLE_MS);
    expect(settles()).toEqual([]); // one is still held
    runs.released("a");
    clock.advance(SETTLE_MS);
    expect(settles()).toEqual([`settle a ${String(clock.now())}`]);
  });

  it("tells each flow once per turn, however many of its runs changed", async () => {
    const { store, signals } = service();
    store.tell({ flowId: "tab1", runId: "a" });
    store.tell({ flowId: "tab1", runId: "b" });
    store.tell({ flowId: "tab2", runId: "c" });
    expect(signals).toEqual([]);
    await Promise.resolve();
    expect(signals).toEqual(["tab1", "tab2"]);
    store.tell({ flowId: "tab1", runId: "a" });
    await Promise.resolve();
    expect(signals).toEqual(["tab1", "tab2", "tab1"]);
  });

  it("settles a run only after a quiet wait, each change starting the wait again", () => {
    const { store, clock } = service();
    const settles = () => store.calls.filter((call) => call.startsWith("settle"));
    store.tell({ flowId: "tab1", runId: "a" });
    clock.advance(SETTLE_MS - 1);
    store.tell({ flowId: "tab1", runId: "a" });
    clock.advance(SETTLE_MS - 1);
    expect(settles()).toEqual([]);
    clock.advance(1);
    expect(settles()).toEqual([`settle a ${String(clock.now())}`]);
  });

  it("settles what a crash left at start, logs a failing settle, and stop cancels the waits", () => {
    const { runs, store, clock, logger } = service(() => null);
    store.idleKeys = [{ flowId: "tab1", runId: "left" }];
    runs.start();
    expect(store.calls).toEqual([`settle left ${String(clock.now())}`]);
    store.tell({ flowId: "tab1", runId: "b" });
    runs.stop();
    clock.advance(10 * DAY_MS);
    expect(store.calls).toHaveLength(1); // no settle of b, no daily prune
    store.tell({ flowId: "tab1", runId: "c" });
    store.fail = new Error("busy");
    clock.advance(SETTLE_MS);
    expect(logger.lines).toContainEqual("ERROR run c could not be settled: Error: busy");
  });
});

describe("retention", () => {
  it("keeps 90 days when unset, the setting's days when set, and everything when Forever", () => {
    let setting: number | null | undefined;
    const { runs, store, clock } = service(() => setting);
    store.pruned = 3;
    runs.start();
    expect(store.calls.at(-1)).toBe(`prune ${String(clock.now() - 90 * DAY_MS)}`);
    setting = 7;
    clock.advance(DAY_MS);
    expect(store.calls.at(-1)).toBe(`prune ${String(clock.now() - 7 * DAY_MS)}`);
    setting = null;
    const before = store.calls.length;
    clock.advance(DAY_MS);
    expect(store.calls).toHaveLength(before);
    runs.stop();
  });

  it("keeps 90 days when the setting cannot be read, and logs a prune that fails", () => {
    const { runs, store, clock, logger } = service(() => {
      throw new Error("not JSON");
    });
    store.fail = new Error("disk full");
    runs.start();
    expect(store.calls).toEqual([`prune ${String(clock.now() - 90 * DAY_MS)}`]);
    expect(logger.lines).toEqual([
      "WARN runs.retentionDays could not be read (Error: not JSON); keeping 90 days",
      "ERROR runs could not be pruned: Error: disk full",
    ]);
    runs.stop();
  });
});
