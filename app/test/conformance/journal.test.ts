// Conformance (spec §12.2) C14, and the journal parts of C15, against the raw fixture node.
//
// C14 binds a node: an input id re-sent across restarts is accepted and completes. C15 binds
// the runtime: journal before send; the planned / crash / quit attempt rules; the awaiting view
// never counted; removal drops entries. (C15's deploy guard, palette lock and pop-out probes
// belong to WI-0018-08 and WI-0018-10.)
//
// A runtime restart is modelled by starting the instance again, with the same id, on the
// journal the last one left. A runtime CRASH leaves the journal exactly as it was at that
// instant, so it is a snapshot the dead runtime can no longer write to; a planned close or a
// quit is a close with that reason.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  LineReader,
  type NodeFrame,
} from "../../src/adapters/process/codec";
import type { CloseReason } from "../../src/domain/journal/entry";
import type { InputMessage, NodeProcess } from "../../src/ports/node-process";
import { MemoryJournal } from "../fakes/journal";
import {
  rawNodeCommand,
  rawNodeEnv,
  RecordingDelivery,
  startRaw,
  waitFor,
  type RawNode,
} from "../fixtures/raw-node/fixture";

const started: NodeProcess[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.close("removed")));
});

function raw(journal: MemoryJournal, id?: string): RawNode {
  const node = startRaw({ journal, ...(id === undefined ? {} : { id }) });
  started.push(node.node);
  return node;
}

/** The instance's current generation, and the journal it writes. */
interface Generation {
  readonly node: RawNode;
  readonly journal: MemoryJournal;
}

/** One step on a fresh instance: its id and its delivery. */
function begin(data: unknown): Generation & { id: string; delivery: RecordingDelivery } {
  const journal = new MemoryJournal();
  const node = raw(journal);
  const delivery = new RecordingDelivery();
  const id = node.node.input({ payload: data, topic: "t.in.v1", _msgid: "m" }, delivery);
  return { node, journal, id: id ?? "", delivery };
}

/** End this generation the way `how` does, and return the journal the next one starts on. */
async function end(generation: Generation, how: CloseReason | "crash"): Promise<MemoryJournal> {
  if (how === "crash") {
    const left = generation.journal.snapshot();
    await generation.node.node.close("removed"); // the dead runtime's process goes too
    return left;
  }
  await generation.node.node.close(how);
  return generation.journal;
}

/** Start the same instance on `journal`, replay, and feed the replay back as Node-RED would. */
function restart(
  journal: MemoryJournal,
  previous: Generation,
): Generation & { deliveries: RecordingDelivery[] } {
  const node = raw(journal, previous.node.spec.identity.id);
  const deliveries: RecordingDelivery[] = [];
  node.node.replay((message: InputMessage) => {
    const delivery = new RecordingDelivery();
    deliveries.push(delivery);
    node.node.input(message, delivery);
  });
  return { node, journal, deliveries };
}

async function working(node: RawNode): Promise<void> {
  await waitFor("working", () => node.host.statuses.some((s) => s.text === "working"));
}

describe("conformance C14: replay", () => {
  it("the raw node accepts the same input id again after a restart, and completes it", async () => {
    const frames: NodeFrame[] = [];
    const run = (): ReturnType<typeof spawn> => {
      const { argv, cwd } = rawNodeCommand();
      const child = spawn(argv[0] as string, argv.slice(1), { cwd, env: rawNodeEnv() });
      const lines = new LineReader();
      child.stdout.on("data", (chunk: Buffer) => {
        for (const line of lines.push(chunk)) {
          const decoded = line.kind === "line" ? decodeFrame(line.bytes) : null;
          if (decoded?.kind === "frame") {
            frames.push(decoded.frame);
          }
        }
      });
      const start = { id: "c14", type: "inny-rawnode-raw", name: "" };
      child.stdin.write(
        encodeFrame({
          t: "start",
          protocol: 2,
          node: start,
          config: {},
          credentials: {},
          data_dir: "/x",
        }),
      );
      return child;
    };
    const first = run();
    first.stdin?.write(
      encodeFrame({ t: "input", id: "same-id", event: { type: "t.v1", data: { do: "slow" } } }),
    );
    await waitFor("working", () => frames.some((f) => f.t === "status"));
    first.kill("SIGKILL");
    const second = run();
    second.stdin?.write(
      encodeFrame({
        t: "input",
        id: "same-id",
        event: { type: "t.v1", data: { do: "echo", value: 1 } },
      }),
    );
    await waitFor("the terminal", () => frames.some((f) => f.t === "done" && f.in === "same-id"));
    second.kill("SIGKILL");
    expect(frames.filter((f) => f.t === "emit" && f.in === "same-id")).toHaveLength(1);
  });

  it("through the runtime: the re-sent input keeps its id, completes, and is cleared", async () => {
    const step = begin({ do: "slow" });
    await working(step.node);
    const next = restart(await end(step, "crash"), step);
    await working(next.node);
    expect(next.journal.get(step.id)?.attempts).toBe(2);
    next.node.node.cancel(step.id);
    await waitFor("the end", () => next.deliveries[0]?.finished === true);
    expect(next.deliveries).toHaveLength(1);
    expect(next.journal.all()).toEqual([]);
  });
});

describe("conformance C15, runtime side: the journal", () => {
  it("journal before send: an input the journal cannot record never reaches the node", async () => {
    const journal = new MemoryJournal();
    const node = raw(journal);
    await waitFor("ready", () => node.logger.has(/\] ready$/));
    journal.failWrites = true;
    const delivery = new RecordingDelivery();
    node.node.input({ payload: { do: "new-run", value: 1 }, topic: "t" }, delivery);
    expect(delivery.ends[0]?.message).toMatch(/the journal could not record this input/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(node.host.sent).toEqual([]);
  });

  it("planned by a node-type change: plannedBy recorded, re-sent without counting", async () => {
    const step = begin({ do: "slow" });
    await working(step.node);
    const left = await end(step, "types");
    expect(left.get(step.id)).toMatchObject({ planned: true, plannedBy: "types", attempts: 1 });
    const next = restart(left, step);
    await working(next.node);
    expect(next.journal.get(step.id)).toMatchObject({ planned: false, attempts: 1 });
    expect(next.node.logger.has(/planned restart \(types\); not counted/)).toBe(true);
  });

  it("planned by a redeploy: plannedBy redeploy, never counted however often it happens", async () => {
    let generation: Generation = begin({ do: "slow" });
    const id = (generation as ReturnType<typeof begin>).id;
    for (let redeploy = 0; redeploy < 3; redeploy += 1) {
      await working(generation.node);
      const left = await end(generation, "redeploy");
      expect(left.get(id)?.plannedBy).toBe("redeploy");
      generation = restart(left, generation);
    }
    await working(generation.node);
    expect(generation.journal.get(id)?.attempts).toBe(1);
  });

  it("a crash is counted, and a second counted interruption fails the step: 'not done after 2 attempts'", async () => {
    const step = begin({ do: "slow" });
    await working(step.node);
    const second = restart(await end(step, "crash"), step);
    await working(second.node);
    expect(second.journal.get(step.id)?.attempts).toBe(2);

    const third = restart(await end(second, "crash"), second);
    const failed = third.deliveries[0];
    expect(failed?.ends[0]?.message).toBe("raw: not done after 2 attempts");
    expect(third.journal.all()).toEqual([]);
    // Given up: never handed to the node again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(third.node.host.statuses.some((s) => s.text === "working")).toBe(false);
  });

  it("a quit is counted", async () => {
    const step = begin({ do: "slow" });
    await working(step.node);
    const left = await end(step, "quit");
    expect(left.get(step.id)).toMatchObject({ planned: false, plannedBy: null, attempts: 1 });
    const next = restart(left, step);
    await working(next.node);
    expect(next.journal.get(step.id)?.attempts).toBe(2);
  });

  it("an awaiting view is never counted: re-presented after every crash, and still answerable", async () => {
    const step = begin({ do: "present" });
    await waitFor("present", () => step.node.host.presented.length === 1);
    let generation: Generation = step;
    for (let crash = 0; crash < 3; crash += 1) {
      const next = restart(await end(generation, "crash"), generation);
      await waitFor("the re-presentation", () => next.node.host.presented.length === 1);
      expect(next.node.host.presented[0]?.inputId).toBe(step.id);
      expect(next.journal.get(step.id)).toMatchObject({ state: "awaiting", attempts: 1 });
      generation = next;
    }
    generation.node.node.action(step.id, { ok: true });
    const last = generation as ReturnType<typeof restart>;
    await waitFor("done", () => last.deliveries[0]?.finished === true);
    expect(last.deliveries[0]?.ends).toEqual([undefined]);
    expect(last.journal.all()).toEqual([]);
  });

  it("removal drops the instance's entries, each logged", async () => {
    const journal = new MemoryJournal();
    const node = raw(journal);
    const ids = [0, 1].map((n) =>
      node.node.input({ payload: { do: "present", n }, topic: "t" }, new RecordingDelivery()),
    );
    await waitFor("presents", () => node.host.presented.length === 2);
    await node.node.close("removed");
    expect(journal.all()).toEqual([]);
    for (const id of ids) {
      expect(node.logger.has(new RegExp(`journaled input ${String(id)} dropped`))).toBe(true);
    }
  });
});
