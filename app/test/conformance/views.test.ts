// Conformance C10 (action view) and C11 (snapshot view) of spec §12.2, against BOTH reference
// view nodes: viewpy (Python, standard library only) and viewts (TypeScript, Node's standard
// library only). The harness plays the runtime frame by frame, and every frame either way goes
// through the runtime's own codec (ajv, §4.5), so a frame of the wrong shape fails here.
//
// These are reference nodes, not the SDKs: WI-0018-26 owes C10 and C11 against the Python and
// TS SDKs proper.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  LineReader,
  type Decoded,
  type NodeFrame,
  type RuntimeFrame,
} from "../../src/adapters/process/codec";
import { rawNodeEnv, waitFor } from "../fixtures/raw-node/fixture";
import { VIEW_LANGUAGES, viewCommand, type ViewLanguage } from "../fixtures/views";

/** The runtime's side of one conversation with a reference view node. */
class Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly decoded: Decoded[] = [];
  stderr = "";

  constructor(language: ViewLanguage, typeId: "ask" | "record") {
    const { argv, cwd } = viewCommand(language, typeId);
    this.child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: rawNodeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = new LineReader();
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const line of lines.push(chunk)) {
        if (line.kind === "line") {
          this.decoded.push(decodeFrame(line.bytes));
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.send({
      t: "start",
      protocol: 2,
      node: { id: "conformance", type: `inny-view${language}-${typeId}`, name: "" },
      config: {},
      credentials: {},
      data_dir: "/nonexistent-data-dir",
    });
  }

  send(frame: RuntimeFrame): void {
    this.child.stdin.write(encodeFrame(frame));
  }

  get frames(): NodeFrame[] {
    return this.decoded.flatMap((decoded) => (decoded.kind === "frame" ? [decoded.frame] : []));
  }

  /** Everything the node wrote that is not a valid frame of this protocol. */
  get rejected(): Decoded[] {
    return this.decoded.filter((decoded) => decoded.kind !== "frame");
  }

  /** The frames about input `id`, in order, `ready` and new-run emits left out. */
  about(id: string): NodeFrame[] {
    return this.frames.filter((frame) => "in" in frame && frame.in === id);
  }
}

const sessions: Session[] = [];

function session(language: ViewLanguage, typeId: "ask" | "record"): Session {
  const opened = new Session(language, typeId);
  sessions.push(opened);
  return opened;
}

afterEach(() => {
  for (const opened of sessions.splice(0)) {
    opened.child.kill("SIGKILL");
  }
});

describe.each(VIEW_LANGUAGES)("conformance: the %s reference view node", (language) => {
  it("C10 action view: present, then action, gives emit {in} + done; __dismiss__ gives error", async () => {
    const node = session(language, "ask");
    node.send({ t: "input", id: "i1", event: { type: "t.v1", data: { n: 1 }, run: "r1" } });
    await waitFor("present", () => node.about("i1").length === 1);
    // The flow waits: nothing but the presentation until the person acts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(node.about("i1")).toEqual([
      {
        t: "present",
        in: "i1",
        content: expect.objectContaining({ title: expect.any(String) as unknown }) as unknown,
      },
    ]);

    node.send({ t: "action", in: "i1", values: { answer: "yes" } });
    await waitFor("done", () => node.about("i1").length === 3);
    expect(node.about("i1").slice(1)).toEqual([
      { t: "emit", port: "answer", data: { answer: "yes" }, in: "i1" },
      { t: "done", in: "i1" },
    ]);

    node.send({ t: "input", id: "i2", event: { type: "t.v1", data: { n: 2 } } });
    await waitFor("present", () => node.about("i2").length === 1);
    node.send({ t: "action", in: "i2", values: { __dismiss__: true } });
    await waitFor("error", () => node.about("i2").length === 2);
    expect(node.about("i2")[1]).toEqual({
      t: "error",
      in: "i2",
      message: "dismissed by the person",
    });
    expect(node.rejected).toEqual([]);
    expect(node.stderr).not.toMatch(/Traceback|Error:/);
  });

  it("C11 snapshot view: snapshot + pass-through emit + done; trigger gives emit with no in on the action port", async () => {
    const node = session(language, "record");
    node.send({ t: "input", id: "s1", event: { type: "t.v1", data: { n: 7 } } });
    await waitFor("done", () => node.about("s1").some((frame) => frame.t === "done"));
    expect(node.about("s1")).toEqual([
      { t: "snapshot", content: expect.any(Object) as unknown, state: { n: 7 }, in: "s1" },
      { t: "emit", port: "passed", data: { n: 7 }, in: "s1" },
      { t: "done", in: "s1" },
    ]);

    node.send({
      t: "trigger",
      action: "again",
      snapshot: { id: "snap-1", state: { n: 7 } },
      values: { why: "again" },
    });
    const newRun = () => node.frames.filter((frame) => frame.t === "emit" && !("in" in frame));
    await waitFor("the triggered emit", () => newRun().length === 1);
    expect(newRun()).toEqual([
      { t: "emit", port: "again", data: { state: { n: 7 }, values: { why: "again" } } },
    ]);
    expect(node.rejected).toEqual([]);
  });
});
