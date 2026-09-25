// Composition root 2 of 3 (plan 0018 §2.2): the runtime utilityProcess.
//
// It will hold Node-RED, the journal and the node processes; Node-RED is started by
// WI-0018-08. For now it obeys the channel (init, stop, call) and runs the ppid watchdog.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { processHostOver, shellLinkOver } from "../adapters/electron/parent-port";
import { openSqliteJournal, type SqliteJournal } from "../adapters/sqlite/journal";
import { systemClock } from "../adapters/system/clock";
import { syncWriter } from "../adapters/system/sync-writer";
import { watchParent } from "../application/parent-watchdog";
import { serveShell } from "../application/serve-shell";
import { printCanary, sourceLog } from "../application/source-log";

// Every record goes to the shell, the one log writer, as a JSON line on stdout (WI-0018-04).
const logger = sourceLog({
  name: "innytypes.runtime",
  pid: process.pid,
  write: syncWriter(1),
  now: () => Date.now(),
});
printCanary(logger, process.env["INNYTYPES_LOG_CANARY"]);
const host = processHostOver(process);

// The journal (WI-0018-07), opened once `init` says where the user's data lives. Node-RED
// (WI-0018-08) takes it from here: its node processes write to it, and its `flows:started`
// drives the one JournalReplay (application/journal-replay.ts).
let journal: SqliteJournal | null = null;
function openJournal(userDir: string): void {
  if (journal !== null) {
    return;
  }
  try {
    fs.mkdirSync(userDir, { recursive: true });
    journal = openSqliteJournal(path.join(userDir, "journal.sqlite"));
    logger.info(
      `journal: node:sqlite (SQLite ${journal.sqliteVersion}), WAL, ` +
        `${String(journal.all().length)} entries in ${journal.file}`,
    );
  } catch (error) {
    logger.error(`the journal could not be opened: ${String(error)}`);
  }
}

watchParent(host, systemClock, logger);
serveShell({
  child: "runtime",
  link: shellLinkOver(process.parentPort),
  host,
  clock: systemClock,
  logger,
  onInit: (config) => {
    openJournal(config.userDir);
    // Node-RED's credential secret (WI-0018-06), for Node-RED's settings once WI-0018-08
    // starts it. Registered before anything could print it. Only a short fingerprint is
    // logged, so a run can show which secret arrived without showing the secret.
    if (config.credentialSecret === undefined) {
      logger.warn("no credential secret arrived in init");
      return;
    }
    logger.protect(config.credentialSecret);
    const fingerprint = createHash("sha256")
      .update(config.credentialSecret)
      .digest("hex")
      .slice(0, 8);
    logger.info(`the credential secret arrived (sha256 ${fingerprint})`);
  },
});
