// The one quit (WI-0018-12): undeployed edits are put to the person before anything stops
// (arch_pivot §4 surprise 1), and every quit that goes ahead stops every child, which is what
// runs RED.stop() in the runtime.

import { describe, expect, it } from "vitest";

import { isQuitChoice, QuitFlow, type QuitChoice } from "../../src/application/quit";
import type { EditorPalette, EditorWindow } from "../../src/ports/editor";
import { RecordingLogger } from "../fakes/children";

function flow(options: {
  palette: EditorPalette | null;
  answers?: QuitChoice[];
  deploys?: (string | null)[];
}) {
  const events: string[] = [];
  const asked: (string | null)[] = [];
  const answers = [...(options.answers ?? [])];
  const deploys = [...(options.deploys ?? [])];
  const editor: EditorWindow = {
    palette: () => Promise.resolve(options.palette),
    deploy: () => {
      events.push("deploy");
      return Promise.resolve(deploys.shift() ?? null);
    },
  };
  const logger = new RecordingLogger();
  const quit = new QuitFlow({
    editor,
    ask: (problem) => {
      asked.push(problem);
      events.push("ask");
      const answer = answers.shift();
      return answer === undefined ? new Promise(() => undefined) : Promise.resolve(answer);
    },
    stopChildren: () => {
      events.push("stop children");
      return Promise.resolve();
    },
    exit: () => {
      events.push("exit");
    },
    logger,
  });
  return { quit, events, asked, logger };
}

const DIRTY: EditorPalette = { sets: [], dirty: true };
const CLEAN: EditorPalette = { sets: [], dirty: false };

describe("the quit", () => {
  it("with a clean editor, or none, asks nothing and stops every child, then exits", async () => {
    for (const palette of [CLEAN, null]) {
      const { quit, events } = flow({ palette });
      expect(quit.idle).toBe(true);
      await expect(quit.request({ ask: true })).resolves.toBe("quit");
      expect(events).toEqual(["stop children", "exit"]);
      expect(quit.done).toBe(true);
      expect(quit.idle).toBe(false);
    }
  });

  it("Deploy and quit: deploys, then stops every child", async () => {
    const { quit, events, logger } = flow({ palette: DIRTY, answers: ["deploy"] });
    await expect(quit.request({ ask: true })).resolves.toBe("quit");
    expect(events).toEqual(["ask", "deploy", "stop children", "exit"]);
    expect(logger.lines).toContain("INFO Deploy and quit: the editor's edits are deployed");
  });

  it("Deploy and quit that fails asks again with the reason, and Cancel then keeps everything", async () => {
    const { quit, events, asked } = flow({
      palette: DIRTY,
      answers: ["deploy", "cancel"],
      deploys: ["Not installed in InnyTypes: exec"],
    });
    await expect(quit.request({ ask: true })).resolves.toBe("cancelled");
    expect(asked).toEqual([null, "Not installed in InnyTypes: exec"]);
    expect(events).toEqual(["ask", "deploy", "ask"]);
    expect(quit.idle).toBe(true);
    expect(quit.done).toBe(false);
  });

  it("Quit and discard: stops every child without deploying, and the log says so", async () => {
    const { quit, events, logger } = flow({ palette: DIRTY, answers: ["discard"] });
    await expect(quit.request({ ask: true })).resolves.toBe("quit");
    expect(events).toEqual(["ask", "stop children", "exit"]);
    expect(logger.lines).toContain(
      "WARN Quit and discard: the editor's undeployed edits are discarded",
    );
  });

  it("Cancel: nothing stops, and a later quit asks again", async () => {
    const { quit, events } = flow({ palette: DIRTY, answers: ["cancel", "discard"] });
    await expect(quit.request({ ask: true })).resolves.toBe("cancelled");
    expect(events).toEqual(["ask"]);
    await expect(quit.request({ ask: true })).resolves.toBe("quit");
    expect(events).toEqual(["ask", "ask", "stop children", "exit"]);
  });

  it("a quit on a signal asks nobody: the edits are discarded, and the log says so", async () => {
    const { quit, events, logger } = flow({ palette: DIRTY });
    await expect(quit.request({ ask: false })).resolves.toBe("quit");
    expect(events).toEqual(["stop children", "exit"]);
    expect(logger.lines).toContain(
      "WARN quitting on a signal: the editor's undeployed edits are discarded",
    );
  });

  it("a second quit while the first waits for its answer is busy, not a second question", async () => {
    const { quit, events } = flow({ palette: DIRTY });
    void quit.request({ ask: true });
    await Promise.resolve();
    await expect(quit.request({ ask: true })).resolves.toBe("busy");
    expect(events).toEqual(["ask"]);
  });
});

describe("isQuitChoice", () => {
  it("knows the three answers and nothing else", () => {
    expect(["deploy", "discard", "cancel"].every(isQuitChoice)).toBe(true);
    expect([undefined, "quit", 1].some(isQuitChoice)).toBe(false);
  });
});
