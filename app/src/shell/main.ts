// Composition root 1 of 3 (plan 0018 §2.2): the Electron main process.
//
// The only place in the shell where parts are wired together, and one of the three files
// allowed to read process.env or import adapters (§2.3). It takes the single-instance lock,
// picks the runtime's stable port, supervises the runtime and services utilityProcesses,
// shows their state in the app page, and stops both before it quits.
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import { UtilityProcessLauncher } from "../adapters/electron/utility-process-launcher";
import { pickFreeLoopbackPort } from "../adapters/net/free-port";
import { systemClock } from "../adapters/system/clock";
import { consoleLogger, logNotifier } from "../adapters/system/console-logger";
import { Supervisor } from "../application/supervisor";
import {
  CHILD_NAMES,
  DEFAULT_SUPERVISION,
  isChildName,
  type ChildName,
} from "../domain/supervision/child-state";
import type * as Contract from "../ui/contract";
import { IPC } from "./ipc";

// The e2e gate runs the real app against a temporary userData directory, so no test ever
// touches this user's own. Set before `ready`, which is when Electron starts using it, and
// before the single-instance lock, which lives in it.
const userData = process.env["INNYTYPES_USER_DATA"];
if (userData !== undefined && userData !== "") {
  app.setPath("userData", userData);
}

// The gate runs with hidden windows (§6, e2e stage), so a run never steals focus.
const hiddenWindows = process.env["INNYTYPES_HIDDEN_WINDOWS"] === "1";

const logger = consoleLogger("shell", process.pid);
const supervisors = new Map<ChildName, Supervisor>();
let mainWindow: BrowserWindow | null = null;

function openMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    title: "InnyTypes",
    show: !hiddenWindows,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  // A minimal page until the shell serves the app pages on inny-app:// (WI-0018-11).
  void window.loadFile(path.join(__dirname, "..", "ui", "pages", "status.html"));
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  return window;
}

/** A second launch, or a click on the dock icon: show the one window, in front. */
function bringForward(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = openMainWindow();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

/** Every child's whole environment: named here, never the shell's (arch_pivot P9 #5). */
function childEnvironment(): Record<string, string> {
  return { HOME: app.getPath("home") };
}

function publish(status: Contract.ChildStatus): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.childStatusChanged, status);
  }
}

// ── quit: stop both children, then really quit ─────────────────────────────────────────
let quitStarted = false;
let quitDone = false;

function onBeforeQuit(event: Electron.Event): void {
  if (quitDone) {
    return;
  }
  event.preventDefault();
  if (quitStarted) {
    return;
  }
  quitStarted = true;
  logger.info("quitting: stopping the children");
  void Promise.all([...supervisors.values()].map((supervisor) => supervisor.stop())).then(() => {
    quitDone = true;
    logger.info("quit complete");
    app.quit();
  });
}

async function start(): Promise<void> {
  await app.whenReady();
  // One port for the whole session: every runtime generation is given this one (§2.2).
  const port = await pickFreeLoopbackPort();
  if (quitStarted) {
    return;
  }
  logger.info(`the runtime's port for this session is ${String(port)}`);

  const launcher = new UtilityProcessLauncher((modulePath, args, options) =>
    utilityProcess.fork(modulePath, args, options),
  );
  for (const child of CHILD_NAMES) {
    const supervisor = new Supervisor({
      child,
      fork: {
        modulePath: path.join(__dirname, "..", child, "main.cjs"),
        serviceName: `InnyTypes ${child}`,
        env: childEnvironment(),
      },
      childSettings: { port: child === "runtime" ? port : null, userDir: app.getPath("userData") },
      settings: DEFAULT_SUPERVISION,
      launcher,
      clock: systemClock,
      logger,
      notifier: logNotifier(logger),
      newId: randomUUID,
    });
    supervisor.onStatus(publish);
    supervisors.set(child, supervisor);
  }

  ipcMain.handle(IPC.childStatus, (): Contract.ChildStatus[] =>
    [...supervisors.values()].map((supervisor) => supervisor.status()),
  );
  ipcMain.handle(IPC.restartChild, (_event, child: unknown) => {
    if (isChildName(child)) {
      supervisors.get(child)?.recover();
    }
  });

  mainWindow = openMainWindow();
  for (const supervisor of supervisors.values()) {
    supervisor.start();
  }
}

// ── single instance: a second launch brings the first one's window forward ─────────────
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", bringForward);
  // macOS: a dock click with no window open. Closing the window is not quitting.
  app.on("activate", () => {
    if (mainWindow === null && app.isReady() && supervisors.size > 0) {
      bringForward();
    }
  });
  app.on("window-all-closed", () => {
    // Closing is not quitting (helper/window.py:65-67): the children keep running.
  });
  app.on("before-quit", onBeforeQuit);
  process.on("SIGTERM", () => {
    app.quit();
  });
  process.on("SIGINT", () => {
    app.quit();
  });
  start().catch((error: unknown) => {
    logger.error(`the shell could not start: ${String(error)}`);
    app.exit(1);
  });
}
