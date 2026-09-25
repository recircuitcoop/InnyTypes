// AppApi over the renderer's IPC (plan 0018 §2.4): what the preload exposes as
// `window.inny.app`. Built here, apart from the preload, so the contract tests can exercise
// every method against a recording IPC with no DOM and no Electron.

import type { IpcRenderer } from "electron";
import { IPC } from "./ipc";
import type {
  AnytypeStatus,
  AppApi,
  ChildName,
  ChildStatus,
  InboxEntry,
  Job,
  ListResult,
  McpEndpointStatus,
  SecretStorageStatus,
  SnapshotSummary,
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
    cancelJob: (id) => listCall("job.cancel", { id }) as Promise<ViewResult>,
    quit: async () => {
      await ipc.invoke(IPC.quit);
    },
  };
}
