// Composition root 1 of 3 (plan 0018 §2.2): the Electron main process.
// The only place in the shell where parts are wired together, and one of the three files allowed
// to read process.env or import adapters (§2.3). It takes the single-instance lock, picks the
// runtime's stable port, supervises the runtime and services utilityProcesses, serves the app
// pages and the pop-outs, keeps the Inbox, tells the person things once (WI-0018-21), starts or
// adopts the Anytype desktop app, and stops both children before it quits.
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
import { autoUpdater } from "electron-updater";
import { EditorFrame } from "../adapters/electron/editor-frame";
import { chooseLegacyLoginItem } from "../adapters/electron/legacy-login-item";
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
import { legacyConfigPath, readTextFileOrNull } from "../adapters/fs/legacy-config";
import { JsonLegacyImportReportStore } from "../adapters/fs/legacy-import-report";
import { FsLegacyPackageEnvironments, legacyAddonsRoot } from "../adapters/fs/legacy-packages";
import { JsonNoticeFile, NOTICES_FILENAME } from "../adapters/fs/notice-file";
import { JsonSettingsStore } from "../adapters/fs/settings-store";
import { anytypeExecutable, ProcessTableApps } from "../adapters/process/desktop-apps";
import { DiskReportQueue, QUEUE_DIRNAME } from "../adapters/telemetry/disk-queue";
import { HttpsPoster } from "../adapters/telemetry/https-poster";
import * as machineId from "../adapters/telemetry/machine-id";
import { HttpsClient } from "../adapters/net/https-client";
import { forgetGeneratedTypes } from "../adapters/nodered/generator";
import { RUNTIMES_DIRNAME } from "../adapters/process/bundled-runtime-locator";
import {
  bundledEnvironmentBuilder,
  systemEnvironmentBuilder,
} from "../adapters/process/env-builder";
import { AjvSchemaValidator } from "../adapters/schema/ajv-validator";
import { sha256Hex, sha512Base64 } from "../adapters/signature/digest";
import { MinisignVerifier } from "../adapters/signature/minisign";
import { JsonPlacementStore } from "../adapters/fs/placement-store";
import { pickFreeLoopbackPort } from "../adapters/net/free-port";
import { systemClock } from "../adapters/system/clock";
import { ElectronUpdaterInstaller } from "../adapters/update/electron-updater-installer";
import { AnytypeApp } from "../application/anytype-app";
import { EventTypeChanges } from "../application/event-type-changes";
import { OneLog } from "../application/one-log";
import { linkPeers } from "../application/peer-link";
import { openSecretStore, readOrCreate } from "../application/secrets";
import { QuitFlow } from "../application/quit";
import { printCanary } from "../application/source-log";
import { Supervisor } from "../application/supervisor";
import type { UpdateCheck } from "../application/update-check";
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
import packageJson from "../../package.json";
import { anytypeAppPath, wireDesktop } from "./desktop";
import { exposeE2eHooks } from "./e2e-hooks";
import { IPC } from "./ipc";
import { wireMigration } from "./migration";
import { wirePackages } from "./packages";
import { quitQuestion, wireQuit } from "./quit-question";
import { childEnvironment, LOG_CANARY_VARIABLE } from "./child-environment";
import { wireRuntimeCalls } from "./runtime-calls";
import { wireServiceCalls } from "./service-calls";
import { wireTelemetry } from "./telemetry";
import { wireUpdate } from "./update";
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
/** Where a package's view component is found until verified installs exist (WI-0018-15, -16). */
const PACKAGE_ROOTS = [
  path.join(APP_DIR, "..", "packages"),
  path.join(APP_DIR, "test", "fixtures"),
];
/** Bundled runtimes (WI-0018-23); null (dev, e2e) falls back to SystemRuntimeLocator. */
const RUNTIMES_DIR = app.isPackaged ? path.join(process.resourcesPath, RUNTIMES_DIRNAME) : null;
// The e2e gate must not touch this user's keychain: Chromium's mock keychain (macOS) encrypts with a fixed key held in memory, so safeStorage never writes a plaintext.
if (process.env["INNYTYPES_MOCK_KEYCHAIN"] === "1") {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// ── the one log (WI-0018-04): the shell is its only writer ──────────────────────────────
// A value registered as a secret and then printed by every process, so the e2e gate and the
// `log` machine proof can show it never reaches the file (plan 0018 §5.4). Unset ordinarily.
const logCanary = process.env[LOG_CANARY_VARIABLE];
let logLevel = DEFAULT_LEVEL;
let levelProblem: string | null = null;
try {
  logLevel = resolveLevel(process.env[LOG_LEVEL_VARIABLE]);
} catch (error) {
  // A misspelled verbosity is said in the log, written at the default (logs.py:438-442).
  levelProblem = (error as Error).message;
}
const logFile = RotatingLogFile.open(
  logPath({ platform: process.platform, home: os.homedir(), env: process.env }),
);
const secretRegistry = new SecretRegistry();
const oneLog = new OneLog({
  registry: secretRegistry,
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
// else the installed one, for the installed InnyTypes only — never a dev or e2e run.
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
let updates: UpdateCheck | null = null;
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
    updates?.installAtQuit(); // a no-op unless WI-0018-24 staged a verified update
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
  // The login item: the e2e gate's autostart directory, else none for a non-installed run (it refuses), else Linux's autostart entry or Electron's login item.
  const autostart = e2eHooks ? process.env["INNYTYPES_TEST_AUTOSTART_DIR"] : undefined;
  const entry = { executable: process.env["APPIMAGE"] ?? process.execPath, icon: "innytypes" };
  const xdg = autostartDirectory(process.env["XDG_CONFIG_HOME"], os.homedir());
  const { notices, launchAtLogin } = wireDesktop({
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
  // ── migrating an old installation (WI-0018-25): imported once (shell/migration.ts) ────────
  const legacyLocation = { platform: process.platform, home: os.homedir(), env: process.env };
  wireMigration({
    ipc: ipcMain,
    readLegacyConfig: () => readTextFileOrNull(legacyConfigPath(legacyLocation)),
    reportStore: new JsonLegacyImportReportStore(userDir),
    shellSettings: new JsonSettingsStore(path.join(userDir, "shell-settings.json")),
    mcpSettings: new JsonSettingsStore(path.join(userDir, "settings.json")),
    launchAtLogin,
    legacyLoginItem: chooseLegacyLoginItem(process.platform, os.homedir(), xdg),
    legacyPackages: new FsLegacyPackageEnvironments(legacyAddonsRoot(legacyLocation)),
    notices,
    logger,
  });
  ipcMain.handle(IPC.secretStorage, (): Contract.SecretStorageStatus => secretStorage);
  // Generated once and kept; every runtime generation is handed the same one in `init`. A
  // keychain that cannot decrypt it stops the start rather than orphan every credential.
  const credentialSecret = readOrCreate(secrets.store, "node-red-credential-secret", () =>
    randomBytes(32).toString("hex"),
  );
  // The Anytype key and proxy token, located once here (os.homedir()) through WI-0018-06's file adapter; init hands the paths on.
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
      env: childEnvironment(child, {
        home: os.homedir(),
        env: process.env,
        runtimesDir: RUNTIMES_DIR,
        e2eHooks,
      }),
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
  const uvCacheDir = path.join(packageBase, "uv");
  // The e2e gate's local HTTPS server's certificate, only with the e2e hooks on; shared below.
  const httpsClient = new HttpsClient(e2eHooks && testCa !== undefined ? { ca: testCa } : {});
  wirePackages({
    ipc: ipcMain,
    dialog,
    runtime,
    editor,
    clock: systemClock,
    logger,
    userDir,
    shippedStore,
    // A release's build settings (WI-0018-23): package.json's "innytypes", a placeholder until a real catalogue exists; INNYTYPES_CATALOGUE_URL/_KEY override it.
    catalogueUrl: process.env["INNYTYPES_CATALOGUE_URL"] ?? packageJson.innytypes.catalogueUrl,
    catalogueKey: process.env["INNYTYPES_CATALOGUE_KEY"] ?? packageJson.innytypes.catalogueKey,
    http: httpsClient,
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
      builder:
        RUNTIMES_DIR === null
          ? systemEnvironmentBuilder(process.env, process.platform, uvCacheDir)
          : bundledEnvironmentBuilder(process.env, process.platform, uvCacheDir, RUNTIMES_DIR),
      logger,
      sha256: sha256Hex,
      target: { platform: process.platform, arch: process.arch },
    },
  });
  // WI-0018-24: minisigned before any download; null on a platform this app cannot self-update.
  const updateRepo = process.env["INNYTYPES_UPDATE_REPO"] ?? packageJson.innytypes.updateRepo;
  const updateChannel = process.env["INNYTYPES_UPDATE_CHANNEL"] ?? "latest";
  updates = wireUpdate({
    transport: { http: httpsClient, verifier: new MinisignVerifier(), sha512: sha512Base64 },
    settings: new JsonSettingsStore(path.join(userDir, "shell-settings.json")),
    report: { notifier: notices, logger },
    selfUpdater: new ElectronUpdaterInstaller(autoUpdater, updateRepo, updateChannel, logger),
    session: { clock: systemClock, currentVersion: () => app.getVersion() },
    publicKey: process.env["INNYTYPES_UPDATE_KEY"] ?? packageJson.innytypes.updatePublicKey,
    feedBaseUrl: `https://github.com/${updateRepo}/releases/latest/download`,
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
  const runtimeCalls = wireRuntimeCalls({ ipc: ipcMain, runtime, editor, logger, dialog });
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
  // ── telemetry (WI-0018-22): nothing is queued, sent or even identified before the answer ──
  const testMachineId = e2eHooks ? process.env["INNYTYPES_TEST_MACHINE_ID"] : undefined;
  wireTelemetry({
    ipc: ipcMain,
    setting: new JsonSettingsStore(path.join(userDir, "shell-settings.json")),
    queue: new DiskReportQueue(path.join(userDir, QUEUE_DIRNAME), logger),
    poster: new HttpsPoster(e2eHooks && testCa !== undefined ? { ca: testCa } : {}),
    machineIdentifier: () =>
      testMachineId ?? machineId.osMachineIdentifier(machineId.systemSeams(process.platform)),
    hashIdentifier: machineId.machineIdHash,
    env: process.env,
    appVersion: app.getVersion(),
    registry: secretRegistry,
    sink: oneLog,
    supervisors,
    packages: () => packageStore.documents(),
    clock: systemClock,
    logger,
  });
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
