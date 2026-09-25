// A child's side of the channel (spec 10.2) and its ppid watchdog (spec 6.6).
import { describe, expect, it } from "vitest";
import { watchParent, WATCHDOG_INTERVAL_MS } from "../../src/application/parent-watchdog";
import { EXIT_FLUSH_MS, serveShell } from "../../src/application/serve-shell";
import type { ChildMessage } from "../../src/domain/channel/messages";
import type { ProcessHost, ShellLink } from "../../src/ports/shell-link";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

class FakeHost implements ProcessHost {
  readonly pid = 4242;
  ppid = 100;
  readonly exits: number[] = [];
  parentPid(): number {
    return this.ppid;
  }
  exit(code: number): void {
    this.exits.push(code);
  }
}

class FakeLink implements ShellLink {
  readonly sent: ChildMessage[] = [];
  #listener: (raw: unknown) => void = () => undefined;
  post(message: ChildMessage): void {
    this.sent.push(message);
  }
  onMessage(listener: (raw: unknown) => void): void {
    this.#listener = listener;
  }
  receive(raw: unknown): void {
    this.#listener(raw);
  }
}

function child() {
  const link = new FakeLink();
  const host = new FakeHost();
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  serveShell({ child: "services", link, host, clock, logger });
  return { link, host, clock, logger };
}

const CONFIG = { generation: 4, port: null, userDir: "/u", restart: null, forkedAt: 0 };

describe("serveShell", () => {
  it("answers init with ready, its pid, the generation and the port it was given", () => {
    const { link } = child();
    link.receive({ v: 1, t: "init", config: { ...CONFIG, port: 18_900 } });
    expect(link.sent).toEqual([{ v: 1, t: "ready", pid: 4242, generation: 4, port: 18_900 }]);
  });

  it("answers stop with stopped, then exits 0 once it has left", () => {
    const { link, host, clock } = child();
    link.receive({ v: 1, t: "stop", reason: "quit" });
    expect(link.sent).toEqual([{ v: 1, t: "stopped", reason: "quit" }]);
    expect(host.exits).toEqual([]);
    clock.advance(EXIT_FLUSH_MS);
    expect(host.exits).toEqual([0]);
  });

  it("stops once, however often it is told", () => {
    const { link, host, clock } = child();
    link.receive({ v: 1, t: "stop", reason: "types" });
    link.receive({ v: 1, t: "stop", reason: "quit" });
    clock.advance(EXIT_FLUSH_MS);
    expect(link.sent).toHaveLength(1);
    expect(host.exits).toEqual([0]);
  });

  it("answers every call with a reply, so no call waits for its timeout", () => {
    const { link } = child();
    link.receive({ v: 1, t: "call", rid: "r9", op: "view.get", args: { id: "x" } });
    expect(link.sent).toEqual([
      {
        v: 1,
        t: "reply",
        rid: "r9",
        result: { ok: false, error: "the InnyTypes services does not serve view.get yet" },
      },
    ]);
  });

  it("ignores and logs what the channel does not know", () => {
    const { link, logger } = child();
    link.receive({ v: 9, t: "init", config: CONFIG });
    link.receive(null);
    expect(link.sent).toEqual([]);
    expect(logger.lines).toHaveLength(2);
  });
});

describe("watchParent", () => {
  it("exits when the parent pid changes, and not before", () => {
    const host = new FakeHost();
    const clock = new FakeClock();
    const logger = new RecordingLogger();
    watchParent(host, clock, logger);

    clock.advance(10 * WATCHDOG_INTERVAL_MS);
    expect(host.exits).toEqual([]);
    host.ppid = 1; // the shell died; launchd adopted the child
    clock.advance(WATCHDOG_INTERVAL_MS);
    expect(host.exits).toEqual([0]);
    expect(logger.lines).toEqual(["WARN parent 100 is gone (ppid now 1); exiting"]);
    expect(clock.pending).toBe(0);
  });

  it("checks every second", () => {
    expect(WATCHDOG_INTERVAL_MS).toBe(1_000);
    const host = new FakeHost();
    const clock = new FakeClock();
    watchParent(host, clock, new RecordingLogger());
    host.ppid = 1;
    clock.advance(999);
    expect(host.exits).toEqual([]);
    clock.advance(1);
    expect(host.exits).toEqual([0]);
  });

  it("can be stopped", () => {
    const host = new FakeHost();
    const clock = new FakeClock();
    const stop = watchParent(host, clock, new RecordingLogger());
    clock.advance(WATCHDOG_INTERVAL_MS);
    stop();
    host.ppid = 1;
    clock.advance(10 * WATCHDOG_INTERVAL_MS);
    expect(host.exits).toEqual([]);
  });
});
