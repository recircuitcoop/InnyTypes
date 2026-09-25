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
import { DeployGuard } from "../application/deploy-guard";
import { JournalReplay } from "../application/journal-replay";
import { loadNodeTypes } from "../application/load-node-types";
import { watchParent } from "../application/parent-watchdog";
import { receiveKeys } from "../application/peer-link";
import { serveShell } from "../application/serve-shell";
import { printCanary, sourceLog } from "../application/source-log";
import { ViewService } from "../application/views";
import type { InitConfig, StopReason } from "../domain/channel/messages";
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
 * The package store's folders until verified installs exist (WI-0018-15, -16): the first-party
 * packages shipped with the app, and the test fixtures.
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
// The views (WI-0018-10), answering the shell's view and snapshot calls once Node-RED runs.
let views: ViewService | null = null;
// Each generated type's instances attach to it as Node-RED constructs them (WI-0018-09).
let replay: JournalReplay | null = null;

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
  store: SqliteJournal,
  packages: DeclaredPackageStore,
  generatedDir: string,
  viewService: ViewService,
): TypeRegistration {
  const validator = new AjvSchemaValidator();
  const loaded = loadNodeTypes(packages.documents(), validator, logger);
  const types = new Map<string, LoadedType>(
    loaded.map((entry) => [nodeTypeName(entry.declaration.package, entry.type.id), entry]),
  );
  const written = generateTypes(loaded, generatedDir, fs.readFileSync(EDITOR_FORMS, "utf8"));
  logger.info(`generated ${String(written.length)} node types: ${written.join(", ") || "none"}`);
  const launcher = nodeProcessLauncher({
    clock: systemClock,
    logger,
    // The person hears of a stopped node with WI-0018-21's notices; until then, the log.
    notifier: {
      raise: (notice) => {
        logger.warn(`notice: ${notice.title}: ${notice.body}`);
      },
    },
    tree: processTreeFor(process.platform),
    newId: randomUUID,
    secrets: logger,
    journal: store,
    settings: DEFAULT_NODE_PROCESS,
  });
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
    logger,
    commandFor: ({ type, folder }) => ({
      // {python} and {node} become the bundled runtimes with WI-0018-15; until then, PATH's
      // python3 and this process's own executable, which is Node only when told to be.
      ...resolveCommand(type.command, process.platform, {
        python: "python3",
        node: process.execPath,
        package: folder,
      }),
      env: minimalEnvironment(
        process.env,
        "electron" in process.versions ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      ),
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
  const store = openJournal(config.userDir);
  if (config.port === null) {
    throw new Error("no port arrived in init; Node-RED has nowhere to listen");
  }
  // Node-RED's own folder, apart from the rest of the user's data.
  const userDir = path.join(config.userDir, "node-red");
  const generatedDir = path.join(userDir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });

  const packages = new DeclaredPackageStore(PACKAGE_ROOTS, logger);
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
  generateNodeTypes(config, store, packages, generatedDir, viewService);

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
      store: packages,
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
  onCall: (op, args) =>
    views === null
      ? Promise.resolve({ ok: false, error: "the InnyTypes runtime is still starting" })
      : views.call(op, args),
  // Spec 10.2: `stop` runs RED.stop() (every node closes) before `stopped` and the exit.
  onStop: (reason) => {
    stopping = reason;
    return nodeRed?.stop();
  },
});
