// The once-only notice for a refused Anytype key (application/anytype-refusals.ts, plan 0018
// §4.2): raised on the first input to fail with PAIR_AGAIN_MESSAGE, not again until an Anytype
// input succeeds, and only for the first-party Anytype package's instances.

import { describe, expect, it } from "vitest";

import { noticeAnytypeRefusals, PAIR_AGAIN_NOTICE } from "../../src/application/anytype-refusals";
import { PAIR_AGAIN_MESSAGE } from "../../src/domain/anytype/errors";
import type {
  InputDelivery,
  NodeProcess,
  NodeProcessLauncher,
  NodeProcessSpec,
} from "../../src/ports/node-process";
import { RecordingNotifier } from "../fakes/children";

/** A process that records what it was asked and hands each input's delivery back. */
class FakeProcess implements NodeProcess {
  readonly pid = 42;
  readonly calls: string[] = [];
  readonly deliveries: InputDelivery[] = [];

  input(_message: unknown, delivery: InputDelivery): string {
    this.deliveries.push(delivery);
    return `in${String(this.deliveries.length)}`;
  }
  cancel(inputId: string): void {
    this.calls.push(`cancel ${inputId}`);
  }
  action(inputId: string): boolean {
    this.calls.push(`action ${inputId}`);
    return true;
  }
  trigger(action: string): boolean {
    this.calls.push(`trigger ${action}`);
    return false;
  }
  fire(): void {
    this.calls.push("fire");
  }
  close(reason: string): Promise<void> {
    this.calls.push(`close ${reason}`);
    return Promise.resolve();
  }
  replay(): number {
    this.calls.push("replay");
    return 3;
  }
  queue(): ReturnType<NodeProcess["queue"]> {
    return { outstanding: 0 } as unknown as ReturnType<NodeProcess["queue"]>;
  }
}

function spec(pkg: string): NodeProcessSpec {
  return { identity: { package: pkg } } as unknown as NodeProcessSpec;
}

function setUp() {
  const processes: FakeProcess[] = [];
  const inner: NodeProcessLauncher = {
    start: () => {
      const started = new FakeProcess();
      processes.push(started);
      return started;
    },
  };
  const notifier = new RecordingNotifier();
  const launcher = noticeAnytypeRefusals(inner, notifier);
  return { processes, notifier, launcher };
}

/** One input through `node`, ended with `error` (or done). What reached Node-RED comes back. */
function end(node: NodeProcess, fake: FakeProcess, error?: Error): (Error | undefined)[] {
  const ends: (Error | undefined)[] = [];
  node.input({ payload: {} }, { send: () => undefined, done: (e) => ends.push(e) });
  fake.deliveries.at(-1)?.done(error);
  return ends;
}

describe("the pair-again notice", () => {
  it("is raised once for refusals across instances, and again only after an Anytype input succeeded", () => {
    const { processes, notifier, launcher } = setUp();
    const first = launcher.start(spec("anytype"), {} as never);
    const second = launcher.start(spec("anytype"), {} as never);
    const [one, two] = processes as [FakeProcess, FakeProcess];
    const refused = new Error(PAIR_AGAIN_MESSAGE);

    // Every end still reaches Node-RED as it was.
    expect(end(first, one, refused)).toEqual([refused]);
    end(first, one, refused);
    end(second, two, refused);
    expect(notifier.notices).toEqual([PAIR_AGAIN_NOTICE]);

    // Another failure is not a refusal; a success means the key works again.
    end(second, two, new Error("Anytype's local API did not answer"));
    expect(notifier.notices).toHaveLength(1);
    expect(end(first, one)).toEqual([undefined]);
    // The shell's board is told the condition went away, once, so the next refusal is news.
    end(first, one);
    expect(notifier.cleared).toEqual(["anytype-key-refused Anytype"]);
    end(second, two, refused);
    expect(notifier.notices).toEqual([PAIR_AGAIN_NOTICE, PAIR_AGAIN_NOTICE]);
  });

  it("does not touch other packages' instances", () => {
    const { processes, notifier, launcher } = setUp();
    const other = launcher.start(spec("monty"), {} as never);
    expect(other).toBe(processes[0]);
    end(other, processes[0] as FakeProcess, new Error(PAIR_AGAIN_MESSAGE));
    expect(notifier.notices).toEqual([]);
  });

  it("leaves everything else of the process as it is", async () => {
    const { processes, launcher } = setUp();
    const node = launcher.start(spec("anytype"), {} as never);
    const fake = processes[0] as FakeProcess;
    expect(node.pid).toBe(42);
    node.cancel("i1");
    expect(node.action("i1", {})).toBe(true);
    expect(node.trigger("again", { id: "s", state: null }, {})).toBe(false);
    node.fire({});
    expect(node.replay(() => undefined)).toBe(3);
    expect(node.queue()).toEqual(fake.queue());
    await node.close("redeploy");
    expect(fake.calls).toEqual([
      "cancel i1",
      "action i1",
      "trigger again",
      "fire",
      "replay",
      "close redeploy",
    ]);
    // Sends pass straight through.
    const sent: unknown[] = [];
    node.input({ payload: {} }, { send: (o) => sent.push(o), done: () => undefined });
    fake.deliveries.at(-1)?.send({ index: 0, port: "created", message: {} as never });
    expect(sent).toHaveLength(1);
  });
});
