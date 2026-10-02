// AppApi over the renderer's IPC (plan 0018 §2.4): what the preload exposes as
// `window.inny.app`. Built here, apart from the preload, so the contract tests can exercise
// every method against a recording IPC with no DOM and no Electron.

import type { IpcRenderer } from "electron";
import { appApiV2Over } from "./app-bridge-v2";
import { IPC } from "./ipc";
import type {
  AnytypeStatus,
  AppApi,
  ChildName,
  ChildStatus,
  EditorPalette,
  EventTypeSummary,
  InboxEntry,
  Job,
  LaunchAtLoginStatus,
  ListResult,
  McpEndpointStatus,
  NodeSetSummary,
  PackageOutcome,
  PackagesState,
  PaletteChange,
  QuitChoice,
  QuitQuestion,
  SecretStorageStatus,
  SnapshotSummary,
  TelemetryStatus,
  ViewPresented,
  ViewResult,
} from "../ui/contract";

/** ipcRenderer, as far as AppApi goes. */
export type RendererIpc = Pick<IpcRenderer, "invoke" | "on">;

export function appApiOver(ipc: RendererIpc): AppApi {
  /** One of the runtime's view calls; the shell checks the op against its own list. */
  const viewCall = (op: string, args: object) =>
    ipc.invoke(IPC.viewCall, { op, args }) as Promise<ViewResult>;
  /** One of the runtime's lists, or the Jobs page's cancel. */
  const listCall = (op: string, args: object | null): Promise<unknown> =>
    ipc.invoke(IPC.listCall, { op, args });
  return {
    ...appApiV2Over(ipc),
    secretStorage: () => ipc.invoke(IPC.secretStorage) as Promise<SecretStorageStatus>,
    childStatus: () => ipc.invoke(IPC.childStatus) as Promise<readonly ChildStatus[]>,
    onChildStatus: (listener) => {
      ipc.on(IPC.childStatusChanged, (_event, status: ChildStatus) => {
        listener(status);
      });
    },
    restartChild: async (child: ChildName) => {
      await ipc.invoke(IPC.restartChild, child);
    },
    anytypeStatus: () => ipc.invoke(IPC.anytypeStatus) as Promise<AnytypeStatus>,
    startAnytypePairing: () => ipc.invoke(IPC.anytypePairStart) as Promise<AnytypeStatus>,
    completeAnytypePairing: (code: string) =>
      ipc.invoke(IPC.anytypePairComplete, code) as Promise<AnytypeStatus>,
    mcpEndpoint: () => ipc.invoke(IPC.mcpEndpoint) as Promise<McpEndpointStatus>,
    moveMcpEndpoint: (host: string, port: number) =>
      ipc.invoke(IPC.mcpEndpointMove, host, port) as Promise<McpEndpointStatus>,
    onViewPresented: (listener) => {
      ipc.on(IPC.viewPresented, (_event, view: ViewPresented) => {
        listener(view);
      });
    },
    onPendingViews: (listener) => {
      ipc.on(IPC.pendingViews, (_event, count: number) => {
        listener(count);
      });
    },
    pendingViews: () => ipc.invoke(IPC.pendingViewsNow) as Promise<number | null>,
    view: (id) => viewCall("view.get", { id }),
    submitView: (id, values) => viewCall("view.submit", { id, values }),
    snapshot: (id) => viewCall("snapshot.get", { id }),
    pressAction: (id, action, values) => viewCall("snapshot.action", { id, action, values }),
    // cutover: WI-21 removes inbox, onInbox, snapshots, jobs, onJobs, cancelJob and the event calls.
    inbox: () => ipc.invoke(IPC.inbox) as Promise<readonly InboxEntry[]>,
    onInbox: (listener) => {
      ipc.on(IPC.inboxChanged, (_event, entries: readonly InboxEntry[]) => {
        listener(entries);
      });
    },
    openView: async (id) => {
      await ipc.invoke(IPC.openView, id);
    },
    snapshots: () => listCall("snapshot.list", null) as Promise<ListResult<SnapshotSummary>>,
    openSnapshot: async (id) => {
      await ipc.invoke(IPC.openSnapshot, id);
    },
    jobs: () => listCall("job.list", null) as Promise<ListResult<Job>>,
    onJobs: (listener) => {
      ipc.on(IPC.jobsChanged, () => {
        listener();
      });
    },
    cancelJob: (id) => listCall("job.cancel", { id }) as Promise<ViewResult>,
    quit: async () => {
      await ipc.invoke(IPC.quit);
    },
    editorPalette: () => ipc.invoke(IPC.editorPalette) as Promise<EditorPalette | null>,
    runtimeNodeSets: () =>
      ipc.invoke(IPC.editorCall, { op: "editor.nodes", args: null }) as Promise<
        ListResult<NodeSetSummary>
      >,
    raiseNodeEvents: (change: PaletteChange) =>
      ipc.invoke(IPC.editorCall, { op: "editor.sync", args: change }) as Promise<ViewResult>,
    eventTypes: () =>
      ipc.invoke(IPC.eventCall, { op: "event.list", args: null }) as Promise<
        ListResult<EventTypeSummary>
      >,
    createEventType: (name, label, schema) =>
      ipc.invoke(IPC.eventCall, {
        op: "event.create",
        args: { name, label, schema },
      }) as Promise<ViewResult>,
    versionEventType: (name, schema) =>
      ipc.invoke(IPC.eventCall, {
        op: "event.version",
        args: { name, schema },
      }) as Promise<ViewResult>,
    deleteEventType: (type) =>
      ipc.invoke(IPC.eventCall, { op: "event.delete", args: { type } }) as Promise<ViewResult>,
    fireEvent: (type, values) =>
      ipc.invoke(IPC.eventCall, {
        op: "event.fire",
        args: { type, values },
      }) as Promise<ViewResult>,
    onQuitQuestion: (listener) => {
      ipc.on(IPC.quitQuestion, (_event, question: QuitQuestion) => {
        listener(question);
      });
    },
    answerQuit: async (choice: QuitChoice) => {
      await ipc.invoke(IPC.quitAnswer, choice);
    },
    packages: () => ipc.invoke(IPC.packages) as Promise<PackagesState>,
    installFromCatalogue: (id: string) =>
      ipc.invoke(IPC.packageInstall, id) as Promise<PackageOutcome>,
    chooseInstallFile: () => ipc.invoke(IPC.packageChooseFile) as Promise<string | null>,
    installFromFile: (file: string, unsignedConfirmed: boolean) =>
      ipc.invoke(IPC.packageInstallFile, file, unsignedConfirmed) as Promise<PackageOutcome>,
    removePackage: (name: string) => ipc.invoke(IPC.packageRemove, name) as Promise<PackageOutcome>,
    checkPackageUpdates: () => ipc.invoke(IPC.packageCheck) as Promise<PackageOutcome>,
    applyPackageUpdate: (name: string) =>
      ipc.invoke(IPC.packageUpdate, name) as Promise<PackageOutcome>,
    installFromSource: (source: string, id: string, unverifiedConfirmed: boolean) =>
      ipc.invoke(
        IPC.packageInstallSource,
        source,
        id,
        unverifiedConfirmed,
      ) as Promise<PackageOutcome>,
    registerSource: (name: string, url: string, publicKey: string) =>
      ipc.invoke(IPC.sourceRegister, name, url, publicKey) as Promise<PackageOutcome>,
    removeSource: (name: string) => ipc.invoke(IPC.sourceRemove, name) as Promise<PackageOutcome>,
    setSourceAutoUpdate: (name: string, on: boolean) =>
      ipc.invoke(IPC.sourceAutoUpdate, name, on) as Promise<PackageOutcome>,
    launchAtLogin: () => ipc.invoke(IPC.launchAtLogin) as Promise<LaunchAtLoginStatus>,
    setLaunchAtLogin: (on: boolean) =>
      ipc.invoke(IPC.setLaunchAtLogin, on) as Promise<LaunchAtLoginStatus>,
    telemetry: () => ipc.invoke(IPC.telemetry) as Promise<TelemetryStatus>,
    setTelemetry: (on: boolean) => ipc.invoke(IPC.setTelemetry, on) as Promise<TelemetryStatus>,
    legacyPackages: () => ipc.invoke(IPC.legacyPackages) as Promise<readonly string[]>,
    deleteLegacyPackages: () => ipc.invoke(IPC.deleteLegacyPackages) as Promise<readonly string[]>,
  };
}
