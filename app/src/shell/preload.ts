// The preload bridge (plan 0018 §2.4): exposes AppApi to the app page as `window.inny.app`,
// and nothing else. It runs in the sandboxed renderer, which may only require `electron`.

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./ipc";
import type {
  AnytypeStatus,
  AppApi,
  McpEndpointStatus,
  ChildName,
  ChildStatus,
  SecretStorageStatus,
  ViewPresented,
  ViewResult,
} from "../ui/contract";

/** One of the runtime's view calls; the shell checks the op against its own list. */
const viewCall = (op: string, args: object): Promise<ViewResult> =>
  ipcRenderer.invoke(IPC.viewCall, { op, args }) as Promise<ViewResult>;

const app: AppApi = {
  secretStorage: () => ipcRenderer.invoke(IPC.secretStorage) as Promise<SecretStorageStatus>,
  childStatus: () => ipcRenderer.invoke(IPC.childStatus) as Promise<readonly ChildStatus[]>,
  onChildStatus: (listener) => {
    ipcRenderer.on(IPC.childStatusChanged, (_event, status: ChildStatus) => {
      listener(status);
    });
  },
  restartChild: async (child: ChildName) => {
    await ipcRenderer.invoke(IPC.restartChild, child);
  },
  anytypeStatus: () => ipcRenderer.invoke(IPC.anytypeStatus) as Promise<AnytypeStatus>,
  startAnytypePairing: () => ipcRenderer.invoke(IPC.anytypePairStart) as Promise<AnytypeStatus>,
  completeAnytypePairing: (code: string) =>
    ipcRenderer.invoke(IPC.anytypePairComplete, code) as Promise<AnytypeStatus>,
  mcpEndpoint: () => ipcRenderer.invoke(IPC.mcpEndpoint) as Promise<McpEndpointStatus>,
  moveMcpEndpoint: (host: string, port: number) =>
    ipcRenderer.invoke(IPC.mcpEndpointMove, host, port) as Promise<McpEndpointStatus>,
  onViewPresented: (listener) => {
    ipcRenderer.on(IPC.viewPresented, (_event, view: ViewPresented) => {
      listener(view);
    });
  },
  onPendingViews: (listener) => {
    ipcRenderer.on(IPC.pendingViews, (_event, count: number) => {
      listener(count);
    });
  },
  pendingViews: () => ipcRenderer.invoke(IPC.pendingViewsNow) as Promise<number | null>,
  view: (id) => viewCall("view.get", { id }),
  submitView: (id, values) => viewCall("view.submit", { id, values }),
  snapshot: (id) => viewCall("snapshot.get", { id }),
  pressAction: (id, action, values) => viewCall("snapshot.action", { id, action, values }),
};

contextBridge.exposeInMainWorld("inny", { app });
