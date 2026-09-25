// Composition root 1 of 3 (plan 0018 §2.2): the Electron main process.
//
// The only place in the shell where parts are wired together, and one of the three files
// allowed to read process.env or import adapters (§2.3). It takes the single-instance lock,
// picks the runtime's stable port, supervises the runtime and services utilityProcesses,
// serves the app pages (inny-app://) and the pop-outs (inny-view://) itself, keeps the Inbox,
// and stops both children before it quits.
import { randomBytes, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from "electron";
import { electronNotifier } from "../adapters/electron/notifier";
import { Popouts } from "../adapters/electron/popouts";
import { KeychainSecretStore } from "../adapters/electron/safe-storage-store";
import { registerSchemes, serveAppPages, serveViewPages } from "../adapters/electron/schemes";
import { UtilityProcessLauncher } from "../adapters/electron/utility-process-launcher";
import { LOG_LEVEL_VARIABLE, logPath, RotatingLogFile } from "../adapters/fs/log-writer";
import {
  anytypeSecretFiles,
  credentialSecretCiphertextFile,
  credentialSecretFile,
  OwnerOnlyFileStore,
} from "../adapters/fs/owner-only-files";
import { DeclaredPackageStore } from "../adapters/fs/declared-package-store";
import { JsonPlacementStore } from "../adapters/fs/placement-store";
import { pickFreeLoopbackPort } from "../adapters/net/free-port";
import { systemClock } from "../adapters/system/clock";
import { logNotifier } from "../adapters/system/console-logger";
import { Inbox } from "../application/inbox";
import { OneLog } from "../application/one-log";
import { linkPeers } from "../application/peer-link";
import { openSecretStore, readOrCreate } from "../application/secrets";
import { printCanary } from "../application/source-log";
import { Supervisor } from "../application/supervisor";
import type { CallOp } from "../domain/channel/messages";
import { APP_HOST, APP_SCHEME, VIEW_PARTITION } from "../domain/views/popout";
import { DEFAULT_LEVEL, resolveLevel } from "../domain/logging/record";
import { SecretRegistry } from "../domain/redaction/registry";
import {
  CHILD_NAMES,
  DEFAULT_SUPERVISION,
  isChildName,
  type ChildName,
} from "../domain/supervision/child-state";
import type { ForkSpec } from "../ports/process-launcher";
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

// The app pages and the pop-outs are served by the shell on schemes of its own (§2.2), which
// must be privileged before Electron is ready.
registerSchemes(protocol);
/** Where what ships with the app lives: this file is bundled to app/dist/shell/main.cjs. */
const APP_DIR = path.join(__dirname, "..", "..");
/** The app pages' URL: never the runtime's, so a runtime restart never blanks them. */
const APP_PAGE = `${APP_SCHEME}://${APP_HOST}/index.html`;
/**
 * Where a package's view component is found (the runtime's package roots, until verified
 * installs exist with WI-0018-15 and -16): the first-party packages and the test fixtures.
 */
const PACKAGE_ROOTS = [
  path.join(APP_DIR, "..", "packages"),
  path.join(APP_DIR, "test", "fixtures"),
];

// The e2e gate must not touch this user's keychain either: Chromium's mock keychain (macOS)
// encrypts with a fixed key held in memory, so safeStorage still never writes a plaintext.
if (process.env["INNYTYPES_MOCK_KEYCHAIN"] === "1") {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// ── the one log (WI-0018-04): the shell is its only writer ──────────────────────────────
// A value registered as a secret and then printed by every process, so the e2e gate and the
// `log` machine proof can show it never reaches the file (plan 0018 §5.4). Unset in every
// ordinary run.
const LOG_CANARY_VARIABLE = "INNYTYPES_LOG_CANARY";
const logCanary = process.env[LOG_CANARY_VARIABLE];

let logLevel = DEFAULT_LEVEL;
let levelProblem: string | null = null;
try {
  logLevel = resolveLevel(process.env[LOG_LEVEL_VARIABLE]);
} catch (error) {
  // A misspelled verbosity is said in the log, which is then written at the default: refusing
  // to log at all would be the worst answer to a misspelling (logs.py:438-442).
  levelProblem = (error as Error).message;
}
const logFile = RotatingLogFile.open(
  logPath({ platform: process.platform, home: os.homedir(), env: process.env }),
);
const oneLog = new OneLog({
  registry: new SecretRegistry(),
  level: logLevel,
  file: logFile,
  // Shown in the terminal the app was started from, too, redacted like the file.
  echo: (line) => process.stderr.write(line),
  now: () => Date.now(),
});
const logger = oneLog.logger("innytypes.shell", process.pid);
oneLog.announce({
  role: "shell",
  pid: process.pid,
  destination: logFile?.path ?? null,
  levelProblem,
});
printCanary(logger, logCanary);
// Said once, so the e2e harness can check every process runs in its scratch home.
logger.info(`this process's HOME is ${process.env["HOME"] ?? "(unset)"}`);
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
  void window.loadURL(APP_PAGE);
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

/**
 * What the services process is handed besides HOME (WI-0018-18): where Anytype's local API is
 * when it is not the desktop app's port (anytype-cli), the e2e gate's substitutes, and the MCP
 * endpoint's variables, the default for a machine whose endpoint was never stored (WI-0018-19).
 */
const SERVICES_VARIABLES = [
  "ANYTYPE_API_BASE_URL",
  "INNYTYPES_TEST_ANYTYPE",
  "INNYTYPES_MCP_HOST",
  "INNYTYPES_MCP_PORT",
] as const;

/** Every child's whole environment: named here, never the shell's (arch_pivot P9 #5). */
function childEnvironment(child: ChildName): Record<string, string> {
  // os.homedir() honours HOME; Electron's app.getPath("home") does not (it asks the account
  // database), which handed the e2e gate's children this user's real home, and with it the
  // real Anytype key (found by WI-0018-18's e2e).
  const env: Record<string, string> = { HOME: os.homedir() };
  if (logCanary !== undefined && logCanary !== "") {
    env[LOG_CANARY_VARIABLE] = logCanary;
  }
  if (child === "services") {
    for (const name of SERVICES_VARIABLES) {
      const value = process.env[name];
      if (value !== undefined && value !== "") {
        env[name] = value;
      }
    }
  }
  return env;
}

/** Send to the app page, when it is open. */
function toPage(channel: string, ...args: unknown[]): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function publish(status: Contract.ChildStatus): void {
  toPage(IPC.childStatusChanged, status);
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

  // ── the secret store (WI-0018-06): safeStorage is usable only once Electron is ready ────
  const userDir = app.getPath("userData");
  const secrets = openSecretStore({
    facts: {
      platform: process.platform,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      linuxBackend: process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : null,
    },
    keychain: () =>
      new KeychainSecretStore(
        safeStorage,
        new OwnerOnlyFileStore(credentialSecretCiphertextFile(userDir)),
      ),
    file: () => new OwnerOnlyFileStore(credentialSecretFile(userDir)),
    sink: oneLog,
    logger,
  });
  const secretStorage: Contract.SecretStorageStatus = secrets.status;
  ipcMain.handle(IPC.secretStorage, (): Contract.SecretStorageStatus => secretStorage);
  // Generated once and kept; every runtime generation is handed the same one in `init`. A
  // keychain that cannot decrypt the stored one stops the start rather than making a new
  // one, which would orphan every credential Node-RED encrypted with it.
  const credentialSecret = readOrCreate(secrets.store, "node-red-credential-secret", () =>
    randomBytes(32).toString("hex"),
  );

  // The Anytype key and the proxy token, located once, here, from this process's HOME
  // (os.homedir() honours it), through WI-0018-06's file adapter. The services process is given
  // these paths in init and looks nothing up itself.
  const anytypeSecrets = anytypeSecretFiles({
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
  });
  logger.info(
    `the Anytype key is kept in ${anytypeSecrets["anytype-api-key"]?.file ?? "(nowhere)"}`,
  );

  // Which child a forked spec belongs to, so each line it prints is named after it.
  const childOf = new Map<ForkSpec, ChildName>();
  const launcher = new UtilityProcessLauncher(
    (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
    (spec, pid, stream, line) => {
      oneLog.ingest(childOf.get(spec) ?? spec.serviceName, pid, stream, line);
    },
  );
  for (const child of CHILD_NAMES) {
    const fork: ForkSpec = {
      modulePath: path.join(__dirname, "..", child, "main.cjs"),
      serviceName: `InnyTypes ${child}`,
      env: childEnvironment(child),
    };
    childOf.set(fork, child);
    const supervisor = new Supervisor({
      child,
      fork,
      childSettings:
        child === "runtime"
          ? { port, userDir, credentialSecret }
          : { port: null, userDir, secretFiles: anytypeSecrets },
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

  // ── Anytype (WI-0018-18): the services process answers; the page never sees the key ─────
  const services = supervisors.get("services");
  const runtime = supervisors.get("runtime");
  if (services === undefined || runtime === undefined) {
    throw new Error("the runtime and the services process must both be supervised");
  }
  const callServices = async (op: CallOp, args: unknown): Promise<unknown> => {
    const result = await services.call(op, args);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.value;
  };
  ipcMain.handle(IPC.anytypeStatus, () => callServices("anytype.status", null));
  ipcMain.handle(IPC.anytypePairStart, () => callServices("anytype.pair.start", null));
  ipcMain.handle(IPC.anytypePairComplete, (_event, code: unknown) =>
    callServices("anytype.pair.complete", code),
  );
  // The loopback MCP endpoint (WI-0018-19): served against saved, and the live move.
  ipcMain.handle(IPC.mcpEndpoint, () => callServices("mcp.endpoint", null));
  ipcMain.handle(IPC.mcpEndpointMove, (_event, host: unknown, port: unknown) =>
    callServices("mcp.endpoint.move", { host, port }),
  );
  // ── the pages and pop-outs (WI-0018-11): served by the shell, never by the runtime ───────
  serveAppPages(protocol, path.join(APP_DIR, "dist", "ui", "pages"));
  const viewSession = session.fromPartition(VIEW_PARTITION);
  const packageStore = new DeclaredPackageStore(PACKAGE_ROOTS, logger);
  serveViewPages(viewSession.protocol, viewSession.webRequest, {
    viewDir: path.join(APP_DIR, "dist", "ui", "view"),
    packageFolder: (name) =>
      packageStore.documents().find((declared) => declared.name === name)?.folder ?? null,
  });
  const popouts = new Popouts({
    createWindow: (options) => new BrowserWindow(options),
    ipc: ipcMain,
    preload: path.join(__dirname, "view-preload.cjs"),
    show: !hiddenWindows,
    call: (op, args) => runtime.call(op, args),
    placements: new JsonPlacementStore(path.join(userDir, "popout-placements.json")),
    openExternal: (url) => {
      void shell.openExternal(url);
    },
    clock: systemClock,
    logger,
  });

  // ── views (WI-0018-10): the runtime raises them; the shell keeps the Inbox ──────────────
  const inbox = new Inbox({
    notifier: electronNotifier(Notification, logger, !hiddenWindows),
    openPopout: (id) => {
      void popouts.open({ kind: "view", id }, "presented");
    },
    list: () => runtime.call("view.list", null),
    badge: (count) => {
      app.setBadgeCount(count);
    },
    logger,
  });
  inbox.onChange((items) => {
    toPage(IPC.inboxChanged, items);
  });
  runtime.onViewEvent((event) => {
    inbox.receive(event);
    if (event.t === "present") {
      const view: Contract.ViewPresented = {
        id: event.id,
        window: event.window,
        first: event.first,
        title: event.title,
      };
      toPage(IPC.viewPresented, view);
    } else {
      toPage(IPC.pendingViews, event.count);
    }
  });
  ipcMain.handle(IPC.pendingViewsNow, () => inbox.pending());
  ipcMain.handle(IPC.inbox, (): readonly Contract.InboxEntry[] => inbox.items());
  ipcMain.handle(IPC.openView, (_event, id: unknown) => {
    if (typeof id === "string" && id !== "") {
      void popouts.open({ kind: "view", id }, "opened from the Inbox");
    }
  });
  ipcMain.handle(IPC.openSnapshot, (_event, id: unknown) => {
    if (typeof id === "string" && id !== "") {
      void popouts.open({ kind: "snapshot", id }, "opened from the Snapshots page");
    }
  });
  // Quit in the window (F1: turning InnyTypes off is never hidden) runs the one quit.
  ipcMain.handle(IPC.quit, () => {
    logger.info("Quit InnyTypes was pressed in the window");
    app.quit();
  });
  ipcMain.handle(IPC.listCall, async (_event, call: unknown) => {
    const { op, args } = (call ?? {}) as { op?: unknown; args?: unknown };
    if (op !== "snapshot.list" && op !== "job.list" && op !== "job.cancel") {
      return { ok: false, error: `${String(op)} is not a list call` };
    }
    return runtime.call(op, args);
  });
  ipcMain.handle(IPC.viewCall, async (_event, call: unknown): Promise<Contract.ViewResult> => {
    const { op, args } = (call ?? {}) as { op?: unknown; args?: unknown };
    if (
      op !== "view.get" &&
      op !== "view.submit" &&
      op !== "snapshot.get" &&
      op !== "snapshot.action"
    ) {
      return { ok: false, error: `${String(op)} is not a view call` };
    }
    return runtime.call(op, args);
  });

  // The runtime ↔ services direct channel (§2.2), made again for every new generation.
  linkPeers(
    runtime,
    services,
    () => {
      const channel = new MessageChannelMain();
      return [channel.port1, channel.port2];
    },
    logger,
  );

  // The e2e gate drives a planned restart the way a type change will (WI-0018-18's
  // independence test); never set in an ordinary run.
  if (process.env["INNYTYPES_E2E_HOOKS"] === "1") {
    Object.assign(globalThis, {
      innytypesE2E: {
        restart: (child: ChildName, reason: "types" | "restart") =>
          supervisors.get(child)?.restart(reason) ?? false,
        // The pop-outs open now, by `view:<id>` or `snapshot:<id>` (WI-0018-11's e2e).
        popouts: () => popouts.list(),
      },
    });
  }

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
