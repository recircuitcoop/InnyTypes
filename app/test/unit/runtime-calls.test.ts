// The app page's calls the runtime answers (shell/runtime-calls.ts): each channel passes only
// its own ops to the runtime, and the editor sync's event path can be switched off. A flow write
// is told by the shell whether the canvas has unsaved changes; "Export flow…" saves through the
// shell's own dialog.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import type { Supervisor } from "../../src/application/supervisor";
import { exportFileName } from "../../src/shell/flow-export";
import { IPC } from "../../src/shell/ipc";
import { wireRuntimeCalls } from "../../src/shell/runtime-calls";
import { obedient } from "../fakes/children";
import { supervised } from "../fakes/supervised";

function wired() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const { clock, supervisor, logger } = supervised(obedient);
  supervisor.start();
  clock.advance(5);
  const calls = wireRuntimeCalls({
    ipc: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (event: unknown, ...args: unknown[]) => unknown);
      },
    },
    runtime: supervisor,
    editor: {
      palette: () => Promise.resolve({ sets: [], dirty: false }),
      deploy: () => Promise.resolve(null),
      loaded: () => true,
    },
    logger,
    dialog: { showSaveDialog: () => Promise.reject(new Error("not used here")) },
  });
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const answer = Promise.resolve(handlers.get(channel)?.({}, ...args));
    clock.advance(5);
    return answer;
  };
  return { call, calls, logger };
}

describe("the runtime's calls from the app page", () => {
  it("passes each channel's own ops to the runtime, and refuses any other", async () => {
    const { call } = wired();
    expect(await call(IPC.listCall, { op: "job.list", args: null })).toEqual({
      ok: true,
      value: "job.list",
    });
    expect(await call(IPC.viewCall, { op: "snapshot.get", args: { id: "s" } })).toEqual({
      ok: true,
      value: "snapshot.get",
    });
    expect(await call(IPC.editorCall, { op: "editor.nodes", args: null })).toEqual({
      ok: true,
      value: "editor.nodes",
    });
    expect(await call(IPC.listCall, { op: "view.get" })).toEqual({
      ok: false,
      error: "view.get is not a list call",
    });
    expect(await call(IPC.viewCall, null)).toEqual({
      ok: false,
      error: "undefined is not a view call",
    });
    expect(await call(IPC.editorCall, { op: "job.cancel" })).toEqual({
      ok: false,
      error: "job.cancel is not an editor call",
    });
    expect(await call(IPC.editorPalette)).toEqual({ sets: [], dirty: false });
  });

  it("passes the run ops on the run channel, and refuses any other there", async () => {
    const { call } = wired();
    for (const op of ["run.list", "run.get", "run.clearDone", "run.undoClear"]) {
      expect(await call(IPC.runCall, { op, args: { flowId: "tab1" } })).toEqual({
        ok: true,
        value: op,
      });
    }
    expect(await call(IPC.runCall, { op: "job.list" })).toEqual({
      ok: false,
      error: "job.list is not a run call",
    });
    expect(await call(IPC.runCall, undefined)).toEqual({
      ok: false,
      error: "undefined is not a run call",
    });
  });

  it("raises nothing for editor.sync once the event path is switched off", async () => {
    const { call, calls, logger } = wired();
    calls.editorEvents(false);
    expect(await call(IPC.editorCall, { op: "editor.sync", args: {} })).toEqual({
      ok: true,
      value: null,
    });
    expect(logger.lines).toContainEqual(
      expect.stringContaining("editor sync: the runtime-event path is disabled"),
    );
    calls.editorEvents(true);
    expect(await call(IPC.editorCall, { op: "editor.sync", args: {} })).toEqual({
      ok: true,
      value: "editor.sync",
    });
  });
});

/** The shell's flow relay over a runtime that records each call and answers from a script. */
function flowRelay(options: {
  /** The palette's dirty flag; null when it cannot be read. */
  dirty: boolean | null;
  /** Whether an editor frame is there; false unless said. */
  loaded?: boolean;
  answer?: (op: string, args: unknown) => unknown;
  saveTo?: string | null;
}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const calls: [string, unknown][] = [];
  const runtime = {
    call: (op: string, args: unknown) => {
      calls.push([op, args]);
      return Promise.resolve(options.answer?.(op, args) ?? { ok: true, value: op });
    },
  };
  const { logger } = supervised(obedient);
  const dialogs: unknown[] = [];
  wireRuntimeCalls({
    ipc: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (event: unknown, ...args: unknown[]) => unknown);
      },
    },
    runtime: runtime as unknown as Supervisor,
    editor: {
      palette: () =>
        Promise.resolve(options.dirty === null ? null : { sets: [], dirty: options.dirty }),
      deploy: () => Promise.resolve(null),
      loaded: () => options.loaded ?? false,
    },
    logger,
    dialog: {
      showSaveDialog: (dialogOptions: unknown) => {
        dialogs.push(dialogOptions);
        const filePath = options.saveTo ?? undefined;
        return Promise.resolve({ canceled: filePath === undefined, filePath: filePath ?? "" });
      },
    },
  });
  const flowCall = (call: unknown) => Promise.resolve(handlers.get(IPC.flowCall)?.({}, call));
  return { flowCall, calls, dialogs };
}

describe("the shell's flow relay", () => {
  it("passes the reads on as they are", async () => {
    const { flowCall, calls } = flowRelay({ dirty: true });
    for (const op of ["flow.list", "flow.templates", "flow.node.form", "node.options"]) {
      expect(await flowCall({ op, args: { flowId: "t" } })).toEqual({ ok: true, value: op });
    }
    expect(calls).toEqual([
      ["flow.list", { flowId: "t" }],
      ["flow.templates", { flowId: "t" }],
      ["flow.node.form", { flowId: "t" }],
      ["node.options", { flowId: "t" }],
    ]);
  });

  it("tells every write whether the canvas is dirty, replacing what the page said", async () => {
    const writes = [
      "flow.setOn",
      "flow.rename",
      "flow.duplicate",
      "flow.delete",
      "flow.fromTemplate",
      "flow.node.configure",
    ];
    const dirty = flowRelay({ dirty: true });
    for (const op of writes) {
      await dirty.flowCall({ op, args: { id: "t", canvasDirty: false } });
    }
    expect(dirty.calls).toEqual(writes.map((op) => [op, { id: "t", canvasDirty: true }]));
    // No editor loaded: nothing unsaved. Arguments that are not an object are none.
    const clean = flowRelay({ dirty: null });
    await clean.flowCall({ op: "flow.delete", args: { id: "t", canvasDirty: true } });
    await clean.flowCall({ op: "flow.delete", args: "t" });
    expect(clean.calls).toEqual([
      ["flow.delete", { id: "t", canvasDirty: false }],
      ["flow.delete", { canvasDirty: false }],
    ]);
  });

  it("counts a loaded editor it cannot read as dirty, and says it is loading", async () => {
    // Loading, navigating, or slow to answer: it may hold unsaved changes.
    const unreadable = flowRelay({ dirty: null, loaded: true });
    await unreadable.flowCall({ op: "flow.rename", args: { id: "t", canvasDirty: false } });
    expect(unreadable.calls).toEqual([
      ["flow.rename", { id: "t", canvasDirty: true, canvasLoading: true }],
    ]);
    // Readable and clean: the write goes through, loaded or not.
    const clean = flowRelay({ dirty: false, loaded: true });
    await clean.flowCall({ op: "flow.rename", args: { id: "t" } });
    expect(clean.calls).toEqual([["flow.rename", { id: "t", canvasDirty: false }]]);
  });

  it("refuses any other op, and never asks the runtime", async () => {
    const { flowCall, calls } = flowRelay({ dirty: false });
    expect(await flowCall({ op: "run.list" })).toEqual({
      ok: false,
      error: "run.list is not a flow call",
    });
    expect(await flowCall(null)).toEqual({ ok: false, error: "undefined is not a flow call" });
    expect(calls).toEqual([]);
  });

  it("saves an export where the person chooses, and says when they cancelled", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-export-"));
    try {
      const file = path.join(scratch, "out.json");
      const exported = { name: "Invoices: 2026/10", nodes: [{ id: "t", type: "tab" }] };
      const saving = flowRelay({
        dirty: true,
        saveTo: file,
        answer: () => ({ ok: true, value: exported }),
      });
      expect(await saving.flowCall({ op: "flow.export", args: { id: "t" } })).toEqual({
        ok: true,
        value: { saved: file },
      });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(exported.nodes);
      expect(saving.dialogs).toEqual([
        expect.objectContaining({ defaultPath: "Invoices 2026 10.json" }),
      ]);
      const cancelled = flowRelay({ dirty: false, answer: () => ({ ok: true, value: exported }) });
      expect(await cancelled.flowCall({ op: "flow.export", args: { id: "t" } })).toEqual({
        ok: true,
        value: { saved: null },
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("answers a refused or failed export as it came, with no dialog", async () => {
    const refusal = { ok: true, value: { refused: { reason: "gone", sentence: "Gone." } } };
    const refused = flowRelay({ dirty: false, answer: () => refusal });
    expect(await refused.flowCall({ op: "flow.export", args: { id: "t" } })).toEqual(refusal);
    const failed = flowRelay({ dirty: false, answer: () => ({ ok: false, error: "down" }) });
    expect(await failed.flowCall({ op: "flow.export", args: { id: "t" } })).toEqual({
      ok: false,
      error: "down",
    });
    expect([...refused.dialogs, ...failed.dialogs]).toEqual([]);
  });

  it("names an export's file after its flow, safely", () => {
    expect(exportFileName("Recordings to Anytype")).toBe("Recordings to Anytype.json");
    expect(exportFileName('a/b\\c:d*e?"f<g>h|i')).toBe("a b c d e f g h i.json");
    expect(exportFileName("  /  ")).toBe("flow.json");
  });
});
