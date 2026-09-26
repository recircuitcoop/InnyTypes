// Pop-outs (spec 8.5): the pure rules (domain/views/popout.ts), the window adapter against a
// fake Electron (adapters/electron/popouts.ts), the notifier, and the shell's Inbox
// (application/inbox.ts): a first presentation notifies and opens its pop-out; a
// re-presentation opens nothing.

import { describe, expect, it } from "vitest";

import {
  CLOSE_AFTER_SUBMIT_MS,
  Popouts,
  type Answer,
  type PopoutWindow,
  type PopoutWindowOptions,
} from "../../src/adapters/electron/popouts";
import { electronDelivery, setAppUserModelId } from "../../src/adapters/electron/notifier";
import { Inbox, type InboxEvent } from "../../src/application/inbox";
import { compose } from "../../src/domain/notices/notices";
import type { CallOp } from "../../src/domain/channel/messages";
import {
  BRIDGE_CHANNELS,
  componentPackageOf,
  isAnytypeLink,
  isBounds,
  parsePlacements,
  placementKey,
  sanitizeValues,
  servedFile,
  VIEW_CSP,
  viewPageUrl,
  viewWebPreferences,
  type Bounds,
} from "../../src/domain/views/popout";
import type { Notice } from "../../src/ports/notifier";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger } from "../fixtures/raw-node/fixture";

describe("the pop-out rules", () => {
  it("the webPreferences are exactly spec 8.5.4's, with the bridge as preload", () => {
    expect(viewWebPreferences("/app/view-preload.cjs")).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      preload: "/app/view-preload.cjs",
    });
    expect(Object.isFrozen(viewWebPreferences("p"))).toBe(true);
  });

  it("the CSP is exactly spec 8.5.5's", () => {
    expect(VIEW_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it("only a flat object of short keys and strings, numbers and booleans crosses the bridge", () => {
    const long = "k".repeat(65);
    expect(
      sanitizeValues({
        a: "x".repeat(2_500),
        b: 3,
        c: true,
        d: { nested: 1 },
        e: [1],
        f: null,
        g: Number.NaN,
        [long]: "dropped",
        ["k".repeat(64)]: "kept",
      }),
    ).toEqual({ a: "x".repeat(2_000), b: 3, c: true, ["k".repeat(64)]: "kept" });
    expect(sanitizeValues(null)).toEqual({});
    expect(sanitizeValues([1, 2])).toEqual({});
    expect(sanitizeValues("text")).toEqual({});
  });

  it("a component draws a view only for the view's own package, with a valid element name", () => {
    const value = (content: unknown, pkg: unknown = "kit") => ({ content, package: pkg });
    expect(componentPackageOf(value({ component: { element: "kit-card" } }))).toBe("kit");
    expect(componentPackageOf(value({ component: { element: "nohyphen" } }))).toBeNull();
    expect(componentPackageOf(value({ component: { element: "kit-card" } }, null))).toBeNull();
    expect(componentPackageOf(value({ component: { element: "kit-card" } }, "app"))).toBeNull();
    expect(componentPackageOf(value({ component: "kit-card" }))).toBeNull();
    expect(componentPackageOf(value({ title: "t" }))).toBeNull();
    expect(componentPackageOf(value("not content"))).toBeNull();
    expect(componentPackageOf(null)).toBeNull();
    expect(viewPageUrl(null)).toBe("inny-view://app/view.html");
    expect(viewPageUrl("kit")).toBe("inny-view://kit/view.html");
  });

  it("placement is keyed by kind and type, and only well-formed bounds are read back", () => {
    expect(placementKey("view", { type: "inny-kit-ask" })).toBe("view:inny-kit-ask");
    expect(placementKey("snapshot", { type: "" })).toBeNull();
    expect(placementKey("view", null)).toBeNull();
    expect(isBounds({ x: 1, y: 2, width: 3, height: 4 })).toBe(true);
    expect(isBounds({ x: 1, y: 2, width: 0, height: 4 })).toBe(false);
    expect(isBounds({ x: 1.5, y: 2, width: 3, height: 4 })).toBe(false);
    const read = parsePlacements(
      JSON.stringify({ good: { x: 1, y: 2, width: 3, height: 4 }, bad: { x: "1" } }),
    );
    expect([...read.keys()]).toEqual(["good"]);
    expect(parsePlacements(null).size).toBe(0);
    expect(parsePlacements("{").size).toBe(0);
    expect(parsePlacements("[1]").size).toBe(0);
  });

  it("serves only flat names with a known extension", () => {
    expect(servedFile("/view.html")).toEqual({
      name: "view.html",
      type: "text/html; charset=utf-8",
    });
    expect(servedFile("/component.js")?.type).toMatch(/javascript/);
    expect(servedFile("/../secret.js")).toBeNull();
    expect(servedFile("/a/b.js")).toBeNull();
    expect(servedFile("/.hidden.js")).toBeNull();
    expect(servedFile("/run.sh")).toBeNull();
    expect(servedFile("/")).toBeNull();
  });

  it("an Anytype link is an object deep link and nothing else", () => {
    expect(isAnytypeLink("anytype://object?objectId=o-1&spaceId=s.2")).toBe(true);
    expect(isAnytypeLink("anytype://object?objectId=o&spaceId=s&x=javascript:1")).toBe(false);
    expect(isAnytypeLink("https://example.com")).toBe(false);
  });
});

// ── the adapter, against a fake Electron ─────────────────────────────────────────────────

class FakeWindow implements PopoutWindow {
  static next = 1;
  readonly listeners = new Map<string, (() => void)[]>();
  navigate: ((event: { preventDefault(): void }, url: string) => void) | null = null;
  openHandler: (() => { action: "deny" }) | null = null;
  loaded: string | null = null;
  focused = 0;
  destroyed = false;
  bounds: Bounds;
  readonly webContents;

  constructor(readonly options: PopoutWindowOptions) {
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width,
      height: options.height,
    };
    this.webContents = {
      id: FakeWindow.next++,
      on: (
        _event: "will-navigate",
        listener: (event: { preventDefault(): void }, url: string) => void,
      ) => {
        this.navigate = listener;
      },
      setWindowOpenHandler: (handler: () => { action: "deny" }) => {
        this.openHandler = handler;
      },
    };
  }

  loadURL(url: string): Promise<void> {
    this.loaded = url;
    return url.includes("fail") ? Promise.reject(new Error("no page")) : Promise.resolve();
  }
  on(event: "close" | "closed", listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  getBounds(): Bounds {
    return this.bounds;
  }
  focus(): void {
    this.focused += 1;
  }
  close(): void {
    for (const event of ["close", "closed"]) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener();
      }
    }
    this.destroyed = true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown;

function harness(answers: Partial<Record<CallOp, Answer>> = {}) {
  const windows: FakeWindow[] = [];
  const handlers = new Map<string, Handler>();
  const calls: { op: CallOp; args: unknown }[] = [];
  const placements = new Map<string, Bounds>();
  const opened: string[] = [];
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const popouts = new Popouts({
    createWindow: (options) => {
      const window = new FakeWindow(options);
      windows.push(window);
      return window;
    },
    ipc: { handle: (channel, handler) => handlers.set(channel, handler) },
    preload: "/dist/shell/view-preload.cjs",
    show: false,
    call: (op, args) => {
      calls.push({ op, args });
      return Promise.resolve(answers[op] ?? { ok: true, value: null });
    },
    placements: {
      get: (key) => placements.get(key) ?? null,
      set: (key, bounds) => placements.set(key, bounds),
    },
    openExternal: (url) => opened.push(url),
    clock,
    logger,
  });
  const bridge = (window: FakeWindow, name: keyof typeof BRIDGE_CHANNELS, ...args: unknown[]) =>
    (handlers.get(BRIDGE_CHANNELS[name]) as Handler)(
      { sender: { id: window.webContents.id } },
      ...args,
    );
  return { popouts, windows, handlers, calls, placements, opened, clock, logger, bridge };
}

const VIEW: Answer = {
  ok: true,
  value: { kind: "view", id: "v1", type: "inny-kit-ask", package: "kit", content: { title: "t" } },
};

describe("Popouts", () => {
  it("opens a window with the exact webPreferences in the inny-views partition, the generic page, and locks it down", async () => {
    const { popouts, windows, logger, opened } = harness({ "view.get": VIEW });
    await popouts.open({ kind: "view", id: "v1" }, "presented");
    const [window] = windows as [FakeWindow];
    expect(window.options.webPreferences).toEqual({
      ...viewWebPreferences("/dist/shell/view-preload.cjs"),
      partition: "inny-views",
    });
    expect(window.options).toMatchObject({ width: 560, height: 640, show: false });
    expect(window.loaded).toBe("inny-view://app/view.html");
    expect(popouts.list()).toEqual(["view:v1"]);
    expect(logger.has(/view:v1 opened in its own window \(presented\)/)).toBe(true);
    // Navigation is prevented; only an Anytype object link is handed to Anytype.
    let prevented = 0;
    window.navigate?.({ preventDefault: () => (prevented += 1) }, "https://example.com");
    window.navigate?.(
      { preventDefault: () => (prevented += 1) },
      "anytype://object?objectId=a&spaceId=b",
    );
    expect(prevented).toBe(2);
    expect(opened).toEqual(["anytype://object?objectId=a&spaceId=b"]);
    expect(window.openHandler?.()).toEqual({ action: "deny" });
  });

  it("a second open focuses the first; opens in flight are not doubled", async () => {
    const { popouts, windows } = harness({ "view.get": VIEW });
    await Promise.all([
      popouts.open({ kind: "view", id: "v1" }, "a"),
      popouts.open({ kind: "view", id: "v1" }, "b"),
    ]);
    await popouts.open({ kind: "view", id: "v1" }, "c");
    expect(windows).toHaveLength(1);
    expect(windows[0]?.focused).toBe(1);
  });

  it("a view drawn by its package's component loads that package's origin", async () => {
    const { popouts, windows } = harness({
      "view.get": {
        ok: true,
        value: {
          kind: "view",
          id: "v1",
          package: "kit",
          content: { component: { element: "kit-card" } },
        },
      },
    });
    await popouts.open({ kind: "view", id: "v1" }, "presented");
    expect(windows[0]?.loaded).toBe("inny-view://kit/view.html");
  });

  it("the bridge answers only for the window's own target, and refuses the wrong call", async () => {
    const { popouts, windows, calls, bridge, clock } = harness({ "view.get": VIEW });
    await popouts.open({ kind: "view", id: "v1" }, "presented");
    await popouts.open({ kind: "snapshot", id: "s1" }, "asked");
    const [view, snapshot] = windows as [FakeWindow, FakeWindow];
    calls.length = 0;
    await bridge(view, "get", "someone-else");
    await bridge(snapshot, "get");
    expect(calls).toEqual([
      { op: "view.get", args: { id: "v1" } },
      { op: "snapshot.get", args: { id: "s1" } },
    ]);
    expect(() => bridge(view, "action", "again", {})).toThrow("not a snapshot");
    expect(() => bridge(snapshot, "submit", {})).toThrow("not an action view");
    const stranger = { webContents: { id: 999 } } as unknown as FakeWindow;
    expect(() => bridge(stranger, "get")).toThrow("this window is not a view window");

    calls.length = 0;
    await bridge(snapshot, "action", 7, { why: "x".repeat(3_000), nested: {} });
    await bridge(view, "submit", { answer: "Ada", nested: { no: 1 } });
    expect(calls).toEqual([
      {
        op: "snapshot.action",
        args: { id: "s1", action: "7", values: { why: "x".repeat(2_000) } },
      },
      { op: "view.submit", args: { id: "v1", values: { answer: "Ada" } } },
    ]);
    // A successful submission closes its window a moment later.
    expect(view.isDestroyed()).toBe(false);
    clock.advance(CLOSE_AFTER_SUBMIT_MS);
    expect(view.isDestroyed()).toBe(true);
    expect(popouts.list()).toEqual(["snapshot:s1"]);
  });

  it("a refused submission leaves the window open", async () => {
    const { popouts, windows, bridge, clock } = harness({
      "view.get": VIEW,
      "view.submit": { ok: false, error: "This view is no longer waiting." },
    });
    await popouts.open({ kind: "view", id: "v1" }, "presented");
    expect(await bridge(windows[0] as FakeWindow, "submit", {})).toEqual({
      ok: false,
      error: "This view is no longer waiting.",
    });
    clock.advance(CLOSE_AFTER_SUBMIT_MS * 2);
    expect(windows[0]?.isDestroyed()).toBe(false);
  });

  it("remembers where a type's pop-out was left, and opens the next one there", async () => {
    const { popouts, windows, placements, logger } = harness({ "view.get": VIEW });
    await popouts.open({ kind: "view", id: "v1" }, "presented");
    const first = windows[0] as FakeWindow;
    first.bounds = { x: 10, y: 20, width: 600, height: 500 };
    popouts.close({ kind: "view", id: "v1" });
    popouts.close({ kind: "view", id: "v1" }); // closing a closed one does nothing
    expect(placements.get("view:inny-kit-ask")).toEqual(first.bounds);
    expect(logger.has(/view:v1 window closed/)).toBe(true);
    await popouts.open({ kind: "view", id: "v1" }, "again");
    expect(windows[1]?.options).toMatchObject({ x: 10, y: 20, width: 600, height: 500 });
  });

  it("a runtime that cannot answer still gets a window, on the generic page, at the default size", async () => {
    const { popouts, windows, placements, logger } = harness({
      "view.get": { ok: false, error: "the InnyTypes runtime is restarting" },
    });
    await popouts.open({ kind: "view", id: "fail" }, "presented");
    expect(windows[0]?.loaded).toBe("inny-view://app/view.html");
    windows[0]?.close();
    expect(placements.size).toBe(0);
    // A page that fails to load is said.
    const failing = harness({
      "view.get": {
        ok: true,
        value: { package: "fail", content: { component: { element: "a-b" } } },
      },
    });
    await failing.popouts.open({ kind: "view", id: "x" }, "presented");
    await Promise.resolve();
    await Promise.resolve();
    expect(failing.logger.has(/did not load inny-view:\/\/fail\/view.html/)).toBe(true);
    expect(logger.has(/opened/)).toBe(true);
  });
});

describe("electronDelivery", () => {
  function fake() {
    const shown: unknown[] = [];
    const clicks: (() => void)[] = [];
    class FakeNotification {
      static supported = true;
      static isSupported(): boolean {
        return FakeNotification.supported;
      }
      constructor(readonly options: { title: string; body: string }) {}
      on(_event: "click", listener: () => void): this {
        clicks.push(listener);
        return this;
      }
      show(): void {
        shown.push(this.options);
      }
    }
    return { FakeNotification, shown, clicks };
  }

  it("shows a message only when asked and supported, its text handed over as data", () => {
    const { FakeNotification, shown } = fake();
    const opened: string[] = [];
    const open = (): void => {
      opened.push("window");
    };
    const text = { title: 'monty "$(rm -rf ~)" `x`; <b>', body: "B" };
    electronDelivery(FakeNotification, true, open)(text);
    electronDelivery(FakeNotification, false, open)({ title: "Hidden", body: "B" });
    FakeNotification.supported = false;
    electronDelivery(FakeNotification, true, open)({ title: "Unsupported", body: "B" });
    expect(shown).toEqual([text]);
    expect(opened).toEqual([]);
  });

  it("opens the window on a click, once per click", () => {
    const { FakeNotification, clicks } = fake();
    const opened: string[] = [];
    electronDelivery(FakeNotification, true, () => opened.push("window"))({
      title: "T",
      body: "B",
    });
    clicks.forEach((click) => {
      click();
      click();
    });
    expect(opened).toEqual(["window", "window"]);
  });
});

describe("setAppUserModelId", () => {
  it("names the application to Windows, under the old helper's bundle identifier, and nowhere else", () => {
    const set: string[] = [];
    const app = { setAppUserModelId: (id: string) => set.push(id) };
    setAppUserModelId(app, "win32");
    setAppUserModelId(app, "darwin");
    setAppUserModelId(app, "linux");
    expect(set).toEqual(["it.l1nx.innytypes.helper"]);
  });
});

describe("Inbox (the shell's)", () => {
  function inbox(list: Answer = { ok: true, value: [] }) {
    const raised: Notice[] = [];
    const cleared: string[] = [];
    const popouts: string[] = [];
    const badges: number[] = [];
    const logger = new RecordingLogger();
    let listed = list;
    const kept = new Inbox({
      notifier: {
        raise: (notice) => raised.push(notice),
        clear: (kind, subject) => cleared.push(`${kind} ${subject}`),
      },
      openPopout: (id) => popouts.push(id),
      list: () => Promise.resolve(listed),
      badge: (count) => badges.push(count),
      logger,
    });
    const setList = (next: Answer): void => {
      listed = next;
    };
    return { kept, raised, cleared, popouts, badges, logger, setList };
  }
  const present = (
    id: string,
    first: boolean,
    window: "inline" | "popout" = "popout",
  ): InboxEvent => ({
    v: 1,
    t: "present",
    id,
    window,
    first,
    title: id === "untitled" ? "" : `Title ${id}`,
  });

  it("a first presentation notifies and opens its pop-out; a re-presentation opens nothing", () => {
    const { kept, raised, popouts, logger } = inbox();
    const heard: string[][] = [];
    kept.onChange((items) => heard.push(items.map((item) => item.id)));
    kept.receive(present("a", true));
    kept.receive(present("b", true, "inline"));
    kept.receive(present("untitled", true, "inline"));
    kept.receive(present("a", false));
    expect(popouts).toEqual(["a"]);
    expect(raised.map(compose)).toEqual([
      { title: "InnyTypes is waiting for you", body: "Title a" },
      { title: "InnyTypes is waiting for you", body: "Title b" },
      { title: "InnyTypes is waiting for you", body: "A view waits in the Inbox." },
    ]);
    expect(logger.has(/view a re-presented: it waits quietly in the Inbox/)).toBe(true);
    expect(kept.items().map((item) => item.id)).toEqual(["a", "b", "untitled"]);
    expect(heard.at(-1)).toEqual(["a", "b", "untitled"]);
  });

  it("the count sets the badge and asks the runtime for the list; a refusal keeps the last list", async () => {
    const { kept, badges, cleared, setList } = inbox({
      ok: true,
      value: [{ id: "b", title: "B", window: "inline" }, { id: 7 }],
    });
    const counts: number[] = [];
    kept.onCount((count) => counts.push(count));
    expect(kept.pending()).toBeNull();
    kept.receive(present("a", true));
    kept.receive({ v: 1, t: "pending", count: 1 });
    await kept.refresh();
    expect(badges).toEqual([1]);
    expect(counts).toEqual([1]);
    expect(kept.pending()).toBe(1);
    expect(kept.items()).toEqual([{ id: "b", title: "B", window: "inline" }]);
    // The view that left the Inbox is no longer waiting: its notice is cleared.
    expect(cleared).toEqual(["view-waiting a"]);
    setList({ ok: false, error: "the InnyTypes runtime is down" });
    await kept.refresh();
    expect(kept.items()).toEqual([{ id: "b", title: "B", window: "inline" }]);
    setList({ ok: true, value: "not a list" });
    await kept.refresh();
    expect(kept.items()).toHaveLength(1);
  });
});
