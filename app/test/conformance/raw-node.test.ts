// Conformance (spec §12.2) of the runtime's codec against the raw fixture node: a Python
// script with only the standard library and no SDK. C1, C2, C4–C9 and C13 here; C3, C10–C12
// need an SDK or the views (WI-0018-26, WI-0018-10), C14 the journal (WI-0018-07).
//
// Every frame the node writes is decoded by the runtime's codec (ajv, §4.5), and every frame
// sent to it is encoded by it, so a frame of the wrong shape in either direction fails here.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  LineReader,
  MAX_FRAME_BYTES,
  type Decoded,
  type NodeFrame,
  type RuntimeFrame,
} from "../../src/adapters/process/codec";
import type { NodeProcess } from "../../src/ports/node-process";
import {
  rawNodeCommand,
  rawNodeEnv,
  RecordingDelivery,
  startRaw,
  waitFor,
} from "../fixtures/raw-node/fixture";

/** The runtime's side of one conversation, frame by frame. */
class Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly decoded: Decoded[] = [];
  readonly stdout: Buffer[] = [];
  stderr = "";
  exit: { code: number | null; signal: string | null; at: number } | null = null;

  constructor() {
    const { argv, cwd } = rawNodeCommand();
    this.child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: rawNodeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = new LineReader();
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdout.push(chunk);
      for (const line of lines.push(chunk)) {
        expect(line.kind).toBe("line");
        if (line.kind === "line") {
          this.decoded.push(decodeFrame(line.bytes));
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("exit", (code, signal) => {
      this.exit = { code, signal, at: Date.now() };
    });
  }

  send(frame: RuntimeFrame): void {
    this.child.stdin.write(encodeFrame(frame));
  }

  start(credentials: Record<string, string> = {}): void {
    this.send({
      t: "start",
      protocol: 2,
      node: { id: "conformance", type: "inny-rawnode-raw", name: "" },
      config: {},
      credentials,
      data_dir: "/nonexistent-data-dir",
    });
  }

  /** The valid frames decoded so far. */
  get frames(): NodeFrame[] {
    return this.decoded.flatMap((decoded) => (decoded.kind === "frame" ? [decoded.frame] : []));
  }

  /** Whatever was not a valid frame: violations, unknown and invalid frames. */
  get rejected(): Decoded[] {
    return this.decoded.filter((decoded) => decoded.kind !== "frame");
  }

  terminal(id: string): NodeFrame[] {
    return this.frames.filter(
      (frame) => (frame.t === "done" || frame.t === "error") && frame.in === id,
    );
  }

  async ready(): Promise<void> {
    await waitFor("ready", () => this.frames.some((frame) => frame.t === "ready"));
  }
}

const sessions: Session[] = [];
const nodes: NodeProcess[] = [];

function session(): Session {
  const opened = new Session();
  sessions.push(opened);
  return opened;
}

afterEach(async () => {
  for (const opened of sessions.splice(0)) {
    if (opened.exit === null) {
      opened.child.kill("SIGKILL");
    }
  }
  await Promise.all(nodes.splice(0).map((node) => node.close("redeploy")));
});

describe("conformance: the raw node (no SDK)", () => {
  it("C1 start / ready: ready follows start within 30 s, and nothing reaches stdout before start", async () => {
    const node = session();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Buffer.concat(node.stdout).length).toBe(0);
    const at = Date.now();
    node.start();
    await node.ready();
    expect(Date.now() - at).toBeLessThan(30_000);
    expect(node.frames[0]).toEqual({ t: "ready" });
  });

  it(
    "C2 framing: 10,000 frames from 8 threads parse one per line",
    { timeout: 30_000 },
    async () => {
      const node = session();
      node.start();
      node.send({
        t: "input",
        id: "burst",
        event: { type: "t.v1", data: { do: "burst", frames: 10_000, threads: 8 } },
      });
      await waitFor("the burst", () => node.terminal("burst").length === 1, 25_000);
      const emits = node.frames.filter((frame) => frame.t === "emit");
      expect(emits).toHaveLength(10_000);
      const seen = new Set(emits.map((frame) => JSON.stringify(frame.data)));
      expect(seen.size).toBe(10_000);
      expect(node.rejected).toEqual([]);
    },
  );

  it("C2 framing: one 1 MiB frame round-trips", async () => {
    const node = session();
    node.start();
    // An input frame of exactly 1 MiB: the value is padded until the encoded frame is.
    const empty = encodeFrame({
      t: "input",
      id: "big",
      event: { type: "t.v1", data: { do: "echo", value: "" } },
    });
    const value = "x".repeat(MAX_FRAME_BYTES - (Buffer.byteLength(empty) - 1));
    const frame: RuntimeFrame = {
      t: "input",
      id: "big",
      event: { type: "t.v1", data: { do: "echo", value } },
    };
    expect(Buffer.byteLength(encodeFrame(frame)) - 1).toBe(MAX_FRAME_BYTES);
    node.send(frame);
    // And one of exactly 1 MiB back from the node.
    node.send({
      t: "input",
      id: "sized",
      event: { type: "t.v1", data: { do: "sized", bytes: MAX_FRAME_BYTES } },
    });
    await waitFor(
      "both",
      () => node.terminal("big").length === 1 && node.terminal("sized").length === 1,
    );
    const echoed = node.frames.find((f) => f.t === "emit" && f.in === "big");
    expect(echoed).toMatchObject({ data: value });
    const sized = node.frames.find((f) => f.t === "emit" && f.in === "sized");
    expect(Buffer.byteLength(JSON.stringify(sized))).toBe(MAX_FRAME_BYTES);
  });

  it("C4 input completion: 100 inputs each get exactly one terminal frame, and emits carry the right in", async () => {
    const node = session();
    node.start();
    for (let n = 0; n < 100; n += 1) {
      node.send({
        t: "input",
        id: `i${String(n)}`,
        event: { type: "t.v1", data: { do: "echo", value: n } },
      });
    }
    await waitFor("100 terminals", () => node.frames.filter((f) => f.t === "done").length === 100);
    expect(node.rejected).toEqual([]);
    for (let n = 0; n < 100; n += 1) {
      const id = `i${String(n)}`;
      expect(node.terminal(id)).toEqual([{ t: "done", in: id }]);
      expect(node.frames.filter((f) => f.t === "emit" && f.in === id)).toEqual([
        { t: "emit", port: "out", data: n, in: id },
      ]);
    }
  });

  it("C5 undeclared port: the runtime refuses and logs", async () => {
    const raw = startRaw();
    nodes.push(raw.node);
    const delivery = new RecordingDelivery();
    raw.node.input({ payload: { do: "undeclared" }, topic: "t.v1" }, delivery);
    await waitFor("done", () => delivery.finished);
    expect(delivery.outputs).toEqual([]);
    expect(raw.host.sent).toEqual([]);
    expect(raw.logger.has(/refused an emit on undeclared port "nope"/)).toBe(true);
  });

  it("C6 cancel: a running input ends with error cancelled …, a queued one cancelled before it started", async () => {
    const node = session();
    node.start();
    node.send({ t: "input", id: "running", event: { type: "t.v1", data: { do: "slow" } } });
    node.send({ t: "input", id: "queued", event: { type: "t.v1", data: { do: "echo" } } });
    await waitFor("working", () => node.frames.some((f) => f.t === "status"));
    node.send({ t: "cancel", in: "queued" });
    node.send({ t: "cancel", in: "running" });
    node.send({ t: "cancel", in: "never-heard-of-it" });
    await waitFor(
      "both",
      () => node.terminal("running").length + node.terminal("queued").length === 2,
    );
    const running = node.terminal("running")[0];
    expect(running?.t).toBe("error");
    expect(running?.t === "error" ? running.message : "").toMatch(/^cancelled/);
    expect(node.terminal("queued")).toEqual([
      { t: "error", in: "queued", message: "cancelled before it started" },
    ]);
  });

  it("C7 close: closed is sent and the process exits 0 within 5 s while an input is running", async () => {
    const node = session();
    node.start();
    node.send({ t: "input", id: "running", event: { type: "t.v1", data: { do: "slow" } } });
    await waitFor("working", () => node.frames.some((f) => f.t === "status"));
    const at = Date.now();
    node.send({ t: "close" });
    await waitFor("the exit", () => node.exit !== null, 5_000);
    expect(node.frames.at(-1)).toEqual({ t: "closed" });
    expect(node.exit?.code).toBe(0);
    expect((node.exit?.at ?? Infinity) - at).toBeLessThan(5_000);
  });

  it("C8 EOF: closing stdin makes the process exit within 1 s, without a traceback", async () => {
    const node = session();
    node.start();
    await node.ready();
    const at = Date.now();
    node.child.stdin.end();
    await waitFor("the exit", () => node.exit !== null, 1_000);
    expect((node.exit?.at ?? Infinity) - at).toBeLessThan(1_000);
    expect(node.exit?.code).toBe(0);
    expect(node.stderr).not.toMatch(/Traceback/);
  });

  it("C9 unknown frame: a frame {t: future} is ignored", async () => {
    const node = session();
    node.start();
    // Written raw: the codec refuses to encode a frame type the spec does not have.
    node.child.stdin.write('{"t":"future","what":1}\n');
    node.send({ t: "input", id: "after", event: { type: "t.v1", data: { do: "echo", value: 1 } } });
    await waitFor("the input after it", () => node.terminal("after").length === 1);
    expect(node.exit).toBeNull();
    expect(node.stderr).not.toMatch(/Traceback/);
  });

  it("C13 credentials: a credential value never appears on stdout or stderr", async () => {
    const canary = "inny-canary-5f2c9a71e0d34b8c";
    const node = session();
    node.start({ token: canary });
    node.send({ t: "input", id: "use", event: { type: "t.v1", data: { do: "credential" } } });
    node.send({ t: "input", id: "noise", event: { type: "t.v1", data: { do: "noise" } } });
    await waitFor("both", () => node.terminal("use").length + node.terminal("noise").length === 2);
    node.send({ t: "close" });
    await waitFor("the exit", () => node.exit !== null);
    expect(node.frames.find((f) => f.t === "emit" && f.in === "use")).toMatchObject({
      data: canary.length,
    });
    expect(node.stderr).toMatch(/used a credential of 28 characters/);
    expect(Buffer.concat(node.stdout).includes(canary)).toBe(false);
    expect(node.stderr.includes(canary)).toBe(false);
    // The one line that is not a frame is the fixture's deliberate stray stdout.
    expect(node.rejected).toEqual([
      { kind: "violation", reason: "not JSON", text: "this is not a frame" },
    ]);
  });
});
