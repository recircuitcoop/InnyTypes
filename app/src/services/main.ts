// Composition root 3 of 3 (plan 0018 §2.2): the services utilityProcess.
//
// It will hold Anytype: the key, the MCP child and the loopback MCP endpoint; the Anytype
// core service arrives with WI-0018-18. For now it obeys the channel (init, stop, call) and
// runs the ppid watchdog.
import { processHostOver, shellLinkOver } from "../adapters/electron/parent-port";
import { systemClock } from "../adapters/system/clock";
import { consoleLogger } from "../adapters/system/console-logger";
import { watchParent } from "../application/parent-watchdog";
import { serveShell } from "../application/serve-shell";

const logger = consoleLogger("services", process.pid);
const host = processHostOver(process);

watchParent(host, systemClock, logger);
serveShell({
  child: "services",
  link: shellLinkOver(process.parentPort),
  host,
  clock: systemClock,
  logger,
});
