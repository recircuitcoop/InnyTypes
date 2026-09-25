// Action and snapshot views through the real node process adapter (WI-0018-10), against both
// reference view nodes: the journal says whether a presentation is the first; an awaiting
// step is re-presented after a restart without an attempt counted; submission and dismissal
// end the step; the timeout output fires from the JOURNALED deadline, across a restart; and a
// trigger starts a new run on its action port.

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_NODE_PROCESS, nodeProcessLauncher } from "../../src/adapters/process/node-process";
import { processTreeFor } from "../../src/adapters/process/process-tree";
import { systemClock } from "../../src/adapters/system/clock";
import type { Clock } from "../../src/ports/clock";
import type { NodeProcess, NodeProcessSpec } from "../../src/ports/node-process";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";
import {
  RecordingDelivery,
  RecordingHost,
  RecordingLogger,
  RecordingNotifier,
  RecordingSecrets,
  waitFor,
} from "../fixtures/raw-node/fixture";
import { VIEW_LANGUAGES, viewSpec, type ViewLanguage } from "../fixtures/views";

const started: NodeProcess[] = [];

interface Started {
  readonly node: NodeProcess;
  readonly host: RecordingHost;
  readonly logger: RecordingLogger;
}

function start(spec: NodeProcessSpec, journal: MemoryJournal, clock: Clock = systemClock): Started {
  const host = new RecordingHost();
  const logger = new RecordingLogger();
  const node = nodeProcessLauncher({
    clock,
    logger,
    notifier: new RecordingNotifier(),
    tree: processTreeFor(process.platform),
    newId: randomUUID,
    secrets: new RecordingSecrets(),
    journal,
    settings: DEFAULT_NODE_PROCESS,
  }).start(spec, host);
  started.push(node);
  return { node, host, logger };
}

/** Present one input on an `ask` instance; its id once presented. */
async function presentOne(
  running: Started,
  delivery: RecordingDelivery,
  data: unknown = { n: 1 },
): Promise<string> {
  const id = running.node.input({ payload: data, topic: "t.v1", inny: { run: "run-1" } }, delivery);
  expect(id).not.toBeNull();
  await waitFor("present", () => running.host.presented.some((p) => p.inputId === id));
  return id as string;
}

/** A runtime killed now: what it leaves behind, handed to the next one, replayed. */
async function restart(
  language: ViewLanguage,
  journal: MemoryJournal,
  id: string,
  options: { clock?: Clock; config?: Record<string, unknown> } = {},
): Promise<{ next: Started; journal: MemoryJournal; delivery: RecordingDelivery }> {
  const left = journal.snapshot();
  const next = start(
    viewSpec(language, "ask", { id, config: options.config ?? {} }),
    left,
    options.clock,
  );
  const delivery = new RecordingDelivery();
  next.node.replay((message) => {
    next.node.input(message, delivery);
  });
  await waitFor("the re-presentation", () => next.host.presented.length === 1);
  return { next, journal: left, delivery };
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.close("redeploy")));
});

describe.each(VIEW_LANGUAGES)("views through the node process adapter (%s)", (language) => {
  it("a present is first once; after a restart the same id is re-presented quietly, with no attempt counted", async () => {
    const journal = new MemoryJournal();
    const instance = `ask-${language}`;
    const first = start(viewSpec(language, "ask", { id: instance }), journal);
    const id = await presentOne(first, new RecordingDelivery());
    expect(first.host.presented).toEqual([
      { inputId: id, content: expect.any(Object) as unknown, first: true },
    ]);
    expect(journal.get(id)).toMatchObject({ state: "awaiting", attempts: 1 });

    const { next, journal: left } = await restart(language, journal, instance);
    expect(next.host.presented).toEqual([
      { inputId: id, content: expect.any(Object) as unknown, first: false },
    ]);
    // Waiting may take days: however often it is re-sent, no attempt is used (spec 7.4).
    expect(left.get(id)).toMatchObject({ state: "awaiting", attempts: 1 });
    const again = await restart(language, left, instance);
    expect(again.journal.get(id)).toMatchObject({ state: "awaiting", attempts: 1 });
  });

  it("a submission continues the flow on the view's output, under the same input, and clears the entry", async () => {
    const journal = new MemoryJournal();
    const running = start(viewSpec(language, "ask"), journal);
    const delivery = new RecordingDelivery();
    const id = await presentOne(running, delivery);
    expect(running.node.action(id, { answer: "Ada" })).toBe(true);
    await waitFor("done", () => delivery.finished);
    expect(delivery.ends).toEqual([undefined]);
    expect(delivery.outputs).toEqual([
      {
        index: 0,
        port: "answer",
        message: expect.objectContaining({
          payload: { answer: "Ada" },
          inny: expect.objectContaining({ run: "run-1", cause: id }) as unknown,
        }) as unknown,
      },
    ]);
    expect(journal.get(id)).toBeNull();
    // Nothing waits on it any more: a second submission is refused.
    expect(running.node.action(id, {})).toBe(false);
  });

  it("a dismissal ends the step with an error, which is what reaches Catch", async () => {
    const journal = new MemoryJournal();
    const running = start(viewSpec(language, "ask"), journal);
    const delivery = new RecordingDelivery();
    const id = await presentOne(running, delivery);
    running.node.action(id, { __dismiss__: true });
    await waitFor("done", () => delivery.finished);
    expect(delivery.ends[0]?.message).toBe("dismissed by the person");
    expect(delivery.outputs).toEqual([]);
    expect(journal.get(id)).toBeNull();
  });

  it("the timeout output fires at the journaled deadline, and a restart does not move it", async () => {
    const clock = new FakeClock();
    const journal = new MemoryJournal();
    const instance = `timed-${language}`;
    const config = { timeout_seconds: 5 };
    const first = start(viewSpec(language, "ask", { id: instance, config }), journal, clock);
    const id = await presentOne(first, new RecordingDelivery(), { n: 9 });
    expect(journal.get(id)?.deadline).toBe(5_000);

    // The runtime dies at 3 s; the next one re-presents at 3 s and keeps the deadline.
    clock.advance(3_000);
    const {
      next,
      journal: left,
      delivery,
    } = await restart(language, journal, instance, {
      clock,
      config,
    });
    expect(left.get(id)?.deadline).toBe(5_000);
    clock.advance(1_999);
    expect(delivery.finished).toBe(false);
    clock.advance(1);
    expect(delivery.ends).toEqual([undefined]);
    expect(delivery.outputs).toEqual([
      expect.objectContaining({
        index: 1,
        port: "timeout",
        message: expect.objectContaining({ payload: { n: 9 } }) as unknown,
      }),
    ]);
    expect(left.get(id)).toBeNull();
    expect(next.logger.has(/timed out; the flow continues from its timeout output/)).toBe(true);
  });

  it("a view without a timeout never times out, and a submitted one is not timed out after", async () => {
    const clock = new FakeClock();
    const journal = new MemoryJournal();
    const plain = start(viewSpec(language, "ask"), journal, clock);
    const waiting = new RecordingDelivery();
    const id = await presentOne(plain, waiting);
    expect(journal.get(id)?.deadline).toBeNull();

    const timed = start(
      viewSpec(language, "ask", { config: { timeout_seconds: 1 } }),
      journal,
      clock,
    );
    const answered = new RecordingDelivery();
    const other = await presentOne(timed, answered);
    timed.node.action(other, { answer: "in time" });
    await waitFor("done", () => answered.finished);
    clock.advance(60_000);
    expect(answered.outputs.map((output) => output.port)).toEqual(["answer"]);
    expect(waiting.finished).toBe(false);
  });

  it("a snapshot is recorded; a trigger starts a new run on the action port", async () => {
    const running = start(viewSpec(language, "record"), new MemoryJournal());
    const delivery = new RecordingDelivery();
    running.node.input({ payload: { n: 3 }, topic: "t.v1", inny: { run: "old-run" } }, delivery);
    await waitFor("done", () => delivery.finished);
    expect(running.host.snapshots).toEqual([
      {
        content: expect.any(Object) as unknown,
        state: { n: 3 },
        inputId: expect.any(String) as unknown,
      },
    ]);
    expect(delivery.outputs.map((output) => output.port)).toEqual(["passed"]);

    expect(running.node.trigger("again", { id: "snap", state: { n: 3 } }, { why: 1 })).toBe(true);
    await waitFor("the new run", () => running.host.sent.length === 1);
    const [output] = running.host.sent;
    expect(output?.port).toBe("again");
    expect(output?.index).toBe(1);
    expect(output?.message.payload).toEqual({ state: { n: 3 }, values: { why: 1 } });
    // A new run: its id is the new event's own, never the run the snapshot was taken in.
    expect(output?.message.inny.run).toBe(output?.message.inny.event.id);
    expect(output?.message.inny.run).not.toBe("old-run");
    expect(output?.message.inny.cause).toBeUndefined();
  });

  it("a press or a submission with no process running is refused, not dropped", async () => {
    const running = start(viewSpec(language, "record"), new MemoryJournal());
    await running.node.close("redeploy");
    expect(running.node.trigger("again", { id: "snap", state: null }, {})).toBe(false);
    expect(running.logger.has(/a trigger frame was not sent/)).toBe(true);
  });
});
