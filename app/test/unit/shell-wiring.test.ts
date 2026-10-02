// The shell helpers main.ts hands its adapters to (WI-0018-21 moved them out of main.ts to keep
// it under 600 lines): the views' IPC and Inbox, and the quit question.
import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";
import type { Supervisor, ViewMessage } from "../../src/application/supervisor";
import { IPC } from "../../src/shell/ipc";
import { wireDesktop } from "../../src/shell/desktop";
import { exposeE2eHooks } from "../../src/shell/e2e-hooks";
import { quitQuestion, wireQuit } from "../../src/shell/quit-question";
import { wireServiceCalls } from "../../src/shell/service-calls";
import { wireViews } from "../../src/shell/views";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

describe("wireViews", () => {
  function wired() {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const sent: unknown[][] = [];
    const opened: string[] = [];
    const badges: number[] = [];
    let raise: ((event: ViewMessage) => void) | null = null;
    const runtime = {
      call: () => Promise.resolve({ ok: true, value: [{ id: "a", title: "A", window: "inline" }] }),
      onViewEvent: (listener: (event: ViewMessage) => void) => {
        raise = listener;
      },
    } as unknown as Supervisor;
    const notifier = new RecordingNotifier();
    wireViews({
      ipc: { handle: (channel, handler) => handlers.set(channel, handler) },
      runtime,
      notifier,
      openPopout: (target, why) => opened.push(`${target.kind}:${target.id} ${why}`),
      badge: (count) => badges.push(count),
      toPage: (channel, ...args) => sent.push([channel, ...args]),
      logger: new RecordingLogger(),
    });
    const call = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)?.({} as IpcMainInvokeEvent, ...args);
    const emit = (event: ViewMessage) => raise?.(event);
    return { call, emit, sent, opened, badges, notifier };
  }

  it("keeps the Inbox, tells the page, notifies a first presentation and opens its pop-out", async () => {
    const { call, emit, sent, opened, badges, notifier } = wired();
    emit({ v: 1, t: "present", id: "a", window: "popout", first: true, title: "A" });
    emit({ v: 1, t: "pending", count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifier.notices).toEqual([{ kind: "view-waiting", subject: "a", detail: "A" }]);
    expect(opened).toEqual(["view:a presented"]);
    expect(badges).toEqual([1]);
    expect(sent.map(([channel]) => channel)).toContain(IPC.viewPresented);
    expect(sent.map(([channel]) => channel)).toContain(IPC.pendingViews);
    expect(sent.map(([channel]) => channel)).toContain(IPC.inboxChanged);
    expect(call(IPC.pendingViewsNow)).toBe(1);
    expect(call(IPC.inbox)).toEqual([{ id: "a", title: "A", window: "inline" }]);
  });

  it("tells the page a flow's runs changed, the Jobs page too, and leaves the Inbox alone", () => {
    const { emit, sent, badges } = wired();
    emit({ v: 1, t: "runs", flowId: "tab1" });
    expect(sent).toEqual([[IPC.runsChanged, { flowId: "tab1" }], [IPC.jobsChanged]]);
    expect(badges).toEqual([]);
  });

  it("opens a view or a snapshot the page asks for, and nothing for an empty id", () => {
    const { call, opened } = wired();
    call(IPC.openView, "v1");
    call(IPC.openSnapshot, "s1");
    call(IPC.openView, "");
    call(IPC.openSnapshot, 7);
    expect(opened).toEqual([
      "view:v1 opened from the Inbox",
      "snapshot:s1 opened from the Snapshots page",
    ]);
  });
});

describe("quitQuestion", () => {
  class FakeWindow extends EventEmitter {
    destroyed = false;
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  function asked(window: FakeWindow | null, hidden = false) {
    const sent: unknown[][] = [];
    let forward = 0;
    const logger = new RecordingLogger();
    const question = quitQuestion({
      window: () => window as unknown as BrowserWindow | null,
      toPage: (channel, ...args) => sent.push([channel, ...args]),
      bringForward: () => {
        forward += 1;
      },
      hidden,
      logger,
    });
    return { question, sent, forwards: () => forward, logger };
  }

  it("asks in the window, brings it forward, and resolves with the person's answer", async () => {
    const { question, sent, forwards, logger } = asked(new FakeWindow());
    const answer = question.ask("the editor did not answer");
    expect(sent).toEqual([[IPC.quitQuestion, { problem: "the editor did not answer" }]]);
    expect(forwards()).toBe(1);
    question.answer("deploy");
    expect(await answer).toBe("deploy");
    expect(logger.lines.join("\n")).toContain("the quit question was answered: deploy");
    // An answer with no question waiting does nothing.
    question.answer("discard");
  });

  it("discards when there is no window, or it closes before an answer; hidden runs keep focus", async () => {
    expect(await asked(null).question.ask(null)).toBe("discard");
    const gone = new FakeWindow();
    gone.destroyed = true;
    expect(await asked(gone).question.ask(null)).toBe("discard");
    const window = new FakeWindow();
    const { question, forwards } = asked(window, true);
    const answer = question.ask(null);
    window.emit("closed");
    expect(await answer).toBe("discard");
    expect(forwards()).toBe(0);
  });
});

describe("wireQuit, wireServiceCalls, wireDesktop and the e2e hooks", () => {
  function ipc() {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const call = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)?.({} as IpcMainInvokeEvent, ...args);
    return { handle: (channel: string, handler: never) => handlers.set(channel, handler), call };
  }

  it("Quit in the window quits; an answer reaches the waiting question only when it is one", () => {
    const { handle, call } = ipc();
    const answers: string[] = [];
    let quits = 0;
    wireQuit(
      { handle },
      { ask: () => Promise.resolve("discard"), answer: (choice) => answers.push(choice) },
      {
        quit: () => {
          quits += 1;
        },
      },
      new RecordingLogger(),
    );
    call(IPC.quit);
    call(IPC.quitAnswer, "deploy");
    call(IPC.quitAnswer, "nonsense");
    expect(quits).toBe(1);
    expect(answers).toEqual(["deploy"]);
  });

  it("the Anytype and endpoint calls go to the services process, and a refusal is thrown", async () => {
    const { handle, call } = ipc();
    const asked: unknown[] = [];
    const services = {
      call: (op: string, args: unknown) => {
        asked.push([op, args]);
        return Promise.resolve(
          op === "anytype.pair.complete"
            ? { ok: false, error: "wrong code" }
            : { ok: true, value: op },
        );
      },
    } as unknown as Supervisor;
    wireServiceCalls({ handle }, services);
    expect(await call(IPC.anytypeStatus)).toBe("anytype.status");
    expect(await call(IPC.anytypePairStart)).toBe("anytype.pair.start");
    await expect(call(IPC.anytypePairComplete, "1234")).rejects.toThrow("wrong code");
    expect(await call(IPC.mcpEndpoint)).toBe("mcp.endpoint");
    expect(await call(IPC.mcpEndpointMove, "127.0.0.1", 31011)).toBe("mcp.endpoint.move");
    expect(asked).toContainEqual(["mcp.endpoint.move", { host: "127.0.0.1", port: 31011 }]);
  });

  it("wireDesktop builds the one board, and with no login item the switch refuses", () => {
    const { handle, call } = ipc();
    const shown: string[] = [];
    const written: number[] = [];
    const { notices: board } = wireDesktop({
      ipc: { handle },
      deliver: (message) => shown.push(message.title),
      noticeFile: { write: (notices) => written.push(notices.length) },
      loginItem: null,
      setting: { readLaunchAtLogin: () => false, writeLaunchAtLogin: () => undefined },
      logger: new RecordingLogger(),
    });
    board.raise({ kind: "view-waiting", subject: "v" });
    board.raise({ kind: "view-waiting", subject: "v" });
    expect(shown).toEqual(["InnyTypes is waiting for you"]);
    expect(written).toEqual([1]);
    expect(call(IPC.setLaunchAtLogin, true)).toMatchObject({ on: false });
  });

  it("the e2e hooks are put where the e2e reads them", () => {
    const hooks = { restart: () => true, popouts: () => [], editorEvents: () => undefined };
    exposeE2eHooks(hooks);
    expect((globalThis as { innytypesE2E?: unknown }).innytypesE2E).toBe(hooks);
  });
});
