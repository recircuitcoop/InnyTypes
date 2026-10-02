// Flow administration's calls from the app page (shell/flow-calls.ts): reads pass on as they are,
// every write is told whether the canvas has unsaved changes, "Export flow…" saves through the
// shell's own dialog, and a refusal the runtime worded for the canvas reaches the page by reason
// and ui/strings.ts key.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import type { Supervisor } from "../../src/application/supervisor";
import { wireFlowCalls } from "../../src/shell/flow-calls";
import { exportFileName } from "../../src/shell/flow-export";
import { IPC } from "../../src/shell/ipc";
import { obedient } from "../fakes/children";
import { supervised } from "../fakes/supervised";

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
  wireFlowCalls({
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
    const failed = { ok: false, refused: { reason: "failed", sentence: "refused.failed" } };
    expect(await flowCall({ op: "run.list" })).toEqual(failed);
    expect(await flowCall(null)).toEqual(failed);
    expect(calls).toEqual([]);
  });

  it("passes a runtime refusal on by reason and key, its slots and problems kept", async () => {
    const refusing = (refused: object) =>
      flowRelay({ dirty: false, answer: () => ({ ok: true, value: { refused } }) });
    expect(
      await refusing({ reason: "dirty", sentence: "Save or discard…" }).flowCall({
        op: "flow.rename",
        args: { id: "t", name: "x" },
      }),
    ).toEqual({ ok: false, refused: { reason: "dirty", sentence: "flows.refused.dirty" } });
    const invalid = {
      reason: "invalid",
      sentence: "File isn't set up yet: space is required.",
      problems: [{ path: "/space", message: "is required" }],
      params: { step: "File", what: "space is required" },
    };
    expect(
      await refusing(invalid).flowCall({ op: "flow.node.configure", args: { flowId: "t" } }),
    ).toEqual({
      ok: false,
      refused: {
        reason: "invalid",
        sentence: "error.formIncomplete",
        params: invalid.params,
        problems: invalid.problems,
      },
    });
    expect(
      await refusing({ reason: "not-paired", sentence: "Pair…" }).flowCall({
        op: "node.options",
        args: { source: "spaces" },
      }),
    ).toEqual({ ok: false, refused: { reason: "not-paired", sentence: "form.notPaired" } });
    // A reason the page has no line for is a failure, its words logged.
    expect(
      await refusing({ reason: "strange", sentence: "?" }).flowCall({
        op: "flow.delete",
        args: { id: "t" },
      }),
    ).toEqual({ ok: false, refused: { reason: "failed", sentence: "refused.failed" } });
  });

  it("answers Setup's spaces with the form's own resolver", async () => {
    const { flowCall, calls } = flowRelay({
      dirty: false,
      answer: () => ({ ok: true, value: { options: [{ value: "s1", label: "Work" }] } }),
    });
    expect(await flowCall({ op: "anytype.spaces" })).toEqual({
      ok: true,
      value: { options: [{ value: "s1", label: "Work" }] },
    });
    expect(calls).toEqual([["node.options", { source: "spaces" }]]);
  });

  it("answers a runtime that is not there, or a handler that throws, as a refusal", async () => {
    const restarting = flowRelay({
      dirty: false,
      answer: () => ({ ok: false, code: "restarting", error: "the runtime is restarting" }),
    });
    expect(await restarting.flowCall({ op: "flow.list" })).toEqual({
      ok: false,
      refused: { reason: "restarting", sentence: "refused.restarting" },
    });
    const throwing = flowRelay({
      dirty: false,
      answer: () => {
        throw new Error("boom");
      },
    });
    expect(await throwing.flowCall({ op: "flow.list" })).toEqual({
      ok: false,
      refused: { reason: "failed", sentence: "refused.failed" },
    });
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

  it("answers a refused or failed export as a refusal, with no dialog", async () => {
    const refusal = { ok: true, value: { refused: { reason: "gone", sentence: "Gone." } } };
    const refused = flowRelay({ dirty: false, answer: () => refusal });
    expect(await refused.flowCall({ op: "flow.export", args: { id: "t" } })).toEqual({
      ok: false,
      refused: { reason: "gone", sentence: "flows.refused.gone" },
    });
    const failed = flowRelay({ dirty: false, answer: () => ({ ok: false, error: "down" }) });
    expect(await failed.flowCall({ op: "flow.export", args: { id: "t" } })).toEqual({
      ok: false,
      refused: { reason: "failed", sentence: "refused.failed" },
    });
    expect([...refused.dialogs, ...failed.dialogs]).toEqual([]);
  });

  it("names an export's file after its flow, safely", () => {
    expect(exportFileName("Recordings to Anytype")).toBe("Recordings to Anytype.json");
    expect(exportFileName('a/b\\c:d*e?"f<g>h|i')).toBe("a b c d e f g h i.json");
    expect(exportFileName("  /  ")).toBe("flow.json");
  });
});
