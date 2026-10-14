// The loopback MCP endpoint through the real app (WI-0018-19, plan 0018 §4.1 points 3 and 4):
// served from the services process once the MCP child is validated, behind the proxy token file
// under the scratch home, moved live over AppApi (bind-before-close, a refusal keeps it serving),
// and the stored address winning over INNYTYPES_MCP_PORT at the next start.
// And a binary file larger than the child's frame bound round-trips intact (WI-0019-04, plan
// 0019), answered by InnyTypes from the fake Anytype's REST API, never by the child.
//
// Never the owner's Anytype, key or port: a fake Anytype, the fake MCP child, a scratch HOME, and
// free loopback ports (the harness gives every run its own INNYTYPES_MCP_PORT, never 31010).
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, type Page } from "@playwright/test";
import { toolSignature } from "../../src/adapters/anytype/tool-surface";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import {
  anytypeKeyFile,
  APP,
  freePortNow,
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
} from "./app-harness";

const FAKE = path.join(APP, "test", "fixtures", "fake-mcp");

interface EndpointStatus {
  readonly served: string | null;
  readonly saved: string | null;
  readonly stored: boolean;
  readonly ignoredVariables: readonly string[];
  readonly problem: string | null;
  readonly warning: string;
}

type EndpointApi = {
  anytypeStatus(): Promise<{ state: string; childPid: number | null }>;
  mcpEndpoint(): Promise<EndpointStatus>;
  moveMcpEndpoint(host: string, port: number): Promise<EndpointStatus>;
};

const endpoint = (window: Page) =>
  window.evaluate(() =>
    (window as unknown as { inny: { app: EndpointApi } }).inny.app.mcpEndpoint(),
  );

const anytypeStatus = (window: Page) =>
  window.evaluate(() =>
    (window as unknown as { inny: { app: EndpointApi } }).inny.app.anytypeStatus(),
  );

const move = (window: Page, host: string, port: number) =>
  window
    .evaluate(
      ([h, p]) =>
        (window as unknown as { inny: { app: EndpointApi } }).inny.app.moveMcpEndpoint(h, p),
      [host, port] as const,
    )
    .catch((error: unknown) => String(error));

/** A file the fake Anytype serves at its content path. */
interface ServedFile {
  readonly type: string;
  readonly body: Buffer;
}

/** A fake Anytype that answers the health gate, and the files it is given by their path. */
async function fakeAnytype(
  files: ReadonlyMap<string, ServedFile> = new Map(),
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const file = files.get(request.url ?? "");
    if (file !== undefined) {
      response.setHeader("content-type", file.type);
      response.setHeader("content-length", String(file.body.length));
      response.end(file.body);
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end('{"data":[]}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as net.AddressInfo).port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The fake child's surface, recorded the way the committed one is. */
function fakeSurface(scratch: string): string {
  const tools = JSON.parse(fs.readFileSync(path.join(FAKE, "tools.json"), "utf8")) as {
    name: string;
    inputSchema: unknown;
  }[];
  const file = path.join(scratch, "fake-surface.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      package_version: PACKAGE_VERSION,
      anytype_version: ANYTYPE_VERSION,
      source: "bundled-spec",
      captured_at: "e2e",
      tools: Object.fromEntries(tools.map((t) => [t.name, toolSignature(t.inputSchema)])),
    }),
  );
  return file;
}

/** One JSON-RPC call to the endpoint, the way an independent client makes it. */
async function rpc(url: string, token: string, method: string): Promise<[number, unknown]> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  });
  return [response.status, await response.json()];
}

const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      resolve(true);
    });
  });

test("the endpoint is served behind the proxy token, moved live, and the stored address wins at the next start", async () => {
  const { scratch, userData, env, canaryKey } = scratchDirectories();
  const anytype = await fakeAnytype();
  const blocker = net.createServer();
  try {
    const firstPort = Number(env["INNYTYPES_MCP_PORT"]);
    const runEnv = {
      ...env,
      ANYTYPE_API_BASE_URL: anytype.url,
      INNYTYPES_TEST_ANYTYPE: JSON.stringify({
        entry: path.join(FAKE, "server.mjs"),
        args: ["--mode=canary"],
        surface: fakeSurface(scratch),
      }),
    };
    const { app, window, output } = await launchApp(runEnv);
    const first = `http://127.0.0.1:${String(firstPort)}/mcp`;
    await expect.poll(async () => (await endpoint(window)).served, { timeout: 20_000 }).toBe(first);

    // The existing token file under the (scratch) home, created owner-only.
    const tokenFile = path.join(path.dirname(anytypeKeyFile(scratch)), "mcp_proxy_token");
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const [listed, tools] = await rpc(first, token, "tools/list");
    expect(listed).toBe(200);
    expect(JSON.stringify(tools)).toContain("API-list-spaces");
    expect((await rpc(first, "wrong", "tools/list"))[0]).toBe(401);

    // A move: the new address serves, the old one is refused, and the setting is stored. It
    // is not a restart: the same MCP child answers through the new address.
    const childBefore = (await anytypeStatus(window)).childPid;
    expect(childBefore).not.toBeNull();
    const secondPort = freePortNow();
    const second = `http://127.0.0.1:${String(secondPort)}/mcp`;
    const moved = (await move(window, "127.0.0.1", secondPort)) as EndpointStatus;
    expect(moved).toMatchObject({ served: second, saved: second, stored: true, problem: null });
    expect(moved.warning).toContain("must be updated");
    expect((await rpc(second, token, "tools/list"))[0]).toBe(200);
    expect(await refused(firstPort)).toBe(true);
    expect((await anytypeStatus(window)).childPid).toBe(childBefore);
    expect(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"))).toEqual({
      mcp: { host: "127.0.0.1", port: secondPort },
    });

    // Refusals cost nothing: a network address, and a port another program holds.
    expect(await move(window, "0.0.0.0", secondPort)).toContain("must be loopback");
    const takenPort = freePortNow();
    await new Promise<void>((resolve) => blocker.listen(takenPort, "127.0.0.1", resolve));
    expect(await move(window, "127.0.0.1", takenPort)).toContain(`127.0.0.1:${String(takenPort)}`);
    expect((await endpoint(window)).served).toBe(second);
    expect((await rpc(second, token, "tools/list"))[0]).toBe(200);

    // kill -9 of the MCP child: the endpoint stays up and says 503 while it is gone, and serves
    // tools again once the restarted child has been validated.
    process.kill(childBefore ?? 0, "SIGKILL");
    await expect
      .poll(async () => (await rpc(second, token, "tools/list"))[0], { timeout: 10_000 })
      .toBe(503);
    await expect
      .poll(async () => (await anytypeStatus(window)).childPid, { timeout: 20_000 })
      .not.toBe(childBefore);
    await expect
      .poll(async () => (await rpc(second, token, "tools/list"))[0], { timeout: 20_000 })
      .toBe(200);
    expect((await endpoint(window)).served).toBe(second);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    expect(await refused(secondPort)).toBe(true);
    // Neither credential in anything the app printed.
    const printed = output.join("");
    expect(printed).not.toContain(token);
    expect(printed).not.toContain(canaryKey);

    // The next start: the variable still names the first port, and the stored one wins.
    const again = await launchApp(runEnv);
    await expect
      .poll(async () => (await endpoint(again.window)).served, { timeout: 20_000 })
      .toBe(second);
    expect(await endpoint(again.window)).toMatchObject({
      stored: true,
      ignoredVariables: ["INNYTYPES_MCP_PORT"],
    });
    expect(await refused(firstPort)).toBe(true);
    await quit(again.app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// Plan 0019's end-to-end bullet (WI-0019-04): a file that is not text, larger than the child's
// 1 MiB frame, reaches an independent client intact, and the child is untouched by it.
test("a binary file round-trips through the endpoint", async () => {
  const { scratch, userData, env } = scratchDirectories();
  // A generated 7.3 MB "PDF": a PDF header, then random bytes, which are not UTF-8.
  const file = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(7_300_000)]);
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const anytype = await fakeAnytype(
    new Map([["/v2/spaces/space-1/files/file-1/content", { type: "application/pdf", body: file }]]),
  );
  try {
    const { app, window } = await launchApp({
      ...env,
      ANYTYPE_API_BASE_URL: anytype.url,
      INNYTYPES_TEST_ANYTYPE: JSON.stringify({
        entry: path.join(FAKE, "server.mjs"),
        surface: fakeSurface(scratch),
      }),
    });
    const url = `http://127.0.0.1:${env["INNYTYPES_MCP_PORT"] ?? ""}/mcp`;
    await expect.poll(async () => (await endpoint(window)).served, { timeout: 20_000 }).toBe(url);
    const childBefore = (await anytypeStatus(window)).childPid;
    expect(childBefore).not.toBeNull();

    const tokenFile = path.join(path.dirname(anytypeKeyFile(scratch)), "mcp_proxy_token");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const mcp = new Client({ name: "an independent client", version: "1" });
    // The SDK's own types disagree with exactOptionalPropertyTypes (sessionId?: string).
    await mcp.connect(transport as Parameters<Client["connect"]>[0]);
    try {
      const downloaded = await mcp.callTool({
        name: "API-download-file",
        arguments: { space_id: "space-1", file_id: "file-1" },
      });
      expect(downloaded.isError).toBeFalsy();
      const blocks = downloaded.content as { type: string; resource?: Record<string, string> }[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe("resource");
      const resource = blocks[0]?.resource ?? {};
      expect(resource["uri"]).toBe("anytype-file://space-1/file-1");
      expect(resource["mimeType"]).toBe("application/pdf");
      expect(sha256(Buffer.from(resource["blob"] ?? "", "base64"))).toBe(sha256(file));

      // The child still answers, and it is the same child: nothing closed its session.
      const listed = await mcp.callTool({ name: "API-list-spaces", arguments: { limit: 1 } });
      expect(listed.content).toEqual([{ type: "text", text: "API-list-spaces" }]);
      expect((await anytypeStatus(window)).childPid).toBe(childBefore);
    } finally {
      await mcp.close();
    }
    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
