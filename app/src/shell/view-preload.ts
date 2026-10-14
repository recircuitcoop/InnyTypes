// The whole of what a pop-out view page can reach (spec 8.5.6): `window.inny`, five calls,
// none of which takes an id. The shell answers for the one view or snapshot the window was
// opened for. `setValid` is page-local: it dispatches an `inny-valid` event and makes no IPC
// call. It runs in the sandboxed renderer, which may only require `electron`.

import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE_CHANNELS } from "../domain/views/popout";
import { VALID_EVENT, type ViewBridge, type ViewResult } from "../ui/contract";

const bridge: ViewBridge = {
  get: () => ipcRenderer.invoke(BRIDGE_CHANNELS.get) as Promise<ViewResult>,
  submit: (values) => ipcRenderer.invoke(BRIDGE_CHANNELS.submit, values) as Promise<ViewResult>,
  action: (actionId, values) =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.action, actionId, values) as Promise<ViewResult>,
  draft: (values) => ipcRenderer.invoke(BRIDGE_CHANNELS.draft, values) as Promise<ViewResult>,
  setValid: (valid) => {
    // Only `true` enables Continue: anything else a page passes disables it.
    window.dispatchEvent(new CustomEvent(VALID_EVENT, { detail: valid === true }));
  },
};

contextBridge.exposeInMainWorld("inny", bridge);
