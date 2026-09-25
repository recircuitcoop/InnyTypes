// A stand-in runtime for test/integration/one-log-pipes.test.ts: the production source log
// and synchronous stdout writer, in a real process that is then killed with SIGKILL.
//
// argv: <credential> <lines>. It registers the credential the way the runtime registers a
// node's credentials (spec 11.1), runs a fake node whose stderr prints the credential, hands
// that stderr to the log as the runtime will (spec 3.4), then writes <lines> records as fast
// as it can and kills itself the instant the last one is written.
import { spawn } from "node:child_process";
import { syncWriter } from "../../src/adapters/system/sync-writer";
import { sourceLog } from "../../src/application/source-log";
import { forEachLine } from "../../src/domain/logging/lines";

const [credential = "", count = "0"] = process.argv.slice(2);
const log = sourceLog({
  name: "innytypes.runtime",
  pid: process.pid,
  write: syncWriter(1),
  now: () => Date.now(),
});
log.protect(credential);

const node = spawn(
  process.execPath,
  [
    "-e",
    `process.stderr.write("the node was started with " + ${JSON.stringify(credential)} + "\\n")`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
node.stderr.setEncoding("utf8");
forEachLine(node.stderr, (line) => {
  log.nodeLine({ type: "fake-node", instance: "n1" }, "STDERR", line.text);
});
node.on("close", () => {
  for (let index = 0; index < Number(count); index++) {
    log.info(`burst line ${String(index)} ${"z".repeat(200)}`);
  }
  process.kill(process.pid, "SIGKILL");
});
