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
  // The runs read model (plan 0022 §C).
  runList: {
    call: (api) => api.runList({ flowId: "tab1", limit: 10 }),
    sent: [IPC.runCall, { op: "run.list", args: { flowId: "tab1", limit: 10 } }],
  },
  runGet: {
    call: (api) => api.runGet("r1"),
    sent: [IPC.runCall, { op: "run.get", args: { runId: "r1" } }],
  },
  runClearDone: {
    call: (api) => api.runClearDone("tab1"),
    sent: [IPC.runCall, { op: "run.clearDone", args: { flowId: "tab1" } }],
  },
  runUndoClear: {
    call: (api) => api.runUndoClear("tab1"),
    sent: [IPC.runCall, { op: "run.undoClear", args: { flowId: "tab1" } }],
  },
  // Flow administration (plan 0022 §D).
  flowList: {
    call: (api) => api.flowList(),
    sent: [IPC.flowCall, { op: "flow.list", args: null }],
  },
  flowTemplates: {
    call: (api) => api.flowTemplates(),
    sent: [IPC.flowCall, { op: "flow.templates", args: null }],
  },
  flowSetOn: {
    call: (api) => api.flowSetOn("tab1", false),
    sent: [IPC.flowCall, { op: "flow.setOn", args: { id: "tab1", on: false } }],
  },
  flowRename: {
    call: (api) => api.flowRename("tab1", "Invoices"),
    sent: [IPC.flowCall, { op: "flow.rename", args: { id: "tab1", name: "Invoices" } }],
  },
  flowDuplicate: {
    call: (api) => api.flowDuplicate("tab1"),
    sent: [IPC.flowCall, { op: "flow.duplicate", args: { id: "tab1" } }],
  },
  flowExport: {
    call: (api) => api.flowExport("tab1"),
    sent: [IPC.flowCall, { op: "flow.export", args: { id: "tab1" } }],
  },
  flowDelete: {
    call: (api) => api.flowDelete("tab1"),
    sent: [IPC.flowCall, { op: "flow.delete", args: { id: "tab1" } }],
  },
  flowFromTemplate: {
    call: (api) => api.flowFromTemplate("blank", "Mine"),
    sent: [IPC.flowCall, { op: "flow.fromTemplate", args: { templateId: "blank", name: "Mine" } }],
  },
  flowNodeForm: {
    call: (api) => api.flowNodeForm("tab1", "n1"),
    sent: [IPC.flowCall, { op: "flow.node.form", args: { flowId: "tab1", nodeId: "n1" } }],
  },
  nodeOptions: {
    call: (api) => api.nodeOptions({ source: "types", spaceId: "sp1" }),
    sent: [IPC.flowCall, { op: "node.options", args: { source: "types", spaceId: "sp1" } }],
  },
  flowNodeConfigure: {
    call: (api) => api.flowNodeConfigure("tab1", "n1", { space_id: "s" }),
    sent: [
      IPC.flowCall,
      {
        op: "flow.node.configure",
        args: { flowId: "tab1", nodeId: "n1", values: { space_id: "s" } },
      },
    ],
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
  launchAtLogin: {
    call: (api) => api.launchAtLogin(),
    sent: [IPC.launchAtLogin],
  },
  setLaunchAtLogin: {
    call: (api) => api.setLaunchAtLogin(true),
    sent: [IPC.setLaunchAtLogin, true],
  },
  // Updates and registered sources (WI-0018-17).
  checkPackageUpdates: { call: (api) => api.checkPackageUpdates(), sent: [IPC.packageCheck] },
  applyPackageUpdate: {
    call: (api) => api.applyPackageUpdate("probekit"),
    sent: [IPC.packageUpdate, "probekit"],
  },
  installFromSource: {
    call: (api) => api.installFromSource("acme", "whodunnit", true),
    sent: [IPC.packageInstallSource, "acme", "whodunnit", true],
  },
  registerSource: {
    call: (api) => api.registerSource("acme", "https://acme.test/c.json", "KEY"),
    sent: [IPC.sourceRegister, "acme", "https://acme.test/c.json", "KEY"],
  },
  removeSource: { call: (api) => api.removeSource("acme"), sent: [IPC.sourceRemove, "acme"] },
  setSourceAutoUpdate: {
    call: (api) => api.setSourceAutoUpdate("acme", false),
    sent: [IPC.sourceAutoUpdate, "acme", false],
  },
  // The telemetry question and switch (WI-0018-22).
  telemetry: { call: (api) => api.telemetry(), sent: [IPC.telemetry] },
  setTelemetry: { call: (api) => api.setTelemetry(false), sent: [IPC.setTelemetry, false] },
  // The old installation's plugin environments (WI-0018-25).
  legacyPackages: { call: (api) => api.legacyPackages(), sent: [IPC.legacyPackages] },
  deleteLegacyPackages: {
    call: (api) => api.deleteLegacyPackages(),
    sent: [IPC.deleteLegacyPackages],
  },
};

/** Each subscription: the channel the shell sends on, and what the listener hears. */
const SUBSCRIPTIONS: Record<string, { channel: string; sent: unknown }> = {
  onChildStatus: { channel: IPC.childStatusChanged, sent: { child: "runtime", state: "running" } },
  onViewPresented: { channel: IPC.viewPresented, sent: { id: "v1", first: true } },
  onPendingViews: { channel: IPC.pendingViews, sent: 3 },
  onJobs: { channel: IPC.jobsChanged, sent: undefined },
  onRuns: { channel: IPC.runsChanged, sent: { flowId: "tab1" } },
  onFlows: { channel: IPC.flowsChanged, sent: undefined },
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
