// The journal through the node-process adapter, against the raw fixture node (spec §7):
// what is journaled and cleared when, the replayed message's fields, and the queue bound.
// The retry rules across restarts are conformance C15 (test/conformance/journal.test.ts).
import { afterEach, describe, expect, it } from "vitest";

import { queueSettings, type QueueSettings } from "../../src/domain/journal/queue";
import type { InputMessage, NodeProcess } from "../../src/ports/node-process";
import { MemoryJournal } from "../fakes/journal";
import { RecordingDelivery, startRaw, waitFor, type RawNode } from "../fixtures/raw-node/fixture";

const started: NodeProcess[] = [];

function raw(journal = new MemoryJournal(), queue?: QueueSettings, id?: string): RawNode {
  const node = startRaw({
    journal,
    ...(id === undefined ? {} : { id }),
    ...(queue === undefined ? {} : { settings: { queue } }),
  });
  started.push(node.node);
  return node;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.close("removed")));
});

function send(node: NodeProcess, data: unknown): [string | null, RecordingDelivery] {
  const delivery = new RecordingDelivery();
  const id = node.input({ payload: data, topic: "t.in.v1", _msgid: "m" }, delivery);
  return [id, delivery];
}

describe("journal before send, clear on done or error (spec 7.1)", () => {
  it("holds the entry, with its message and event, while the node works on it", async () => {
    const node = raw();
    const [id, delivery] = send(node.node, { do: "slow" });
    await waitFor("working", () => node.host.statuses.some((s) => s.text === "working"));
    expect(node.journal.get(id ?? "")).toMatchObject({
      instanceId: node.spec.identity.id,
      type: "inny-rawnode-raw",
      message: { payload: { do: "slow" }, topic: "t.in.v1", _msgid: "m" },
      event: { type: "t.in.v1", data: { do: "slow" } },
      attempts: 1,
      state: "sent",
    });
    node.node.cancel(id ?? "");
    await waitFor("the cancel", () => delivery.finished);
    expect(node.journal.all()).toEqual([]);
  });

  it("clears the entry on done and on error, before Node-RED is told", async () => {
    const journal = new MemoryJournal();
    const node = raw(journal);
    const [okId, ok] = send(node.node, { do: "echo", value: 1 });
    const [badId, bad] = send(node.node, { do: "fail", message: "no" });
    await waitFor("both", () => ok.finished && bad.finished);
    expect(ok.ends).toEqual([undefined]);
    expect(bad.ends[0]?.message).toBe("no");
    expect(journal.calls).toEqual([
      `put ${String(okId)}`,
      `put ${String(badId)}`,
      `clear ${String(okId)}`,
      `clear ${String(badId)}`,
    ]);
  });

  it("an input the journal cannot record is failed and never reaches the process", async () => {
    const journal = new MemoryJournal();
    const node = raw(journal);
    await waitFor("ready", () => node.logger.has(/\] ready$/));
    journal.failWrites = true;
    const [id, delivery] = send(node.node, { do: "new-run", value: "leaked" });
    expect(id).toBeNull();
    expect(delivery.ends[0]?.message).toMatch(
      /the journal could not record this input: .*disk full/,
    );
    // Had the frame been written first, the node would have started a run with it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(node.host.sent).toEqual([]);
    expect(node.logger.has(/ignored done\/error for unknown/)).toBe(false);
  });

  it("a presented view is journaled awaiting with its content, and sent again on submit", async () => {
    const node = raw();
    const [id, delivery] = send(node.node, { do: "present" });
    await waitFor("present", () => node.host.presented.length === 1);
    expect(node.journal.get(id ?? "")).toMatchObject({
      state: "awaiting",
      content: { title: "Choose" },
    });
    node.node.action(id ?? "", { ok: 1 });
    await waitFor("done", () => delivery.finished);
    expect(node.journal.all()).toEqual([]);
  });

  it("a node process crash clears the sent inputs it failed, and keeps the awaiting one", async () => {
    const node = raw();
    const [waitingId] = send(node.node, { do: "present" });
    await waitFor("present", () => node.host.presented.length === 1);
    const [, running] = send(node.node, { do: "slow" });
    await waitFor("working", () => node.host.statuses.some((s) => s.text === "working"));
    process.kill(node.node.pid ?? 0, "SIGKILL");
    await waitFor("the failure", () => running.finished);
    expect(node.journal.all().map((e) => [e.inputId, e.state])).toEqual([[waitingId, "awaiting"]]);
  });
});

describe("replay carries no internal marker (plan 0018 §7)", () => {
  it("the replayed message has payload, topic, inny and _msgid only, and keeps its input id", async () => {
    const journal = new MemoryJournal();
    const first = raw(journal);
    const upstream: InputMessage = {
      payload: { do: "slow" },
      topic: "t.in.v1",
      inny: { run: "run-9" },
      _msgid: "msg-9",
    };
    const id = first.node.input(
      { ...upstream, req: "not kept" } as InputMessage,
      new RecordingDelivery(),
    );
    await waitFor("working", () => first.host.statuses.some((s) => s.text === "working"));
    await first.node.close("redeploy");

    const next = raw(journal, undefined, first.spec.identity.id);
    const replayed: InputMessage[] = [];
    expect(next.node.replay((message) => replayed.push(message))).toBe(1);
    expect(replayed).toEqual([upstream]);
    expect(Object.keys(replayed[0] ?? {}).sort()).toEqual(["_msgid", "inny", "payload", "topic"]);
    expect(Object.getOwnPropertySymbols(replayed[0])).toEqual([]);

    // The same object back through Node-RED's receive is the journaled input again...
    const delivery = new RecordingDelivery();
    expect(next.node.input(replayed[0] as InputMessage, delivery)).toBe(id);
    // ...and an equal message that is not that object is a new input: nothing rides on it.
    const lookalike = new RecordingDelivery();
    const otherId = next.node.input({ ...upstream, payload: { do: "echo" } }, lookalike);
    expect(otherId).not.toBe(id);
    next.node.cancel(id ?? "");
    await waitFor("both", () => delivery.finished && lookalike.finished);
    expect(delivery.ends[0]?.message).toMatch(/^cancelled/);
    expect(lookalike.ends).toEqual([undefined]);
    expect(journal.all()).toEqual([]);
  });

  it("an input replayed twice while in flight is refused without touching its entry", async () => {
    const journal = new MemoryJournal();
    const first = raw(journal);
    const [id] = send(first.node, { do: "slow" });
    await first.node.close("redeploy");
    const next = raw(journal, undefined, first.spec.identity.id);
    const handed: InputMessage[] = [];
    next.node.replay((message) => handed.push(message));
    next.node.replay((message) => handed.push(message));
    next.node.input(handed[0] as InputMessage, new RecordingDelivery());
    const second = new RecordingDelivery();
    next.node.input(handed[1] as InputMessage, second);
    expect(second.ends[0]?.message).toBe(`input ${String(id)} is already in flight`);
    expect(journal.get(id ?? "")).not.toBeNull();
  });

  it("a replayed input whose entry is gone is finished without being sent", async () => {
    const journal = new MemoryJournal();
    const first = raw(journal);
    const [id] = send(first.node, { do: "slow" });
    await first.node.close("redeploy");
    const next = raw(journal, undefined, first.spec.identity.id);
    const handed: InputMessage[] = [];
    next.node.replay((message) => handed.push(message));
    journal.clear(id ?? "");
    const delivery = new RecordingDelivery();
    expect(next.node.input(handed[0] as InputMessage, delivery)).toBeNull();
    expect(delivery.ends).toEqual([undefined]);
    expect(next.logger.has(/has no journal entry any more/)).toBe(true);
  });
});

describe("the bounded queue (spec 7.6)", () => {
  it("hold: at the bound further inputs wait, are reported and logged, and go when one finishes", async () => {
    const node = raw(new MemoryJournal(), queueSettings(2, "hold"));
    const [a] = send(node.node, { do: "present" });
    send(node.node, { do: "present" });
    await waitFor("two presents", () => node.host.presented.length === 2);
    const [heldId, held] = send(node.node, { do: "echo", value: "held" });
    expect(heldId).toBeNull();
    expect(node.node.queue()).toEqual({
      instanceId: node.spec.identity.id,
      outstanding: 2,
      held: 1,
      refused: 0,
      bound: 2,
      policy: "hold",
    });
    expect(node.journal.all()).toHaveLength(2); // a held input is not journaled yet
    expect(node.logger.has(/queue full: 2 inputs outstanding \(the bound\); holding/)).toBe(true);

    node.node.action(a ?? "", {});
    await waitFor("the held input", () => held.finished);
    expect(held.outputs[0]?.message.payload).toBe("held");
    expect(node.node.queue()).toMatchObject({ outstanding: 1, held: 0 });
    expect(node.logger.has(/every held input has been sent/)).toBe(true);
  });

  it("fail: at the bound further inputs fail with 'queue full', counted and logged", () => {
    const node = raw(new MemoryJournal(), queueSettings(1, "fail"));
    send(node.node, { do: "present" });
    const [, refused] = send(node.node, { do: "echo" });
    const [, again] = send(node.node, { do: "echo" });
    expect(refused.ends[0]?.message).toBe("queue full");
    expect(again.ends[0]?.message).toBe("queue full");
    expect(node.node.queue()).toMatchObject({
      outstanding: 1,
      held: 0,
      refused: 2,
      policy: "fail",
    });
    expect(node.logger.has(/queue full: .*an input was failed \(2 so far\)/)).toBe(true);
    expect(node.journal.all()).toHaveLength(1);
  });

  it("the default bound is 64", () => {
    const node = raw();
    expect(node.node.queue()).toMatchObject({ bound: 64, policy: "hold" });
  });

  it("held inputs are journaled at a close for the next start, without an attempt", async () => {
    const journal = new MemoryJournal();
    const node = raw(journal, queueSettings(1, "hold"));
    send(node.node, { do: "present" });
    send(node.node, { do: "echo", value: "later" });
    await node.node.close("quit");
    const held = journal.all().find((entry) => entry.attempts === 0);
    expect(held?.message.payload).toEqual({ do: "echo", value: "later" });
    expect(node.logger.has(/1 held inputs journaled for the next start/)).toBe(true);
  });

  it("held inputs are dropped, and logged, when the node is removed", async () => {
    const journal = new MemoryJournal();
    const node = raw(journal, queueSettings(1, "hold"));
    send(node.node, { do: "present" });
    send(node.node, { do: "echo" });
    await node.node.close("removed");
    expect(journal.all()).toEqual([]);
    expect(node.logger.has(/node removed from the flow; 1 held inputs dropped/)).toBe(true);
  });

  it("held inputs are failed when the crash-loop limit stops the node", async () => {
    const node = raw(new MemoryJournal(), queueSettings(1, "hold"));
    send(node.node, { do: "present" });
    await waitFor("present", () => node.host.presented.length === 1);
    const [, held] = send(node.node, { do: "echo" });
    // Five crashes in the window: each process is killed as soon as it runs.
    for (let exit = 0; exit < 5; exit += 1) {
      await waitFor("a process", () => node.node.pid !== null, 5_000);
      process.kill(node.node.pid ?? 0, "SIGKILL");
      await waitFor("its exit", () => node.node.pid === null, 5_000);
    }
    await waitFor("the stop", () => held.finished, 5_000);
    expect(held.ends[0]?.message).toMatch(/the node process stopped after 5 exits/);
  }, 20_000);
});
