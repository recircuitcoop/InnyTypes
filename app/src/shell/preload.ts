// The preload bridge (plan 0018 §2.4): exposes AppApi to the app page as `window.inny.app`,
// and nothing else. It runs in the sandboxed renderer, which may only require `electron`.

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./ipc";
import type {
  AnytypeStatus,
  AppApi,
  ChildName,
  ChildStatus,
  SecretStorageStatus,
} from "../ui/contract";

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
};

contextBridge.exposeInMainWorld("inny", { app });
