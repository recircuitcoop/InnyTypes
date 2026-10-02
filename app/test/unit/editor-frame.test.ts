// The editor in the app window's frame, reached from the shell (WI-0018-12): its palette as
// node sets, its dirty flag, its own Deploy, and a frame that is missing, gone or hung.

import { describe, expect, it } from "vitest";

import {
  DEPLOY_SCRIPT,
  EditorFrame,
  PALETTE_SCRIPT,
  type ScriptFrame,
} from "../../src/adapters/electron/editor-frame";
import { FakeClock } from "../fakes/clock";

const URL = "http://127.0.0.1:18800/red/";

const settle = async (): Promise<void> => {
  for (let n = 0; n < 10; n += 1) {
    await Promise.resolve();
  }
};

/** An editor frame whose scripts answer from `answer`. */
function frameAnswering(answer: (script: string) => Promise<unknown>, url = URL): ScriptFrame {
  return { url, executeJavaScript: answer };
}

describe("EditorFrame.palette", () => {
  it("answers the editor frame's node sets and dirty flag", async () => {
    const palette = { sets: [{ id: "node-red/inject", types: ["inject"] }], dirty: true };
    const scripts: string[] = [];
    const editor = new EditorFrame({
      frames: () => [
        frameAnswering(() => Promise.resolve("not the editor"), "inny-app://app/index.html"),
        frameAnswering((script) => {
          scripts.push(script);
          return Promise.resolve(palette);
        }, `${URL}#flow/1`),
      ],
      editorUrl: () => URL,
      clock: new FakeClock(),
    });
    await expect(editor.palette()).resolves.toEqual(palette);
    expect(scripts).toEqual([PALETTE_SCRIPT]);
  });

  it("reads node SETS from the registry's node list, never the definitions", () => {
    expect(PALETTE_SCRIPT).toContain("registry.getNodeList()");
    expect(PALETTE_SCRIPT).not.toContain("getNodeTypes");
    expect(PALETTE_SCRIPT).not.toContain("getType");
  });

  it("is null with no port yet, no editor frame, a failing or hung script, or no answer", async () => {
    const clock = new FakeClock();
    const cases: [() => string | null, ScriptFrame[]][] = [
      [() => null, [frameAnswering(() => Promise.resolve({ sets: [], dirty: false }))]],
      [() => URL, []],
      [() => URL, [frameAnswering(() => Promise.reject(new Error("frame detached")))]],
      [() => URL, [frameAnswering(() => Promise.resolve(null))]],
      [() => URL, [frameAnswering(() => Promise.resolve({ sets: "no", dirty: 1 }))]],
    ];
    for (const [editorUrl, frames] of cases) {
      const editor = new EditorFrame({ frames: () => frames, editorUrl, clock });
      await expect(editor.palette()).resolves.toBeNull();
    }
    const hung = new EditorFrame({
      frames: () => [frameAnswering(() => new Promise(() => undefined))],
      editorUrl: () => URL,
      clock,
      scriptMs: 100,
    });
    const answer = hung.palette();
    clock.advance(100);
    await expect(answer).resolves.toBeNull();
  });
});

describe("EditorFrame.loaded", () => {
  it("is true while the editor's frame is there, readable or not, and false with none", () => {
    const clock = new FakeClock();
    const hung = frameAnswering(() => new Promise(() => undefined), `${URL}#flow/1`);
    expect(new EditorFrame({ frames: () => [hung], editorUrl: () => URL, clock }).loaded()).toBe(
      true,
    );
    const other = frameAnswering(() => Promise.resolve(null), "inny-app://app/index.html");
    expect(new EditorFrame({ frames: () => [other], editorUrl: () => URL, clock }).loaded()).toBe(
      false,
    );
    expect(new EditorFrame({ frames: () => [hung], editorUrl: () => null, clock }).loaded()).toBe(
      false,
    );
  });
});

describe("EditorFrame.deploy", () => {
  /** An editor that becomes clean `cleanAfter` checks after its Deploy is pressed. */
  function editorThat(options: { dirty: boolean; cleanAfter?: number; hasButton?: boolean }) {
    let dirty = options.dirty;
    let checksLeft = options.cleanAfter ?? 0;
    let pressed = 0;
    let pressedYet = false;
    const clock = new FakeClock();
    const editor = new EditorFrame({
      frames: () => [
        frameAnswering((script) => {
          if (script === DEPLOY_SCRIPT) {
            pressed += 1;
            pressedYet = true;
            return Promise.resolve(options.hasButton !== false);
          }
          if (pressedYet && dirty) {
            if (checksLeft === 0) {
              dirty = false;
            } else {
              checksLeft -= 1;
            }
          }
          return Promise.resolve({ sets: [], dirty });
        }),
      ],
      editorUrl: () => URL,
      clock,
      deployMs: 1_000,
      pollMs: 250,
    });
    return { editor, clock, pressed: () => pressed };
  }

  it("presses the editor's Deploy and answers null once it is clean", async () => {
    const { editor, clock, pressed } = editorThat({ dirty: true, cleanAfter: 1 });
    const done = editor.deploy();
    for (let n = 0; n < 4; n += 1) {
      await settle();
      clock.advance(250);
    }
    await expect(done).resolves.toBeNull();
    expect(pressed()).toBe(1);
  });

  it("does nothing for a clean editor", async () => {
    const { editor, pressed } = editorThat({ dirty: false });
    await expect(editor.deploy()).resolves.toBeNull();
    expect(pressed()).toBe(0);
  });

  it("says why when the deploy does not finish in time", async () => {
    const { editor, clock } = editorThat({ dirty: true, cleanAfter: 1_000 });
    const done = editor.deploy();
    for (let n = 0; n < 8; n += 1) {
      await settle();
      clock.advance(250);
    }
    await expect(done).resolves.toBe("The deploy did not finish within 1 s; the editor says why.");
  });

  it("says why with no editor or no Deploy button", async () => {
    const none = new EditorFrame({
      frames: () => [],
      editorUrl: () => URL,
      clock: new FakeClock(),
    });
    await expect(none.deploy()).resolves.toBe(
      "The editor is not loaded, so its edits cannot be deployed.",
    );
    const { editor } = editorThat({ dirty: true, hasButton: false });
    await expect(editor.deploy()).resolves.toBe("The editor's Deploy button was not found.");
  });
});
