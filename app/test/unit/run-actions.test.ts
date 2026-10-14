// application/run-actions.ts against an in-memory store and flow (plan 0022 §E, risk 3): a re-run
// from the source sends the event again with a fresh envelope, a re-run from a step re-stamps
// its kept input and keeps the earlier steps' results, a changed step's settings are noted, and
// every refusal is a sentence. Delete cancels the inputs in hand and deletes snapshots and
// records, and nothing else. The SQLite side is test/integration/run-records.test.ts.
import { describe, expect, it } from "vitest";

import { GONE_SENTENCE, NO_STEP_SENTENCE } from "../../src/application/flows";
import {
  FLOW_OFF_SENTENCE,
  isRunActionOp,
  MAX_MANY,
  NOT_REACHED_SENTENCE,
  RunActions,
  SETTINGS_CHANGED_NOTE,
  sourceOf,
} from "../../src/application/run-actions";
import { RUN_GONE_SENTENCE } from "../../src/application/runs";
import type { CallOp } from "../../src/domain/channel/messages";
import type { JournaledMessage } from "../../src/domain/journal/entry";
import { fold, type Run, type RunEvent } from "../../src/domain/runs/run";
import type { FlowTab } from "../../src/ports/flow-admin";
import type { InputMessage, NodeMessage } from "../../src/ports/node-process";
import type { RunStart } from "../../src/ports/run-store";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

const FLOW = "tab1";
const at = (minute: number) => new Date(2026, 9, 6, 14, minute);

const envelope = (id: string) => ({
  specversion: "1.0",
  id,
  source: "inny://livekit/recorder/rec",
  type: "livekit.recording.v1",
  time: "2026-10-06T12:00:00.000Z",
  datacontenttype: "application/json",
});

/** A done run of the flow: the recorder's event, copied, then worked on, with a result each. */
function doneRun(runId = "r1"): Run {
  const events = [
    { kind: "started", title: "rec1", durationSeconds: 120 },
    { kind: "stepStarted", instanceId: "copy", inputId: "i1", name: "Copy" },
    {
      kind: "stepDone",
      instanceId: "copy",
      inputId: "i1",
      results: [{ kind: "file", text: "Copied rec1", folder: "/f" }],
    },
    { kind: "stepStarted", instanceId: "work", inputId: "i2", name: "Work" },
    {
      kind: "stepDone",
      instanceId: "work",
      inputId: "i2",
      results: [{ kind: "anytype", text: "Notes", anytype: { spaceId: "s", objectId: "o" } }],
    },
    { kind: "finished" },
  ].map((event, n) => ({ flowId: FLOW, runId, at: at(n), ...event }) as unknown as RunEvent);
  return fold(events);
}

const KEPT: JournaledMessage[] = [
  {
    payload: { title: "rec1" },
    topic: "livekit.recording.v1",
    inny: { event: envelope("r1"), run: "r1" },
    _msgid: "m1",
  },
  {
    payload: { title: "rec1" },
    topic: "livekit.copied.v1",
    inny: { event: envelope("e2"), run: "r1", cause: "i1" },
    _msgid: "m1",
  },
];

class Fixture {
  readonly clock = new FakeClock();
  readonly logger = new RecordingLogger();
  readonly runs = new Map<string, Run>([["r1", doneRun()]]);
  readonly kept = new Map<string, (JournaledMessage | null)[]>([["r1", [...KEPT]]]);
  readonly started: RunStart[] = [];
  readonly deleted: string[] = [];
  readonly cancelled: string[] = [];
  readonly snapshotsGone: string[] = [];
  readonly emitted: { instance: string; message: NodeMessage }[] = [];
  readonly redelivered: { instance: string; message: InputMessage }[] = [];
  flow: FlowTab | null = {
    id: FLOW,
    label: "Recordings",
    disabled: false,
    nodes: ["rec", "copy", "work"].map((id) => ({ id, type: `inny-livekit-${id}`, z: FLOW })),
    configs: [],
  };
  storeFails = false;
  #ids = 0;
  readonly actions = new RunActions({
    store: {
      run: (runId) => this.runs.get(runId) ?? null,
      started: (start) => {
        if (this.storeFails) {
          throw new Error("disk full");
        }
        this.started.push(start);
      },
      keptInputs: (runId) => this.kept.get(runId) ?? [],
      deleteRuns: (flowId, runIds) => {
        this.deleted.push(...runIds.map((id) => `${flowId}/${id}`));
        return runIds.length;
      },
    },
    engine: { getFlow: () => Promise.resolve(this.flow) },
    cancelRunInputs: (runId) => {
      this.cancelled.push(runId);
      return 1;
    },
    deleteSnapshots: (runIds) => {
      this.snapshotsGone.push(...runIds);
      return runIds.length;
    },
    clock: this.clock,
    newId: () => `new${String(++this.#ids)}`,
    logger: this.logger,
  });

  /** Each instance as registration attaches it, with its config. */
  attachAll(config: object = { folder: "/f" }): (() => void)[] {
    return ["rec", "copy", "work"].map((instance) =>
      this.actions.attach(instance, config, {
        emit: (message) => this.emitted.push({ instance, message }),
        redeliver: (message) => this.redelivered.push({ instance, message }),
      }),
    );
  }
}

describe("re-run (plan 0022 §E)", () => {
  it("knows its four ops", () => {
    const ops: CallOp[] = ["run.rerun", "run.rerunMany", "run.delete", "run.deleteMany"];
    expect(ops.every((op) => isRunActionOp(op))).toBe(true);
    expect(isRunActionOp("run.list")).toBe(false);
  });

  it("from the start: the source sends its event again with a fresh envelope, as a new run", async () => {
    const fixture = new Fixture();
    fixture.attachAll();
    fixture.clock.advance(5_000);
    const answer = await fixture.actions.call("run.rerun", { flowId: FLOW, runId: "r1" });
    expect(answer).toEqual({ ok: true, value: { runId: "new1" } });
    expect(fixture.started).toEqual([
      { flowId: FLOW, runId: "new1", title: "rec1", at: 5_000, rerunOf: "r1", durationSeconds: 120 },
    ]);
    expect(fixture.emitted).toEqual([
      {
        instance: "rec",
        message: {
          payload: { title: "rec1" },
          topic: "livekit.recording.v1",
          inny: {
            event: { ...envelope("new1"), time: new Date(5_000).toISOString() },
            run: "new1",
          },
        },
      },
    ]);
    expect(fixture.redelivered).toEqual([]);
  });

  it("from a step: its kept input re-stamped, the earlier steps' results kept", async () => {
    const fixture = new Fixture();
    fixture.attachAll();
    const answer = await fixture.actions.call("run.rerun", {
      flowId: FLOW,
      runId: "r1",
      from: "work",
    });
    expect(answer).toEqual({ ok: true, value: { runId: "new1" } });
    expect(fixture.started[0]).toMatchObject({
      runId: "new1",
      rerunOf: "r1",
      rerunFrom: "work",
      notes: [],
      results: [
        { step: "Copy", sink: "file", text: "Copied rec1", anytype: null, folder: "/f", due: null },
      ],
    });
    expect(fixture.redelivered).toEqual([
      {
        instance: "work",
        message: {
          payload: { title: "rec1" },
          topic: "livekit.copied.v1",
          inny: { event: envelope("e2"), run: "new1", cause: "i1" },
        },
      },
    ]);
    expect(fixture.emitted).toEqual([]);
  });

  it("notes a step whose settings changed since the run started, and only then", async () => {
    const fixture = new Fixture();
    fixture.attachAll();
    // The same config again (a redeploy) is no change.
    fixture.attachAll();
    await fixture.actions.call("run.rerun", { flowId: FLOW, runId: "r1", from: "work" });
    expect(fixture.started[0]?.notes).toEqual([]);

    // Changed before the run started: not a change since it.
    fixture.clock.advance(at(0).getTime() - 1);
    fixture.attachAll({ folder: "/g" });
    await fixture.actions.call("run.rerun", { flowId: FLOW, runId: "r1", from: "work" });
    expect(fixture.started[1]?.notes).toEqual([]);

    fixture.clock.advance(60 * 60_000);
    fixture.attachAll({ folder: "/h" });
    await fixture.actions.call("run.rerun", { flowId: FLOW, runId: "r1", from: "work" });
    expect(fixture.started[2]?.notes).toEqual([{ step: "Work", text: SETTINGS_CHANGED_NOTE }]);
  });

  it("refuses with a sentence: run gone, flow gone or off, step gone or not running, never reached", async () => {
    const fixture = new Fixture();
    const detach = fixture.attachAll();
    const rerun = (args: object) =>
      fixture.actions.call("run.rerun", { flowId: FLOW, runId: "r1", ...args });
    const refusal = (error: string) => ({ ok: false, error });

    expect(await rerun({ runId: "nope" })).toEqual(refusal(RUN_GONE_SENTENCE));
    expect(await rerun({ flowId: "other" })).toEqual(refusal(RUN_GONE_SENTENCE));
    expect(await rerun({ from: "gone" })).toEqual(refusal(NO_STEP_SENTENCE));

    // A step in the flow the run never reached, and one whose input was too large to keep.
    fixture.runs.set("r2", doneRun("r2"));
    fixture.kept.set("r2", [KEPT[0] ?? null, null]);
    const flow = fixture.flow as FlowTab;
    fixture.flow = { ...flow, nodes: [...flow.nodes, { id: "late", type: "x", z: FLOW }] };
    fixture.actions.attach("late", {}, { emit: () => undefined, redeliver: () => undefined });
    expect(await rerun({ from: "late" })).toEqual(refusal(NOT_REACHED_SENTENCE));
    expect(await rerun({ runId: "r2", from: "work" })).toEqual(refusal(NOT_REACHED_SENTENCE));

    // A source event that names no InnyTypes source (a Node-RED inject fed the first step).
    fixture.kept.set("r2", [{ payload: 1 }, null]);
    expect(await rerun({ runId: "r2" })).toEqual(refusal(NO_STEP_SENTENCE));
    fixture.kept.set("r2", []);
    expect(await rerun({ runId: "r2" })).toEqual(refusal(NOT_REACHED_SENTENCE));

    // A step in the flow but not running (its instance closed): no one to hand it to.
    detach[2]?.();
    expect(await rerun({ from: "work" })).toEqual(refusal(NO_STEP_SENTENCE));
    // A detach of an instance already replaced leaves the new one attached.
    fixture.attachAll();
    detach[1]?.();
    expect(await rerun({ from: "copy" })).toMatchObject({ ok: true });

    fixture.flow = { ...flow, disabled: true };
    expect(await rerun({})).toEqual(refusal(FLOW_OFF_SENTENCE));
    fixture.flow = null;
    expect(await rerun({})).toEqual(refusal(GONE_SENTENCE));
    expect(fixture.logger.lines).toContain(`INFO run.rerun refused: ${GONE_SENTENCE}`);
  });

  it("refuses wrong arguments, and answers a failure without throwing", async () => {
    const fixture = new Fixture();
    fixture.attachAll();
    expect(await fixture.actions.call("run.rerun", { runId: "r1" })).toEqual({
      ok: false,
      error: "flowId is required",
    });
    expect(await fixture.actions.call("run.rerun", null)).toMatchObject({ ok: false });
    expect(
      await fixture.actions.call("run.rerun", { flowId: FLOW, runId: "r1", from: 3 }),
    ).toEqual({ ok: false, error: "from must be a step's id" });
    for (const runIds of [[], "r1", [""], Array.from({ length: MAX_MANY + 1 }, () => "r1")]) {
      expect(await fixture.actions.call("run.deleteMany", { flowId: FLOW, runIds })).toEqual({
        ok: false,
        error: `runIds must be 1 to ${String(MAX_MANY)} run ids`,
      });
    }
    fixture.storeFails = true;
    expect(await fixture.actions.call("run.rerun", { flowId: FLOW, runId: "r1" })).toEqual({
      ok: false,
      error: "run.rerun failed: disk full",
    });
    expect(await fixture.actions.call("run.rerunMany", { flowId: FLOW, runIds: ["r1"] })).toEqual(
      { ok: false, error: "run.rerunMany failed: disk full" },
    );
    expect(fixture.logger.lines.some((line) => line.startsWith("ERROR run.rerun failed"))).toBe(
      true,
    );
  });

  it("re-runs many, skipping the refused; refused only when none started", async () => {
    const fixture = new Fixture();
    fixture.attachAll();
    fixture.runs.set("r2", doneRun("r2"));
    fixture.kept.set("r2", [...KEPT]);
    expect(
      await fixture.actions.call("run.rerunMany", { flowId: FLOW, runIds: ["r1", "gone", "r2"] }),
    ).toEqual({ ok: true, value: { started: 2 } });
    expect(fixture.started.map((start) => start.rerunOf)).toEqual(["r1", "r2"]);
    expect(fixture.logger.lines).toContain(`INFO run gone was not re-run: ${RUN_GONE_SENTENCE}`);
    expect(
      await fixture.actions.call("run.rerunMany", { flowId: FLOW, runIds: ["gone", "x"] }),
    ).toEqual({ ok: false, error: RUN_GONE_SENTENCE });
  });
});

describe("delete (plan 0022 §E)", () => {
  it("cancels the inputs in hand, deletes snapshots and records, of this flow's runs only", async () => {
    const fixture = new Fixture();
    fixture.runs.set("r2", doneRun("r2"));
    fixture.runs.set("elsewhere", { ...doneRun("elsewhere"), flowId: "tab2" });
    expect(await fixture.actions.call("run.delete", { flowId: FLOW, runId: "r1" })).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
    expect(
      await fixture.actions.call("run.deleteMany", {
        flowId: FLOW,
        runIds: ["r2", "elsewhere", "gone"],
      }),
    ).toEqual({ ok: true, value: { deleted: 1 } });
    expect(fixture.cancelled).toEqual(["r1", "r2"]);
    expect(fixture.snapshotsGone).toEqual(["r1", "r2"]);
    expect(fixture.deleted).toEqual([`${FLOW}/r1`, `${FLOW}/r2`]);
    expect(fixture.logger.lines).toContain(
      `INFO 1 runs of flow ${FLOW} deleted: 1 inputs in hand cancelled, 1 snapshots deleted; ` +
        "Anytype is not touched",
    );
  });
});

describe("sourceOf", () => {
  it("names the emitting instance from the envelope's inny:// source, else nothing", () => {
    expect(sourceOf(KEPT[0] as JournaledMessage)).toBe("rec");
    expect(sourceOf({ payload: 1 })).toBeNull();
    expect(sourceOf({ payload: 1, inny: { event: { source: "https://x/y" } } })).toBeNull();
    expect(sourceOf({ payload: 1, inny: { event: { source: "inny://a/b/" } } })).toBeNull();
    expect(sourceOf({ payload: 1, inny: { event: "nope" } })).toBeNull();
  });
});
