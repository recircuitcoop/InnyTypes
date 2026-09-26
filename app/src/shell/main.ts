// Composition root 1 of 3 (plan 0018 §2.2): the Electron main process.
//
// The only place in the shell where parts are wired together, and one of the three files
// allowed to read process.env or import adapters (§2.3). It takes the single-instance lock,
// picks the runtime's stable port, supervises the runtime and services utilityProcesses,
// serves the app pages (inny-app://) and the pop-outs (inny-view://) itself, keeps the Inbox,
// tells the person things once (WI-0018-21), starts or adopts the Anytype desktop app, and stops
// both children (and Anytype, only if it started it) before it quits.
import { randomBytes, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from "electron";
import { EditorFrame } from "../adapters/electron/editor-frame";
import { AutostartLoginItem, autostartDirectory } from "../adapters/electron/login-item-linux";
import { ElectronLoginItem } from "../adapters/electron/login-item";
import { electronDelivery, setAppUserModelId } from "../adapters/electron/notifier";
import { Popouts } from "../adapters/electron/popouts";
import { KeychainSecretStore } from "../adapters/electron/safe-storage-store";
import { registerSchemes, serveAppPages, serveViewPages } from "../adapters/electron/schemes";
import { UtilityProcessLauncher } from "../adapters/electron/utility-process-launcher";
import { LOG_LEVEL_VARIABLE, logPath, RotatingLogFile } from "../adapters/fs/log-writer";
import {
  anytypeSecretFiles,
  keyFileOnly,
  credentialSecretCiphertextFile,
  credentialSecretFile,
  OwnerOnlyFileStore,
} from "../adapters/fs/owner-only-files";
import { FileCatalogueCache } from "../adapters/fs/catalogue-cache";
import { FsBlockedUpdates } from "../adapters/fs/blocked-updates";
import { FsContentHashes } from "../adapters/fs/content-hashes";
import { DeclaredPackageStore } from "../adapters/fs/declared-package-store";
import { InstalledPackageStore } from "../adapters/fs/installed-package-store";
import { FsPackageRoots } from "../adapters/fs/package-roots";
import { FsPackageSource } from "../adapters/fs/package-source";
import { JsonNoticeFile, NOTICES_FILENAME } from "../adapters/fs/notice-file";
import { JsonSettingsStore } from "../adapters/fs/settings-store";
import { anytypeExecutable, ProcessTableApps } from "../adapters/process/desktop-apps";
import { HttpsClient } from "../adapters/net/https-client";
import { forgetGeneratedTypes } from "../adapters/nodered/generator";
import { systemEnvironmentBuilder } from "../adapters/process/env-builder";
import { AjvSchemaValidator } from "../adapters/schema/ajv-validator";
import { sha256Hex } from "../adapters/signature/digest";
import { MinisignVerifier } from "../adapters/signature/minisign";
import { JsonPlacementStore } from "../adapters/fs/placement-store";
import { pickFreeLoopbackPort } from "../adapters/net/free-port";
import { systemClock } from "../adapters/system/clock";
import { AnytypeApp } from "../application/anytype-app";
import { EventTypeChanges } from "../application/event-type-changes";
import { OneLog } from "../application/one-log";
import { linkPeers } from "../application/peer-link";
import { openSecretStore, readOrCreate } from "../application/secrets";
import { QuitFlow } from "../application/quit";
import { printCanary } from "../application/source-log";
import { Supervisor } from "../application/supervisor";
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
import { anytypeAppPath, wireDesktop } from "./desktop";
import { exposeE2eHooks } from "./e2e-hooks";
import { IPC } from "./ipc";
import { wirePackages } from "./packages";
import { quitQuestion, wireQuit } from "./quit-question";
import { wireRuntimeCalls } from "./runtime-calls";
import { wireServiceCalls } from "./service-calls";
import { wireViews } from "./views";

// The e2e gate runs the real app against a temporary userData directory, so no test ever
// touches this user's own. Set before `ready`, which is when Electron starts using it, and
// before the single-instance lock, which lives in it.
const userData = process.env["INNYTYPES_USER_DATA"];
if (userData !== undefined && userData !== "") {
  app.setPath("userData", userData);
}

// The e2e gate's hooks (never set in an ordinary run).
const e2eHooks = process.env["INNYTYPES_E2E_HOOKS"] === "1";

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
// Windows raises a toast only under the id the shortcuts carry (WI-0018-21).
setAppUserModelId(app, process.platform);
// The Anytype desktop app (§4.1 point 6): INNYTYPES_ANYTYPE_APP names it ("none": not used),
// else the installed one, for the installed InnyTypes only: a development or e2e run never
// starts, adopts or quits this user's own Anytype.
const anytypeApp = new AnytypeApp({
  apps: new ProcessTableApps(process.platform),
  executable: anytypeAppPath(process.env["INNYTYPES_ANYTYPE_APP"], () =>
    app.isPackaged
      ? anytypeExecutable(process.platform, os.homedir(), process.env["LOCALAPPDATA"])
      : null,
  ),
  logger,
});
let mainWindow: BrowserWindow | null = null;
/** The editor's address once the session's port is picked (WI-0018-12). */
let editorUrl: string | null = null;

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
  // The editor's beforeunload guard silently cancels a quit or a reload in Electron (arch_pivot
  // §4 surprise 1). Its edits were already put to the person (the quit question, the fallback's
  // prompt), so the unload always goes ahead, and the log says so.
  window.webContents.on("will-prevent-unload", (event) => {
    logger.warn("the editor held undeployed changes as it unloaded; the unload goes ahead");
    event.preventDefault();
  });
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

// ── quit (WI-0018-12): undeployed edits are put to the person, then both children stop ──
const editor = new EditorFrame({
  frames: () =>
    mainWindow === null || mainWindow.isDestroyed()
      ? []
      : mainWindow.webContents.mainFrame.framesInSubtree,
  editorUrl: () => editorUrl,
  clock: systemClock,
});
const question = quitQuestion({
  window: () => mainWindow,
  toPage,
  bringForward,
  hidden: hiddenWindows,
  logger,
});

const quitFlow = new QuitFlow({
  editor,
  ask: (problem) => question.ask(problem),
  stopChildren: async () => {
    await Promise.all([
      ...[...supervisors.values()].map((supervisor) => supervisor.stop()),
      // Quit only if InnyTypes started it (launcher.py:986); an adopted Anytype keeps running.
      anytypeApp.quitIfOurs(),
    ]);
  },
  exit: () => {
    app.quit();
  },
  logger,
});
/** A signal quits without asking: nobody may be at the window to answer. */
let quitBySignal = false;

function onBeforeQuit(event: Electron.Event): void {
  if (quitFlow.done) {
    return;
  }
  event.preventDefault();
  void quitFlow.request({ ask: !quitBySignal });
}

async function start(): Promise<void> {
  await app.whenReady();
  // One port for the whole session: every runtime generation is given this one (§2.2).
  const port = await pickFreeLoopbackPort();
  if (!quitFlow.idle) {
    return;
  }
  editorUrl = `http://127.0.0.1:${String(port)}/red/`;
  logger.info(`the runtime's port for this session is ${String(port)}`);
  // Anytype first, as the old helper did (launcher.py:894), so its API is up sooner.
  void anytypeApp.start();

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
  // ── desktop (WI-0018-21): notices told once, and launch at login (shell/desktop.ts) ───────
  // The login item: the e2e gate's autostart directory, else none for a run that is not the
  // installed app (it refuses), else Linux's autostart entry or Electron's login item.
  const autostart = e2eHooks ? process.env["INNYTYPES_TEST_AUTOSTART_DIR"] : undefined;
  const entry = { executable: process.env["APPIMAGE"] ?? process.execPath, icon: "innytypes" };
  const xdg = autostartDirectory(process.env["XDG_CONFIG_HOME"], os.homedir());
  const notices = wireDesktop({
    ipc: ipcMain,
    deliver: electronDelivery(Notification, !hiddenWindows, bringForward),
    noticeFile: new JsonNoticeFile(path.join(userDir, NOTICES_FILENAME)),
    loginItem:
      autostart !== undefined
        ? new AutostartLoginItem(entry, autostart)
        : !app.isPackaged
          ? null
          : process.platform === "linux"
            ? new AutostartLoginItem(entry, xdg)
            : new ElectronLoginItem(app),
    // Stored by the shell alone, in a file of its own: the services process writes settings.json.
    setting: new JsonSettingsStore(path.join(userDir, "shell-settings.json")),
    logger,
  });
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
          ? // The key's path only, for the first-party Anytype nodes (WI-0018-20, §4.2).
            { port, userDir, credentialSecret, secretFiles: keyFileOnly(anytypeSecrets) }
          : { port: null, userDir, secretFiles: anytypeSecrets },
      settings: DEFAULT_SUPERVISION,
      launcher,
      clock: systemClock,
      logger,
      notifier: notices,
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
  // And the loopback MCP endpoint (WI-0018-19): served against saved, and the live move.
  wireServiceCalls(ipcMain, services);
  // ── the pages and pop-outs (WI-0018-11): served by the shell, never by the runtime ───────
  serveAppPages(protocol, path.join(APP_DIR, "dist", "ui", "pages"));
  const viewSession = session.fromPartition(VIEW_PARTITION);
  // ── packages (WI-0018-16): verified installs, and only the runtime restarted ──────────
  const packageBase = path.join(userDir, "node-packages");
  const packageRoots = new FsPackageRoots(packageBase);
  const shippedStore = new DeclaredPackageStore(PACKAGE_ROOTS, logger);
  const packageStore = new InstalledPackageStore(shippedStore, packageRoots, logger);
  const testCa = process.env["INNYTYPES_TEST_CATALOGUE_CA"];
  wirePackages({
    ipc: ipcMain,
    dialog,
    runtime,
    editor,
    clock: systemClock,
    logger,
    userDir,
    shippedStore,
    // A release's build settings (WI-0018-23); until then these, and with none, no catalogue.
    catalogueUrl: process.env["INNYTYPES_CATALOGUE_URL"] ?? "",
    catalogueKey: process.env["INNYTYPES_CATALOGUE_KEY"] ?? null,
    // The e2e gate's local HTTPS server's certificate: only with the e2e hooks on.
    http: new HttpsClient(e2eHooks && testCa !== undefined ? { ca: testCa } : {}),
    catalogueCache: new FileCatalogueCache(path.join(userDir, "catalogues")),
    notifier: notices,
    settings: new JsonSettingsStore(path.join(userDir, "shell-settings.json")),
    blocked: new FsBlockedUpdates(path.join(packageBase, "blocked-updates.json")),
    forgetGenerated: (name) =>
      forgetGeneratedTypes(path.join(userDir, "node-red", "generated"), name),
    environment: {
      source: new FsPackageSource(),
      verifier: new MinisignVerifier(),
      validator: new AjvSchemaValidator(),
      contentHashes: new FsContentHashes(path.join(packageBase, "content-hashes.json")),
      roots: packageRoots,
      builder: systemEnvironmentBuilder(
        process.env,
        process.platform,
        path.join(packageBase, "uv"),
      ),
      logger,
      sha256: sha256Hex,
      target: { platform: process.platform, arch: process.arch },
    },
  });
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

  // ── views (WI-0018-10, -11): the runtime raises them; the shell keeps the Inbox ─────────
  wireViews({
    ipc: ipcMain,
    runtime,
    notifier: notices,
    openPopout: (target, why) => void popouts.open(target, why),
    badge: (count) => app.setBadgeCount(count),
    toPage,
    logger,
  });
  // Quit in the window (F1: turning InnyTypes off is never hidden) runs the one quit.
  wireQuit(ipcMain, question, app, logger);
  // The page's calls the runtime answers: views, lists and the editor sync (WI-0018-10–12).
  const runtimeCalls = wireRuntimeCalls({ ipc: ipcMain, runtime, editor, logger });
  // ── created event types (WI-0018-13): a change restarts the runtime ONLY; edits are kept ──
  const eventTypes = new EventTypeChanges({ runtime, editor, clock: systemClock, logger });
  ipcMain.handle(IPC.eventCall, (_event, call: unknown) => eventTypes.call(call));

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

  if (e2eHooks) {
    exposeE2eHooks({
      restart: (child, reason) => supervisors.get(child)?.restart(reason) ?? false,
      popouts: () => popouts.list(),
      editorEvents: (on) => {
        runtimeCalls.editorEvents(on);
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
    quitBySignal = true;
    app.quit();
  });
  process.on("SIGINT", () => {
    quitBySignal = true;
    app.quit();
  });
  start().catch((error: unknown) => {
    logger.error(`the shell could not start: ${String(error)}`);
    app.exit(1);
  });
}
