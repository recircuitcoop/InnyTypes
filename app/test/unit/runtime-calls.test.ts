// The app page's calls the runtime answers (shell/runtime-calls.ts): the view channel passes only
// its own op to the runtime, and the canvas asks for the editor's palette. The runs' and the
// flows' calls are run-calls.ts's and flow-calls.ts's (v2-calls.test.ts, flow-calls.test.ts).
import { describe, expect, it } from "vitest";

import { MAX_ANSWER_BYTES, REFUSED_ANSWER } from "../../src/domain/views/answers";
import { IPC } from "../../src/shell/ipc";
import { wireRuntimeCalls } from "../../src/shell/runtime-calls";
import { obedient } from "../fakes/children";
import { supervised } from "../fakes/supervised";

function wired() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const { clock, supervisor } = supervised(obedient);
  supervisor.start();
  clock.advance(5);
  wireRuntimeCalls({
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
  });
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const answer = Promise.resolve(handlers.get(channel)?.({}, ...args));
    clock.advance(5);
    return answer;
  };
  return { call };
}

describe("the runtime's calls from the app page", () => {
  it("passes the view channel's own op to the runtime, and refuses any other", async () => {
    const { call } = wired();
    expect(await call(IPC.viewCall, { op: "view.submit", args: { id: "v", values: {} } })).toEqual(
      { ok: true, value: "view.submit" },
    );
    for (const op of ["view.get", "snapshot.get", "snapshot.action", "job.cancel"]) {
      expect(await call(IPC.viewCall, { op, args: { id: "s" } })).toEqual({
        ok: false,
        error: `${op} is not a view call`,
      });
    }
    expect(await call(IPC.viewCall, null)).toEqual({
      ok: false,
      error: "undefined is not a view call",
    });
    expect(await call(IPC.editorPalette)).toEqual({ sets: [], dirty: false });
  });

  it("an answer over 64 KiB is refused before the hop; a smaller one goes on", async () => {
    const { call } = wired();
    const big = { text: "x".repeat(MAX_ANSWER_BYTES) };
    expect(await call(IPC.viewCall, { op: "view.submit", args: { id: "v", values: big } })).toEqual(
      { ok: false, error: REFUSED_ANSWER },
    );
    expect(
      await call(IPC.viewCall, { op: "view.submit", args: { id: "v", values: { a: [1] } } }),
    ).toEqual({ ok: true, value: "view.submit" });
  });
});
