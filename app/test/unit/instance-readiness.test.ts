// The runtime's answer to `package.ready` (application/instance-readiness.ts; WI-0018-17): which
// deployed instances of some packages' types have a process that sent `ready`. A package update
// waits on it for 30 s before it swaps the old version back.
import { describe, expect, it } from "vitest";

import { enabledNodes, InstanceReadiness } from "../../src/application/instance-readiness";
import type {
  NodeProcess,
  NodeProcessLauncher,
  NodeProcessSpec,
} from "../../src/ports/node-process";

class FakeProcess implements NodeProcess {
  readonly calls: string[] = [];
  pid: number | null = 7;
  ready = false;
  #closing: (() => void) | null = null;
  input(): string | null {
    this.calls.push("input");
    return "in-1";
  }
  cancel(): void {
    this.calls.push("cancel");
  }
  action(): boolean {
    this.calls.push("action");
    return true;
  }
  trigger(): boolean {
    this.calls.push("trigger");
    return true;
  }
  fire(): void {
    this.calls.push("fire");
  }
  close(): Promise<void> {
    this.calls.push("close");
    return new Promise((resolve) => {
      this.#closing = resolve;
    });
  }
  finishClose(): void {
    this.#closing?.();
  }
  replay(): number {
    this.calls.push("replay");
    return 2;
  }
  queue() {
    this.calls.push("queue");
    return { outstanding: 0, held: 0, refused: 0, bound: 100 } as unknown as ReturnType<
      NodeProcess["queue"]
    >;
  }
}

function spec(id: string, pkg: string): NodeProcessSpec {
  return {
    identity: {
      id,
      flowId: "flow-1",
      package: pkg,
      typeId: "ping",
      type: `inny-${pkg}-ping`,
      name: "",
      kind: "node",
    },
    argv: ["node"],
    cwd: "/",
    env: {},
    config: {},
    credentials: {},
    dataDir: "/tmp",
    ports: [],
  };
}

function launched() {
  const started: FakeProcess[] = [];
  const inner: NodeProcessLauncher = {
    start: () => {
      const process = new FakeProcess();
      started.push(process);
      return process;
    },
  };
  const readiness = new InstanceReadiness();
  const launcher = readiness.wrap(inner);
  const host = {} as Parameters<NodeProcessLauncher["start"]>[1];
  return {
    readiness,
    started,
    start: (id: string, pkg: string) => launcher.start(spec(id, pkg), host),
  };
}

describe("which instances are ready", () => {
  it("answers the deployed instances of the packages asked about, and those whose process sent ready", () => {
    const { readiness, started, start } = launched();
    start("b", "pinger");
    start("a", "pinger");
    start("c", "other");
    const [b, a, c] = started;
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error("three processes were started");
    }
    a.ready = true;
    c.ready = true;
    const deployed = [
      { id: "a", package: "pinger" },
      { id: "b", package: "pinger" },
      { id: "c", package: "other" },
      { id: "never-constructed", package: "pinger" },
      { id: "inject", package: undefined },
    ];
    expect(readiness.answer({ packages: ["pinger"] }, deployed)).toEqual({
      ok: true,
      value: { deployed: ["a", "b", "never-constructed"], ready: ["a"] },
    });
  });

  it("forgets a process once it is closed, but not the next one started under the same id", async () => {
    const { readiness, started, start } = launched();
    const first = start("a", "pinger");
    const [process] = started;
    if (process === undefined) {
      throw new Error("a process was started");
    }
    process.ready = true;
    // A redeploy: the new instance starts before the old one has finished closing.
    const closing = first.close("redeploy");
    start("a", "pinger");
    process.finishClose();
    await closing;
    expect(readiness.answer({ packages: ["pinger"] }, [{ id: "a", package: "pinger" }])).toEqual({
      ok: true,
      value: { deployed: ["a"], ready: [] },
    });
    const second = started[1];
    if (second === undefined) {
      throw new Error("a second process was started");
    }
    second.ready = true;
    const last = start("z", "pinger");
    const closed = last.close("removed");
    started[2]?.finishClose();
    await closed;
    expect(
      readiness.answer({ packages: ["pinger"] }, [
        { id: "a", package: "pinger" },
        { id: "z", package: "pinger" },
      ]),
    ).toEqual({ ok: true, value: { deployed: ["a", "z"], ready: ["a"] } });
  });

  it("passes every call to the process it wraps", () => {
    const { started, start } = launched();
    const wrapped = start("a", "pinger");
    const [process] = started;
    expect(wrapped.pid).toBe(7);
    expect(wrapped.ready).toBe(false);
    expect(wrapped.input({} as never, {} as never)).toBe("in-1");
    wrapped.cancel("in-1");
    expect(wrapped.action("in-1", {})).toBe(true);
    expect(wrapped.trigger("again", { id: "s", state: null }, {})).toBe(true);
    wrapped.fire({});
    expect(wrapped.replay(() => undefined)).toBe(2);
    wrapped.queue();
    expect(process?.calls).toEqual([
      "input",
      "cancel",
      "action",
      "trigger",
      "fire",
      "replay",
      "queue",
    ]);
  });

  it("refuses a call that does not name its packages", () => {
    const { readiness } = launched();
    for (const args of [null, {}, { packages: "pinger" }, { packages: [1] }]) {
      expect(readiness.answer(args, [])).toEqual({
        ok: false,
        error: "package.ready takes {packages: [names]}",
      });
    }
  });
});

describe("the nodes Node-RED runs", () => {
  it("leave out a disabled node and every node on a disabled tab, which never send ready", () => {
    expect(
      enabledNodes([
        { id: "on", type: "tab" },
        { id: "off", type: "tab", disabled: true },
        { id: "a", type: "inny-pinger-ping", z: "on" },
        { id: "b", type: "inny-pinger-ping", z: "on", d: true },
        { id: "c", type: "inny-pinger-ping", z: "off" },
        { id: "d", type: "inny-pinger-ping" },
        { id: 7, type: "odd" },
        null,
        ["not", "a", "node"],
      ]),
    ).toEqual([
      { id: "on", type: "tab" },
      { id: "off", type: "tab" },
      { id: "a", type: "inny-pinger-ping" },
      { id: "d", type: "inny-pinger-ping" },
    ]);
  });
});
