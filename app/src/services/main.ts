// Composition root 3 of 3 (plan 0018 §2.2): the services utilityProcess.
//
// It will hold Anytype: the key, the MCP child and the loopback MCP endpoint; the Anytype
// core service arrives with WI-0018-18. For now it obeys the channel (init, stop, call) and
// runs the ppid watchdog.
import { processHostOver, shellLinkOver } from "../adapters/electron/parent-port";
import { systemClock } from "../adapters/system/clock";
import { syncWriter } from "../adapters/system/sync-writer";
import { watchParent } from "../application/parent-watchdog";
import { serveShell } from "../application/serve-shell";
import { printCanary, sourceLog } from "../application/source-log";

// Every record goes to the shell, the one log writer, as a JSON line on stdout (WI-0018-04).
const logger = sourceLog({
  name: "innytypes.services",
  pid: process.pid,
  write: syncWriter(1),
  now: () => Date.now(),
});
printCanary(logger, process.env["INNYTYPES_LOG_CANARY"]);
const host = processHostOver(process);

watchParent(host, systemClock, logger);
serveShell({
  child: "services",
  link: shellLinkOver(process.parentPort),
  host,
  clock: systemClock,
  logger,
});
