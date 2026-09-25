// The adapters under the supervisor and the children: utilityProcess, the parent port, the
// process host, the free loopback port, the clock and the log lines.
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import type { ForkOptions, ParentPort, UtilityProcess } from "electron";
import { describe, expect, it, vi } from "vitest";
import { processHostOver, shellLinkOver } from "../../src/adapters/electron/parent-port";
import { UtilityProcessLauncher } from "../../src/adapters/electron/utility-process-launcher";
import { LOOPBACK, pickFreeLoopbackPort } from "../../src/adapters/net/free-port";
import { systemClock } from "../../src/adapters/system/clock";
import { consoleLogger, logNotifier } from "../../src/adapters/system/console-logger";

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = undefined;
  readonly posted: unknown[] = [];
  kills = 0;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  kill(): boolean {
    this.kills += 1;
    return true;
  }
}

describe("UtilityProcessLauncher", () => {
  function launch() {
    const forks: { modulePath: string; args: string[]; options: ForkOptions }[] = [];
    const process = new FakeUtilityProcess();
    const launcher = new UtilityProcessLauncher((modulePath, args, options) => {
      forks.push({ modulePath, args, options });
      return process as unknown as UtilityProcess;
    });
    const handle = launcher.fork({
      modulePath: "/dist/runtime/main.cjs",
      serviceName: "InnyTypes runtime",
      env: { HOME: "/h" },
    });
    return { forks, process, handle };
  }

  it("forks with exactly the given env, never the shell's", () => {
    const { forks } = launch();
    expect(forks).toEqual([
      {
        modulePath: "/dist/runtime/main.cjs",
        args: [],
        options: { env: { HOME: "/h" }, serviceName: "InnyTypes runtime", stdio: "inherit" },
      },
    ]);
    expect(forks[0]?.options.env).not.toHaveProperty("PATH");
  });

  it("carries messages, exits and kills between the port and the process", () => {
    const { process, handle } = launch();
    expect(handle.pid).toBeNull();
    process.pid = 77;
    expect(handle.pid).toBe(77);

    handle.post({ v: 1, t: "stop", reason: "quit" });
    expect(process.posted).toEqual([{ v: 1, t: "stop", reason: "quit" }]);

    const messages: unknown[] = [];
    const exits: number[] = [];
    handle.onMessage((raw) => messages.push(raw));
    handle.onExit((code) => exits.push(code));
    process.emit("message", { v: 1, t: "failed", error: "x" });
    process.emit("exit", 9);
    expect(messages).toEqual([{ v: 1, t: "failed", error: "x" }]);
    expect(exits).toEqual([9]);

    handle.kill();
    expect(process.kills).toBe(1);
  });
});

describe("the child's ports", () => {
  it("shellLinkOver posts to the parent port and hands on each message's data", () => {
    const port = new EventEmitter() as EventEmitter & { posted: unknown[] };
    port.posted = [];
    const parentPort = Object.assign(port, {
      postMessage: (message: unknown) => port.posted.push(message),
    }) as unknown as ParentPort & { posted: unknown[] };

    const link = shellLinkOver(parentPort);
    link.post({ v: 1, t: "stopped", reason: "quit" });
    const received: unknown[] = [];
    link.onMessage((raw) => received.push(raw));
    port.emit("message", { data: { v: 1, t: "stop", reason: "quit" }, ports: [] });

    expect(parentPort.posted).toEqual([{ v: 1, t: "stopped", reason: "quit" }]);
    expect(received).toEqual([{ v: 1, t: "stop", reason: "quit" }]);
  });

  it("processHostOver reads the parent pid live and exits through the process", () => {
    const exit = vi.fn();
    const proc = { pid: 5, ppid: 1, exit: exit as unknown as (code?: number) => never };
    const host = processHostOver(proc);
    expect(host.pid).toBe(5);
    expect(host.parentPid()).toBe(1);
    proc.ppid = 2;
    expect(host.parentPid()).toBe(2);
    host.exit(3);
    expect(exit).toHaveBeenCalledWith(3);
  });
});

describe("pickFreeLoopbackPort", () => {
  it("gives a loopback port that is free to bind", async () => {
    const port = await pickFreeLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, LOOPBACK, resolve);
    });
    await new Promise((resolve) => server.close(resolve));
  });
});

describe("systemClock", () => {
  it("runs a callback after its delay, and not once cancelled", async () => {
    const ran: string[] = [];
    systemClock.after(5, () => ran.push("kept"));
    const cancel = systemClock.after(5, () => ran.push("cancelled"));
    cancel();
    const start = systemClock.now();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ran).toEqual(["kept"]);
    expect(systemClock.now()).toBeGreaterThanOrEqual(start);
  });
});

describe("consoleLogger and logNotifier", () => {
  it("write one line per message, naming the process, and a notice as an error line", () => {
    const out: string[] = [];
    const err: string[] = [];
    const logger = consoleLogger("shell", 12, {
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    logger.info("a");
    logger.warn("b");
    logNotifier(logger).raise({ title: "T", body: "B" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/ INFO {2}\[shell 12\] a$/);
    expect(err[0]).toMatch(/ WARN {2}\[shell 12\] b$/);
    expect(err[1]).toMatch(/ ERROR \[shell 12\] notice: T: B$/);
  });
});
