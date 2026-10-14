// AppApi v2 end to end without a DOM or Electron (plan 0022 §N): every call goes from the
// renderer's bridge (shell/app-bridge.ts) over an in-memory IPC to the shell's handlers
// (shell/app-calls.ts and its *-calls.ts), on to a fake runtime and services process, and comes
// back typed; every push event reaches the page's listener, coalesced.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IpcMain } from "electron";
import { describe, expect, it } from "vitest";
import { NOTHING_TO_UNDO_SENTENCE, RUN_GONE_SENTENCE } from "../../src/application/runs";
import type { Supervisor } from "../../src/application/supervisor";
import type { BoardOutcome, BoardRow } from "../../src/application/package-board";
import type { CallResult } from "../../src/domain/channel/errors";
import type { StepUse } from "../../src/domain/packages/states";
import type { EditorNode } from "../../src/ports/editor";
import type { ChildStatus } from "../../src/domain/supervision/child-state";
import type { UpdateEvent } from "../../src/domain/updates/machine";
import { appApiOver, type RendererIpc } from "../../src/shell/app-bridge";
import { wireAppCalls } from "../../src/shell/app-calls";
import { IPC } from "../../src/shell/ipc";
import { notifyingPackageChanges } from "../../src/shell/package-calls";
import { PushEvents } from "../../src/shell/push";
import { wireViews } from "../../src/shell/views";
import type { FlowSummary } from "../../src/ui/flow-contract";
import { RecordingLogger, RecordingNotifier } from "../fakes/children";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
type Listener = (event: unknown, ...args: unknown[]) => void;

const flow = (id: string, more: Partial<FlowSummary> = {}): FlowSummary => ({
  id,
  name: `Flow ${id}`,
  on: true,
  health: { kind: "ready" },
  lastRun: null,
  viewNodes: [],
  steps: [],
  sources: [],
  ...more,
});

const RUNNING = (child: "runtime" | "services"): ChildStatus => ({
  child,
  state: "running",
  generation: 1,
  pid: 1,
  port: null,
  error: null,
});

/** A fake child: answers each op from `answers`, or `{ok: true, value: op}`. */
class FakeChild {
  readonly calls: [string, unknown][] = [];
  readonly answers = new Map<string, (args: unknown) => CallResult>();
  readonly #view: ((event: never) => void)[] = [];
  readonly #status: ((status: ChildStatus) => void)[] = [];
  state: ChildStatus;
  /** A limit other than the default, so the banner is seen to name this one. */
  readonly crashLoop = { maxCrashes: 3, windowMs: 60_000 };

  constructor(name: "runtime" | "services") {
    this.state = RUNNING(name);
  }

  call(op: string, args: unknown): Promise<CallResult> {
    this.calls.push([op, args]);
    return Promise.resolve(this.answers.get(op)?.(args) ?? { ok: true, value: op });
  }
  onViewEvent(listener: (event: never) => void): void {
    this.#view.push(listener);
  }
  emit(event: object): void {
    for (const listener of this.#view) listener(event as never);
  }
  status(): ChildStatus {
    return this.state;
  }
  onStatus(listener: (status: ChildStatus) => void): void {
    this.#status.push(listener);
  }
  setState(state: ChildStatus["state"]): void {
    this.state = { ...this.state, state };
    for (const listener of this.#status) listener(this.state);
  }
}

/**
 * General's Packages board, faked: what it was asked, the use lists it was handed, and the
 * domain's rule for a use (refused, naming every one) or none (done).
 */
class FakeBoard {
  readonly calls: [string, ...unknown[]][] = [];
  outcome: BoardOutcome = { ok: true };
  rows: BoardRow[] = [];
  #judged(action: "unregister" | "remove", uses: readonly StepUse[]): BoardOutcome {
    return uses.length > 0
      ? { ok: false, refusal: { reason: "in-use", action, uses } }
      : this.outcome;
  }
  #did(op: string, ...args: unknown[]): Promise<BoardOutcome> {
    this.calls.push([op, ...args]);
    return Promise.resolve(this.outcome);
  }
  board = () => Promise.resolve({ rows: this.rows, offers: [] });
  install = (source: string, id: string) => this.#did("install", source, id);
  installFolder = (folder: string) => this.#did("installFolder", folder);
  update = (name: string) => this.#did("update", name);
  register = (name: string) => this.#did("register", name);
  checkFolder = (name: string) => this.#did("checkFolder", name);
  goBack = (name: string) => this.#did("goBack", name);
  unregister = (name: string, uses: readonly StepUse[]) => {
    this.calls.push(["unregister", name, uses]);
    return Promise.resolve(this.#judged("unregister", uses));
  };
  remove = (name: string, uses: readonly StepUse[]) => {
    this.calls.push(["remove", name, uses]);
    return Promise.resolve(this.#judged("remove", uses));
  };
}

function harness() {
  const handlers = new Map<string, Handler>();
  const pageListeners = new Map<string, Listener[]>();
  const ipcMain: Pick<IpcMain, "handle"> = {
    handle: (channel, handler) => {
      handlers.set(channel, handler as Handler);
    },
  };
  const renderer = {
    invoke: (channel: string, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.({}, ...args)),
    on: (channel: string, listener: Listener) => {
      pageListeners.set(channel, [...(pageListeners.get(channel) ?? []), listener]);
      return renderer;
    },
  };
  const sent: [string, unknown][] = [];
  const timers: (() => void)[] = [];
  const push = new PushEvents(
    (channel, ...args) => {
      sent.push([channel, args[0]]);
      for (const listener of pageListeners.get(channel) ?? []) listener({}, ...args);
    },
    (_ms, run) => {
      timers.push(run);
    },
  );
  /** Let the coalesced push events go. */
  const flush = () => {
    for (const run of timers.splice(0)) run();
  };
  const runtime = new FakeChild("runtime");
  const services = new FakeChild("services");
  services.answers.set("anytype.status", () => ({
    ok: true,
    value: { state: "ready", detail: null, childPid: 2, beats: 1, pairing: false },
  }));
  runtime.answers.set("view.list", () => ({ ok: true, value: [] }));
  const settings = {
    stored: {} as Record<string, unknown>,
    telemetry: "unset" as "unset" | "on" | "off",
    readSetup() {
      return this.stored["setup"];
    },
    writeSetup(state: Readonly<Record<string, unknown>>) {
      this.stored["setup"] = state;
    },
    readRunRetentionDays() {
      return this.stored["retention"] as number | null | undefined;
    },
    writeRunRetentionDays(days: number | null) {
      this.stored["retention"] = days;
    },
    readTelemetry() {
      return this.telemetry;
    },
  };
  const logger = new RecordingLogger();
  const dialogs = { folder: "/Users/me/packages/innyrize" as string | null };
  const quits: number[] = [];
  const board = new FakeBoard();
  /** The editor's canvas: deployed nodes and steps not saved yet, with their names. */
  const canvas = { nodes: null as EditorNode[] | null };
  const pending = wireViews({
    ipc: ipcMain,
    runtime: runtime as unknown as Supervisor,
    notifier: new RecordingNotifier(),
    openPopout: () => undefined,
    badge: () => undefined,
    toPage: push.toPage,
    logger,
  });
  // Node-RED's saved flows, where the runtime loads them from; none until a test writes it.
  const flowsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inny-v2-")), "flows.json");
  const updateCalls = wireAppCalls({
    ipc: ipcMain,
    flowsFile,
    runtime: runtime as unknown as Supervisor,
    services: services as unknown as Supervisor,
    editor: {
      palette: () => Promise.resolve({ sets: [], dirty: false }),
      deploy: () => Promise.resolve(null),
      loaded: () => true,
      nodes: () => Promise.resolve(canvas.nodes),
    },
    dialog: {
      showSaveDialog: () => Promise.resolve({ canceled: true, filePath: "" }),
      showOpenDialog: () =>
        Promise.resolve({
          canceled: dialogs.folder === null,
          filePaths: dialogs.folder === null ? [] : [dialogs.folder],
        }),
    },
    settings,
    packages: board,
    pending,
    toPage: push.toPage,
    currentVersion: () => "0.3.0",
    quit: () => quits.push(1),
    clock: { now: () => new Date(2026, 9, 2, 9, 30).getTime() },
    logger,
  });
  const api = appApiOver(renderer as unknown as RendererIpc);
  /** One raw invoke of a shell handler, as a page that sent a wrong op would. */
  const raw = (channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)?.({}, ...args));
  return {
    api,
    raw,
    ipcMain,
    runtime,
    services,
    settings,
    dialogs,
    quits,
    sent,
    flush,
    push,
    updateCalls,
    flowsFile,
    board,
    canvas,
  };
}

/** A tab and a node on it, as Node-RED saves a flow. */
const SAVED_FLOW = JSON.stringify([
  { id: "t1", type: "tab", label: "Flow 1" },
  { id: "n1", type: "inject", z: "t1" },
]);

const NOT_AVAILABLE = {
  ok: false,
  refused: { reason: "not-available", sentence: "refused.notAvailable" },
};
const FAILED = { ok: false, refused: { reason: "failed", sentence: "refused.failed" } };

describe("AppApi v2 calls, through the shell to its processes", () => {
  it("runs: list, get, clear and undo from the runtime; a known refusal by key", async () => {
    const h = harness();
    h.runtime.answers.set("run.list", () => ({ ok: true, value: { runs: [], next: null } }));
    expect(await h.api.runs({ flowId: "f" })).toEqual({
      ok: true,
      value: { runs: [], next: null },
    });
    h.runtime.answers.set("run.get", () => ({ ok: false, error: RUN_GONE_SENTENCE }));
    expect(await h.api.run("r1")).toEqual({
      ok: false,
      refused: { reason: "gone", sentence: "history.runGone" },
    });
    h.runtime.answers.set("run.clearDone", () => ({ ok: true, value: { count: 2 } }));
    expect(await h.api.clearDone("f")).toEqual({ ok: true, value: { count: 2 } });
    h.runtime.answers.set("run.undoClear", () => ({ ok: false, error: NOTHING_TO_UNDO_SENTENCE }));
    expect(await h.api.undoClear("f")).toEqual({
      ok: false,
      refused: { reason: "gone", sentence: "card.nothingToUndo" },
    });
    // Any other words the runtime refuses with are a failure; the channel's own, by its code.
    h.runtime.answers.set("run.get", () => ({ ok: false, error: "run.get failed: disk" }));
    expect(await h.api.run("r1")).toEqual(FAILED);
    h.runtime.answers.set("run.get", () => ({ ok: false, code: "down", error: "down" }));
    expect(await h.api.run("r1")).toEqual({
      ok: false,
      refused: { reason: "down", sentence: "refused.down" },
    });
    h.runtime.answers.set("run.get", () => ({ ok: false, code: "timeout", error: "slow" }));
    expect(await h.api.run("r1")).toEqual(FAILED);
    expect(h.runtime.calls.map(([op]) => op)).toEqual([
      "run.list",
      "run.get",
      "run.clearDone",
      "run.undoClear",
      "run.get",
      "run.get",
      "run.get",
    ]);
  });

  it("runs: re-run, re-run many and delete are not available until WI-0022-15", async () => {
    const h = harness();
    expect(await h.api.rerun("f", "r1")).toEqual(NOT_AVAILABLE);
    expect(await h.api.rerunMany("f", ["r1"])).toEqual(NOT_AVAILABLE);
    expect(await h.api.deleteRuns("f", ["r1"])).toEqual(NOT_AVAILABLE);
    expect(h.runtime.calls).toEqual([]);
  });

  it("flows: every call reaches the runtime and answers its value", async () => {
    const h = harness();
    h.runtime.answers.set("flow.list", () => ({ ok: true, value: [flow("f")] }));
    expect(await h.api.flows()).toEqual({ ok: true, value: [flow("f")] });
    expect((await h.api.setFlowOn("f", false)).ok).toBe(true);
    expect((await h.api.renameFlow("f", "New")).ok).toBe(true);
    expect((await h.api.duplicateFlow("f")).ok).toBe(true);
    expect((await h.api.deleteFlow("f")).ok).toBe(true);
    expect((await h.api.templates()).ok).toBe(true);
    expect((await h.api.flowFromTemplate("starter")).ok).toBe(true);
    expect((await h.api.nodeForm("f", "n")).ok).toBe(true);
    expect((await h.api.configureNode("f", "n", {})).ok).toBe(true);
    expect((await h.api.nodeOptions({ source: "spaces" })).ok).toBe(true);
    h.runtime.answers.set("flow.export", () => ({ ok: true, value: { name: "F", nodes: [] } }));
    expect(await h.api.exportFlow("f")).toEqual({ ok: true, value: { saved: null } });
    h.runtime.answers.set("node.options", () => ({
      ok: true,
      value: { options: [{ value: "s1", label: "Work" }] },
    }));
    expect(await h.api.anytypeSpaces()).toEqual({
      ok: true,
      value: { options: [{ value: "s1", label: "Work" }] },
    });
  });

  it("board: the default layout, reconciled with the flow's view nodes; save not yet", async () => {
    const h = harness();
    h.runtime.answers.set("flow.list", () => ({
      ok: true,
      value: [flow("f", { viewNodes: [{ id: "q1", name: "Approve", kind: "question" }] })],
    }));
    const board = await h.api.board("f");
    expect(board).toEqual({
      ok: true,
      value: {
        flowId: "f",
        tabs: [{ id: "tab-1", name: "Overview", order: 0 }],
        slots: [
          expect.objectContaining({ viewNodeId: "runs", kind: "card", tabId: "tab-1" }),
          expect.objectContaining({ viewNodeId: "q1", kind: "question", tabId: "tab-1" }),
        ],
      },
    });
    expect(await h.api.board("gone")).toEqual({
      ok: false,
      refused: { reason: "gone", sentence: "flows.refused.gone" },
    });
    h.runtime.answers.set("flow.list", () => ({ ok: false, code: "restarting", error: "r" }));
    expect(await h.api.board("f")).toEqual({
      ok: false,
      refused: { reason: "restarting", sentence: "refused.restarting" },
    });
    if (board.ok) {
      expect(await h.api.saveBoard(board.value)).toEqual(NOT_AVAILABLE);
    }
  });

  it("setup: a new installation starts at Welcome, moves, resumes and completes", async () => {
    const h = harness();
    h.runtime.answers.set("flow.list", () => ({ ok: true, value: [] }));
    expect(await h.api.setup()).toEqual({
      ok: true,
      value: { step: "welcome", formIndex: 0, formCount: 0, completed: false },
    });
    expect((await h.api.setSetupStep({ kind: "next" })).ok).toBe(true);
    expect(h.settings.stored["setup"]).toMatchObject({ step: "reports" });
    expect(await h.api.setSetupStep({ kind: "back" })).toMatchObject({
      value: { step: "welcome" },
    });
    for (let step = 0; step < 3; step += 1) await h.api.setSetupStep({ kind: "next" });
    expect(await h.api.setSetupStep({ kind: "starterForms", formCount: 2 })).toMatchObject({
      value: { step: "source-folder", formCount: 2 },
    });
    expect(await h.api.setSetupStep({ kind: "next" })).toMatchObject({
      value: { step: "node-forms", formIndex: 0 },
    });
    // Not a move: the state stays as it is.
    expect(
      await h.api.setSetupStep({ kind: "starterForms", formCount: "two" } as never),
    ).toMatchObject({ value: { step: "node-forms", formCount: 2 } });
    expect(await h.api.setSetupStep({ kind: "dance" } as never)).toMatchObject({
      value: { step: "node-forms" },
    });
    expect(await h.api.completeSetup()).toMatchObject({ value: { completed: true } });
    expect(await h.api.setSetupStep({ kind: "finish" })).toMatchObject({
      value: { completed: true },
    });
    expect(await h.api.trySample()).toEqual(NOT_AVAILABLE);
  });

  it("setup: Ready's closing choice completes it", async () => {
    const h = harness();
    h.settings.stored["setup"] = { step: "ready", formIndex: 0, formCount: 0 };
    expect(await h.api.setSetupStep({ kind: "finish" })).toMatchObject({
      value: { step: "ready", completed: true },
    });
  });

  it("setup: a 0.2.1 installation with flows, or a reports answer, never sees it", async () => {
    const withFlows = harness();
    fs.writeFileSync(withFlows.flowsFile, SAVED_FLOW);
    expect(await withFlows.api.setup()).toMatchObject({ value: { completed: true } });
    expect(withFlows.settings.stored["setup"]).toMatchObject({ completed: true });
    const answered = harness();
    answered.settings.telemetry = "off";
    answered.runtime.answers.set("flow.list", () => ({ ok: false, code: "down", error: "d" }));
    expect(await answered.api.setup()).toMatchObject({ value: { completed: true } });
  });

  it("setup: saved flows are judged from the flows file, never from a runtime still starting", async () => {
    // The window asks before the runtime is up: flow.list is refused while it starts.
    const h = harness();
    h.runtime.answers.set("flow.list", () => ({ ok: false, code: "restarting", error: "r" }));
    fs.writeFileSync(h.flowsFile, SAVED_FLOW);
    expect(await h.api.setup()).toMatchObject({ value: { completed: true } });
    expect(h.settings.stored["setup"]).toMatchObject({ completed: true });
    // A flows file with no tab is no flow: a new installation, stored as such.
    const empty = harness();
    fs.writeFileSync(empty.flowsFile, "[]");
    expect(await empty.api.setup()).toMatchObject({ value: { step: "welcome", completed: false } });
    expect(empty.settings.stored["setup"]).toMatchObject({ completed: false });
  });

  it("setup: a flows file that cannot be read stores no decision; the next read judges again", async () => {
    const h = harness();
    fs.writeFileSync(h.flowsFile, "{ not json");
    expect(await h.api.setup()).toMatchObject({ value: { step: "welcome", completed: false } });
    expect(h.settings.stored["setup"]).toBeUndefined();
    fs.writeFileSync(h.flowsFile, SAVED_FLOW);
    expect(await h.api.setup()).toMatchObject({ value: { completed: true } });
    expect(h.settings.stored["setup"]).toMatchObject({ completed: true });
  });

  it("update: the state follows each check's events; quit only with an update ready", async () => {
    const h = harness();
    expect(await h.api.updateState()).toEqual({
      ok: true,
      value: { state: { kind: "unchecked", version: "0.3.0" }, goBack: null },
    });
    // No platform self-updater attached: Check now is not available.
    expect(await h.api.checkNow()).toEqual(NOT_AVAILABLE);
    expect(await h.api.quitAndUpdate()).toEqual({
      ok: false,
      refused: { reason: "nothing-to-do", sentence: "update.notReady" },
    });
    const events: UpdateEvent[] = [
      { kind: "check" },
      { kind: "found", version: "0.4.0", at: new Date(2026, 9, 2, 9, 0) },
      { kind: "progress", percent: 100 },
      { kind: "downloaded" },
    ];
    h.updateCalls.attach({
      check: () => {
        for (const event of events) h.updateCalls.onEvent(event);
        return Promise.resolve({ ok: true, message: "checked" });
      },
    });
    expect(await h.api.checkNow()).toEqual({
      ok: true,
      value: { state: { kind: "ready", version: "0.4.0" }, goBack: null },
    });
    // An event the state does not take changes nothing.
    h.updateCalls.onEvent({ kind: "progress", percent: 5 });
    expect((await h.api.updateState()).ok && (await h.api.updateState())).toMatchObject({
      value: { state: { kind: "ready" } },
    });
    expect(await h.api.quitAndUpdate()).toEqual({ ok: true, value: null });
    expect(h.quits).toEqual([1]);
    expect(await h.api.goBack()).toEqual(NOT_AVAILABLE);
  });

  it("packages: unregister and remove name every flow and step that uses it; every outcome is a key", async () => {
    const h = harness();
    const steps = (type: string, name: string) => [{ id: name, name, type, setUp: true }];
    h.runtime.answers.set("flow.list", () => ({
      ok: true,
      value: [
        flow("a", {
          name: "Recordings to Anytype",
          steps: steps("inny-innyrize-diarize", "Transcribe"),
        }),
        flow("b", {
          name: "Invoices from the mailbox",
          steps: steps("inny-innyrize-pdf", "Read PDF"),
        }),
        flow("c", { name: "Photos", steps: steps("inny-anytype-create", "File") }),
      ],
    }));
    expect(await h.api.unregisterPackage("innyrize")).toEqual({
      ok: false,
      refused: {
        reason: "in-use",
        sentence: "packages.inUse.many",
        inUse: {
          name: "innyrize",
          action: "unregister",
          uses: [
            { flow: "Recordings to Anytype", step: "Transcribe" },
            { flow: "Invoices from the mailbox", step: "Read PDF" },
          ],
        },
      },
    });
    expect(await h.api.unregisterPackage("anytype")).toMatchObject({
      refused: { sentence: "packages.inUse.one" },
    });
    expect(await h.api.unregisterPackage("monty")).toEqual({ ok: true, value: null });
    expect(h.board.calls.at(-1)).toEqual(["unregister", "monty", []]);
    // A source counts as a use as much as a step does.
    h.runtime.answers.set("flow.list", () => ({
      ok: true,
      value: [flow("d", { name: "Watch", sources: steps("inny-folder-watch", "New file") })],
    }));
    expect(await h.api.uninstallPackage("folder")).toMatchObject({
      refused: {
        sentence: "packages.inUse.one",
        inUse: { action: "remove", uses: [{ flow: "Watch", step: "New file" }] },
      },
    });
    // A step on the canvas, not saved: a use as much as a deployed one, named as the canvas does.
    h.canvas.nodes = [
      { id: "New file", type: "inny-folder-watch", name: "New file", flow: "Watch" },
      { id: "draft", type: "inny-folder-watch", name: "Draft watch", flow: "Sketch" },
      { id: "other", type: "inject", name: "inject", flow: "Sketch" },
    ];
    expect(await h.api.unregisterPackage("folder")).toMatchObject({
      refused: {
        sentence: "packages.inUse.many",
        inUse: {
          action: "unregister",
          uses: [
            { flow: "Watch", step: "New file" },
            { flow: "Sketch", step: "Draft watch" },
          ],
        },
      },
    });
    h.canvas.nodes = null;
    h.runtime.answers.set("flow.list", () => ({ ok: false, code: "down", error: "d" }));
    expect(await h.api.unregisterPackage("monty")).toMatchObject({ refused: { reason: "down" } });
    expect(await h.api.registerPackage("monty")).toEqual({ ok: true, value: null });
    expect(await h.api.checkFolder("monty")).toEqual({ ok: true, value: null });
    expect(await h.api.installFolder("/Users/me/monty")).toEqual({ ok: true, value: null });
    expect(await h.api.installCatalogueEntry("official", "monty")).toEqual({
      ok: true,
      value: null,
    });
    h.board.outcome = { ok: false, refusal: { reason: "rollback-expired" } };
    expect(await h.api.goBackPackage("monty")).toMatchObject({
      refused: { sentence: "packages.goBackExpired" },
    });
    h.board.outcome = { ok: false, failed: "go-back", version: "0.1.0" };
    expect(await h.api.goBackPackage("monty")).toMatchObject({
      refused: { sentence: "packages.goBackFailed", params: { name: "monty", version: "0.1.0" } },
    });
    h.board.outcome = { ok: false, failed: "update" };
    expect(await h.api.updatePackage("monty")).toMatchObject({
      refused: { sentence: "packages.updateFailed", params: { name: "monty" } },
    });
    h.board.outcome = { ok: false, refusal: { reason: "busy" } };
    expect(await h.api.updatePackage("monty")).toMatchObject({ refused: { reason: "busy" } });
    expect(h.board.calls.map(([op]) => op)).toEqual([
      "unregister",
      "unregister",
      "unregister",
      "remove",
      "unregister",
      "register",
      "checkFolder",
      "installFolder",
      "install",
      "goBack",
      "goBack",
      "update",
      "update",
    ]);
    // Each one told the page the packages changed.
    h.flush();
    expect(h.sent.some(([channel]) => channel === IPC.packagesChanged)).toBe(true);
    expect(await h.api.chooseInstallFolder()).toEqual({
      ok: true,
      value: { folder: "/Users/me/packages/innyrize" },
    });
    h.dialogs.folder = null;
    expect(await h.api.chooseInstallFolder()).toEqual({ ok: true, value: { folder: null } });
  });

  it("status and retention: the pill, banner and badge; 90 days unless a choice is made", async () => {
    const h = harness();
    expect(await h.api.status()).toEqual({
      ok: true,
      // The runtime supervisor's own crash-loop limit, not a default restated.
      value: { pill: "running", banner: null, badge: 0, crashLoop: { crashes: 3, minutes: 1 } },
    });
    h.services.answers.set("anytype.status", () => ({ ok: false, code: "down", error: "d" }));
    expect(await h.api.status()).toMatchObject({ value: { pill: "running" } });
    expect(await h.api.retention()).toEqual({ ok: true, value: { days: 90 } });
    expect(await h.api.setRetention(30)).toEqual({ ok: true, value: { days: 30 } });
    expect(await h.api.setRetention(null)).toEqual({ ok: true, value: { days: null } });
    expect(await h.api.setRetention(45)).toEqual(FAILED);
    expect(h.settings.stored["retention"]).toBeNull();
  });

  it("answers an op no channel knows, and a handler that throws, as a refusal", async () => {
    const h = harness();
    for (const channel of [
      IPC.runCall,
      IPC.boardCall,
      IPC.setupCall,
      IPC.updateCall,
      IPC.packageCall,
      IPC.generalCall,
    ]) {
      expect(await h.raw(channel, { op: "nope" })).toEqual(FAILED);
    }
    h.settings.readRunRetentionDays = () => {
      throw new Error("unreadable");
    };
    expect(await h.api.retention()).toEqual(FAILED);
  });
});

describe("AppApi v2 push events, delivered and coalesced", () => {
  it("a burst of runs of one flow is one event; another flow's is its own", async () => {
    const h = harness();
    const heard: unknown[] = [];
    h.api.onRuns((changed) => heard.push(changed));
    for (const flowId of ["a", "a", "b", "a"]) h.runtime.emit({ v: 1, t: "runs", flowId });
    expect(heard).toEqual([]);
    h.flush();
    expect(heard).toEqual([{ flowId: "a" }, { flowId: "b" }]);
    await Promise.resolve();
  });

  it("flows and every board: one flows event, then each board's", async () => {
    const h = harness();
    h.runtime.answers.set("flow.list", () => ({ ok: true, value: [flow("a"), flow("b")] }));
    const flows: unknown[] = [];
    const boards: unknown[] = [];
    h.api.onFlows(() => flows.push("flows"));
    h.api.onBoard((changed) => boards.push(changed));
    h.runtime.emit({ v: 1, t: "flows" });
    h.runtime.emit({ v: 1, t: "flows" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.flush();
    expect(flows).toEqual(["flows"]);
    expect(boards).toEqual([{ flowId: "a" }, { flowId: "b" }]);
  });

  it("setup, update and status carry their last value; packages after a change", async () => {
    const h = harness();
    h.runtime.answers.set("flow.list", () => ({ ok: true, value: [] }));
    const heard: [string, unknown][] = [];
    h.api.onSetup((state) => heard.push(["setup", state.step]));
    h.api.onUpdateState((view) => heard.push(["update", view.state.kind]));
    h.api.onStatus((view) => heard.push(["status", view.pill]));
    h.api.onPackages(() => heard.push(["packages", null]));
    await h.api.setSetupStep({ kind: "next" });
    await h.api.setSetupStep({ kind: "next" });
    h.updateCalls.onEvent({ kind: "check" });
    h.updateCalls.onEvent({ kind: "found", version: null, at: new Date() });
    h.runtime.setState("restarting");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The Packages page's own calls, wrapped: a finished install tells the page.
    notifyingPackageChanges(h.ipcMain, h.push.toPage).handle(IPC.packageRemove, () =>
      Promise.resolve({ ok: true, message: "removed" }),
    );
    notifyingPackageChanges(h.ipcMain, h.push.toPage).handle(IPC.packages, () =>
      Promise.resolve(null),
    );
    await h.raw(IPC.packageRemove, "x");
    await h.raw(IPC.packages);
    h.flush();
    expect(heard).toEqual([
      ["setup", "connect-anytype"],
      ["update", "up-to-date"],
      ["status", "restarting"],
      ["packages", null],
    ]);
  });
});
