// The editor sync and the quit question in the app page (WI-0018-12), through AppApi and
// nothing else, with no DOM: node SETS compared (never definitions, arch_pivot P11 surprise 2),
// node/added and node/removed requested until the palette matches, the 10 s fallback for a
// clean and a dirty editor, and the three answers to a quit.

import { describe, expect, it } from "vitest";

import type {
  AppApi,
  ChildStatus,
  EditorPalette,
  ListResult,
  NodeSetSummary,
  PaletteChange,
  QuitQuestion,
} from "../../src/ui/contract";
import {
  CHECK_MS,
  FALLBACK_MS,
  FIRST_CHECK_MS,
  mountEditorSync,
  paletteChange,
  syncHtml,
  type SyncTimer,
} from "../../src/ui/pages/editor-sync";
import { mountApp, PAGES } from "../../src/ui/pages/app";
import type { PageEvent, Section } from "../../src/ui/pages/page";
import { mountQuitQuestion, quitQuestionHtml } from "../../src/ui/pages/quit-question";
import { ANYTYPE_UNUSED } from "../fakes/anytype";
import { VIEWS_UNUSED } from "../fakes/views";

const settle = async (): Promise<void> => {
  for (let n = 0; n < 20; n += 1) {
    await Promise.resolve();
  }
};

/** Time the sync sleeps through, moved by hand. */
class ManualTimer implements SyncTimer {
  #now = 0;
  #waiting: { at: number; resolve: () => void }[] = [];
  now(): number {
    return this.#now;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#waiting.push({ at: this.#now + ms, resolve });
    });
  }
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await settle();
      const due = this.#waiting.filter((w) => w.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      this.#waiting = this.#waiting.filter((w) => w !== due);
      this.#now = due.at;
      due.resolve();
    }
    this.#now = target;
    await settle();
  }
}

class FakeSection implements Section {
  listener: ((event: PageEvent) => void) | null = null;
  on(_type: "click" | "submit", listener: (event: PageEvent) => void): void {
    this.listener = listener;
  }
  click(attributes: Record<string, string>): void {
    this.listener?.({
      target: { getAttribute: (name: string) => attributes[name] ?? null },
      preventDefault: () => undefined,
    });
  }
}

const CORE: NodeSetSummary = { id: "node-red/inject", types: ["inject"] };
const LATE: NodeSetSummary = { id: "node-red/late", types: ["inny-late-one"] };
const GONE: NodeSetSummary = { id: "node-red/gone", types: ["inny-gone"] };

const running = (generation: number): ChildStatus => ({
  child: "runtime",
  state: "running",
  generation,
  pid: 10 + generation,
  port: 18_800,
  error: null,
});

/** An editor and a runtime the sync talks to through a fake AppApi. */
function harness(options: {
  editor: NodeSetSummary[] | null;
  runtime: NodeSetSummary[];
  dirty?: boolean;
  /** Whether a raised event reaches the editor (false: the convention broke). */
  eventsWork?: boolean;
  runtimeAnswers?: boolean;
}) {
  const state = {
    editor: options.editor,
    runtime: options.runtime,
    dirty: options.dirty ?? false,
    raised: [] as PaletteChange[],
    reloads: 0,
  };
  const api: AppApi = {
    ...ANYTYPE_UNUSED,
    ...VIEWS_UNUSED,
    secretStorage: () => Promise.reject(new Error("not used here")),
    childStatus: () => Promise.resolve([]),
    onChildStatus: () => undefined,
    restartChild: () => Promise.resolve(),
    editorPalette: (): Promise<EditorPalette | null> =>
      Promise.resolve(state.editor === null ? null : { sets: state.editor, dirty: state.dirty }),
    runtimeNodeSets: (): Promise<ListResult<NodeSetSummary>> =>
      Promise.resolve(
        options.runtimeAnswers === false
          ? { ok: false, error: "restarting", code: "restarting" }
          : { ok: true, value: state.runtime },
      ),
    raiseNodeEvents: (change) => {
      state.raised.push(change);
      if (options.eventsWork !== false && state.editor !== null) {
        const removed = new Set(change.removed.map((set) => set.id));
        state.editor = [
          ...state.editor.filter((set) => !removed.has(set.id)),
          ...state.runtime.filter((set) => change.added.includes(set.id)),
        ];
      }
      return Promise.resolve({ ok: true, value: null });
    },
  };
  const timer = new ManualTimer();
  const section = new FakeSection();
  const dom = {
    section,
    status: { innerHTML: "" },
    prompt: { innerHTML: "" },
    reload: () => {
      state.reloads += 1;
      if (state.editor !== null) {
        state.editor = [...state.runtime];
        state.dirty = false;
      }
    },
  };
  const onRuntime = mountEditorSync(dom, api, timer);
  const said = () => /data-state="([a-z-]+)"/.exec(dom.status.innerHTML)?.[1];
  return { state, timer, dom, section, onRuntime, said };
}

describe("paletteChange: node sets, not definitions", () => {
  it("asks for the runtime's sets the editor lacks, and the editor's sets the runtime lacks", () => {
    expect(paletteChange([CORE, LATE], [CORE, GONE])).toEqual({
      added: ["node-red/late"],
      removed: [GONE],
    });
    expect(paletteChange([CORE], [CORE])).toEqual({ added: [], removed: [] });
  });

  it("treats a set whose types changed as removed and added again", () => {
    const v2 = { id: "node-red/late", types: ["inny-late-one", "inny-late-two"] };
    expect(paletteChange([CORE, v2], [CORE, LATE])).toEqual({
      added: ["node-red/late"],
      removed: [LATE],
    });
    // The order of types within a set does not matter.
    const shuffled = { id: "node-red/late", types: ["inny-late-two", "inny-late-one"] };
    expect(paletteChange([v2], [shuffled])).toEqual({ added: [], removed: [] });
  });
});

describe("the editor sync after a runtime generation", () => {
  it("raises node/added and node/removed until the palette matches, then stops", async () => {
    const h = harness({ editor: [CORE, GONE], runtime: [CORE, LATE], dirty: true });
    h.onRuntime(running(2));
    expect(h.said()).toBe("checking");
    await h.timer.advance(FIRST_CHECK_MS);
    expect(h.state.raised).toEqual([{ added: ["node-red/late"], removed: [GONE] }]);
    await h.timer.advance(CHECK_MS);
    expect(h.said()).toBe("matched");
    expect(h.dom.status.innerHTML).toBe(syncHtml(2, "matched", 2));
    // Matched: no more checks, no reload, the dirty editor untouched.
    await h.timer.advance(FALLBACK_MS * 2);
    expect(h.state.raised).toHaveLength(1);
    expect(h.state.reloads).toBe(0);
    expect(h.dom.prompt.innerHTML).toBe("");
  });

  it("repeats while the events have not reached the editor yet (its websocket still down)", async () => {
    const h = harness({ editor: [CORE], runtime: [CORE, LATE], eventsWork: false });
    h.onRuntime(running(3));
    await h.timer.advance(FIRST_CHECK_MS + CHECK_MS * 2);
    expect(h.state.raised).toHaveLength(3);
    expect(h.said()).toBe("checking");
  });

  it("falls back after 10 s: a clean editor is reloaded, once", async () => {
    const h = harness({ editor: [CORE], runtime: [CORE, LATE], eventsWork: false });
    h.onRuntime(running(4));
    await h.timer.advance(FALLBACK_MS - 1);
    expect(h.state.reloads).toBe(0);
    await h.timer.advance(CHECK_MS);
    expect(h.state.reloads).toBe(1);
    expect(h.said()).toBe("reloaded");
    expect(h.dom.prompt.innerHTML).toBe("");
    await h.timer.advance(FALLBACK_MS);
    expect(h.state.reloads).toBe(1);
  });

  it("falls back after 10 s: a dirty editor is not reloaded; the person is asked", async () => {
    const h = harness({ editor: [CORE], runtime: [CORE, LATE], eventsWork: false, dirty: true });
    h.onRuntime(running(5));
    await h.timer.advance(FALLBACK_MS + CHECK_MS);
    expect(h.state.reloads).toBe(0);
    expect(h.said()).toBe("stale");
    expect(h.dom.prompt.innerHTML).toContain('data-testid="editor-reload"');
    expect(h.dom.prompt.innerHTML).toContain('data-testid="editor-keep"');
    h.section.click({ "data-editor-keep": "1" });
    expect(h.said()).toBe("kept");
    expect(h.dom.prompt.innerHTML).toBe("");
    expect(h.state.reloads).toBe(0);
  });

  it("reloads a dirty editor only when the person presses Reload", async () => {
    const h = harness({ editor: [CORE], runtime: [CORE, LATE], eventsWork: false, dirty: true });
    h.onRuntime(running(6));
    await h.timer.advance(FALLBACK_MS + CHECK_MS);
    h.section.click({ "data-other": "1" });
    expect(h.said()).toBe("stale");
    h.section.click({ "data-editor-reload": "1" });
    expect(h.state.reloads).toBe(1);
    expect(h.said()).toBe("reloaded");
  });

  it("does not fall back from an editor that is not loaded; it loads from this runtime", async () => {
    const h = harness({ editor: null, runtime: [CORE, LATE] });
    h.onRuntime(running(7));
    await h.timer.advance(FALLBACK_MS + CHECK_MS);
    expect(h.said()).toBe("no-editor");
    expect(h.state.raised).toEqual([]);
    expect(h.state.reloads).toBe(0);
  });

  it("keeps checking while the runtime cannot answer, then falls back", async () => {
    const h = harness({ editor: [CORE], runtime: [CORE], runtimeAnswers: false });
    h.onRuntime(running(8));
    await h.timer.advance(FALLBACK_MS + CHECK_MS);
    expect(h.state.raised).toEqual([]);
    expect(h.said()).toBe("reloaded");
  });

  it("syncs once per generation: a newer one takes the job over, a repeat or a stop does nothing", async () => {
    const h = harness({ editor: [CORE], runtime: [CORE, LATE], eventsWork: false });
    h.onRuntime(running(9));
    await h.timer.advance(FIRST_CHECK_MS);
    expect(h.state.raised).toHaveLength(1);
    h.onRuntime(running(9));
    h.onRuntime({ ...running(10), state: "restarting-planned" });
    await h.timer.advance(CHECK_MS);
    expect(h.state.raised).toHaveLength(2);
    h.onRuntime(running(10));
    // The old loop wakes, sees generation 10, and ends; the new one checks.
    await h.timer.advance(CHECK_MS);
    expect(h.dom.status.innerHTML).toContain('data-generation="10"');
    await h.timer.advance(FALLBACK_MS + CHECK_MS);
    expect(h.state.reloads).toBe(1);
  });

  it("drops a check whose generation was replaced while the runtime answered", async () => {
    const h = harness({ editor: [CORE], runtime: [CORE, LATE], eventsWork: false });
    let answer: ((value: ListResult<NodeSetSummary>) => void) | null = null;
    const onRuntime = mountEditorSync(
      h.dom,
      {
        editorPalette: () => Promise.resolve({ sets: [CORE], dirty: false }),
        runtimeNodeSets: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
        raiseNodeEvents: (change: PaletteChange) => {
          h.state.raised.push(change);
          return Promise.resolve({ ok: true, value: null });
        },
      } as unknown as AppApi,
      h.timer,
    );
    onRuntime(running(11));
    await h.timer.advance(FIRST_CHECK_MS);
    onRuntime(running(12));
    (answer as unknown as (value: ListResult<NodeSetSummary>) => void)({
      ok: true,
      value: [CORE, LATE],
    });
    await h.timer.advance(0);
    expect(h.state.raised).toEqual([]);
  });

  it("ignores the prompt's buttons before any generation was seen", () => {
    const h = harness({ editor: [CORE], runtime: [CORE] });
    h.section.click({ "data-editor-reload": "1" });
    expect(h.state.reloads).toBe(0);
    expect(h.dom.status.innerHTML).toBe("");
  });
});

describe("the quit question", () => {
  function mounted() {
    let ask: ((question: QuitQuestion) => void) | null = null;
    const answers: string[] = [];
    const section = new FakeSection();
    const box = { innerHTML: "", hidden: true };
    mountQuitQuestion({ section, box }, {
      onQuitQuestion: (listener: (question: QuitQuestion) => void) => {
        ask = listener;
      },
      answerQuit: (choice: string) => {
        answers.push(choice);
        return Promise.resolve();
      },
    } as unknown as AppApi);
    return {
      section,
      box,
      answers,
      ask: (question: QuitQuestion) => {
        (ask as unknown as (q: QuitQuestion) => void)(question);
      },
    };
  }

  it("offers exactly Deploy and quit, Quit and discard, and Cancel", () => {
    const html = quitQuestionHtml({ problem: null });
    expect(
      [...html.matchAll(/data-quit-choice="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => m[2]),
    ).toEqual(["Deploy and quit", "Quit and discard", "Cancel"]);
    expect(html).not.toContain("quit-problem");
    expect(quitQuestionHtml({ problem: "The deploy <failed>" })).toContain(
      'data-testid="quit-problem">The deploy &lt;failed&gt;</p>',
    );
  });

  for (const choice of ["deploy", "discard", "cancel"]) {
    it(`shows the question when the shell asks, and sends ${choice} back`, () => {
      const page = mounted();
      page.ask({ problem: null });
      expect(page.box.hidden).toBe(false);
      page.section.click({ "data-quit-choice": "nonsense" });
      expect(page.answers).toEqual([]);
      page.section.click({ "data-quit-choice": choice });
      expect(page.answers).toEqual([choice]);
      expect(page.box.hidden).toBe(true);
      expect(page.box.innerHTML).toBe("");
    });
  }
});

describe("the app page mounts both", () => {
  it("syncs the editor on each runtime state it hears, and shows the quit question", async () => {
    const h = harness({ editor: [CORE], runtime: [CORE] });
    let status: ((s: ChildStatus) => void) | null = null;
    let ask: ((q: QuitQuestion) => void) | null = null;
    const api = {
      ...VIEWS_UNUSED,
      ...ANYTYPE_UNUSED,
      childStatus: () => Promise.resolve([running(1)]),
      onChildStatus: (listener: (s: ChildStatus) => void) => {
        status = listener;
      },
      inbox: () => Promise.resolve([]),
      pendingViews: () => Promise.resolve(null),
      editorPalette: () => Promise.resolve({ sets: [CORE], dirty: false }),
      runtimeNodeSets: () => Promise.resolve({ ok: true, value: [CORE] }),
      onQuitQuestion: (listener: (q: QuitQuestion) => void) => {
        ask = listener;
      },
    } as unknown as AppApi;
    const region = () => ({ innerHTML: "" });
    const box = { innerHTML: "", hidden: true };
    await mountApp(
      {
        nav: new FakeSection(),
        sections: new Map(PAGES.map((name) => [name, { hidden: false }])),
        status: { innerHTML: "", addEventListener: () => undefined },
        runtimeLines: [],
        inbox: {
          section: new FakeSection(),
          list: region(),
          detail: region(),
          message: region(),
          badge: region(),
        },
        snapshots: {
          section: new FakeSection(),
          list: region(),
          detail: region(),
          message: region(),
        },
        jobs: { section: new FakeSection(), list: region(), message: region() },
        settings: {
          section: new FakeSection(),
          secrets: region(),
          endpoint: region(),
          anytype: region(),
          message: region(),
        },
        editorSync: h.dom,
        quitQuestion: { section: new FakeSection(), box },
      },
      api,
    );
    expect(h.dom.status.innerHTML).toContain('data-generation="1"');
    (status as unknown as (s: ChildStatus) => void)(running(2));
    expect(h.dom.status.innerHTML).toContain('data-generation="2"');
    (ask as unknown as (q: QuitQuestion) => void)({ problem: null });
    expect(box.hidden).toBe(false);
  });
});
