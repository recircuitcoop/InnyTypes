// The preload bridge (plan 0018 §2.4): exposes AppApi to the app page as `window.inny.app`,
// and nothing else. It runs in the sandboxed renderer, which may only require `electron`.

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./ipc";
import type { AppApi, ChildName, ChildStatus, SecretStorageStatus } from "../ui/contract";

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
};

contextBridge.exposeInMainWorld("inny", { app });
