// The Electron main gallery.e2e.ts starts: one hidden window on the dev build's gallery page
// (dist/ui/gallery/index.html#/gallery), drawn by the same Chromium as the app. Not the app's
// own shell: the gallery is a dev-only page the packaged shell never serves.
//
// Rendering is pinned so a baseline means one thing on any Mac: offscreen, device scale 1 and a
// fixed window size. userData goes where the spec says (a scratch folder), never this user's.
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

// The window renders offscreen, in software: an on-screen window (even hidden) is colour-managed
// to the display it belongs to, so a baseline drawn with one monitor attached failed with
// another, and force-color-profile did not stop it. Offscreen, the pixels are the tokens' own
// sRGB values whatever the displays.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");
const userData = process.env["INNYTYPES_USER_DATA"];
if (userData === undefined || userData === "") {
  throw new Error("gallery-window.cjs needs INNYTYPES_USER_DATA (a scratch folder)");
}
app.setPath("userData", userData);

void app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });
  void window.loadFile(path.join(__dirname, "..", "..", "dist", "ui", "gallery", "index.html"), {
    hash: "/gallery",
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
