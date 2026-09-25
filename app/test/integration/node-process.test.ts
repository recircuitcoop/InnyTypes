// adapters/process/node-process.ts against a real process: the raw fixture node (node.py, the
// standard library only). Spec §3–§6 and §11.2, from the runtime's side.

import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { INHERITED_VARIABLES } from "../../src/adapters/process/command";
import { MAX_FRAME_BYTES } from "../../src/adapters/process/codec";
import type { NodeProcess } from "../../src/ports/node-process";
import { FakeClock } from "../fakes/clock";
import {
  alive,
  RAW_NODE_DIR,
  RecordingDelivery,
  startRaw,
  waitFor,
  type RawNode,
  type StartOptions,
} from "../fixtures/raw-node/fixture";

const started: NodeProcess[] = [];

function raw(options?: StartOptions): RawNode {
  const node = startRaw(options);
  started.push(node.node);
  return node;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.close("redeploy")));
});

/** Send one input and return its id and recorded delivery. */
function send(node: NodeProcess, data: unknown, run?: string): [string, RecordingDelivery] {
  const delivery = new RecordingDelivery();
  const inny = run === undefined ? {} : { inny: { run } };
  const id = node.input({ payload: data, topic: "test.in.v1", ...inny }, delivery);
  return [id ?? "(refused)", delivery];
}

async function ready(node: RawNode): Promise<void> {
  await waitFor("ready", () => node.logger.has(/\] ready$/));
}

describe("a node process", () => {
  it("is spawned in its package directory with a minimal environment, in its own process group", async () => {
    process.env["INNY_TEST_SECRET"] = "must-not-reach-a-node";
    const node = raw();
    delete process.env["INNY_TEST_SECRET"];
    const [, delivery] = send(node.node, { do: "whoami" });
    await waitFor("done", () => delivery.finished);

    const about = delivery.outputs[0]?.message.payload as {
      env: string[];
      cwd: string;
      pgid: number;
      data_dir: string;
    };
    const allowed = new Set([...INHERITED_VARIABLES, "PYTHONUNBUFFERED", "PYTHONIOENCODING"]);
    // Darwin adds these to every process itself; they were not passed.
    const added = new Set(["__CF_USER_TEXT_ENCODING", "LC_CTYPE"]);
    expect(about.env.filter((name) => !allowed.has(name) && !added.has(name))).toEqual([]);
    expect(about.env).not.toContain("INNY_TEST_SECRET");
    expect(about.cwd).toBe(fs.realpathSync(RAW_NODE_DIR));
    expect(about.pgid).toBe(node.node.pid);
    expect(about.data_dir).toBe(node.spec.dataDir);
  });

  it("registers every credential with the log redactor before the process can print a line", () => {
    const node = raw({ credentials: { token: "inny-canary-1", empty: "" } });
    expect(node.secrets.protected).toEqual(["inny-canary-1"]);
    expect(node.logger.nodeLines).toEqual([]);
  });

  it("sends start, then shows ready once the process says so", async () => {
    const node = raw();
    await ready(node);
    expect(node.host.statuses[0]).toEqual({ fill: "grey", shape: "ring", text: "starting" });
    expect(node.host.statuses.at(-1)).toEqual({ fill: "green", shape: "ring", text: "ready" });
    expect(fs.existsSync(node.spec.dataDir)).toBe(true);
  });

  it("stamps every envelope field of an output caused by an input, and keeps its run", async () => {
    const node = raw();
    const [id, delivery] = send(node.node, { do: "echo", value: { a: 1 } }, "run-1");
    await waitFor("done", () => delivery.finished);

    expect(delivery.ends).toEqual([undefined]);
    const output = delivery.outputs[0];
    expect(output?.index).toBe(0);
    expect(output?.port).toBe("out");
    expect(output?.message.payload).toEqual({ a: 1 });
    expect(output?.message.topic).toBe("rawnode.out.v1");
    expect(output?.message.inny.run).toBe("run-1");
    expect(output?.message.inny.cause).toBe(id);
    const event = output?.message.inny.event;
    expect(event?.specversion).toBe("1.0");
    expect(event?.source).toBe(`inny://rawnode/raw/${node.spec.identity.id}`);
    expect(event?.type).toBe("rawnode.out.v1");
    expect(event?.datacontenttype).toBe("application/json");
    expect(event?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(event?.time ?? ""))).toBe(false);
  });

  it("starts a new run for an emit with no in, whose run is the new event's id", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "new-run", value: 7 });
    await waitFor("done", () => delivery.finished);
    expect(delivery.outputs).toEqual([]);
    const output = node.host.sent[0];
    expect(output?.message.payload).toBe(7);
    expect(output?.message.inny.run).toBe(output?.message.inny.event.id);
    expect(output?.message.inny.cause).toBeUndefined();
  });

  it("refuses and logs an emit on an undeclared port", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "undeclared" });
    await waitFor("done", () => delivery.finished);
    expect(delivery.outputs).toEqual([]);
    expect(node.host.sent).toEqual([]);
    expect(node.logger.has(/refused an emit on undeclared port "nope"/)).toBe(true);
  });

  it("refuses and logs an emit for an input id that is not its own", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "foreign" });
    await waitFor("done", () => delivery.finished);
    expect(node.host.sent).toEqual([]);
    expect(node.logger.has(/refused an emit for unknown input "not-an-input-of-mine"/)).toBe(true);
  });

  it("ignores and logs a second terminal frame for the same input", async () => {
    const node = raw();
    const [id, delivery] = send(node.node, { do: "twice" });
    await waitFor("the second done", () => node.logger.has(/ignored done\/error/));
    expect(delivery.ends).toEqual([undefined]);
    expect(node.logger.has(new RegExp(`unknown or finished input ${id}`))).toBe(true);
  });

  it("fails an input with the message of its error frame", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "fail", message: "no such folder" });
    await waitFor("the error", () => delivery.finished);
    expect(delivery.ends[0]?.message).toBe("no such folder");
  });

  it("routes stderr, stray stdout, log frames and input-less errors to the one log", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "noise" });
    await waitFor("done", () => delivery.finished);
    await waitFor("stderr", () => node.logger.nodeLines.some((l) => l.line === "a line on stderr"));
    const levels = node.logger.nodeLines.map((l) => `${l.level}: ${l.line}`);
    expect(levels).toContain("stdout: protocol violation (not JSON): this is not a frame");
    expect(levels).toContain("STDERR: a line on stderr");
    expect(levels).toContain("warn: a log frame");
    expect(node.logger.nodeLines[0]?.source).toEqual({
      type: "inny-rawnode-raw",
      instance: node.spec.identity.id,
    });
    expect(node.host.errors).toEqual(["an error of no input"]);
  });

  it("accepts a frame of exactly 1 MiB, and fails the input of one byte more: frame too large", async () => {
    const node = raw();
    const [, fits] = send(node.node, { do: "sized", bytes: MAX_FRAME_BYTES });
    await waitFor("the 1 MiB frame", () => fits.finished);
    expect(fits.ends).toEqual([undefined]);
    expect((fits.outputs[0]?.message.payload as string).length).toBeGreaterThan(1_000_000);

    const [, over] = send(node.node, { do: "sized", bytes: MAX_FRAME_BYTES + 1 });
    await waitFor("the oversize frame", () => over.finished);
    expect(over.outputs).toEqual([]);
    expect(over.ends[0]?.message).toBe("frame too large");
    expect(node.logger.has(/discarded a 1048577-byte frame: frame too large/)).toBe(true);
  });

  it("presents an action view, then emits and finishes on submit, or fails on dismiss", async () => {
    const node = raw();
    const [submitId, submitted] = send(node.node, { do: "present" });
    const [dismissId, dismissed] = send(node.node, { do: "present" });
    await waitFor("two presents", () => node.host.presented.length === 2);
    node.node.action(submitId, { answer: "yes" });
    node.node.action(dismissId, { __dismiss__: true });
    await waitFor("both ends", () => submitted.finished && dismissed.finished);
    expect(submitted.outputs[0]?.message.payload).toEqual({ answer: "yes" });
    expect(submitted.ends).toEqual([undefined]);
    expect(dismissed.ends[0]?.message).toBe("dismissed by the person");
    node.node.action(submitId, {});
    const refused = new RegExp(`refused an action for ${submitId}: no view is waiting`);
    expect(node.logger.has(refused)).toBe(true);
  });
});

describe("an unexpected exit of a node process", () => {
  it("kill -9: fails the sent input, keeps the awaiting one, and respawns it to the next process after 1 s", async () => {
    const node = raw();
    const [awaitingId, awaiting] = send(node.node, { do: "present" });
    await waitFor("present", () => node.host.presented.length === 1);
    const [, running] = send(node.node, { do: "slow" });
    await waitFor("working", () => node.host.statuses.some((s) => s.text === "working"));
    const first = node.node.pid as number;

    const killedAt = Date.now();
    process.kill(first, "SIGKILL");
    await waitFor("the sent input to fail", () => running.finished);
    expect(running.ends[0]?.message).toBe(
      "raw: node process exited (signal SIGKILL) while handling this event",
    );
    expect(awaiting.finished).toBe(false);
    expect(node.host.statuses).toContainEqual({
      fill: "red",
      shape: "dot",
      text: "process exited (signal SIGKILL)",
    });

    // The next process gets the awaiting input again, and re-presents it.
    await waitFor("the re-presentation", () => node.host.presented.length === 2, 5_000);
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(1_000);
    expect(node.host.presented[1]?.inputId).toBe(awaitingId);
    expect(node.node.pid).not.toBe(first);
    node.node.action(awaitingId, { ok: true });
    await waitFor("the awaiting input to finish", () => awaiting.finished);
    expect(awaiting.ends).toEqual([undefined]);
  });

  it("reads a done written just before the exit before failing anything", async () => {
    const node = raw();
    const [, delivery] = send(node.node, { do: "done-then-crash" });
    await waitFor("the exit", () => node.logger.has(/exited unexpectedly \(code 4\)/));
    expect(delivery.ends).toEqual([undefined]);
  });

  it("queues inputs while no process runs, sends them to the next, and cancels a queued one itself", async () => {
    const node = raw();
    await ready(node);
    process.kill(node.node.pid as number, "SIGKILL");
    await waitFor("the exit", () => node.logger.has(/exited unexpectedly/));
    const [, queued] = send(node.node, { do: "echo", value: 1 });
    const [cancelId, cancelled] = send(node.node, { do: "echo", value: 2 });
    node.node.cancel(cancelId);
    expect(cancelled.ends[0]?.message).toBe("cancelled before it started");
    await waitFor("the queued input", () => queued.finished);
    expect(queued.ends).toEqual([undefined]);
  });

  it("stops respawning when the breaker trips: red status, one notice, and inputs refused", async () => {
    const clock = new FakeClock();
    const node = raw({ clock, config: { exit_at_start: 3 } });
    for (let exit = 1; exit <= 5; exit += 1) {
      await waitFor(`exit ${String(exit)}`, () => node.node.pid === null);
      if (exit < 5) {
        clock.advance(999);
        expect(node.node.pid).toBeNull();
        clock.advance(1);
        expect(node.node.pid).not.toBeNull();
      }
    }
    await waitFor("the stop", () => node.notifier.notices.length === 1);
    expect(node.host.statuses.at(-1)).toEqual({
      fill: "red",
      shape: "dot",
      text: "stopped after 5 exits in 120 s",
    });
    expect(node.notifier.notices[0]?.title).toBe("InnyTypes node raw stopped");
    clock.advance(60_000);
    expect(node.node.pid).toBeNull();
    const [, refused] = send(node.node, { do: "echo" });
    expect(refused.ends[0]?.message).toBe("the node process is stopped after repeated exits");
  });

  it("kills a process that sends no ready within 30 s, and counts it as an exit", async () => {
    const clock = new FakeClock();
    const node = raw({ clock, config: { no_ready: true } });
    await waitFor("the spawn", () => node.logger.has(/spawned pid/));
    clock.advance(29_999);
    expect(node.node.pid).not.toBeNull();
    clock.advance(1);
    await waitFor("the kill", () => node.node.pid === null);
    expect(node.host.statuses).toContainEqual({
      fill: "red",
      shape: "dot",
      text: "did not start in 30 s",
    });
    expect(node.logger.has(/sent no ready within 30 s of start; killing it/)).toBe(true);
    clock.advance(1_000);
    expect(node.node.pid).not.toBeNull();
  });

  it("reports a command that cannot be spawned, and retries it like any exit", async () => {
    const clock = new FakeClock();
    const node = raw({ clock, argv: ["/nonexistent/inny-node"] });
    await waitFor("the failure", () => node.logger.has(/spawn failed: .*ENOENT/));
    await waitFor("the exit", () => node.logger.has(/exited unexpectedly \(failed to start\)/));
    clock.advance(1_000);
    expect(node.logger.lines.filter((line) => /spawned pid/.test(line.text))).toHaveLength(2);
  });
});

describe("closing a node process", () => {
  it("sends close, reads closed, and waits for the exit", async () => {
    const node = raw();
    await ready(node);
    const [, running] = send(node.node, { do: "slow" });
    await waitFor("working", () => node.host.statuses.some((s) => s.text === "working"));
    await node.node.close("redeploy");
    expect(node.logger.has(/close acknowledged/)).toBe(true);
    expect(node.logger.has(/process exited \(code 0\) on close/)).toBe(true);
    expect(running.finished).toBe(false); // the journal owns it now (WI-0018-07)
    expect(node.node.pid).toBeNull();
    await node.node.close("redeploy"); // a second close is a no-op
  });

  it("sends SIGKILL to a process still alive 5 s after close", { timeout: 15_000 }, async () => {
    const node = raw({ config: { ignore_close: true } });
    await ready(node);
    const at = Date.now();
    await node.node.close("redeploy");
    const took = Date.now() - at;
    expect(took).toBeGreaterThanOrEqual(5_000);
    expect(took).toBeLessThan(7_000);
    expect(node.logger.has(/did not exit within 5000 ms of close; sending SIGKILL/)).toBe(true);
    expect(node.logger.has(/process exited \(signal SIGKILL\) on close/)).toBe(true);
  });

  it("refuses an input once closing", async () => {
    const node = raw();
    const closing = node.node.close("redeploy");
    const [, refused] = send(node.node, { do: "echo" });
    expect(refused.ends[0]?.message).toBe("the node process is closing");
    await closing;
  });
});

describe("no orphan: a node's grandchildren end with it", () => {
  async function grandchild(node: RawNode): Promise<number> {
    const [, delivery] = send(node.node, { do: "grandchild" });
    await waitFor("the grandchild", () => delivery.finished);
    const pid = delivery.outputs[0]?.message.payload as number;
    expect(alive(pid)).toBe(true);
    return pid;
  }

  it("on close", async () => {
    const node = raw();
    const pid = await grandchild(node);
    await node.node.close("redeploy");
    await waitFor("the grandchild to go", () => !alive(pid), 3_000);
  });

  it("on a crash (kill -9 of the node)", async () => {
    const node = raw();
    const pid = await grandchild(node);
    process.kill(node.node.pid as number, "SIGKILL");
    await waitFor("the grandchild to go", () => !alive(pid), 3_000);
  });
});
