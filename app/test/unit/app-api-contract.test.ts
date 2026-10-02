// The AppApi contract (plan 0018 §2.4, plan 0022 §N), with no DOM and no Electron: every method
// of the bridge the preload exposes as `window.inny.app` (shell/app-bridge.ts and
// app-bridge-v2.ts), against a recording IPC. app-api-v2.test.ts takes the v2 calls on through
// the shell's handlers. The list of methods is checked whole, so a method added to the contract without a case
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
  // AppApi v2 (plan 0022 §N): one `{op, args}` invoke each.
  runs: {
    call: (api) => api.runs({ flowId: "tab1", limit: 10 }),
    sent: [IPC.runCall, { op: "run.list", args: { flowId: "tab1", limit: 10 } }],
  },
  run: {
    call: (api) => api.run("r1"),
    sent: [IPC.runCall, { op: "run.get", args: { runId: "r1" } }],
  },
  clearDone: {
    call: (api) => api.clearDone("tab1"),
    sent: [IPC.runCall, { op: "run.clearDone", args: { flowId: "tab1" } }],
  },
  undoClear: {
    call: (api) => api.undoClear("tab1"),
    sent: [IPC.runCall, { op: "run.undoClear", args: { flowId: "tab1" } }],
  },
  rerun: {
    call: (api) => api.rerun("tab1", "r1", "n2"),
    sent: [IPC.runCall, { op: "run.rerun", args: { flowId: "tab1", runId: "r1", from: "n2" } }],
  },
  rerunMany: {
    call: (api) => api.rerunMany("tab1", ["r1", "r2"]),
    sent: [IPC.runCall, { op: "run.rerunMany", args: { flowId: "tab1", runIds: ["r1", "r2"] } }],
  },
  deleteRuns: {
    call: (api) => api.deleteRuns("tab1", ["r1"]),
    sent: [IPC.runCall, { op: "run.deleteMany", args: { flowId: "tab1", runIds: ["r1"] } }],
  },
  flows: { call: (api) => api.flows(), sent: [IPC.flowCall, { op: "flow.list", args: null }] },
  templates: {
    call: (api) => api.templates(),
    sent: [IPC.flowCall, { op: "flow.templates", args: null }],
  },
  setFlowOn: {
    call: (api) => api.setFlowOn("tab1", false),
    sent: [IPC.flowCall, { op: "flow.setOn", args: { id: "tab1", on: false } }],
  },
  renameFlow: {
    call: (api) => api.renameFlow("tab1", "Invoices"),
    sent: [IPC.flowCall, { op: "flow.rename", args: { id: "tab1", name: "Invoices" } }],
  },
  duplicateFlow: {
    call: (api) => api.duplicateFlow("tab1"),
    sent: [IPC.flowCall, { op: "flow.duplicate", args: { id: "tab1" } }],
  },
  exportFlow: {
    call: (api) => api.exportFlow("tab1"),
    sent: [IPC.flowCall, { op: "flow.export", args: { id: "tab1" } }],
  },
  deleteFlow: {
    call: (api) => api.deleteFlow("tab1"),
    sent: [IPC.flowCall, { op: "flow.delete", args: { id: "tab1" } }],
  },
  flowFromTemplate: {
    call: (api) => api.flowFromTemplate("blank", "Mine"),
    sent: [IPC.flowCall, { op: "flow.fromTemplate", args: { templateId: "blank", name: "Mine" } }],
  },
  nodeForm: {
    call: (api) => api.nodeForm("tab1", "n1"),
    sent: [IPC.flowCall, { op: "flow.node.form", args: { flowId: "tab1", nodeId: "n1" } }],
  },
  configureNode: {
    call: (api) => api.configureNode("tab1", "n1", { space_id: "s" }),
    sent: [
      IPC.flowCall,
      {
        op: "flow.node.configure",
        args: { flowId: "tab1", nodeId: "n1", values: { space_id: "s" } },
      },
    ],
  },
  nodeOptions: {
    call: (api) => api.nodeOptions({ source: "types", spaceId: "sp1" }),
    sent: [IPC.flowCall, { op: "node.options", args: { source: "types", spaceId: "sp1" } }],
  },
  anytypeSpaces: {
    call: (api) => api.anytypeSpaces(),
    sent: [IPC.flowCall, { op: "anytype.spaces", args: null }],
  },
  board: {
    call: (api) => api.board("tab1"),
    sent: [IPC.boardCall, { op: "board.get", args: { flowId: "tab1" } }],
  },
  saveBoard: {
    call: (api) => api.saveBoard({ flowId: "tab1", tabs: [], slots: [] }),
    sent: [
      IPC.boardCall,
      { op: "board.save", args: { layout: { flowId: "tab1", tabs: [], slots: [] } } },
    ],
  },
  setup: { call: (api) => api.setup(), sent: [IPC.setupCall, { op: "setup.get", args: null }] },
  setSetupStep: {
    call: (api) => api.setSetupStep({ kind: "next" }),
    sent: [IPC.setupCall, { op: "setup.move", args: { kind: "next" } }],
  },
  completeSetup: {
    call: (api) => api.completeSetup(),
    sent: [IPC.setupCall, { op: "setup.complete", args: null }],
  },
  trySample: {
    call: (api) => api.trySample(),
    sent: [IPC.setupCall, { op: "setup.trySample", args: null }],
  },
  updateState: {
    call: (api) => api.updateState(),
    sent: [IPC.updateCall, { op: "update.state", args: null }],
  },
  checkNow: {
    call: (api) => api.checkNow(),
    sent: [IPC.updateCall, { op: "update.checkNow", args: null }],
  },
  quitAndUpdate: {
    call: (api) => api.quitAndUpdate(),
    sent: [IPC.updateCall, { op: "update.quit", args: null }],
  },
  goBack: {
    call: (api) => api.goBack(),
    sent: [IPC.updateCall, { op: "update.goBack", args: null }],
  },
  registerPackage: {
    call: (api) => api.registerPackage("innyrize"),
    sent: [IPC.packageCall, { op: "package.register", args: { name: "innyrize" } }],
  },
  unregisterPackage: {
    call: (api) => api.unregisterPackage("innyrize"),
    sent: [IPC.packageCall, { op: "package.unregister", args: { name: "innyrize" } }],
  },
  chooseInstallFolder: {
    call: (api) => api.chooseInstallFolder(),
    sent: [IPC.packageCall, { op: "package.chooseFolder", args: null }],
  },
  checkFolder: {
    call: (api) => api.checkFolder("innyrize"),
    sent: [IPC.packageCall, { op: "package.checkFolder", args: { name: "innyrize" } }],
  },
  goBackPackage: {
    call: (api) => api.goBackPackage("innyrize"),
    sent: [IPC.packageCall, { op: "package.goBack", args: { name: "innyrize" } }],
  },
  status: {
    call: (api) => api.status(),
    sent: [IPC.generalCall, { op: "status.get", args: null }],
  },
  retention: {
    call: (api) => api.retention(),
    sent: [IPC.generalCall, { op: "retention.get", args: null }],
  },
  setRetention: {
    call: (api) => api.setRetention(null),
    sent: [IPC.generalCall, { op: "retention.set", args: { days: null } }],
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
  onBoard: { channel: IPC.boardChanged, sent: { flowId: "tab1" } },
  onSetup: { channel: IPC.setupChanged, sent: { step: "reports", completed: false } },
  onUpdateState: { channel: IPC.updateStateChanged, sent: { state: { kind: "checking" } } },
  onPackages: { channel: IPC.packagesChanged, sent: undefined },
  onStatus: { channel: IPC.statusChanged, sent: { pill: "running", banner: null, badge: 0 } },
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
