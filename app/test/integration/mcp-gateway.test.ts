// The loopback MCP endpoint over real sockets (plan 0018 §4.1 point 3; WI-0018-19), the port of
// tests/test_anytype_mcp_gateway.py. It is the one network-facing surface the application has,
// so most of what is asserted is a refusal, each staged from its real cause, each asserting both
// the bounded failure and that the child was never reached. Every listener binds a free loopback
// port (never 31010), every child session is a fake, and both credentials are fake literals.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_LIMITS,
  HttpMcpGateway,
  type GatewayLimits,
} from "../../src/adapters/anytype/gateway";
import { OwnerOnlyFileStore } from "../../src/adapters/fs/owner-only-files";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import { mcpDispatch, type ServedMcp } from "../../src/application/mcp-dispatch";
import { readOrCreate, registering } from "../../src/application/secrets";
import { EndpointError } from "../../src/domain/endpoint/address";
import {
  GET_REFUSAL,
  MAX_BODY_BYTES,
  MAX_CONCURRENT_REQUESTS,
  MAX_HEADER_BYTES,
} from "../../src/domain/endpoint/limits";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import type { McpSession, McpTool } from "../../src/ports/anytype";
import type { McpHandler } from "../../src/ports/mcp-gateway";
import { RecordingLogger } from "../fakes/children";

const TOKEN = "fake-mcp-proxy-token-0123456789";
const TOOL: McpTool = { name: "get_object", inputSchema: { type: "object" } };
const PING = { jsonrpc: "2.0", id: 1, method: "ping" };
const PONG = { jsonrpc: "2.0", id: 1, result: {} };

// ── helpers ────────────────────────────────────────────────────────────────────────────────

/** A child session that records what it was asked; `hold` keeps each call open until released. */
class RecordingSession implements McpSession {
  closed = false;
  readonly calls: string[] = [];
  delayMs = 0;
  #held: (() => void)[] = [];
  hold = false;
  entered = 0;

  initialize(): Promise<readonly McpTool[]> {
    return Promise.resolve([TOOL]);
  }
  ping(): Promise<void> {
    return Promise.resolve();
  }
  async request(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.calls.push(method);
    this.entered += 1;
    if (this.hold) {
      await new Promise<void>((resolve) => this.#held.push(resolve));
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return { content: [{ type: "text", text: params["name"] }] };
  }
  release(): void {
    for (const resolve of this.#held.splice(0)) {
      resolve();
    }
  }
  close(): void {
    this.closed = true;
  }
}

function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

async function canBind(host: string): Promise<boolean> {
  try {
    await freePort(host);
    return true;
  } catch {
    return false;
  }
}

const gateways: HttpMcpGateway[] = [];
const blockers: net.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(
    blockers.splice(0).map((blocker) => new Promise((resolve) => blocker.close(resolve))),
  );
});

interface Serving {
  readonly gateway: HttpMcpGateway;
  readonly port: number;
  readonly session: RecordingSession;
  readonly logger: RecordingLogger;
}

async function serving(
  options: {
    token?: string;
    host?: string;
    limits?: Partial<GatewayLimits>;
    handle?: McpHandler;
    served?: () => ServedMcp | null;
  } = {},
): Promise<Serving> {
  const session = new RecordingSession();
  const logger = new RecordingLogger();
  const gateway = new HttpMcpGateway({
    token: options.token ?? TOKEN,
    handle:
      options.handle ??
      mcpDispatch({
        served: options.served ?? (() => ({ session, tools: [TOOL] })),
        redact: (text) => text,
      }),
    logger,
    limits: { ...GATEWAY_LIMITS, ...options.limits },
  });
  gateways.push(gateway);
  const host = options.host ?? "127.0.0.1";
  const port = await freePort(host);
  await gateway.serveAt(host, port);
  return { gateway, port, session, logger };
}

interface Reply {
  readonly status: number;
  readonly text: string;
}

/** One request with full control of method, path and headers; the status and the raw body. */
function request(
  port: number,
  body: string | Buffer | null,
  options: {
    token?: string | null;
    headers?: Record<string, string>;
    host?: string;
    method?: string;
    path?: string;
  } = {},
): Promise<Reply> {
  const host = options.host ?? "127.0.0.1";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  Object.assign(headers, options.headers);
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host,
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/mcp",
        headers,
        agent: false,
        timeout: 10_000,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, text });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body ?? undefined);
  });
}

async function post(port: number, payload: unknown, token?: string): Promise<[number, unknown]> {
  const reply = await request(port, JSON.stringify(payload), { token: token ?? TOKEN });
  return [reply.status, reply.text === "" ? null : JSON.parse(reply.text)];
}

/** The bytes of one POST /mcp header block, spelled out header by header. */
function head(port: number, length: number, ...extra: string[]): string {
  return [
    "POST /mcp HTTP/1.1",
    `Host: 127.0.0.1:${String(port)}`,
    `Authorization: Bearer ${TOKEN}`,
    `Content-Length: ${String(length)}`,
    ...extra,
  ]
    .join("\r\n")
    .concat("\r\n\r\n");
}

/** The status code these exact bytes are answered with, or "reset" when the connection dies first. */
function answerTo(
  port: number,
  bytes: string | Buffer,
  socket?: net.Socket,
): Promise<number | "reset"> {
  return new Promise((resolve) => {
    const connection = socket ?? net.connect(port, "127.0.0.1");
    let seen = "";
    connection.on("data", (chunk: Buffer) => {
      seen += chunk.toString("latin1");
      const line = seen.split("\r\n")[0];
      if (seen.includes("\r\n") && line !== undefined) {
        resolve(Number(line.split(" ")[1]));
        connection.destroy();
      }
    });
    connection.on("error", () => {
      resolve("reset");
    });
    connection.on("close", () => {
      resolve("reset");
    });
    if (bytes.length > 0) {
      connection.write(bytes);
    }
  });
}

/** Whether a connection to `port` is refused by the TCP stack. */
function refused(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "ECONNREFUSED");
    });
  });
}

/** Assert nothing holds this address, by taking it: the only honest way to ask. */
async function freeAgain(port: number): Promise<void> {
  const reclaim = net.createServer();
  await new Promise<void>((resolve, reject) => {
    reclaim.once("error", reject);
    reclaim.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => reclaim.close(resolve));
}

/** A loopback port another program is really listening on. */
async function occupied(): Promise<number> {
  const port = await freePort();
  const blocker = net.createServer();
  blockers.push(blocker);
  await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  return port;
}

/** A valid JSON-RPC ping whose encoded body is exactly `total` bytes long. */
function paddedPing(total: number): string {
  const skeleton = { jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "" } };
  const overhead = JSON.stringify(skeleton).length;
  const body = JSON.stringify({ ...skeleton, params: { pad: "p".repeat(total - overhead) } });
  expect(body.length).toBe(total);
  return body;
}

/** Every HTTP server made from here on, so a test can count the ones still listening. */
function watchListeners(): () => number {
  const made: http.Server[] = [];
  const create = http.createServer.bind(http);
  vi.spyOn(http, "createServer").mockImplementation((...args: Parameters<typeof create>) => {
    const server = create(...args);
    made.push(server);
    return server;
  });
  return () => made.filter((server) => server.listening).length;
}

// ── the address it may bind ──────────────────────────────────────────────────────────────

describe("the address it binds", () => {
  it.each(["127.0.0.1", "::1"])(
    "serves each accepted loopback address for real: %s",
    async (host) => {
      if (!(await canBind(host))) {
        // Said, not skipped silently: this machine leaves the IPv6 half unproven.
        console.warn(`acceptance left unproven on this machine: cannot bind ${host}`);
        return;
      }
      const { port, gateway } = await serving({ host });
      const reply = await request(port, JSON.stringify(PING), {
        host,
        headers: {
          host: host.includes(":") ? `[${host}]:${String(port)}` : `${host}:${String(port)}`,
        },
      });
      expect([reply.status, JSON.parse(reply.text)]).toEqual([200, PONG]);
      expect(gateway.serving).toEqual({ host, port });
    },
  );

  it("refuses to serve without a proxy token: an empty one equals an empty header", () => {
    expect(
      () =>
        new HttpMcpGateway({
          token: "",
          handle: () => Promise.reject(new Error("unused")),
          logger: new RecordingLogger(),
        }),
    ).toThrow("token is empty");
  });

  it.each([
    ["0.0.0.0", "must be loopback"],
    ["localhost", "numeric loopback"],
    ["127.0.0.1", "between 1 and 65535"],
  ])("refuses to bind %s before any socket is opened", async (host, reason) => {
    const listening = watchListeners();
    const gateway = new HttpMcpGateway({
      token: TOKEN,
      handle: () => Promise.reject(new Error("unused")),
      logger: new RecordingLogger(),
    });
    await expect(gateway.serveAt(host, host === "127.0.0.1" ? 0 : 40000)).rejects.toThrow(reason);
    expect(gateway.serving).toBeNull();
    expect(listening()).toBe(0);
    expect(http.createServer).not.toHaveBeenCalled();
  });

  it("names a port collision and never moves to another port", async () => {
    const { port } = await serving();
    const second = new HttpMcpGateway({
      token: TOKEN,
      handle: () => Promise.reject(new Error("unused")),
      logger: new RecordingLogger(),
    });
    gateways.push(second);
    const failure = await second.serveAt("127.0.0.1", port).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EndpointError);
    expect((failure as Error).message).toMatch(
      new RegExp(`could not bind the MCP service at 127\\.0\\.0\\.1:${String(port)}`),
    );
    expect(second.serving).toBeNull();
  });

  it("refuses to bind twice the address it already serves, and keeps serving it", async () => {
    const { gateway, port } = await serving();
    await expect(gateway.serveAt("127.0.0.1", port)).rejects.toThrow(`127.0.0.1:${String(port)}`);
    expect(gateway.serving).toEqual({ host: "127.0.0.1", port });
    expect(await post(port, PING)).toEqual([200, PONG]);
  });
});

// ── the two credentials ──────────────────────────────────────────────────────────────────

describe("the proxy token", () => {
  function tokenFile() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-token-"));
    const file = path.join(scratch, "credentials", "mcp_proxy_token");
    const registry = new SecretRegistry();
    const store = registering(new OwnerOnlyFileStore({ "mcp-proxy-token": { file } }), registry);
    const token = () =>
      readOrCreate(
        store,
        "mcp-proxy-token",
        () => `fake-${Math.random().toString(36).slice(2)}-0123456789abcdefghijklmnop`,
      );
    return { scratch, file, registry, token };
  }

  it("is persistent and owner-only, and registered with the redactor whether made or read", () => {
    const { scratch, file, registry, token } = tokenFile();
    try {
      const first = token();
      expect(token()).toBe(first);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(registry.redact(`refused: authorization was Bearer ${first}`)).not.toContain(first);
      // A second process reads the existing file rather than creating it, and registers it too.
      const reader = new SecretRegistry();
      const read = registering(
        new OwnerOnlyFileStore({ "mcp-proxy-token": { file } }),
        reader,
      ).read("mcp-proxy-token");
      expect(read).toBe(first);
      expect(reader.redact(`Bearer ${first}`)).toBe(`Bearer ${REDACTED}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses the value it replaced once rotated", async () => {
    const { scratch, file, token } = tokenFile();
    try {
      const first = token();
      const before = await serving({ token: first });
      expect((await post(before.port, PING, first))[0]).toBe(200);
      fs.rmSync(file);
      const second = token();
      expect(second).not.toBe(first);
      const after = await serving({ token: second });
      expect((await post(after.port, PING, first))[0]).toBe(401);
      expect((await post(after.port, PING, second))[0]).toBe(200);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("is checked before the body: a wrong bearer is refused, and the body never read or parsed", async () => {
    let handled = 0;
    const { port } = await serving({
      handle: () => {
        handled += 1;
        return Promise.resolve({ status: 200, body: { parsed: true } });
      },
    });
    const reply = await request(port, "not-json", { token: "wrong" });
    expect(reply.status).toBe(401);
    expect(reply.text).not.toContain("invalid JSON");
    expect(handled).toBe(0);
    // A megabyte announced and never sent is refused at once: nothing waits for the body.
    const started = Date.now();
    const bytes = head(port, MAX_BODY_BYTES).replace(`Bearer ${TOKEN}`, "Bearer wrong");
    expect(await answerTo(port, bytes)).toBe(401);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(handled).toBe(0);
    // And no bearer at all is the same refusal.
    expect((await request(port, JSON.stringify(PING), { token: null })).status).toBe(401);
  });
});

// ── who is allowed to speak to it ────────────────────────────────────────────────────────

describe("Host and Origin", () => {
  it.each([
    ["host", "innytypes.attacker.example", "a name the browser was told is this service"],
    ["host", "127.0.0.1:1", "the right address on a port this service does not own"],
    ["host", "", "no Host at all"],
    ["origin", "http://innytypes.attacker.example", "a page served by a real site"],
    ["origin", "http://localhost:{port}", "a name rather than an address"],
    ["origin", "http://127.0.0.1:1", "loopback, on another port"],
    ["origin", "null", "an opaque origin"],
  ])("refuses %s %j (%s) before the child hears of it", async (header, value) => {
    const { port, session, logger } = await serving();
    const body = JSON.stringify(PING);
    const status =
      header === "host" && value === ""
        ? // node's client always sends a Host; this one is written by hand without any.
          await answerTo(
            port,
            head(port, body.length).replace(`Host: 127.0.0.1:${String(port)}\r\n`, "") + body,
          )
        : (
            await request(port, body, {
              headers: { [header]: value.replace("{port}", String(port)) },
            })
          ).status;
    expect(status).toBe(403);
    expect(session.calls).toEqual([]);
    expect(logger.lines.join("\n")).not.toContain(TOKEN);
  });

  it("serves the configured loopback origin: the refusals are worth nothing otherwise", async () => {
    const { port } = await serving();
    const reply = await request(port, JSON.stringify(PING), {
      headers: { origin: `http://127.0.0.1:${String(port)}` },
    });
    expect([reply.status, JSON.parse(reply.text)]).toEqual([200, PONG]);
  });
});

// ── the exchange ─────────────────────────────────────────────────────────────────────────

describe("the Streamable HTTP exchange", () => {
  it("lets an independent HTTP client initialise, list and call a tool", async () => {
    const { port } = await serving();
    const [status, initialized] = await post(port, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(status).toBe(200);
    expect(initialized).toMatchObject({ result: { capabilities: { tools: {} } } });
    expect((await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list" }))[1]).toMatchObject({
      result: { tools: [TOOL] },
    });
    const [, called] = await post(port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_object", arguments: {} },
    });
    expect(called).toMatchObject({ result: { content: [{ text: "get_object" }] } });
    // A notification is a bare 202.
    const accepted = await request(
      port,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(accepted).toEqual({ status: 202, text: "" });
  });

  it("is 503 while the child is unavailable, an MCP error and not a second child", async () => {
    const { port } = await serving({ served: () => null });
    expect(await post(port, { jsonrpc: "2.0", id: 4, method: "tools/list" })).toEqual([
      503,
      {
        jsonrpc: "2.0",
        id: 4,
        error: { code: -32000, message: "the Anytype MCP child is unavailable" },
      },
    ]);
  });

  it("serves one method and one path: GET is refused in its own words, whoever sends it", async () => {
    const { port } = await serving();
    for (const token of [TOKEN, null]) {
      const got = await request(port, null, { method: "GET", token });
      expect([got.status, JSON.parse(got.text)]).toEqual([405, { error: GET_REFUSAL }]);
    }
    expect((await request(port, null, { method: "DELETE" })).status).toBe(405);
    expect(
      await answerTo(
        port,
        `POST /admin HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nContent-Length: 0\r\n\r\n`,
      ),
    ).toBe(404);
  });
});

// ── the four bounds ──────────────────────────────────────────────────────────────────────

describe("the bounds", () => {
  it("serves a body at the bound, and refuses one byte over it from the declared length", async () => {
    const { port } = await serving();
    const at = await request(port, paddedPing(MAX_BODY_BYTES));
    expect([at.status, JSON.parse(at.text)]).toMatchObject([200, { result: {} }]);
    // Announced, not sent: the refusal comes from the header, so the body is never read.
    expect(await answerTo(port, head(port, MAX_BODY_BYTES + 1))).toBe(413);
  });

  it("refuses a body whose length is not a number, or not given", async () => {
    const { port } = await serving();
    const missing = `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`;
    expect(await answerTo(port, missing)).toBe(411);
    const chunked = missing.replace("\r\n\r\n", "\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
    expect(await answerTo(port, chunked)).toBe(411);
  });

  it("serves a header block inside the bound and refuses one past it with 431", async () => {
    const { port } = await serving();
    const body = JSON.stringify(PING);
    const within = head(port, body.length, `X-Pad: ${"v".repeat(MAX_HEADER_BYTES - 200)}`);
    const past = head(port, body.length, `X-Pad: ${"v".repeat(MAX_HEADER_BYTES)}`);
    expect(await answerTo(port, within + body)).toBe(200);
    expect(await answerTo(port, past + body)).toBe(431);
  });

  it("admits its full count at once and refuses the next with 429, then gives the slots back", async () => {
    const { port, session } = await serving();
    session.hold = true;
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_object" } };
    const admitted = Array.from({ length: MAX_CONCURRENT_REQUESTS }, () => post(port, call));
    await vi.waitFor(() => {
      expect(session.entered).toBe(MAX_CONCURRENT_REQUESTS);
    });
    expect(await post(port, call)).toEqual([429, { error: "request bound is full" }]);
    session.release();
    expect((await Promise.all(admitted)).map(([status]) => status)).toEqual(
      Array<number>(MAX_CONCURRENT_REQUESTS).fill(200),
    );
    // The bound is a bound, not a fuse.
    expect(await post(port, PING)).toEqual([200, PONG]);
  });

  it("times out a body that never arrives, and gives every slot back", async () => {
    const { port } = await serving({ limits: { readTimeoutMs: 300 } });
    const started = Date.now();
    const answers = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_REQUESTS }, () =>
        answerTo(port, `${head(port, 64)}{"jsonrpc"`),
      ),
    );
    expect(answers).toEqual(Array<number>(MAX_CONCURRENT_REQUESTS).fill(408));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await post(port, PING)).toEqual([200, PONG]);
  });

  it("times out a body dribbled a byte at a time: the whole request is bounded, not each read", async () => {
    // The per-read bound is raised, so a pass comes from the request bound alone.
    const { port } = await serving({ limits: { readTimeoutMs: 30_000, receiveTimeoutMs: 500 } });
    const started = Date.now();
    const sockets: net.Socket[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    const answers = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_REQUESTS }, () => {
        const socket = net.connect(port, "127.0.0.1");
        sockets.push(socket);
        const answer = answerTo(port, head(port, MAX_BODY_BYTES), socket);
        timers.push(
          setInterval(() => {
            if (!socket.destroyed) {
              socket.write(" ");
            }
          }, 50),
        );
        return answer;
      }),
    );
    timers.forEach(clearInterval);
    sockets.forEach((socket) => socket.destroy());
    // Answered 408, or reset before the answer could be read: the platform's choice. What the
    // bound promises is that the request ends and the slot comes back.
    expect(answers.every((answer) => answer === 408 || answer === "reset")).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await post(port, PING)).toEqual([200, PONG]);
  });

  it("does not bound a slow child: two slow calls down one connection both come back", async () => {
    const { port, session } = await serving({ limits: { receiveTimeoutMs: 200 } });
    session.delayMs = 600; // three times the bound these requests are received under
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_object" },
    });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const once = () =>
        new Promise<number>((resolve, reject) => {
          const outgoing = http.request(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: "/mcp",
              agent,
              headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            },
            (response) => {
              response.resume();
              response.on("end", () => {
                resolve(response.statusCode ?? 0);
              });
            },
          );
          outgoing.on("error", reject);
          outgoing.end(call);
        });
      expect(await once()).toBe(200);
      expect(await once()).toBe(200);
    } finally {
      agent.destroy();
    }
  });

  it("treats a client that leaves before its answer as an ending, not a fault, and frees its slot", async () => {
    const { port, session, logger } = await serving();
    session.hold = true;
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_object" },
    });
    const socket = net.connect(port, "127.0.0.1");
    socket.write(head(port, call.length) + call);
    await vi.waitFor(() => {
      expect(session.entered).toBe(1);
    });
    socket.resetAndDestroy();
    session.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    session.hold = false;
    expect(await post(port, PING)).toEqual([200, PONG]);
    expect(logger.lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });

  it("treats a notification whose client left the same way, on the other write path", async () => {
    let arrived: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    let letGo: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => (letGo = resolve));
    const dispatch = mcpDispatch({ served: () => null, redact: (text) => text });
    const { port, logger } = await serving({
      handle: async (body) => {
        arrived();
        await gone;
        return dispatch(body);
      },
    });
    const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const socket = net.connect(port, "127.0.0.1");
    socket.write(head(port, note.length) + note);
    await reached;
    socket.resetAndDestroy();
    letGo();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await post(port, PING)).toEqual([200, PONG]);
    expect(logger.lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  });
});

// ── shutdown ─────────────────────────────────────────────────────────────────────────────

describe("stopping", () => {
  it("closes the listener and leaves no listener or bound port behind, and twice is not an error", async () => {
    const listening = watchListeners();
    const { gateway, port } = await serving();
    expect(await post(port, PING)).toEqual([200, PONG]);
    await gateway.stop();
    expect(gateway.serving).toBeNull();
    expect(await refused(port)).toBe(true);
    await freeAgain(port);
    expect(listening()).toBe(0);
    await gateway.stop();
  });
});

// ── moving a live listener ───────────────────────────────────────────────────────────────

describe("moving the endpoint", () => {
  it("moves it, and the old address stops answering: somewhere else, and only there", async () => {
    const { gateway, port: oldPort } = await serving();
    expect(await post(oldPort, PING)).toEqual([200, PONG]);
    const newPort = await freePort();
    await gateway.serveAt("127.0.0.1", newPort);
    expect(gateway.serving).toEqual({ host: "127.0.0.1", port: newPort });
    expect(await post(newPort, PING)).toEqual([200, PONG]);
    const [, called] = await post(newPort, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_object" },
    });
    expect(called).toMatchObject({ result: { content: [{ text: "get_object" }] } });
    expect(await refused(oldPort)).toBe(true);
    await freeAgain(oldPort);
  });

  it("already listens at the new address at the moment the old one stops accepting", async () => {
    const { gateway } = await serving();
    const newPort = await freePort();
    // Applied to each server as its own `this` below, so it is taken unbound on purpose.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const close = http.Server.prototype.close;
    const sampled: string[] = [];
    // Sampled from inside the old listener's own close, the one moment the ordering exists to
    // be seen. A short separate process asks the kernel, so the answer is not this process's
    // event loop: a listening socket completes the connection, a missing one refuses it.
    vi.spyOn(http.Server.prototype, "close").mockImplementation(function (
      this: http.Server,
      ...args: Parameters<typeof close>
    ) {
      sampled.push(
        execFileSync(
          process.execPath,
          [
            "-e",
            `const s=require('net').connect(${String(newPort)},'127.0.0.1');` +
              `s.on('connect',()=>{process.stdout.write('listening');s.destroy()});` +
              `s.on('error',e=>process.stdout.write(e.code))`,
          ],
          { encoding: "utf8" },
        ),
      );
      return close.apply(this, args);
    });
    await gateway.serveAt("127.0.0.1", newPort);
    vi.restoreAllMocks();
    expect(sampled).toEqual(["listening"]);
    expect(await post(newPort, PING)).toEqual([200, PONG]);
  });

  it.each([
    ["localhost", null, "numeric loopback"],
    ["127.0.0.1.nip.io", null, "numeric loopback"],
    ["", null, "numeric loopback"],
    ["0.0.0.0", null, "must be loopback"],
    ["::", null, "must be loopback"],
    ["192.168.1.2", null, "must be loopback"],
    ["93.184.216.34", null, "must be loopback"],
    ["127.0.0.1", 0, "between 1 and 65535"],
    ["127.0.0.1", 65536, "between 1 and 65535"],
  ])("refuses %j:%j with its reason and closes nothing", async (host, port, reason) => {
    const { gateway, port: oldPort } = await serving();
    const target = port ?? (await freePort());
    await expect(gateway.serveAt(host, target)).rejects.toThrow(reason);
    expect(gateway.serving).toEqual({ host: "127.0.0.1", port: oldPort });
    expect(await post(oldPort, PING)).toEqual([200, PONG]);
  });

  it("refuses a taken port, chooses no other, and does not take it when it is let go", async () => {
    const listening = watchListeners();
    const { gateway, port: oldPort } = await serving();
    const blocked = await occupied();
    await expect(gateway.serveAt("127.0.0.1", blocked)).rejects.toThrow(
      new RegExp(`could not bind .*127\\.0\\.0\\.1:${String(blocked)}`),
    );
    expect(gateway.serving).toEqual({ host: "127.0.0.1", port: oldPort });
    expect(await post(oldPort, PING)).toEqual([200, PONG]);
    // No second listener was put up anywhere, on any port.
    expect(listening()).toBe(1);
    const blocker = blockers.pop();
    await new Promise((resolve) => blocker?.close(resolve));
    await freeAgain(blocked);
  });

  it("finishes a request already received across the move, while the old address refuses", async () => {
    const { gateway, port: oldPort, session } = await serving();
    session.hold = true;
    const inFlight = post(oldPort, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_object" },
    });
    await vi.waitFor(() => {
      expect(session.entered).toBe(1);
    });
    const newPort = await freePort();
    await gateway.serveAt("127.0.0.1", newPort);
    expect(await refused(oldPort)).toBe(true);
    session.hold = false;
    expect(await post(newPort, PING)).toEqual([200, PONG]);
    session.release();
    expect(await inFlight).toEqual([
      200,
      { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "get_object" }] } },
    ]);
  });

  it("leaves one listener after a completed move and after a refused one", async () => {
    const listening = watchListeners();
    const { gateway, port: oldPort } = await serving();
    expect(listening()).toBe(1);
    await gateway.serveAt("127.0.0.1", await freePort());
    expect(listening()).toBe(1);
    await freeAgain(oldPort);
    const blocked = await occupied();
    await expect(gateway.serveAt("127.0.0.1", blocked)).rejects.toThrow(EndpointError);
    expect(listening()).toBe(1);
    await gateway.stop();
    expect(listening()).toBe(0);
  });
});

// ── the settings file ────────────────────────────────────────────────────────────────────

describe("the settings file", () => {
  function scratchFile() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-settings-"));
    return { scratch, file: path.join(scratch, "user-data", "settings.json") };
  }

  it("reads nothing stored from a missing file, and keeps every other setting on a write", () => {
    const { scratch, file } = scratchFile();
    try {
      const store = new JsonSettingsStore(file);
      expect(store.readEndpoint()).toEqual({});
      store.writeEndpoint({ port: 32010 });
      expect(new JsonSettingsStore(file).readEndpoint()).toEqual({ port: 32010 });
      fs.writeFileSync(file, JSON.stringify({ telemetry: "off", mcp: { port: 1 } }));
      store.writeEndpoint({ host: "127.0.0.1", port: 32011 });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        telemetry: "off",
        mcp: { host: "127.0.0.1", port: 32011 },
      });
      expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each([
    ["{ not json", "is not JSON"],
    ["[1, 2]", "does not hold a settings object"],
    ['{"mcp": {"port": "32010"}}', "must hold a host (text) and a port (a whole number)"],
    ['{"mcp": 7}', "must hold a host (text) and a port (a whole number)"],
  ])("names the file when it holds %j, rather than reading nothing stored", (text, reason) => {
    const { scratch, file } = scratchFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      expect(() => new JsonSettingsStore(file).readEndpoint()).toThrow(reason);
      expect(() => new JsonSettingsStore(file).readEndpoint()).toThrow(file);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("names the file it could not read or write", () => {
    const { scratch, file } = scratchFile();
    try {
      fs.mkdirSync(file, { recursive: true }); // a directory where the file belongs
      expect(() => new JsonSettingsStore(file).readEndpoint()).toThrow(`could not read ${file}`);
      const locked = path.join(scratch, "locked");
      fs.mkdirSync(locked, { mode: 0o500 });
      const under = path.join(locked, "settings.json");
      expect(() => {
        new JsonSettingsStore(under).writeEndpoint({ port: 1 });
      }).toThrow(`could not write ${under}`);
      fs.chmodSync(locked, 0o700);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
