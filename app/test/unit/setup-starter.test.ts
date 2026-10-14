// Setup's starter flow in the shell (plan 0022 §H, D18, D19; shell/setup.ts, shell/setup-starter.ts):
// installed once when Setup reaches Source folder, the chosen folder written into its source,
// switched on at Ready only once it is set up, and Try with a sample copying the bundled sample
// into the folder once the folder source has scanned it. A fake runtime answers the flow ops.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IpcMain } from "electron";
import { describe, expect, it } from "vitest";
import type { Supervisor } from "../../src/application/supervisor";
import type { CallResult } from "../../src/domain/channel/errors";
import { IPC } from "../../src/shell/ipc";
import { wireSetup } from "../../src/shell/setup";
import { copySample } from "../../src/shell/setup-starter";
import type { FlowSummary } from "../../src/ui/flow-contract";
import { RecordingLogger } from "../fakes/children";

const STARTER = "starter-flow";
const SOURCE = "watch-1";

/** The starter as flow.list answers it: its source, one step, off or on, set up or not. */
function starterRow(on: boolean, ready: boolean): FlowSummary {
  return {
    id: STARTER,
    name: "Folder to Anytype",
    on,
    health: ready ? { kind: "ready" } : { kind: "steps-not-set-up", count: 1 },
    lastRun: null,
    viewNodes: [],
    steps: [{ id: "file-1", name: "File in Anytype", type: "t", setUp: ready }],
    sources: [{ id: SOURCE, name: "Watch a folder", type: "inny-folder-watch", setUp: true }],
  };
}

function harness() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-setup-"));
  const folder = path.join(scratch, "Inbox");
  fs.mkdirSync(folder);
  const sampleFile = path.join(scratch, "sample-10s.wav");
  fs.writeFileSync(sampleFile, "RIFF-sample");
  const instancesDir = path.join(scratch, "instances");
  const calls: [string, Record<string, unknown>][] = [];
  const flow = { installed: false, on: false, ready: false, folder: "" };
  const answers: Record<string, (args: Record<string, unknown>) => CallResult> = {
    "flow.templates": () => ({
      ok: true,
      value: [
        { id: "blank", starter: false },
        { id: "folder-to-anytype", starter: true },
      ],
    }),
    "flow.fromTemplate": () => {
      flow.installed = true;
      return { ok: true, value: { id: STARTER, name: "Folder to Anytype" } };
    },
    "flow.list": () => ({
      ok: true,
      value: flow.installed ? [starterRow(flow.on, flow.ready)] : [],
    }),
    "flow.node.configure": (args) => {
      flow.folder = String((args["values"] as { folder: string }).folder);
      return { ok: true, value: { flowId: STARTER, nodeId: SOURCE } };
    },
    "flow.node.form": () => ({ ok: true, value: { values: { folder: flow.folder } } }),
    "flow.setOn": () => {
      flow.on = true;
      return { ok: true, value: { id: STARTER, on: true } };
    },
  };
  let down = false;
  const runtime = {
    call: (op: string, args: unknown): Promise<CallResult> => {
      calls.push([op, (args ?? {}) as Record<string, unknown>]);
      if (down) return Promise.resolve({ ok: false, code: "down", error: "down" });
      return Promise.resolve(answers[op]?.((args ?? {}) as Record<string, unknown>) ?? {
        ok: false,
        error: `no ${op}`,
      });
    },
  };
  let handler: ((event: unknown, call: unknown) => Promise<unknown>) | undefined;
  const ipc: Pick<IpcMain, "handle"> = {
    handle: (channel, given) => {
      if (channel === IPC.setupCall) handler = given as typeof handler;
    },
  };
  const stored: Record<string, unknown> = {};
  const pushed: unknown[] = [];
  const chooser = { folder: folder as string | null };
  const sleeps: number[] = [];
  wireSetup({
    ipc,
    flowsFile: path.join(scratch, "flows.json"),
    settings: {
      readSetup: () => stored["setup"],
      writeSetup: (state) => {
        stored["setup"] = state;
      },
      readTelemetry: () => "unset",
    },
    toPage: (_channel, state) => pushed.push(state),
    runtime: runtime as unknown as Pick<Supervisor, "call">,
    editor: {
      palette: () => Promise.resolve({ sets: [], dirty: false }),
      deploy: () => Promise.resolve(null),
      loaded: () => true,
    },
    dialog: {
      showOpenDialog: () =>
        Promise.resolve({
          canceled: chooser.folder === null,
          filePaths: chooser.folder === null ? [] : [chooser.folder],
        }),
    },
    files: { sampleFile, instancesDir },
    logger: new RecordingLogger(),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  const call = async (op: string, args: unknown = null) => {
    if (handler === undefined) throw new Error("setup is not wired");
    return (await handler({}, { op, args })) as {
      ok: boolean;
      value?: Record<string, unknown> | null;
      refused?: { reason: string };
    };
  };
  /** Let the background install finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const setDown = (value: boolean) => {
    down = value;
  };
  /** The folder source's record of its first scan, as packages/folder writes it. */
  const scanned = (of: string) => {
    fs.mkdirSync(path.join(instancesDir, SOURCE), { recursive: true });
    fs.writeFileSync(
      path.join(instancesDir, SOURCE, "seen.json"),
      JSON.stringify({ folder: of, files: {} }),
    );
  };
  return { call, calls, flow, stored, pushed, chooser, folder, settle, setDown, scanned, sleeps };
}

/** Continue from Welcome to Source folder. */
async function toSourceFolder(h: ReturnType<typeof harness>) {
  for (let pressed = 0; pressed < 3; pressed += 1) {
    await h.call("setup.move", { kind: "next" });
  }
  await h.settle();
}

describe("the starter flow, installed by Setup", () => {
  it("is installed once Setup reaches Source folder, never before, and only once", async () => {
    const h = harness();
    await h.call("setup.get");
    for (let pressed = 0; pressed < 2; pressed += 1) {
      await h.call("setup.move", { kind: "next" });
    }
    await h.settle();
    expect(h.calls.filter(([op]) => op === "flow.fromTemplate")).toEqual([]);
    await h.call("setup.move", { kind: "next" });
    await h.settle();
    // A burst of reads while it installs, and reads after: one install.
    await Promise.all([h.call("setup.get"), h.call("setup.get"), h.call("setup.get")]);
    await h.settle();
    const installs = h.calls.filter(([op]) => op === "flow.fromTemplate");
    expect(installs).toHaveLength(1);
    expect(installs[0]?.[1]).toMatchObject({ templateId: "folder-to-anytype", canvasDirty: false });
    expect(h.stored["setup"]).toMatchObject({
      step: "source-folder",
      starterFlowId: STARTER,
      formCount: 1,
    });
    // Pushed, so the page sees the starter without asking.
    expect(h.pushed.at(-1)).toMatchObject({ starterFlowId: STARTER });
  });

  it("is installed on a later read when the runtime was not up for the first", async () => {
    const h = harness();
    h.setDown(true);
    await toSourceFolder(h);
    expect(h.stored["setup"]).toMatchObject({ starterFlowId: null });
    h.setDown(false);
    expect((await h.call("setup.get")).ok).toBe(true);
    await h.settle();
    expect(h.stored["setup"]).toMatchObject({ starterFlowId: STARTER });
  });

  it("writes the chosen folder into the starter's source; a cancel writes nothing", async () => {
    const h = harness();
    expect(await h.call("setup.chooseFolder")).toMatchObject({
      ok: false,
      refused: { reason: "loading" },
    });
    await toSourceFolder(h);
    h.chooser.folder = null;
    expect(await h.call("setup.chooseFolder")).toEqual({ ok: true, value: { folder: null } });
    expect(h.calls.filter(([op]) => op === "flow.node.configure")).toEqual([]);
    h.chooser.folder = h.folder;
    expect(await h.call("setup.chooseFolder")).toEqual({ ok: true, value: { folder: h.folder } });
    expect(h.calls.find(([op]) => op === "flow.node.configure")?.[1]).toMatchObject({
      flowId: STARTER,
      nodeId: SOURCE,
      values: { folder: h.folder },
    });
  });

  it("is switched on at Ready only once it is set up", async () => {
    const notReady = harness();
    await toSourceFolder(notReady);
    await notReady.call("setup.move", { kind: "next" });
    expect(await notReady.call("setup.move", { kind: "next" })).toMatchObject({
      value: { step: "ready" },
    });
    expect(notReady.calls.filter(([op]) => op === "flow.setOn")).toEqual([]);

    const h = harness();
    await toSourceFolder(h);
    await h.call("setup.move", { kind: "next" });
    h.flow.ready = true;
    await h.call("setup.move", { kind: "next" });
    expect(h.calls.find(([op]) => op === "flow.setOn")?.[1]).toMatchObject({
      id: STARTER,
      on: true,
    });
    expect(h.flow.on).toBe(true);
  });
});

describe("Try with a sample", () => {
  it("copies the sample into the folder once the folder source has scanned it", async () => {
    const h = harness();
    await toSourceFolder(h);
    await h.call("setup.chooseFolder");
    h.flow.ready = true;
    h.scanned(h.folder);
    expect(await h.call("setup.trySample")).toEqual({ ok: true, value: null });
    expect(h.flow.on).toBe(true);
    expect(fs.readdirSync(h.folder)).toEqual(["sample-10s.wav"]);
    // Again: a new file, never over the first.
    expect(await h.call("setup.trySample")).toEqual({ ok: true, value: null });
    expect(fs.readdirSync(h.folder).sort()).toEqual(["sample-10s 2.wav", "sample-10s.wav"]);
  });

  it("copies nothing while the source has not scanned the chosen folder", async () => {
    const h = harness();
    await toSourceFolder(h);
    await h.call("setup.chooseFolder");
    h.flow.ready = true;
    // A record of another folder (the setting changed): not this folder's first scan.
    h.scanned(path.join(h.folder, "..", "elsewhere"));
    expect(await h.call("setup.trySample")).toMatchObject({
      ok: false,
      refused: { reason: "failed" },
    });
    expect(fs.readdirSync(h.folder)).toEqual([]);
    expect(h.sleeps.length).toBeGreaterThan(10);
  });

  it("is refused without a folder, or while the starter is not set up", async () => {
    const h = harness();
    await toSourceFolder(h);
    expect(await h.call("setup.trySample")).toMatchObject({ refused: { reason: "failed" } });
    await h.call("setup.chooseFolder");
    h.scanned(h.folder);
    expect(await h.call("setup.trySample")).toMatchObject({ refused: { reason: "failed" } });
    expect(fs.readdirSync(h.folder)).toEqual([]);
  });

  it("names a copy so it never replaces a file of the person's own", () => {
    const h = harness();
    const own = path.join(h.folder, "sample-10s.wav");
    fs.writeFileSync(own, "mine");
    const sample = path.join(h.folder, "..", "sample-10s.wav");
    expect(copySample(sample, h.folder)).toBe("sample-10s 2.wav");
    expect(fs.readFileSync(own, "utf8")).toBe("mine");
  });
});
