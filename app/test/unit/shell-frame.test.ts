// The parts main.ts hands its construction to (plan 0022 §N: main.ts only constructs): the app
// window, the shell's life and its quit, the children's status calls, and the push events'
// pass-through of every other message.
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";
import type { Supervisor } from "../../src/application/supervisor";
import type { ChildName, ChildStatus } from "../../src/domain/supervision/child-state";
import { wireChildCalls } from "../../src/shell/child-calls";
import { IPC } from "../../src/shell/ipc";
import { runShell } from "../../src/shell/lifecycle";
import { PushEvents } from "../../src/shell/push";
import { AppWindow } from "../../src/shell/window";
import { RecordingLogger } from "../fakes/children";

/** A BrowserWindow as far as AppWindow uses one. */
class FakeWindow extends EventEmitter {
  readonly loaded: string[] = [];
  readonly sent: unknown[][] = [];
  readonly calls: string[] = [];
  destroyed = false;
  minimized = false;
  readonly webContents = Object.assign(new EventEmitter(), {
    send: (...args: unknown[]) => this.sent.push(args),
  });
  loadURL(url: string) {
    this.loaded.push(url);
    return Promise.resolve();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.calls.push("restore");
  }
  show() {
    this.calls.push("show");
  }
  focus() {
    this.calls.push("focus");
  }
}

function appWindow() {
  const made: FakeWindow[] = [];
  const options: unknown[] = [];
  const logger = new RecordingLogger();
  const window = new AppWindow({
    createWindow: (given) => {
      options.push(given);
      const fake = new FakeWindow();
      made.push(fake);
      return fake as unknown as BrowserWindow;
    },
    url: "inny-app://app/index.html",
    preload: "/app/preload.cjs",
    hidden: true,
    logger,
  });
  return { window, made, options, logger };
}

describe("the app window", () => {
  it("opens one sandboxed window on the app pages, hidden for the gate", () => {
    const { window, made, options } = appWindow();
    expect(window.current).toBeNull();
    window.open();
    expect(made[0]?.loaded).toEqual(["inny-app://app/index.html"]);
    expect(options[0]).toMatchObject({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    expect(window.current).toBe(made[0]);
  });

  it("lets an unload go ahead, and forgets the window once it closes", () => {
    const { window, made, logger } = appWindow();
    window.open();
    let prevented = false;
    made[0]?.webContents.emit("will-prevent-unload", {
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(logger.lines).toContainEqual(expect.stringContaining("the unload goes ahead"));
    made[0]?.emit("closed");
    expect(window.current).toBeNull();
  });

  it("brings the one window forward, opening one when there is none", () => {
    const { window, made } = appWindow();
    window.bringForward();
    expect(made).toHaveLength(1);
    const first = made[0];
    if (first === undefined) throw new Error("no window");
    first.minimized = true;
    window.bringForward();
    expect(made).toHaveLength(1);
    expect(first.calls).toEqual(["show", "focus", "restore", "show", "focus"]);
    first.destroyed = true;
    window.bringForward();
    expect(made).toHaveLength(2);
  });

  it("sends to the page only while a window is open", () => {
    const { window, made } = appWindow();
    window.toPage("inny:x", 1);
    window.open();
    window.toPage("inny:x", 2);
    const first = made[0];
    if (first === undefined) throw new Error("no window");
    first.destroyed = true;
    window.toPage("inny:x", 3);
    expect(first.sent).toEqual([["inny:x", 2]]);
  });
});

describe("the push events", () => {
  it("pass every other message to the page at once", () => {
    const sent: unknown[][] = [];
    const push = new PushEvents(
      (...args) => sent.push(args),
      () => undefined,
    );
    push.toPage(IPC.childStatusChanged, { child: "runtime" });
    expect(sent).toEqual([[IPC.childStatusChanged, { child: "runtime" }]]);
  });
});

function lifecycle(lock = true) {
  const app = Object.assign(new EventEmitter(), {
    exits: [] as number[],
    quits: 0,
    ready: true,
    requestSingleInstanceLock: () => lock,
    exit: (code: number) => {
      app.exits.push(code);
    },
    isReady: () => app.ready,
    quit: () => {
      app.quits += 1;
    },
  });
  const signals = new EventEmitter();
  const requests: { ask: boolean }[] = [];
  const quitFlow = {
    done: false,
    request: (options: { ask: boolean }) => {
      requests.push(options);
      return Promise.resolve("quit" as never);
    },
  };
  const state = { forward: 0, open: false, started: true, startFails: false };
  const logger = new RecordingLogger();
  runShell({
    app: app as never,
    signals: signals as never,
    quitFlow,
    bringForward: () => {
      state.forward += 1;
    },
    windowOpen: () => state.open,
    started: () => state.started,
    start: () => (state.startFails ? Promise.reject(new Error("no")) : Promise.resolve()),
    logger,
  });
  return { app, signals, quitFlow, requests, state, logger };
}

describe("the shell's life", () => {
  it("exits at once when another instance runs, and starts nothing", () => {
    const { app, requests } = lifecycle(false);
    expect(app.exits).toEqual([0]);
    expect(app.listenerCount("before-quit")).toBe(0);
    expect(requests).toEqual([]);
  });

  it("brings the window forward on a second launch, and on a dock click with none open", () => {
    const { app, state } = lifecycle();
    app.emit("second-instance");
    app.emit("activate");
    state.open = true;
    app.emit("activate");
    state.open = false;
    state.started = false;
    app.emit("activate");
    app.emit("window-all-closed");
    expect(state.forward).toBe(2);
    expect(app.quits).toBe(0);
  });

  it("puts a quit through the QuitFlow, asking unless a signal asked for it", () => {
    const { app, signals, quitFlow, requests } = lifecycle();
    let prevented = 0;
    const event = {
      preventDefault: () => {
        prevented += 1;
      },
    };
    app.emit("before-quit", event);
    signals.emit("SIGTERM");
    expect(app.quits).toBe(1);
    app.emit("before-quit", event);
    signals.emit("SIGINT");
    quitFlow.done = true;
    app.emit("before-quit", event);
    expect(requests).toEqual([{ ask: true }, { ask: false }]);
    expect(prevented).toBe(2);
  });

  it("says why it could not start, and exits", async () => {
    const app = Object.assign(new EventEmitter(), {
      exits: [] as number[],
      requestSingleInstanceLock: () => true,
      exit: (code: number) => {
        app.exits.push(code);
      },
      isReady: () => true,
      quit: () => undefined,
    });
    const logger = new RecordingLogger();
    runShell({
      app: app as never,
      signals: new EventEmitter() as never,
      quitFlow: { done: false, request: () => Promise.resolve("quit" as never) },
      bringForward: () => undefined,
      windowOpen: () => false,
      started: () => false,
      start: () => Promise.reject(new Error("no port")),
      logger,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.exits).toEqual([1]);
    expect(logger.lines).toContainEqual(expect.stringContaining("could not start: Error: no port"));
  });
});

describe("the children's calls", () => {
  it("pushes each child's status, lists them, and restarts only a child by its name", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const listeners: ((status: ChildStatus) => void)[] = [];
    const recovered: string[] = [];
    const status: ChildStatus = {
      child: "runtime",
      state: "running",
      generation: 1,
      pid: 1,
      port: 1,
      error: null,
    };
    const supervisors = new Map<ChildName, Pick<Supervisor, "status" | "onStatus" | "recover">>([
      [
        "runtime",
        {
          status: () => status,
          onStatus: (listener) => {
            listeners.push(listener);
          },
          recover: () => {
            recovered.push("runtime");
            return true;
          },
        },
      ],
    ]);
    const sent: unknown[][] = [];
    wireChildCalls(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler as (event: unknown, ...args: unknown[]) => unknown);
        },
      },
      supervisors,
      (...args) => sent.push(args),
    );
    listeners[0]?.(status);
    expect(sent).toEqual([[IPC.childStatusChanged, status]]);
    expect(await handlers.get(IPC.childStatus)?.({})).toEqual([status]);
    await handlers.get(IPC.restartChild)?.({}, "runtime");
    await handlers.get(IPC.restartChild)?.({}, "nobody");
    expect(recovered).toEqual(["runtime"]);
  });
});
