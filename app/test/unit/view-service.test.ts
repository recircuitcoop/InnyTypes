// application/views.ts: the runtime's views, against fakes. What it raises to the shell
// (present, first or not; the pending count), what it keeps (snapshots with the type's
// actions and the instance id), and how it answers the shell's calls: a pending view, a
// submission or dismissal, a snapshot with its actions judged NOW, and a press refused with
// 409 and the reason when the view left the flow, the port is unwired, or nothing runs.

import { beforeEach, describe, expect, it } from "vitest";

import { ViewService, type ViewEvent } from "../../src/application/views";
import { newEntry, presented } from "../../src/domain/journal/entry";
import type { LiveView } from "../../src/ports/views";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";
import { MemorySnapshots } from "../fakes/snapshots";
import { RecordingLogger } from "../fixtures/raw-node/fixture";

/** A view instance's process, recording what it is sent. */
class FakeViewNode {
  pid: number | null = 42;
  accepts = true;
  readonly actions: { inputId: string; values: unknown }[] = [];
  readonly triggers: { action: string; snapshot: unknown; values: unknown }[] = [];
  action(inputId: string, values: Readonly<Record<string, unknown>>): boolean {
    this.actions.push({ inputId, values });
    return this.accepts;
  }
  trigger(action: string, snapshot: { id: string; state: unknown }, values: object): boolean {
    this.triggers.push({ action, snapshot, values });
    return this.pid !== null;
  }
}

const ACTIONS = [
  { id: "again", label: "Run again", event: "viewpy.again.v1" },
  { id: "spare", label: "Spare", event: "viewpy.spare.v1" },
];

function liveRecord(node: FakeViewNode, wires: string[][] = [["next"], ["downstream"], []]) {
  const view: LiveView = {
    node,
    type: "inny-viewpy-record",
    label: "Record",
    window: "popout",
    ports: ["passed", "again", "spare"],
    wires,
    actions: ACTIONS,
  };
  return view;
}

let journal: MemoryJournal;
let snapshots: MemorySnapshots;
let raised: ViewEvent[];
let logger: RecordingLogger;
let service: ViewService;
let ids: number;

beforeEach(() => {
  journal = new MemoryJournal();
  snapshots = new MemorySnapshots();
  raised = [];
  logger = new RecordingLogger();
  ids = 0;
  const clock = new FakeClock();
  clock.advance(1_000);
  service = new ViewService({
    journal,
    snapshots,
    clock,
    newId: () => `snap-${String((ids += 1))}`,
    logger,
    raise: (event) => raised.push(event),
  });
});

/** A journaled step of instance `ask`, awaiting with content. */
function awaiting(inputId: string, instanceId = "ask"): void {
  const entry = newEntry({ inputId, instanceId, type: "t", message: { payload: 1 }, now: 0 });
  journal.put(presented(entry, { title: "Name them" }, 0));
}

function recordOne(node = new FakeViewNode()): { node: FakeViewNode; id: string } {
  service.attach("rec", liveRecord(node));
  service.snapshot({ instanceId: "rec", content: { title: "t" }, state: { n: 1 } });
  return { node, id: "snap-1" };
}

describe("ViewService: what it raises", () => {
  it("present carries the window, whether it is first, and the title; the pending count follows", () => {
    service.attach("ask", { ...liveRecord(new FakeViewNode()), window: "popout", actions: [] });
    awaiting("i1");
    service.presented({
      inputId: "i1",
      instanceId: "ask",
      content: { title: "Name them" },
      first: true,
    });
    service.presented({ inputId: "i1", instanceId: "ask", content: {}, first: false });
    expect(raised).toEqual([
      { v: 1, t: "present", id: "i1", window: "popout", first: true, title: "Name them" },
      { v: 1, t: "pending", count: 1 },
      { v: 1, t: "present", id: "i1", window: "popout", first: false, title: "" },
    ]);
    expect(logger.has(/view i1 of instance ask re-presented \(quietly/)).toBe(true);
  });

  it("an instance not attached presents inline; the count is raised only when it moves", () => {
    service.changed();
    awaiting("i1", "gone");
    service.presented({ inputId: "i1", instanceId: "gone", content: {}, first: true });
    journal.clear("i1");
    service.changed();
    service.changed();
    expect(raised).toEqual([
      { v: 1, t: "pending", count: 0 },
      { v: 1, t: "present", id: "i1", window: "inline", first: true, title: "" },
      { v: 1, t: "pending", count: 1 },
      { v: 1, t: "pending", count: 0 },
    ]);
  });

  it("a journal that cannot be read is logged, and no count is raised", () => {
    journal.all = () => {
      throw new Error("disk gone");
    };
    service.changed();
    expect(raised).toEqual([]);
    expect(logger.has(/pending views could not be counted: Error: disk gone/)).toBe(true);
  });
});

describe("ViewService: snapshots", () => {
  it("keeps the content, state, window, the type's actions and the instance id", () => {
    recordOne();
    expect(snapshots.get("snap-1")).toEqual({
      id: "snap-1",
      instanceId: "rec",
      type: "inny-viewpy-record",
      label: "Record",
      time: 1_000,
      content: { title: "t" },
      state: { n: 1 },
      window: "popout",
      actions: ACTIONS,
    });
    expect(logger.has(/snapshot snap-1 recorded from \[inny-viewpy-record rec\]/)).toBe(true);
  });

  it("from an instance not in the flow, or with a failing store, nothing is kept and it is said", () => {
    service.snapshot({ instanceId: "nobody", content: {}, state: null });
    service.attach("rec", liveRecord(new FakeViewNode()));
    snapshots.failWrites = true;
    service.snapshot({ instanceId: "rec", content: {}, state: null });
    expect(snapshots.all()).toEqual([]);
    expect(logger.has(/instance nobody, which is not in the flow, was dropped/)).toBe(true);
    expect(logger.has(/was not kept: Error: disk full/)).toBe(true);
  });

  it("snapshot.get judges each action now: enabled, or disabled with the reason", async () => {
    const { node, id } = recordOne();
    expect(await service.call("snapshot.get", { id })).toEqual({
      ok: true,
      value: expect.objectContaining({
        kind: "snapshot",
        id,
        actions: [
          { ...ACTIONS[0], enabled: true, reason: null },
          { ...ACTIONS[1], enabled: false, reason: 'Nothing is wired to the "Spare" output.' },
        ],
      }) as unknown,
    });
    node.pid = null;
    const down = await service.call("snapshot.get", { id });
    expect(JSON.stringify(down)).toContain("process is not running");
    expect(await service.call("snapshot.get", { id: "nope" })).toEqual({
      ok: true,
      value: { kind: "gone", id: "nope" },
    });
  });
});

describe("ViewService: a press", () => {
  it("of a wired action triggers the CURRENT process with the snapshot's state and the values", async () => {
    const { id } = recordOne();
    // Redeployed since: a new process, and the old one detached.
    const current = new FakeViewNode();
    service.attach("rec", liveRecord(current));
    expect(
      await service.call("snapshot.action", { id, action: "again", values: { a: 1 } }),
    ).toEqual({ ok: true, value: null });
    expect(current.triggers).toEqual([
      { action: "again", snapshot: { id, state: { n: 1 } }, values: { a: 1 } },
    ]);
  });

  it("is refused with 409 and the reason: unwired, gone from the flow, or no process", async () => {
    const { node, id } = recordOne();
    expect(await service.call("snapshot.action", { id, action: "spare" })).toEqual({
      ok: false,
      error: 'Nothing is wired to the "Spare" output.',
      status: 409,
    });
    node.pid = null;
    expect(await service.call("snapshot.action", { id, action: "again" })).toEqual({
      ok: false,
      error: "The view's process is not running; try again in a moment.",
      status: 409,
    });
    expect(node.triggers).toEqual([]);
    // Its process ended between the judgement and the trigger.
    node.pid = 7;
    node.trigger = () => false;
    expect(await service.call("snapshot.action", { id, action: "again" })).toMatchObject({
      status: 409,
    });
    const detach = service.attach("rec", liveRecord(new FakeViewNode()));
    detach();
    detach(); // a second detach is harmless
    expect(await service.call("snapshot.action", { id, action: "again" })).toEqual({
      ok: false,
      error: "The view that took this snapshot is no longer in the flow.",
      status: 409,
    });
    expect(logger.has(/a press of again on snapshot snap-1 was refused/)).toBe(true);
  });

  it("a detach of an instance since re-attached keeps the new one", async () => {
    const { id } = recordOne();
    const detachOld = service.attach("rec", liveRecord(new FakeViewNode()));
    const current = new FakeViewNode();
    service.attach("rec", liveRecord(current));
    detachOld();
    await service.call("snapshot.action", { id, action: "again" });
    expect(current.triggers).toHaveLength(1);
  });

  it("of an unknown action or snapshot, or with bad arguments, is refused", async () => {
    const { id } = recordOne();
    expect(await service.call("snapshot.action", { id, action: "nope" })).toEqual({
      ok: false,
      error: `There is no action "nope" on snapshot ${id}.`,
    });
    expect(await service.call("snapshot.action", { id: "x", action: "again" })).toMatchObject({
      ok: false,
    });
    expect(await service.call("snapshot.action", { id, action: "again", values: 3 })).toEqual({
      ok: false,
      error: "the call's values must be an object",
    });
    expect(await service.call("snapshot.action", { id })).toEqual({
      ok: false,
      error: "the call's action must be a non-empty string",
    });
    expect(await service.call("snapshot.get", null)).toEqual({
      ok: false,
      error: "the call's arguments must be an object",
    });
  });
});

describe("ViewService: a pending view", () => {
  it("view.get answers the view while it waits, and gone after", async () => {
    service.attach("ask", { ...liveRecord(new FakeViewNode()), actions: [] });
    awaiting("i1");
    expect(await service.call("view.get", { id: "i1" })).toEqual({
      ok: true,
      value: {
        kind: "view",
        id: "i1",
        instanceId: "ask",
        content: { title: "Name them" },
        window: "popout",
      },
    });
    awaiting("i2", "elsewhere");
    expect(await service.call("view.get", { id: "i2" })).toMatchObject({
      value: { window: "inline" },
    });
    journal.clear("i1");
    expect(await service.call("view.get", { id: "i1" })).toEqual({
      ok: true,
      value: { kind: "gone", id: "i1" },
    });
    expect(await service.call("view.get", {})).toMatchObject({ ok: false });
  });

  it("view.submit hands the values to the instance's process, and the count follows", async () => {
    const node = new FakeViewNode();
    service.attach("ask", { ...liveRecord(node), actions: [] });
    awaiting("i1");
    service.changed();
    node.action = (inputId, values) => {
      node.actions.push({ inputId, values });
      const entry = journal.get(inputId);
      if (entry !== null) {
        journal.put({ ...entry, state: "sent" });
      }
      return true;
    };
    expect(await service.call("view.submit", { id: "i1", values: { answer: "Ada" } })).toEqual({
      ok: true,
      value: null,
    });
    expect(node.actions).toEqual([{ inputId: "i1", values: { answer: "Ada" } }]);
    expect(raised.at(-1)).toEqual({ v: 1, t: "pending", count: 0 });
    expect(logger.has(/view i1 submitted by the person/)).toBe(true);
  });

  it("a dismissal is handed on as the values say, and logged as one", async () => {
    const node = new FakeViewNode();
    service.attach("ask", { ...liveRecord(node), actions: [] });
    awaiting("i1");
    await service.call("view.submit", { id: "i1", values: { __dismiss__: true } });
    expect(node.actions).toEqual([{ inputId: "i1", values: { __dismiss__: true } }]);
    expect(logger.has(/view i1 dismissed by the person/)).toBe(true);
  });

  it("view.submit is refused when nothing waits, when the process refuses, or with bad values", async () => {
    expect(await service.call("view.submit", { id: "none" })).toEqual({
      ok: false,
      error: "This view is no longer waiting.",
    });
    awaiting("i1");
    expect(await service.call("view.submit", { id: "i1" })).toEqual({
      ok: false,
      error: "The view's process is not running; try again in a moment.",
    });
    const node = new FakeViewNode();
    node.accepts = false;
    service.attach("ask", { ...liveRecord(node), actions: [] });
    expect(await service.call("view.submit", { id: "i1" })).toMatchObject({ ok: false });
    expect(await service.call("view.submit", { id: "i1", values: [] })).toEqual({
      ok: false,
      error: "the call's values must be an object",
    });
    expect(await service.call("view.submit", { values: {} })).toMatchObject({ ok: false });
  });

  it("an op it does not serve, or a store that throws, is answered, never thrown", async () => {
    expect(await service.call("anytype.status", null)).toEqual({
      ok: false,
      error: "the InnyTypes runtime does not serve anytype.status",
    });
    snapshots.get = () => {
      throw new Error("corrupt");
    };
    expect(await service.call("snapshot.get", { id: "x" })).toEqual({
      ok: false,
      error: "Error: corrupt",
    });
  });
});
