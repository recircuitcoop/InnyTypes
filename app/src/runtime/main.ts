// Composition root 2 of 3 (plan 0018 §2.2): the runtime utilityProcess.
//
// It will hold Node-RED, the journal and the node processes; Node-RED is started by
// WI-0018-08. For now it obeys the channel (init, stop, call) and runs the ppid watchdog.
import { processHostOver, shellLinkOver } from "../adapters/electron/parent-port";
import { systemClock } from "../adapters/system/clock";
import { consoleLogger } from "../adapters/system/console-logger";
import { watchParent } from "../application/parent-watchdog";
import { serveShell } from "../application/serve-shell";

const logger = consoleLogger("runtime", process.pid);
const host = processHostOver(process);

watchParent(host, systemClock, logger);
serveShell({
  child: "runtime",
  link: shellLinkOver(process.parentPort),
  host,
  clock: systemClock,
  logger,
});
