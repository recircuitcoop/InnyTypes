// A fake Anytype MCP child: speaks MCP over stdio (one JSON object per line) the way the pinned
// @anyproto/anytype-mcp does, with no Anytype and no network. WI-0018-18's tests run it on the
// same node the app would run the real package on.
//
// Modes, as `--mode=<name>`:
// * normal  — answers initialize, tools/list (tools.json beside this file), ping, and
//             tools/call with the tool's name (for the gateway's independent client);
// * deaf    — answers the handshake, then never answers a ping, and stays alive: the child the
//             heartbeat must judge stale;
// * canary  — like normal, but first prints the key it was given (from OPENAPI_MCP_HEADERS) to
//             stderr, the way a careless server would: the one log must redact it; and quotes
//             it in every tools/call result, the way the real child quotes Anytype's refusals:
//             the gateway must redact it;
// * crash   — answers the handshake, then exits 3 on the first ping.
// `--pid-file=<path>` writes this process's pid there, for a test that must find it.
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = JSON.parse(fs.readFileSync(path.join(here, "tools.json"), "utf8"));
const option = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = option("mode") ?? "normal";
const pidFile = option("pid-file");
if (pidFile !== undefined) {
  fs.writeFileSync(pidFile, String(process.pid));
}

if (mode === "canary") {
  const headers = JSON.parse(process.env.OPENAPI_MCP_HEADERS ?? "{}");
  process.stderr.write(`fake MCP child starting with ${headers.Authorization}\n`);
}
process.stderr.write(`fake MCP child ${String(process.pid)} running on stdio (${mode})\n`);

const send = (message) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    answer(JSON.parse(frame));
  }
});
// The real server exits when its client closes stdin; so does this one.
process.stdin.on("end", () => {
  process.exit(0);
});

function answer(message) {
  if (message.id === undefined) {
    return; // a notification
  }
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-anytype-mcp", version: "0" },
        },
      });
      return;
    case "tools/list":
      send({ id: message.id, result: { tools } });
      return;
    case "tools/call": {
      const quoted =
        mode === "canary"
          ? ` ${JSON.parse(process.env.OPENAPI_MCP_HEADERS ?? "{}").Authorization}`
          : "";
      send({
        id: message.id,
        result: { content: [{ type: "text", text: `${message.params.name}${quoted}` }] },
      });
      return;
    }
    case "ping":
      if (mode === "deaf") {
        return; // alive, and silent
      }
      if (mode === "crash") {
        process.exit(3);
      }
      send({ id: message.id, result: {} });
      return;
    default:
      send({ id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
  }
}
