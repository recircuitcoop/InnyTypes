// Composition root 2 of 3 (plan 0018 §2.2): the runtime utilityProcess.
//
// It holds Node-RED (WI-0018-08), behind the deploy guard and the Host check, the journal
// (WI-0018-07) and, with WI-0018-09, the node processes. It obeys the channel (init, stop,
// call) and runs the ppid watchdog.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { processHostOver, shellLinkOver } from "../adapters/electron/parent-port";
import { DeclaredPackageStore } from "../adapters/fs/declared-package-store";
import { EmbeddedNodeRed } from "../adapters/nodered/engine";
import { nodeRedLogging } from "../adapters/nodered/logging";
import { nodeRedSettings } from "../adapters/nodered/settings";
import { openSqliteJournal, type SqliteJournal } from "../adapters/sqlite/journal";
import { systemClock } from "../adapters/system/clock";
import { syncWriter } from "../adapters/system/sync-writer";
import { DeployGuard } from "../application/deploy-guard";
import { JournalReplay } from "../application/journal-replay";
import { watchParent } from "../application/parent-watchdog";
import { serveShell } from "../application/serve-shell";
import { printCanary, sourceLog } from "../application/source-log";
import type { InitConfig } from "../domain/channel/messages";
import { SecretRegistry } from "../domain/redaction/registry";

// Every record goes to the shell, the one log writer, as a JSON line on stdout (WI-0018-04).
// Node-RED's own lines go under a name of their own, redacted with the same secrets.
const registry = new SecretRegistry();
const logWith = (name: string) =>
  sourceLog({ name, pid: process.pid, write: syncWriter(1), now: () => Date.now(), registry });
const logger = logWith("innytypes.runtime");
const nodeRedLogger = logWith("innytypes.node-red");
printCanary(logger, process.env["INNYTYPES_LOG_CANARY"]);
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
// Kept for WI-0018-09, whose node constructors attach each instance to it.
let replay: JournalReplay | null = null;

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
      store: new DeclaredPackageStore(PACKAGE_ROOTS, logger),
      logger,
      port: config.port,
    }),
  });
  nodeRed = engine;
  // Listening before Node-RED starts, so the first `flows:started` is not missed (spec 7.2).
  replay = new JournalReplay({ store, logger, events: engine.events });
  await engine.start();
  logger.info(
    `Node-RED ${engine.version()} started at http://127.0.0.1:${String(config.port)}/red ` +
      `(journal replay listening for ${String(replay.queues().length)} instances so far)`,
  );
}

watchParent(host, systemClock, logger);
serveShell({
  child: "runtime",
  link: shellLinkOver(process.parentPort),
  host,
  clock: systemClock,
  logger,
  onInit: startNodeRed,
  // Spec 10.2: `stop` runs RED.stop() (every node closes) before `stopped` and the exit.
  onStop: () => nodeRed?.stop(),
});
