// The whole of what a pop-out view page can reach (spec 8.5.6): `window.inny`, three calls,
// none of which takes an id. The shell answers for the one view or snapshot the window was
// opened for. It runs in the sandboxed renderer, which may only require `electron`.

import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE_CHANNELS } from "../domain/views/popout";
import type { ViewBridge, ViewResult } from "../ui/contract";

const bridge: ViewBridge = {
  get: () => ipcRenderer.invoke(BRIDGE_CHANNELS.get) as Promise<ViewResult>,
  submit: (values) => ipcRenderer.invoke(BRIDGE_CHANNELS.submit, values) as Promise<ViewResult>,
  action: (actionId, values) =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.action, actionId, values) as Promise<ViewResult>,
};

contextBridge.exposeInMainWorld("inny", bridge);
