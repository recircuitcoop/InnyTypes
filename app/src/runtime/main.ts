// Composition root 2 of 3 (plan 0018 §2.2): the runtime utilityProcess.
//
// It holds Node-RED (WI-0018-08), behind the deploy guard and the Host check, the journal
// (WI-0018-07) and, with WI-0018-09, the node processes. It obeys the channel (init, stop,
// call) and runs the ppid watchdog.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { processHostOver, shellLinkOver } from "../adapters/electron/parent-port";
import { DeclaredPackageStore } from "../adapters/fs/declared-package-store";
import { JsonEventTypeStore, writeDeclaration } from "../adapters/fs/event-type-store";
import { InstalledPackageStore } from "../adapters/fs/installed-package-store";
import { FsPackageRoots } from "../adapters/fs/package-roots";
import { EmbeddedNodeRed } from "../adapters/nodered/engine";
import { generateTypes, REGISTER_GLOBAL } from "../adapters/nodered/generator";
import { TypeRegistration, type NodeRedNodeApi } from "../adapters/nodered/registration";
import { nodeRedLogging } from "../adapters/nodered/logging";
import { nodeRedSettings } from "../adapters/nodered/settings";
import { minimalEnvironment, resolveCommand } from "../adapters/process/command";
import { DEFAULT_NODE_PROCESS, nodeProcessLauncher } from "../adapters/process/node-process";
import { processTreeFor } from "../adapters/process/process-tree";
import { AjvSchemaValidator } from "../adapters/schema/ajv-validator";
import { openSqliteJournal, type SqliteJournal } from "../adapters/sqlite/journal";
import { openSqliteSnapshots } from "../adapters/sqlite/snapshots";
import { systemClock } from "../adapters/system/clock";
import { syncWriter } from "../adapters/system/sync-writer";
import { noticeAnytypeRefusals } from "../application/anytype-refusals";
import { DeployGuard } from "../application/deploy-guard";
import { answerEditorCall } from "../application/editor-events";
import { EventTypeService, isEventOp } from "../application/event-types";
import { JournalReplay, signallingJournal } from "../application/journal-replay";
import type { JournalStore } from "../ports/journal-store";
import { loadNodeTypes } from "../application/load-node-types";
import { watchParent } from "../application/parent-watchdog";
import { receiveKeys } from "../application/peer-link";
import { serveShell, shellNotifier } from "../application/serve-shell";
import { printCanary, sourceLog } from "../application/source-log";
import { ViewService } from "../application/views";
import { enabledNodes, InstanceReadiness } from "../application/instance-readiness";
import { anytypeKeyVariables } from "../domain/anytype/pins";
import type { InitConfig, StopReason } from "../domain/channel/messages";
import {
  USER_EVENTS_PACKAGE,
  userEventsDeclaration,
  userEventTypes,
} from "../domain/events/event-types";
import type { CloseReason } from "../domain/journal/entry";
import { nodeTypeName, type LoadedType } from "../domain/packages/declaration";
import { SecretRegistry } from "../domain/redaction/registry";

// Every record goes to the shell, the one log writer, as a JSON line on stdout (WI-0018-04).
// Node-RED's own lines go under a name of their own, redacted with the same secrets.
const registry = new SecretRegistry();
const logWith = (name: string) =>
  sourceLog({ name, pid: process.pid, write: syncWriter(1), now: () => Date.now(), registry });
const logger = logWith("innytypes.runtime");
const nodeRedLogger = logWith("innytypes.node-red");
printCanary(logger, process.env["INNYTYPES_LOG_CANARY"]);
// Said once, so the e2e harness can check every process runs in its scratch home.
logger.info(`this process's HOME is ${process.env["HOME"] ?? "(unset)"}`);
const host = processHostOver(process);

// Where the app keeps what ships with it. This file is bundled to app/dist/runtime/main.cjs.
const APP_DIR = path.join(__dirname, "..", "..");
/**
 * The packages shipped with the app, and the test fixtures. Installed packages come from the
 * live root the installer swaps verified packages into (WI-0018-16), each with its own
 * environment.
 */
const PACKAGE_ROOTS = [
  path.join(APP_DIR, "..", "packages"),
  path.join(APP_DIR, "test", "fixtures"),
];

// The journal (WI-0018-07), opened once `init` says where the user's data lives. Its node
// processes (WI-0018-09) write to it, and Node-RED's `flows:started` drives the one
// JournalReplay (application/journal-replay.ts), constructed below before Node-RED starts.
let journal: SqliteJournal | null = null;
function openJournal(userDir: string): SqliteJournal {
  if (journal !== null) {
    return journal;
  }
  fs.mkdirSync(userDir, { recursive: true });
  journal = openSqliteJournal(path.join(userDir, "journal.sqlite"));
  logger.info(
    `journal: node:sqlite (SQLite ${journal.sqliteVersion}), WAL, ` +
      `${String(journal.all().length)} entries in ${journal.file}`,
  );
  return journal;
}

/** Register Node-RED's credential secret (WI-0018-06) before anything could print it. */
function protectCredentialSecret(secret: string | undefined): string {
  if (secret === undefined) {
    throw new Error("no credential secret arrived in init; Node-RED is not started without one");
  }
  logger.protect(secret);
  // Only a short fingerprint is logged, so a run shows which secret arrived without showing it.
  const fingerprint = createHash("sha256").update(secret).digest("hex").slice(0, 8);
  logger.info(`the credential secret arrived (sha256 ${fingerprint})`);
  return secret;
}

let nodeRed: EmbeddedNodeRed | null = null;

// ── created event types (WI-0018-13) ──────────────────────────────────────────────────────
// The store in the user's data; its versions become the synthetic `user-events` package's
// sources, written beside it and generated with every other type. The shell restarts this
// process when they change (spec 9.7).
let eventTypes: EventTypeService | null = null;
function createdEventTypes(userDir: string): { service: EventTypeService; types: LoadedType[] } {
  const store = new JsonEventTypeStore(path.join(userDir, "event-types.json"));
  if (store.problem !== null) {
    logger.error(`created event types: ${store.problem}`);
  }
  const service = new EventTypeService({
    store,
    validator: new AjvSchemaValidator(),
    deployed: () => nodeRed?.flowNodes() ?? Promise.resolve([]),
    clock: systemClock,
    logger,
  });
  const source = path.join(APP_DIR, "dist", "runtime", "event-source.cjs");
  const declaration = userEventsDeclaration(store.list(), ["{node}", source]);
  const folder = path.join(userDir, USER_EVENTS_PACKAGE);
  writeDeclaration(folder, declaration);
  return { service, types: userEventTypes(declaration, folder) };
}
// ── end of created event types ────────────────────────────────────────────────────────────
// The views (WI-0018-10), answering the shell's view and snapshot calls once Node-RED runs.
let views: ViewService | null = null;
// Each generated type's instances attach to it as Node-RED constructs them (WI-0018-09).
let replay: JournalReplay | null = null;
// Which instances are ready, for a package update's 30 s window (WI-0018-17), and which package
// each generated type belongs to.
const readiness = new InstanceReadiness();
let packageOfType: (type: string) => string | undefined = () => undefined;

/** The form code of the generated types' editors, built by `npm run build:editor`. */
const EDITOR_FORMS = path.join(APP_DIR, "dist", "nodered", "editor-forms.js");

// Why the runtime is stopping, once `stop` arrives: instances closed then are closed for it
// (spec 7.3). Before that, a close that is not a removal is a redeploy.
let stopping: StopReason | null = null;
const CLOSE_REASON: Readonly<Record<StopReason, Exclude<CloseReason, "removed">>> = {
  quit: "quit",
  types: "types",
  // Any other planned restart is planned all the same: not the step's fault.
  restart: "redeploy",
};

/**
 * The generated types (WI-0018-09): every accepted declaration's types written as Node-RED
 * modules into `generatedDir`, and the registration their modules call, on a global, before
 * Node-RED loads them.
 */
function generateNodeTypes(
  config: InitConfig,
  store: JournalStore,
  packages: InstalledPackageStore,
  generatedDir: string,
  viewService: ViewService,
  created: { service: EventTypeService; types: LoadedType[] },
): TypeRegistration {
  const validator = new AjvSchemaValidator();
  const stored = packages.documents();
  const loaded = [...loadNodeTypes(stored, validator, logger), ...created.types];
  // An installed uv-python package's `{python}` is its own environment's (WI-0018-16).
  const ownPython = new Map(
    stored.flatMap((entry) => (entry.python === undefined ? [] : [[entry.name, entry.python]])),
  );
  const types = new Map<string, LoadedType>(
    loaded.map((entry) => [nodeTypeName(entry.declaration.package, entry.type.id), entry]),
  );
  packageOfType = (type) => types.get(type)?.declaration.package;
  const written = generateTypes(loaded, generatedDir, fs.readFileSync(EDITOR_FORMS, "utf8"));
  logger.info(`generated ${String(written.length)} node types: ${written.join(", ") || "none"}`);
  // The person hears of a stopped node, and of a refused key, through the shell (WI-0018-21).
  const notifier = shellNotifier(link);
  // An Anytype key that Anytype refuses is said once, whichever instance meets it (§4.2).
  const launcher = noticeAnytypeRefusals(
    readiness.wrap(
      nodeProcessLauncher({
        clock: systemClock,
        logger,
        notifier,
        tree: processTreeFor(process.platform),
        newId: randomUUID,
        secrets: logger,
        journal: store,
        settings: DEFAULT_NODE_PROCESS,
      }),
    ),
    notifier,
  );
  const registration = new TypeRegistration({
    types,
    launcher,
    validator,
    replay: {
      attach: (id, node, redeliver) => {
        if (replay === null) {
          throw new Error("the journal replay is not ready; Node-RED constructed a node too early");
        }
        return replay.attach(id, node, redeliver);
      },
    },
    views: viewService,
    sources: created.service,
    logger,
    commandFor: (entry) => ({
      // {python} and {node} become the bundled runtimes with WI-0018-15; until then, PATH's
      // python3 and this process's own executable, which is Node only when told to be.
      ...resolveCommand(entry.type.command, process.platform, {
        python: ownPython.get(entry.declaration.package) ?? "python3",
        node: process.execPath,
        package: entry.folder,
      }),
      env: minimalEnvironment(process.env, {
        ...("electron" in process.versions ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        // Only the key's location, only for the first-party Anytype package (§4.2).
        ...anytypeKeyVariables(
          entry.declaration.package,
          // The first root is the packages shipped with the app.
          path.dirname(entry.folder) === PACKAGE_ROOTS[0],
          config.secretFiles,
        ),
      }),
    }),
    dataDirFor: (id) => path.join(config.userDir, "instances", id),
    closeReason: () => (stopping === null ? "redeploy" : CLOSE_REASON[stopping]),
  });
  (globalThis as Record<symbol, unknown>)[Symbol.for(REGISTER_GLOBAL)] = (
    RED: NodeRedNodeApi,
    typeName: string,
  ) => {
    registration.register(RED, typeName);
  };
  return registration;
}

async function startNodeRed(config: InitConfig): Promise<void> {
  const credentialSecret = protectCredentialSecret(config.credentialSecret);
  // Every write tells the shell the jobs changed, so the Jobs page follows each to its end.
  const store = signallingJournal(openJournal(config.userDir), () => {
    link.post({ v: 1, t: "jobs" });
  });
  if (config.port === null) {
    throw new Error("no port arrived in init; Node-RED has nowhere to listen");
  }
  // Node-RED's own folder, apart from the rest of the user's data.
  const userDir = path.join(config.userDir, "node-red");
  const generatedDir = path.join(userDir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });

  const packages = new InstalledPackageStore(
    new DeclaredPackageStore(PACKAGE_ROOTS, logger),
    new FsPackageRoots(path.join(config.userDir, "node-packages")),
    logger,
  );
  const viewService = new ViewService({
    journal: store,
    snapshots: openSqliteSnapshots(path.join(config.userDir, "snapshots.sqlite")),
    clock: systemClock,
    newId: randomUUID,
    logger,
    raise: (event) => {
      link.post(event);
    },
  });
  const created = createdEventTypes(config.userDir);
  generateNodeTypes(config, store, packages, generatedDir, viewService, created);

  const engine: EmbeddedNodeRed = new EmbeddedNodeRed({
    port: config.port,
    settings: nodeRedSettings({
      userDir,
      generatedDir,
      credentialSecret,
      coreNodesDir: path.dirname(require.resolve("@node-red/nodes/package.json")),
      logging: nodeRedLogging(nodeRedLogger),
    }),
    guard: new DeployGuard({
      engine: { nodeSets: () => engine.nodeSets() },
      // The created event types' package is the runtime's own (WI-0018-13).
      store: { packages: () => [...packages.packages(), USER_EVENTS_PACKAGE] },
      logger,
      port: config.port,
    }),
  });
  nodeRed = engine;
  // Listening before Node-RED starts, so the first `flows:started` is not missed (spec 7.2).
  replay = new JournalReplay({ store, logger, events: engine.events });
  await engine.start();
  // The Inbox badge from the journal: views pending before a restart are pending still.
  viewService.changed();
  views = viewService;
  eventTypes = created.service;
  logger.info(
    `Node-RED ${engine.version()} started at http://127.0.0.1:${String(config.port)}/red ` +
      `(journal replay listening for ${String(replay.queues().length)} instances so far)`,
  );
}

// The Anytype key reaches the redactor from the services process, over the direct channel the
// shell hands every generation (§2.2, WI-0018-18).
const link = shellLinkOver(process.parentPort);
link.onPeer((peer) => {
  receiveKeys(peer, logger, logger);
});
watchParent(host, systemClock, logger);
serveShell({
  child: "runtime",
  link,
  host,
  clock: systemClock,
  logger,
  onInit: startNodeRed,
  onCall: (op, args) => {
    if (views === null || replay === null || nodeRed === null || eventTypes === null) {
      return Promise.resolve({ ok: false, error: "the InnyTypes runtime is still starting" });
    }
    // A package update's check that its instances came back ready (WI-0018-17).
    if (op === "package.ready") {
      return nodeRed.deployedFlows().then((flows) =>
        readiness.answer(
          args,
          enabledNodes(flows).map((node) => ({ id: node.id, package: packageOfType(node.type) })),
        ),
      );
    }
    // The Events page (WI-0018-13): the created event types' store, and their sources.
    if (isEventOp(op)) {
      return eventTypes.call(op, args);
    }
    // The editor sync (WI-0018-12): the node sets, and Node-RED's own node/added, node/removed.
    if (op === "editor.nodes" || op === "editor.sync") {
      return answerEditorCall(op, args, nodeRed, logger);
    }
    // The Jobs page's calls go to the journal replay, which holds every instance's process.
    return op === "job.list" || op === "job.cancel"
      ? Promise.resolve(replay.call(op, args))
      : views.call(op, args);
  },
  // Spec 10.2: `stop` runs RED.stop() (every node closes) before `stopped` and the exit.
  onStop: (reason) => {
    stopping = reason;
    return nodeRed?.stop();
  },
});
