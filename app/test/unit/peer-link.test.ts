// The runtime ↔ services direct channel (plan 0018 §2.2; WI-0018-18): the shell links every
// new generation, the services process sends the key over each end, the runtime's redactor
// learns it. Also the call path the services process answers AppApi's Anytype members on.
import { describe, expect, it } from "vitest";
import { peerLinkOver, shellLinkOver } from "../../src/adapters/electron/parent-port";
import {
  KeyPublisher,
  linkPeers,
  receiveKeys,
  type PeerChild,
} from "../../src/application/peer-link";
import { serveShell } from "../../src/application/serve-shell";
import { sourceLog } from "../../src/application/source-log";
import {
  parseShellMessage,
  type ChildMessage,
  type OpResult,
} from "../../src/domain/channel/messages";
import { parsePeerMessage } from "../../src/domain/channel/peer-messages";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import type { ChildStatus } from "../../src/domain/supervision/child-state";
import type { PeerLink } from "../../src/ports/shell-link";
import { obedient, RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";
import { supervised } from "../fakes/supervised";
import { flush } from "../fakes/anytype";

const KEY = "peer-key-0123456789";

class FakeChild implements PeerChild {
  readonly ends: object[] = [];
  #status: ChildStatus;
  readonly #listeners: ((status: ChildStatus) => void)[] = [];
  constructor(child: "runtime" | "services") {
    this.#status = { child, state: "starting", generation: 1, pid: null, port: null, error: null };
  }
  status(): ChildStatus {
    return this.#status;
  }
  onStatus(listener: (status: ChildStatus) => void): void {
    this.#listeners.push(listener);
  }
  sendPeer(end: object): boolean {
    if (this.#status.state !== "running") {
      return false;
    }
    this.ends.push(end);
    return true;
  }
  set(change: Partial<ChildStatus>): void {
    this.#status = { ...this.#status, ...change };
    for (const listener of this.#listeners) {
      listener(this.#status);
    }
  }
}

class MemoryPeer implements PeerLink {
  readonly sent: unknown[] = [];
  closed = false;
  listener: (raw: unknown) => void = () => undefined;
  other: MemoryPeer | null = null;
  post(message: unknown): void {
    this.sent.push(message);
    this.other?.listener(message);
  }
  onMessage(listener: (raw: unknown) => void): void {
    this.listener = listener;
  }
  close(): void {
    this.closed = true;
  }
}

function pair(): [MemoryPeer, MemoryPeer] {
  const a = new MemoryPeer();
  const b = new MemoryPeer();
  a.other = b;
  b.other = a;
  return [a, b];
}

describe("linkPeers (the shell)", () => {
  it("links once both run, and again for every new generation of either, never twice", () => {
    const runtime = new FakeChild("runtime");
    const services = new FakeChild("services");
    let channels = 0;
    const logger = new RecordingLogger();
    linkPeers(
      runtime,
      services,
      () => [
        { n: ++channels, end: 1 },
        { n: channels, end: 2 },
      ],
      logger,
    );
    runtime.set({ state: "running" });
    expect(channels).toBe(0); // the services process is not up yet
    services.set({ state: "running" });
    expect(runtime.ends).toEqual([{ n: 1, end: 1 }]);
    expect(services.ends).toEqual([{ n: 1, end: 2 }]);
    services.set({ pid: 42 }); // a status change that is no new generation
    expect(channels).toBe(1);

    // A runtime restarted for a type change: a fresh channel, and the services process untouched.
    runtime.set({ state: "restarting-planned" });
    runtime.set({ state: "running", generation: 2 });
    expect(runtime.ends).toHaveLength(2);
    expect(services.ends).toEqual([
      { n: 1, end: 2 },
      { n: 2, end: 2 },
    ]);
    expect(logger.lines.at(-1)).toContain("linked runtime generation 2 and services generation 1");
  });
});

describe("the key over the channel", () => {
  it("is sent over every end the services process is handed, and after a new pairing", () => {
    const keys = new KeyPublisher();
    const [first] = pair();
    keys.connect(first);
    expect(first.sent).toEqual([]); // no key yet
    keys.publish(KEY);
    expect(first.sent).toEqual([{ v: 1, t: "anytype-key", key: KEY }]);
    const [second] = pair();
    keys.connect(second);
    expect(first.closed).toBe(true);
    expect(second.sent).toEqual([{ v: 1, t: "anytype-key", key: KEY }]);
    keys.publish("new-key-0123456789");
    expect(second.sent).toHaveLength(2);
  });

  it("is registered with the runtime's redactor, which then redacts it from every line", () => {
    const registry = new SecretRegistry();
    const written: string[] = [];
    const runtimeLog = sourceLog({
      name: "innytypes.runtime",
      pid: 1,
      write: (text) => written.push(text),
      now: () => 0,
      registry,
    });
    const [servicesEnd, runtimeEnd] = pair();
    receiveKeys(runtimeEnd, runtimeLog, runtimeLog);
    const keys = new KeyPublisher();
    keys.publish(KEY);
    keys.connect(servicesEnd);
    runtimeLog.info(`a node printed ${KEY}`);
    const all = written.join("");
    expect(all).toContain(`a node printed ${REDACTED}`);
    // The shell's one writer is told too, on the same pipe, before any line that carries it.
    expect(all).toContain('"protect"');
    expect(written.filter((line) => line.includes(`printed ${KEY}`))).toEqual([]);
  });

  it("is refused in any shape but its own, and a stray message is said, not acted on", () => {
    expect(parsePeerMessage({ v: 1, t: "anytype-key", key: KEY })).toEqual({
      v: 1,
      t: "anytype-key",
      key: KEY,
    });
    for (const raw of [
      null,
      [],
      "x",
      { v: 2, t: "anytype-key", key: KEY },
      { v: 1, t: "anytype-key", key: "" },
      { v: 1, t: "other" },
    ]) {
      expect(parsePeerMessage(raw)).toBeNull();
    }
    const protectedKeys: string[] = [];
    const logger = new RecordingLogger();
    const [left, right] = pair();
    receiveKeys(right, { protect: (s) => protectedKeys.push(s) }, logger);
    left.post({ v: 1, t: "anytype-key", key: "" });
    expect(protectedKeys).toEqual([]);
    expect(logger.lines.join("\n")).toContain("does not know");
  });
});

describe("the adapters over Electron's ports", () => {
  /** An Electron port as the child sees one: `on("message")` delivers `{data, ports}`. */
  function electronPort() {
    const listeners: ((event: { data: unknown; ports: unknown[] }) => void)[] = [];
    const posted: unknown[] = [];
    let started = false;
    let closed = false;
    return {
      port: {
        on: (_event: "message", listener: (event: { data: unknown; ports: unknown[] }) => void) => {
          listeners.push(listener);
        },
        postMessage: (message: unknown) => posted.push(message),
        start: () => (started = true),
        close: () => (closed = true),
      },
      deliver: (data: unknown, ports: unknown[] = []) => {
        for (const listener of listeners) {
          listener({ data, ports });
        }
      },
      posted,
      state: () => ({ started, closed }),
    };
  }

  it("hands a message carrying a channel end to onPeer, and every other message to onMessage", () => {
    const parent = electronPort();
    const link = shellLinkOver(parent.port as never);
    const messages: unknown[] = [];
    const peers: PeerLink[] = [];
    link.onMessage((raw) => messages.push(raw));
    link.onPeer((peer) => peers.push(peer));
    parent.deliver({ v: 1, t: "stop", reason: "quit" });
    const end = electronPort();
    parent.deliver({ v: 1, t: "peer" }, [end.port]);
    expect(messages).toEqual([{ v: 1, t: "stop", reason: "quit" }]);
    expect(peers).toHaveLength(1);
    expect(end.state().started).toBe(true);

    const received: unknown[] = [];
    peers[0]?.onMessage((raw) => received.push(raw));
    end.deliver({ v: 1, t: "anytype-key", key: KEY });
    peers[0]?.post({ v: 1, t: "anytype-key", key: KEY });
    peers[0]?.close();
    expect(received).toEqual([{ v: 1, t: "anytype-key", key: KEY }]);
    expect(end.posted).toHaveLength(1);
    expect(end.state().closed).toBe(true);
    link.post({ v: 1, t: "stopped", reason: "quit" });
    expect(parent.posted).toEqual([{ v: 1, t: "stopped", reason: "quit" }]);
  });

  it("wraps a bare channel end the same way", () => {
    const end = electronPort();
    const peer = peerLinkOver(end.port as never);
    peer.post({ v: 1, t: "anytype-key", key: KEY });
    expect(end.posted).toEqual([{ v: 1, t: "anytype-key", key: KEY }]);
  });

  it("parses the peer message on the shell channel as its own kind", () => {
    expect(parseShellMessage({ v: 1, t: "peer" })).toEqual({ v: 1, t: "peer" });
  });
});

describe("Supervisor.sendPeer", () => {
  it("transfers a channel end to a running child only", () => {
    const { supervisor, launcher, clock } = supervised(obedient);
    const end = { port: 1 };
    expect(supervisor.sendPeer(end)).toBe(false);
    supervisor.start();
    clock.advance(1);
    expect(supervisor.sendPeer(end)).toBe(true);
    expect(launcher.current.posted.at(-1)).toEqual({ v: 1, t: "peer" });
  });
});

describe("serveShell's calls", () => {
  function served(onCall?: (op: string, args: unknown) => Promise<OpResult>) {
    const sent: ChildMessage[] = [];
    let listener: (raw: unknown) => void = () => undefined;
    serveShell({
      child: "services",
      link: {
        post: (m) => sent.push(m),
        onMessage: (l) => (listener = l),
        onPeer: () => undefined,
      },
      host: { pid: 7, parentPid: () => 1, exit: () => undefined },
      clock: new FakeClock(),
      logger: new RecordingLogger(),
      ...(onCall === undefined ? {} : { onCall }),
    });
    return {
      sent,
      receive: (raw: unknown) => {
        listener(raw);
      },
    };
  }

  it("answers a call with what onCall resolved to, and a rejection with its sentence", async () => {
    const ok = served(() => Promise.resolve({ ok: true, value: { state: "ready" } }));
    ok.receive({ v: 1, t: "call", rid: "r1", op: "anytype.status", args: null });
    await flush();
    expect(ok.sent).toEqual([
      { v: 1, t: "reply", rid: "r1", result: { ok: true, value: { state: "ready" } } },
    ]);

    const failing = served(() => Promise.reject(new Error("boom")));
    failing.receive({ v: 1, t: "call", rid: "r2", op: "anytype.pair.start", args: null });
    await flush();
    expect(failing.sent).toEqual([
      { v: 1, t: "reply", rid: "r2", result: { ok: false, error: "Error: boom" } },
    ]);
  });

  it("ignores the peer message itself: its channel end went to onPeer", () => {
    const { sent, receive } = served();
    receive({ v: 1, t: "peer" });
    expect(sent).toEqual([]);
  });
});
