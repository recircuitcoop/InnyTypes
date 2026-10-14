// Conformance (spec §12.2) of the first-party folder source (packages/folder, WI-0022-25), the
// bundle as it ships: the cases of the reference suite (sdk-node.test.ts) a source with no
// inputs can be held to. Every frame either way goes through the runtime's own codec (ajv,
// spec 4.5), so a frame of the wrong shape fails here exactly as it would in the app.
//
// C2 (concurrent emitters), C4 to C6 (inputs, ports, cancel), C10/C11 (views), C12 (fire) and
// C13 (credentials) are about inputs, views and secrets, which this type has none of; its
// emits are checked instead: each is a valid frame on its one declared port, with no `in`.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  LineReader,
  type Decoded,
  type NodeFrame,
  type RuntimeFrame,
} from "../../src/adapters/process/codec";
import { buildFolderPackage, type BuiltFolderPackage } from "../fixtures/folder-package";
import { rawNodeEnv, waitFor } from "../fixtures/raw-node/fixture";

let built: BuiltFolderPackage;
let scratch: string;

beforeAll(async () => {
  built = await buildFolderPackage();
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-folder-conf-")));
}, 60_000);

afterAll(() => {
  built.remove();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** The runtime's side of one conversation with the folder source. */
class Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly decoded: Decoded[] = [];
  readonly stdout: Buffer[] = [];
  readonly folder: string;
  readonly dataDir: string;
  stderr = "";
  exit: { code: number | null; at: number } | null = null;

  /** A new instance, or the instance that watched `same` before when given. */
  constructor(same?: { folder: string; dataDir: string }) {
    this.folder = same?.folder ?? fs.mkdtempSync(path.join(scratch, "watched-"));
    this.dataDir = same?.dataDir ?? fs.mkdtempSync(path.join(scratch, "data-"));
    this.child = spawn(built.argv[0] as string, built.argv.slice(1), {
      cwd: built.cwd,
      env: rawNodeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = new LineReader();
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdout.push(chunk);
      for (const line of lines.push(chunk)) {
        if (line.kind === "line") {
          this.decoded.push(decodeFrame(line.bytes));
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("exit", (code) => {
      this.exit = { code, at: Date.now() };
    });
  }

  send(frame: RuntimeFrame): void {
    this.child.stdin.write(encodeFrame(frame));
  }

  start(config: Record<string, unknown> = {}): void {
    this.send({
      t: "start",
      protocol: 2,
      node: { id: "conformance", type: "inny-folder-watch", name: "" },
      config: { folder: this.folder, ...config },
      credentials: {},
      data_dir: this.dataDir,
    });
  }

  get frames(): NodeFrame[] {
    return this.decoded.flatMap((decoded) => (decoded.kind === "frame" ? [decoded.frame] : []));
  }

  get rejected(): Decoded[] {
    return this.decoded.filter((decoded) => decoded.kind !== "frame");
  }

  async ready(): Promise<void> {
    await waitFor("ready", () => this.frames.some((frame) => frame.t === "ready"));
  }

  /** The first scan has happened once the node says what it is doing. */
  async scanned(): Promise<void> {
    await waitFor("the first scan", () => this.frames.some((frame) => frame.t === "status"));
  }
}

const sessions: Session[] = [];

/** The names a session passed on, in order. */
function emittedNames(node: Session): string[] {
  return node.frames.flatMap((frame) =>
    frame.t === "emit" ? [(frame.data as { name: string }).name] : [],
  );
}

function session(same?: { folder: string; dataDir: string }): Session {
  const opened = new Session(same);
  sessions.push(opened);
  return opened;
}

afterEach(() => {
  for (const opened of sessions.splice(0)) {
    if (opened.exit === null) {
      opened.child.kill("SIGKILL");
    }
  }
});

// Each emit waits out the fixed 2 s quiet period (watcher.ts QUIET_MS).
describe("conformance: the folder source (packages/folder)", { timeout: 20_000 }, () => {
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

  it("C3 stdout hygiene, and its emits: every line is a valid frame; each new file is one emit on created, with no in", async () => {
    const node = session();
    node.start();
    await node.ready();
    await node.scanned();
    fs.writeFileSync(path.join(node.folder, "a.txt"), "first");
    fs.writeFileSync(path.join(node.folder, "b.txt"), "second");
    await waitFor(
      "two emits",
      () => node.frames.filter((frame) => frame.t === "emit").length === 2,
      10_000,
    );
    const emits = node.frames.filter((frame) => frame.t === "emit");
    expect(emits.map((frame) => [frame.port, "in" in frame])).toEqual([
      ["created", false],
      ["created", false],
    ]);
    expect(emits.map((frame) => (frame.data as { name: string }).name)).toEqual(["a.txt", "b.txt"]);
    expect(node.rejected).toEqual([]);
    expect(node.stderr).toBe("");
  });

  it("C7 close: closed is sent and the process exits 0 within 5 s", async () => {
    const node = session();
    node.start();
    await node.ready();
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
    expect(node.stderr).not.toMatch(/at [A-Za-z].*\.(ts|cjs|js):\d/);
  });

  it("C9 unknown frame: a frame {t: future} is ignored", async () => {
    const node = session();
    node.start();
    await node.ready();
    // Written raw: the codec refuses to encode a frame type the spec does not have.
    node.child.stdin.write('{"t":"future","what":1}\n');
    await node.scanned();
    fs.writeFileSync(path.join(node.folder, "after.txt"), "still watching");
    await waitFor(
      "the emit after it",
      () => node.frames.some((frame) => frame.t === "emit"),
      10_000,
    );
    expect(node.exit).toBeNull();
    expect(node.rejected).toEqual([]);
  });

  // Not spec C14 (an input id sent twice): a source has no inputs. This is its own restart rule.
  // Without the record the first process wrote, the second would take B as part of a first
  // run's baseline and pass on nothing: so this fails if that record is not written or read.
  it("restart: a second process for the same instance passes on what arrived while stopped, and nothing the first did", async () => {
    const first = session();
    first.start();
    await first.ready();
    await first.scanned();
    fs.writeFileSync(path.join(first.folder, "a.txt"), "A");
    await waitFor("the emit of A", () => first.frames.some((frame) => frame.t === "emit"), 10_000);
    // A scan or two more: A is passed on once, not again.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(emittedNames(first)).toEqual(["a.txt"]);
    first.child.kill("SIGKILL"); // the crash a real restart follows
    await waitFor("the exit", () => first.exit !== null);

    // B arrives while stopped.
    fs.writeFileSync(path.join(first.folder, "b.txt"), "B");

    // The same folder and data folder: the same instance, started again.
    const second = session({ folder: first.folder, dataDir: first.dataDir });
    second.start();
    await second.ready();
    await waitFor("the emit of B", () => second.frames.some((frame) => frame.t === "emit"), 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(emittedNames(second)).toEqual(["b.txt"]);
    expect(second.rejected).toEqual([]);
  });

  it("restart with a record it cannot read: says so at warn, and takes what is there as the baseline", async () => {
    const first = session();
    first.start();
    await first.ready();
    await first.scanned();
    first.child.kill("SIGKILL");
    await waitFor("the exit", () => first.exit !== null);
    fs.writeFileSync(path.join(first.dataDir, "seen.json"), "{ not json");
    fs.writeFileSync(path.join(first.folder, "b.txt"), "B");

    const second = session({ folder: first.folder, dataDir: first.dataDir });
    second.start();
    await second.ready();
    await waitFor("the warning", () =>
      second.frames.some(
        (frame) =>
          frame.t === "log" &&
          frame.level === "warn" &&
          /cannot read the record of the files passed on/.test(frame.msg),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(emittedNames(second)).toEqual([]);
    expect(second.rejected).toEqual([]);
  });
});
