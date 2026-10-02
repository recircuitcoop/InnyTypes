// The app page's calls the runtime answers (shell/runtime-calls.ts): each channel passes only
// its own ops to the runtime, and the editor sync's event path can be switched off. The runs' and
// the flows' calls are run-calls.ts's and flow-calls.ts's (v2-calls.test.ts, flow-calls.test.ts).
import { describe, expect, it } from "vitest";

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
