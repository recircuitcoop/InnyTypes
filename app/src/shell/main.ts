// Composition root 1 of 3 (plan 0018 §2.2): the Electron main process.
//
// The only place in the shell where parts are wired together, and one of the three files
// allowed to read process.env or import adapters (§2.3). For now it opens one window and
// quits cleanly; the supervisor, the channel and Node-RED arrive with later work items.
import { app, BrowserWindow } from "electron";

// The e2e gate runs the real app against a temporary userData directory, so no test ever
// touches this user's own. Set before `ready`, which is when Electron starts using it.
const userData = process.env["INNYTYPES_USER_DATA"];
if (userData !== undefined && userData !== "") {
  app.setPath("userData", userData);
}

// The gate runs with hidden windows (§6, e2e stage), so a run never steals focus.
const hiddenWindows = process.env["INNYTYPES_HIDDEN_WINDOWS"] === "1";

// A placeholder page until the shell serves the app pages on inny-app:// (WI-0018-11).
const PLACEHOLDER_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>InnyTypes</title></head>' +
  '<body><main data-testid="shell-ready">InnyTypes</main></body></html>';

function openMainWindow(): void {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    title: "InnyTypes",
    show: !hiddenWindows,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PLACEHOLDER_PAGE)}`);
}

app
  .whenReady()
  .then(openMainWindow)
  .catch((error: unknown) => {
    console.error("the shell could not start:", error);
    app.exit(1);
  });
