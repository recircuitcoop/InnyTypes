// Two programs that never touch each other (plan 0018 §4.1 point 3; WI-0018-19), the port of
// tests/test_independent_client_connection.py. A real Streamable HTTP MCP client (the official
// SDK's) initialises, lists tools and calls one through the gateway, against the fake MCP child
// on its own pipes, from nothing but a URL and a bearer token: neither side launches the other.
// The Anytype key never appears on the wire, in an error or in a log line (a canary). And no
// source file, and no documented client configuration, launches or configures a client.
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpMcpGateway } from "../../src/adapters/anytype/gateway";
import { NodeMcpChildLauncher } from "../../src/adapters/anytype/mcp-child";
import { toolSignature } from "../../src/adapters/anytype/tool-surface";
import { systemClock } from "../../src/adapters/system/clock";
import { mcpDispatch } from "../../src/application/mcp-dispatch";
import { sourceLog } from "../../src/application/source-log";
import { childEnvironment } from "../../src/domain/anytype/pins";
import {
  checkedAddress,
  DEFAULT_PORT,
  endpointUrl,
  MCP_PATH,
} from "../../src/domain/endpoint/address";
import { SecretRegistry } from "../../src/domain/redaction/registry";
import type { McpChild, McpTool } from "../../src/ports/anytype";
import { RecordingLogger } from "../fakes/children";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = path.resolve(APP, "..");
const FAKE = path.join(APP, "test", "fixtures", "fake-mcp", "server.mjs");
const FAKE_TOOLS = JSON.parse(
  fs.readFileSync(path.join(APP, "test", "fixtures", "fake-mcp", "tools.json"), "utf8"),
) as McpTool[];
const FAKE_SURFACE = Object.fromEntries(
  FAKE_TOOLS.map((tool) => [tool.name, toolSignature(tool.inputSchema)]),
);
// The word "fake" is on these lines for the committed-secret scan.
const PROXY_TOKEN = "fake-proxy-token-for-the-client-0123456789";
const ANYTYPE_KEY = "fake-anytype-canary-key-for-the-client-0123456789";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((one) => one.stop()));
});

/** The services side: the fake child on its pipes, validated, and the gateway in front of it. */
async function services(mode: string, registry: SecretRegistry, port: number) {
  const logged: string[] = [];
  const log = (name: string, pid: number) =>
    sourceLog({ name, pid, write: (text) => logged.push(text), now: () => 0, registry });
  const launcher = new NodeMcpChildLauncher({
    node: { command: process.execPath, env: {} },
    entry: FAKE,
    args: [`--mode=${mode}`],
    clock: systemClock,
    expected: FAKE_SURFACE,
    stopDeadlineMs: 2_000,
  });
  const child: McpChild = launcher.launch(
    childEnvironment(ANYTYPE_KEY, "http://127.0.0.1:9"),
    (pid, line) => {
      log("innytypes.anytype-mcp", pid).warn(line);
    },
  );
  running.push(child);
  const tools = await child.session.initialize();
  const logger = new RecordingLogger();
  const gateway = new HttpMcpGateway({
    token: PROXY_TOKEN,
    handle: mcpDispatch({
      served: () => ({ session: child.session, tools }),
      redact: (text) => registry.redact(text),
    }),
    logger,
  });
  running.push(gateway);
  await gateway.serveAt("127.0.0.1", port);
  return { child, gateway, logged, logger };
}

/** An MCP client that started on its own: a URL and a bearer token, and nothing else. */
async function client(url: string, wire: string[] = []) {
  const fetched = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? init.body : "";
    wire.push(input.toString(), JSON.stringify(init?.headers ?? {}), body);
    const response = await fetch(input, init);
    wire.push(await response.clone().text());
    return response;
  };
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${PROXY_TOKEN}` } },
    fetch: fetched,
  });
  const mcp = new Client({ name: "a client that started on its own", version: "1" });
  // The SDK's own types disagree with exactOptionalPropertyTypes (sessionId?: string).
  await mcp.connect(transport as Parameters<Client["connect"]>[0]);
  running.push({ stop: () => mcp.close() });
  return mcp;
}

describe("an independent Streamable HTTP client", () => {
  it("finds nothing while InnyTypes is absent: an ordinary refused connection", async () => {
    const port = await freePort();
    const failure = await fetch(`http://127.0.0.1:${String(port)}${MCP_PATH}`, {
      method: "POST",
      body: "{}",
    }).catch((error: unknown) => error);
    expect(((failure as Error).cause as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
  });

  it("initialises, lists and calls a tool through the gateway, with no process launched by either side", async () => {
    const port = await freePort();
    const url = endpointUrl("127.0.0.1", port);
    // A client that found the address refused a moment ago...
    const early = await fetch(url, { method: "POST", body: "{}" }).catch((error: unknown) => error);
    expect(early).toBeInstanceOf(Error);
    // ...and InnyTypes, which starts later on its own.
    await services("normal", new SecretRegistry(), port);

    // From here on, every way this process can start another one fails the test.
    const childProcess = createRequire(import.meta.url)(
      "node:child_process",
    ) as typeof import("node:child_process");
    const spawned = (
      ["spawn", "fork", "exec", "execFile", "spawnSync", "execSync", "execFileSync"] as const
    ).map((name) => vi.spyOn(childProcess, name));

    const mcp = await client(url);
    const listed = await mcp.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(FAKE_TOOLS.map((tool) => tool.name));
    const called = await mcp.callTool({ name: "API-list-spaces", arguments: { limit: 1 } });
    expect(called.content).toEqual([{ type: "text", text: "API-list-spaces" }]);
    for (const spy of spawned) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("answers a second client on a connection of its own, with no session to inherit", async () => {
    const port = await freePort();
    await services("normal", new SecretRegistry(), port);
    const url = endpointUrl("127.0.0.1", port);
    const wire: string[] = [];
    const first = await client(url, wire);
    const second = await client(url, wire);
    expect((await first.listTools()).tools).toEqual((await second.listTools()).tools);
    await second.ping();
    // No session identity is issued, so there is nothing for a second client to take over.
    expect(wire.join("\n").toLowerCase()).not.toContain("mcp-session-id");
  });

  it("never sees the Anytype key: not on the wire, in the URL, an error or a log line", async () => {
    const registry = new SecretRegistry();
    registry.protect(ANYTYPE_KEY); // what the registering store does when the key is read
    registry.protect(PROXY_TOKEN);
    const port = await freePort();
    // The canary child prints the key on stderr and quotes it in every tool result.
    const { logged, logger } = await services("canary", registry, port);
    const url = endpointUrl("127.0.0.1", port);
    const wire: string[] = [url];
    const mcp = await client(url, wire);
    await mcp.listTools();
    const called = await mcp.callTool({ name: "API-get-object", arguments: {} });
    expect(JSON.stringify(called)).toContain("Bearer [redacted]");
    const refusal = await mcp
      .callTool({ name: "API-delete-everything", arguments: {} })
      .catch((error: unknown) => String(error));
    wire.push(JSON.stringify(refusal));
    await vi.waitFor(() => {
      expect(logged.join("")).toContain("fake MCP child starting with");
    });
    const everything = [...wire, ...logged, ...logger.lines].join("\n");
    expect(everything).not.toContain(ANYTYPE_KEY);
    expect(logged.join("")).not.toContain(PROXY_TOKEN);
  });
});

// ── neither side launches or configures the other ──────────────────────────────────────

function sourceFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { recursive: true, encoding: "utf8" })
    .map((relative) => path.join(directory, relative))
    .filter((file) => /\.(ts|mjs|cjs|js|html)$/.test(file) && fs.statSync(file).isFile());
}

describe("the application's source", () => {
  it("never names the MCP client: no line of it launches, configures or supervises one", () => {
    // The words a person reads (ui/strings.ts, plan 0022 §O) name it in one line, General's AI
    // apps row from ux-writing: "Claude, Codex and other apps can use your Anytype…". That file
    // holds sentences only, and that line is the only one that names it.
    const STRINGS = path.join(APP, "src", "ui", "strings.ts");
    const named = sourceFiles(path.join(APP, "src")).filter(
      (file) => file !== STRINGS && /codex/i.test(fs.readFileSync(file, "utf8")),
    );
    expect(named).toEqual([]);
    const lines = fs.readFileSync(STRINGS, "utf8").split("\n");
    expect(lines.filter((line) => /codex/i.test(line))).toEqual([
      expect.stringMatching(/^ {4}"Claude, Codex and other apps can use your Anytype through/),
    ]);
  });

  it("never reaches for a client's configuration file", () => {
    const reaching = sourceFiles(path.join(APP, "src")).filter((file) =>
      fs.readFileSync(file, "utf8").includes(".codex"),
    );
    expect(reaching).toEqual([]);
  });
});

// ── what the documentation tells a person to write ─────────────────────────────────────

const CONNECTION_DOC = path.join(REPO, "docs", "anytype-mcp-connection.md");
const README = path.join(REPO, "README.md");
const DOCUMENTS = [CONNECTION_DOC, README];

/** One document as one line, with Markdown emphasis and backticks taken out. */
const flattened = (document: string) =>
  fs.readFileSync(document, "utf8").replaceAll("**", "").replaceAll("`", "").replace(/\s+/g, " ");

/** Every fenced block of one document, with its language. */
function blocks(document: string): { language: string; text: string }[] {
  return [...fs.readFileSync(document, "utf8").matchAll(/```([a-z]*)\n([\s\S]*?)```/g)].map(
    ([, language, text]) => ({ language: language ?? "", text: text ?? "" }),
  );
}

/** The tables of a TOML block, each key's value read as TOML's plain scalars are. */
function tomlTables(text: string): Map<string, Record<string, unknown>> {
  const tables = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> = {};
  tables.set("", current);
  for (const line of text.split("\n").map((raw) => raw.trim())) {
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      current = {};
      tables.set(header[1], current);
      continue;
    }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (pair?.[1] !== undefined && pair[2] !== undefined) {
      current[pair[1]] = JSON.parse(pair[2]) as unknown;
    }
  }
  return tables;
}

describe("the documentation", () => {
  it("configures a client with a URL and a token, and never a command", () => {
    const servers = DOCUMENTS.flatMap((document) =>
      blocks(document)
        .filter((block) => block.language === "toml")
        .flatMap((block) =>
          [...tomlTables(block.text)].filter(([name]) => name.startsWith("mcp_servers.")),
        ),
    );
    expect(servers.length).toBeGreaterThan(0);
    for (const [name, table] of servers) {
      expect(table, name).toHaveProperty("url");
      expect(table, name).toHaveProperty("bearer_token_env_var");
      expect(table, name).not.toHaveProperty("command");
      expect(table, name).not.toHaveProperty("args");
      expect(String(table["url"]).endsWith(MCP_PATH), name).toBe(true);
    }
  });

  it("never hands a client Anytype's REST port, and says what that port is", () => {
    const code = DOCUMENTS.flatMap(blocks);
    expect(code.length).toBeGreaterThan(0);
    for (const block of code) {
      expect(block.text).not.toContain("31009");
    }
    const prose = flattened(CONNECTION_DOC);
    expect(prose).toMatch(/do not use .{0,60}31009/i);
    expect(prose).toMatch(/31009.{0,40}is Anytype's REST API/i);
  });

  it("says which transport is public and which is private", () => {
    const prose = flattened(CONNECTION_DOC);
    expect(prose).toMatch(/stdio pipes are private internal transport/i);
    expect(prose).toMatch(/public contract is the loopback Streamable HTTP/i);
  });

  it("documents a stored endpoint the one rule accepts, and not the default port", () => {
    const stored = blocks(CONNECTION_DOC)
      .filter((block) => block.language === "toml")
      .map((block) => tomlTables(block.text).get("mcp"))
      .filter((table) => table !== undefined);
    expect(stored.length).toBeGreaterThan(0);
    for (const table of stored) {
      const { host, port } = table as { host: string; port: number };
      expect(checkedAddress(host, port)).toEqual({ host, port });
      expect(port).not.toBe(DEFAULT_PORT);
    }
  });

  it("calls the stored setting the way to choose the endpoint, in both documents", () => {
    for (const document of DOCUMENTS) {
      const prose = flattened(document);
      expect(prose, document).toMatch(
        /stored setting.{0,80}stored value is what InnyTypes serves/i,
      );
      expect(prose, document).toContain("[mcp]");
    }
  });

  it("never presents a variable as the way to choose the port without saying it is the default", () => {
    const qualifications =
      /never been configured|nothing is stored|is ignored|are ignored|only while nothing/i;
    for (const document of DOCUMENTS) {
      const prose = flattened(document);
      const mentions = [...prose.matchAll(/INNYTYPES_MCP_(HOST|PORT)/g)].map((m) => m.index);
      expect(mentions.length, document).toBeGreaterThan(0);
      for (const position of mentions) {
        const window = prose.slice(Math.max(0, position - 400), position + 400);
        expect(window, document).toMatch(qualifications);
      }
    }
  });
});
