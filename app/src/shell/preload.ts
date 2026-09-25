// The preload bridge (plan 0018 §2.4): exposes AppApi to the app page as `window.inny.app`,
// and nothing else. It runs in the sandboxed renderer, which may only require `electron`.

import { contextBridge, ipcRenderer } from "electron";
import { appApiOver } from "./app-bridge";

contextBridge.exposeInMainWorld("inny", { app: appApiOver(ipcRenderer) });
