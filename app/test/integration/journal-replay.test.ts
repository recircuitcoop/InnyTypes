// application/journal-replay.ts: the runtime's ONE replay on `flows:started` (spec 7.2,
// plan 0018 §7), with fakes, then with 50 real instances through the node-process adapter.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { JournalReplay, type Replayable } from "../../src/application/journal-replay";
import { newEntry } from "../../src/domain/journal/entry";
import type { QueueReport } from "../../src/domain/journal/queue";
import type { InputMessage, NodeProcess } from "../../src/ports/node-process";
import { MemoryJournal } from "../fakes/journal";
import {
  RecordingDelivery,
  RecordingLogger,
  startRaw,
  waitFor,
} from "../fixtures/raw-node/fixture";

function entry(inputId: string, instanceId: string, data: unknown = { do: "echo" }) {
  return newEntry({
    inputId,
    instanceId,
    type: "inny-rawnode-raw",
    message: { payload: data, topic: "t.in.v1", _msgid: `m-${inputId}` },
    now: 1,
  });
}

class FakeInstance implements Replayable {
  replays = 0;
  constructor(readonly id: string) {}
  replay(redeliver: (message: InputMessage) => void): number {
    this.replays += 1;
    redeliver({ payload: this.id });
    return 1;
  }
  queue(): QueueReport {
    return { instanceId: this.id, outstanding: 0, held: 0, refused: 0, bound: 64, policy: "hold" };
  }
  readonly cancelled: string[] = [];
  cancel(inputId: string): void {
    this.cancelled.push(inputId);
  }
}

describe("JournalReplay", () => {
  it("listens once, and replays each attached instance once, on the next flows:started", () => {
    const events = new EventEmitter();
    const logger = new RecordingLogger();
    const replay = new JournalReplay({ store: new MemoryJournal(), logger, events });
    const a = new FakeInstance("a");
    const b = new FakeInstance("b");
    const received: unknown[] = [];
    replay.attach("a", a, (m) => received.push(m.payload));
    replay.attach("b", b, (m) => received.push(m.payload));
    expect(events.listenerCount("flows:started")).toBe(1);
    expect(received).toEqual([]); // nothing before the flow has started

    events.emit("flows:started");
    expect(received).toEqual(["a", "b"]);
    expect(logger.has(/flows started: 2 journaled inputs re-sent/)).toBe(true);

    // A later deploy replays only instances constructed since.
    const c = new FakeInstance("c");
    replay.attach("c", c, (m) => received.push(m.payload));
    events.emit("flows:started");
    expect([a.replays, b.replays, c.replays]).toEqual([1, 1, 1]);
    expect(replay.queues().map((q) => q.instanceId)).toEqual(["a", "b", "c"]);
  });

  it("a detached instance is not replayed, and a newer one of the same id is kept", () => {
    const events = new EventEmitter();
    const replay = new JournalReplay({
      store: new MemoryJournal(),
      logger: new RecordingLogger(),
      events,
    });
    const old = new FakeInstance("a");
    const detach = replay.attach("a", old, () => undefined);
    const newer = new FakeInstance("a");
    replay.attach("a", newer, () => undefined);
    detach(); // the old instance's close runs after the new one was constructed
    events.emit("flows:started");
    expect([old.replays, newer.replays]).toEqual([0, 1]);
    const gone = new FakeInstance("b");
    replay.attach("b", gone, () => undefined)();
    events.emit("flows:started");
    expect(gone.replays).toBe(0);
  });

  it("says, once each, which entries belong to no instance in the flow, and keeps them", () => {
    const events = new EventEmitter();
    const store = new MemoryJournal();
    store.put(entry("lost-1", "gone"));
    const logger = new RecordingLogger();
    new JournalReplay({ store, logger, events });
    events.emit("flows:started");
    events.emit("flows:started");
    const said = logger.lines.filter((line) => line.text.includes("lost-1"));
    expect(said).toHaveLength(1);
    expect(said[0]?.text).toMatch(/instance gone, which is not in the running flow; it is kept/);
    expect(store.get("lost-1")).not.toBeNull();
  });
});

describe("JournalReplay: the Jobs page", () => {
  it("lists the inputs in hand, cancels one through its instance, and refuses what it cannot", () => {
    const events = new EventEmitter();
    const store = new MemoryJournal();
    const logger = new RecordingLogger();
    const replay = new JournalReplay({ store, logger, events });
    const a = new FakeInstance("a");
    replay.attach("a", a, () => undefined);
    store.put(entry("in-1", "a"));
    store.put({ ...entry("in-2", "a"), state: "awaiting" });
    store.put(entry("in-3", "gone"));
    expect(replay.call("job.list", null)).toEqual({
      ok: true,
      value: [
        { id: "in-1", instanceId: "a", type: "inny-rawnode-raw", attempts: 1, createdAt: 1 },
        { id: "in-3", instanceId: "gone", type: "inny-rawnode-raw", attempts: 1, createdAt: 1 },
      ],
    });
    expect(replay.call("job.cancel", { id: "in-1" })).toEqual({ ok: true, value: null });
    expect(a.cancelled).toEqual(["in-1"]);
    expect(logger.has(/cancel requested for input in-1 from the Jobs page/)).toBe(true);
    // A view waiting on a person is not a job; an instance not in the flow has nothing to stop.
    for (const id of ["in-2", "in-3", "nobody"]) {
      expect(replay.call("job.cancel", { id })).toEqual({
        ok: false,
        error: "This job is no longer running.",
      });
    }
    expect(replay.call("job.cancel", {})).toMatchObject({ ok: false });
    expect(replay.call("job.cancel", null)).toMatchObject({ ok: false });
    expect(replay.call("view.get", { id: "in-1" })).toMatchObject({ ok: false });
    expect(a.cancelled).toEqual(["in-1"]);
  });
});

describe("one replay for 50 instances through the adapter", () => {
  const nodes: NodeProcess[] = [];
  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((node) => node.close("removed")));
  });

  it(
    "re-sends every journaled input once, with no MaxListeners warning",
    { timeout: 60_000 },
    async () => {
      const warnings: Error[] = [];
      const onWarning = (warning: Error): void => {
        warnings.push(warning);
      };
      process.on("warning", onWarning);
      try {
        const events = new EventEmitter(); // RED.events: the default limit of 10 listeners
        const store = new MemoryJournal();
        const logger = new RecordingLogger();
        const replay = new JournalReplay({ store, logger, events });
        // The journal a crashed runtime left: one step per instance.
        for (let n = 0; n < 50; n += 1) {
          store.put(entry(`in-${String(n)}`, `inst-${String(n)}`, { do: "echo", value: n }));
        }
        const deliveries = new Map<number, RecordingDelivery>();
        for (let n = 0; n < 50; n += 1) {
          const raw = startRaw({ journal: store, id: `inst-${String(n)}` });
          nodes.push(raw.node);
          const delivery = new RecordingDelivery();
          deliveries.set(n, delivery);
          // WI-0018-08's constructor: attach, with Node-RED's receive → input as the redeliver.
          replay.attach(`inst-${String(n)}`, raw.node, (message) =>
            raw.node.input(message, delivery),
          );
        }
        events.emit("flows:started");
        await waitFor(
          "every replayed input",
          () => [...deliveries.values()].every((d) => d.finished),
          30_000,
        );
        await new Promise((resolve) => setImmediate(resolve)); // warnings are emitted on a tick

        expect(events.listenerCount("flows:started")).toBe(1);
        expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
        for (const [n, delivery] of deliveries) {
          expect(delivery.ends).toEqual([undefined]);
          expect(delivery.outputs[0]?.message.payload).toBe(n);
          expect(delivery.outputs[0]?.message.inny.cause).toBe(`in-${String(n)}`);
        }
        expect(store.all()).toEqual([]);
        expect(logger.has(/flows started: 50 journaled inputs re-sent/)).toBe(true);
      } finally {
        process.off("warning", onWarning);
      }
    },
  );
});
