// The AppApi contract (plan 0018 §2.4), with no DOM and no Electron: every method of the
// bridge the preload exposes as `window.inny.app` (shell/app-bridge.ts), against a recording
// IPC. The list of methods is checked whole, so a method added to the contract without a case
// here fails this test.

import { describe, expect, it } from "vitest";

import { appApiOver, type RendererIpc } from "../../src/shell/app-bridge";
import { IPC } from "../../src/shell/ipc";
import type { AppApi } from "../../src/ui/contract";

type Listener = (event: unknown, ...args: unknown[]) => void;

function recording() {
  const invoked: unknown[][] = [];
  const listeners = new Map<string, Listener>();
  const answers = new Map<string, unknown>();
  const ipc = {
    invoke: (channel: string, ...args: unknown[]) => {
      invoked.push([channel, ...args]);
      return Promise.resolve(answers.get(channel) ?? `answer of ${channel}`);
    },
    on: (channel: string, listener: Listener) => {
      listeners.set(channel, listener);
      return ipc;
    },
  };
  return { ipc: ipc as unknown as RendererIpc, invoked, listeners, answers };
}

/** Each call: what the page calls, and the IPC it must make. */
const CALLS: Record<string, { call: (api: AppApi) => Promise<unknown>; sent: unknown[] }> = {
  secretStorage: { call: (api) => api.secretStorage(), sent: [IPC.secretStorage] },
  childStatus: { call: (api) => api.childStatus(), sent: [IPC.childStatus] },
  restartChild: { call: (api) => api.restartChild("runtime"), sent: [IPC.restartChild, "runtime"] },
  anytypeStatus: { call: (api) => api.anytypeStatus(), sent: [IPC.anytypeStatus] },
  startAnytypePairing: { call: (api) => api.startAnytypePairing(), sent: [IPC.anytypePairStart] },
  completeAnytypePairing: {
    call: (api) => api.completeAnytypePairing("1234"),
    sent: [IPC.anytypePairComplete, "1234"],
  },
  mcpEndpoint: { call: (api) => api.mcpEndpoint(), sent: [IPC.mcpEndpoint] },
  moveMcpEndpoint: {
    call: (api) => api.moveMcpEndpoint("127.0.0.1", 31011),
    sent: [IPC.mcpEndpointMove, "127.0.0.1", 31011],
  },
  pendingViews: { call: (api) => api.pendingViews(), sent: [IPC.pendingViewsNow] },
  view: {
    call: (api) => api.view("v1"),
    sent: [IPC.viewCall, { op: "view.get", args: { id: "v1" } }],
  },
  submitView: {
    call: (api) => api.submitView("v1", { a: 1 }),
    sent: [IPC.viewCall, { op: "view.submit", args: { id: "v1", values: { a: 1 } } }],
  },
  snapshot: {
    call: (api) => api.snapshot("s1"),
    sent: [IPC.viewCall, { op: "snapshot.get", args: { id: "s1" } }],
  },
  pressAction: {
    call: (api) => api.pressAction("s1", "again", { why: "x" }),
    sent: [
      IPC.viewCall,
      { op: "snapshot.action", args: { id: "s1", action: "again", values: { why: "x" } } },
    ],
  },
  inbox: { call: (api) => api.inbox(), sent: [IPC.inbox] },
  openView: { call: (api) => api.openView("v1"), sent: [IPC.openView, "v1"] },
  snapshots: {
    call: (api) => api.snapshots(),
    sent: [IPC.listCall, { op: "snapshot.list", args: null }],
  },
  openSnapshot: { call: (api) => api.openSnapshot("s1"), sent: [IPC.openSnapshot, "s1"] },
  jobs: { call: (api) => api.jobs(), sent: [IPC.listCall, { op: "job.list", args: null }] },
  quit: { call: (api) => api.quit(), sent: [IPC.quit] },
  cancelJob: {
    call: (api) => api.cancelJob("in-1"),
    sent: [IPC.listCall, { op: "job.cancel", args: { id: "in-1" } }],
  },
  editorPalette: { call: (api) => api.editorPalette(), sent: [IPC.editorPalette] },
  runtimeNodeSets: {
    call: (api) => api.runtimeNodeSets(),
    sent: [IPC.editorCall, { op: "editor.nodes", args: null }],
  },
  raiseNodeEvents: {
    call: (api) => api.raiseNodeEvents({ added: ["node-red/a"], removed: [] }),
    sent: [IPC.editorCall, { op: "editor.sync", args: { added: ["node-red/a"], removed: [] } }],
  },
  answerQuit: { call: (api) => api.answerQuit("cancel"), sent: [IPC.quitAnswer, "cancel"] },
  eventTypes: {
    call: (api) => api.eventTypes(),
    sent: [IPC.eventCall, { op: "event.list", args: null }],
  },
  createEventType: {
    call: (api) => api.createEventType("note", "Note", { type: "object" }),
    sent: [
      IPC.eventCall,
      { op: "event.create", args: { name: "note", label: "Note", schema: { type: "object" } } },
    ],
  },
  versionEventType: {
    call: (api) => api.versionEventType("note", { type: "object" }),
    sent: [
      IPC.eventCall,
      { op: "event.version", args: { name: "note", schema: { type: "object" } } },
    ],
  },
  deleteEventType: {
    call: (api) => api.deleteEventType("user.note.v1"),
    sent: [IPC.eventCall, { op: "event.delete", args: { type: "user.note.v1" } }],
  },
  fireEvent: {
    call: (api) => api.fireEvent("user.note.v1", { a: 1 }),
    sent: [IPC.eventCall, { op: "event.fire", args: { type: "user.note.v1", values: { a: 1 } } }],
  },
  // The Packages page (WI-0018-16).
  packages: { call: (api) => api.packages(), sent: [IPC.packages] },
  installFromCatalogue: {
    call: (api) => api.installFromCatalogue("probekit"),
    sent: [IPC.packageInstall, "probekit"],
  },
  chooseInstallFile: { call: (api) => api.chooseInstallFile(), sent: [IPC.packageChooseFile] },
  installFromFile: {
    call: (api) => api.installFromFile("/dev/pkg", true),
    sent: [IPC.packageInstallFile, "/dev/pkg", true],
  },
  removePackage: {
    call: (api) => api.removePackage("probekit"),
    sent: [IPC.packageRemove, "probekit"],
  },
};

/** Each subscription: the channel the shell sends on, and what the listener hears. */
const SUBSCRIPTIONS: Record<string, { channel: string; sent: unknown }> = {
  onChildStatus: { channel: IPC.childStatusChanged, sent: { child: "runtime", state: "running" } },
  onViewPresented: { channel: IPC.viewPresented, sent: { id: "v1", first: true } },
  onPendingViews: { channel: IPC.pendingViews, sent: 3 },
  onInbox: { channel: IPC.inboxChanged, sent: [{ id: "v1", title: "T", window: "inline" }] },
  onQuitQuestion: { channel: IPC.quitQuestion, sent: { problem: null } },
};

describe("AppApi over IPC", () => {
  it("has exactly the methods this test covers", () => {
    const api = appApiOver(recording().ipc);
    expect(Object.keys(api).sort()).toEqual(
      [...Object.keys(CALLS), ...Object.keys(SUBSCRIPTIONS)].sort(),
    );
  });

  for (const [name, { call, sent }] of Object.entries(CALLS)) {
    it(`${name} makes one IPC call and answers what the shell answered`, async () => {
      const { ipc, invoked } = recording();
      const answer = await call(appApiOver(ipc));
      expect(invoked).toEqual([sent]);
      // The Promise<void> calls answer nothing; every other passes the shell's answer on.
      const voided = ["restartChild", "openView", "openSnapshot", "quit", "answerQuit"].includes(
        name,
      );
      expect(answer).toEqual(voided ? undefined : `answer of ${String(sent[0])}`);
    });
  }

  for (const [name, { channel, sent }] of Object.entries(SUBSCRIPTIONS)) {
    it(`${name} hears what the shell sends on ${channel}`, () => {
      const { ipc, listeners } = recording();
      const heard: unknown[] = [];
      const api = appApiOver(ipc) as unknown as Record<string, (l: (v: unknown) => void) => void>;
      (api[name] as (l: (v: unknown) => void) => void)((value) => heard.push(value));
      listeners.get(channel)?.({}, sent);
      expect(heard).toEqual([sent]);
    });
  }
});
