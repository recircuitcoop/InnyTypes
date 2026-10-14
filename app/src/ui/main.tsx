// The app window's entry for the redesigned UI (plan 0022 §J, §M): the frame, on the preload
// bridge, with one store per domain read (ui/store.ts). Bundled by build:pages into dist/ui/main.js
// and loaded by the app page beside the old pages until WI-0022-21's cutover removes them.
import { createRoot } from "react-dom/client";
import type { AppApi } from "./contract";
import { Frame } from "./screens/Frame";
import { createStores, StoresContext } from "./store";

declare global {
  interface Window {
    readonly inny: { readonly app: AppApi };
  }
}

const mount = document.getElementById("frame");
if (mount !== null) {
  const api = window.inny.app;
  createRoot(mount).render(
    <StoresContext.Provider value={createStores(api)}>
      <Frame api={api} />
    </StoresContext.Provider>,
  );
}
