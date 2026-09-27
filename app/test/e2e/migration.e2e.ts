// Migrating a fixture old installation (WI-0018-25, plan 0018 §10 risk 4): an existing Codex
// configuration (the mcp_proxy_token file, the endpoint's imported port) keeps working after
// the cutover, the import never runs twice, and the endpoint refuses to serve while a fixture
// helper.lock names a process that is still alive.
//
// Never the owner's own old install: everything is written under scratchDirectories()'s HOME, at
// exactly the paths adapters/fs/legacy-*.ts computes — with XDG_CONFIG_HOME, XDG_DATA_HOME and
// XDG_RUNTIME_DIR pinned into the scratch home too, so this run's paths never depend on whatever
// the machine it runs on happens to have set. The Anytype health gate and the MCP child are
// faked exactly as mcp-endpoint.e2e.ts fakes them: this spec is about the migration, not Anytype.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { legacyConfigPath, type LegacyConfigLocation } from "../../src/adapters/fs/legacy-config";
import { legacyLockPath } from "../../src/adapters/fs/legacy-helper-lock";
import { credentialsDirectory } from "../../src/adapters/fs/owner-only-files";
import { toolSignature } from "../../src/adapters/anytype/tool-surface";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import { APP, launchApp, quit, scratchDirectories, type RunningApp } from "./app-harness";

const FAKE = path.join(APP, "test", "fixtures", "fake-mcp");

interface EndpointStatus {
  readonly served: string | null;
  readonly problem: string | null;
}

// mcpEndpoint() rejects, rather than resolving with a problem field, while the whole endpoint
// is null (no token, or WI-0018-25's legacy-helper-lock refusal): shell/service-calls.ts throws
// the services process's error across the IPC boundary. Normalised here so both shapes read the
// same way: served null, problem the reason.
const endpoint = (window: Page): Promise<EndpointStatus> =>
  window.evaluate(async () => {
    try {
      return await (
        window as unknown as { inny: { app: { mcpEndpoint(): Promise<EndpointStatus> } } }
      ).inny.app.mcpEndpoint();
    } catch (error) {
      return { served: null, problem: String(error) };
    }
  });

/** Forces a restart regardless of state (the e2e hooks, INNYTYPES_E2E_HOOKS=1, exposed on the
 * shell's own globalThis, so this runs in the main process via app.evaluate): the public Restart
 * button only works from down-for-good, and the services process here never crashed. */
const restartServices = (app: ElectronApplication) =>
  app.evaluate(() =>
    (
      globalThis as unknown as { innytypesE2E: { restart(child: string, reason: string): boolean } }
    ).innytypesE2E.restart("services", "types"),
  );

/** One JSON-RPC call, the way an existing Codex configuration makes it. */
async function rpc(url: string, token: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return response.status;
}

/** A fake Anytype that answers the health gate, and nothing else (mcp-endpoint.e2e.ts's own). */
async function fakeAnytype(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
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

/** The fake child's surface, recorded the way the committed one is (mcp-endpoint.e2e.ts's own). */
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

/** A scratch home, with its own XDG locations pinned so this run's legacy paths are exact, and
 * a fake Anytype plus the fake MCP child wired in, so the real endpoint actually opens. */
async function scratchWithLegacyLocation() {
  const base = scratchDirectories();
  const anytype = await fakeAnytype();
  const env: Record<string, string> = {
    ...base.env,
    XDG_CONFIG_HOME: path.join(base.scratch, ".config"),
    XDG_DATA_HOME: path.join(base.scratch, ".local", "share"),
    XDG_RUNTIME_DIR: path.join(base.scratch, ".runtime"),
    INNYTYPES_E2E_HOOKS: "1",
    ANYTYPE_API_BASE_URL: anytype.url,
    INNYTYPES_TEST_ANYTYPE: JSON.stringify({
      entry: path.join(FAKE, "server.mjs"),
      args: ["--mode=canary"],
      surface: fakeSurface(base.scratch),
    }),
  };
  const location: LegacyConfigLocation = { platform: process.platform, home: base.scratch, env };
  return { ...base, env, location, anytype };
}

test("an existing Codex configuration (token and port) keeps working after the cutover", async () => {
  const { scratch, env, location, anytype } = await scratchWithLegacyLocation();
  const fixturePort = Number(env["INNYTYPES_MCP_PORT"]);

  // ── the fixture old install ────────────────────────────────────────────────────────────
  const configFile = legacyConfigPath(location);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(
    configFile,
    ["telemetry = false", "launch_at_login = false", "[mcp]", `port = ${String(fixturePort)}`].join(
      "\n",
    ),
  );
  const credentials = credentialsDirectory(scratch, process.platform);
  fs.mkdirSync(credentials, { recursive: true, mode: 0o700 });
  const existingToken = "existing-codex-token-0123456789abcdef";
  fs.writeFileSync(path.join(credentials, "mcp_proxy_token"), existingToken, { mode: 0o600 });

  let app: RunningApp | undefined;
  let window: Page;
  try {
    app = await launchApp(env, { allowedKeys: [] });
    window = app.window;
    const url = `http://127.0.0.1:${String(fixturePort)}/mcp`;
    await expect.poll(async () => (await endpoint(window)).served, { timeout: 20_000 }).toBe(url);
    // The existing token, unrotated, still authenticates: the same file the old Codex config
    // named it in was never touched.
    expect(await rpc(url, existingToken)).not.toBe(401);
    expect(fs.readFileSync(path.join(credentials, "mcp_proxy_token"), "utf8").trim()).toBe(
      existingToken,
    );

    // The import ran exactly once, and left its report.
    const reportFile = path.join(scratch, "user-data", "legacy-import-report.json");
    const report = JSON.parse(fs.readFileSync(reportFile, "utf8")) as { imported: string[] };
    expect(report.imported.some((line) => line.startsWith("mcp:"))).toBe(true);

    await quit(app.app);
    app = undefined;

    // A second run: the file changed underneath it, and the change is never imported again.
    fs.writeFileSync(
      configFile,
      ["telemetry = true", "[mcp]", `port = ${String(fixturePort + 1)}`].join("\n"),
    );
    app = await launchApp(env, { allowedKeys: [] });
    window = app.window;
    await expect.poll(async () => (await endpoint(window)).served, { timeout: 20_000 }).toBe(url);
  } finally {
    if (app !== undefined) {
      await quit(app.app);
    }
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the endpoint refuses to serve while a fixture helper.lock names a live process", async () => {
  const { scratch, env, location, anytype } = await scratchWithLegacyLocation();
  const lockFile = legacyLockPath(location, path.join(scratch, "unused-tmp"));
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // This test's own pid: guaranteed alive for as long as the assertion runs.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, kind: "helper" }));

  let app: RunningApp | undefined;
  try {
    app = await launchApp(env, { allowedKeys: [] });
    const window = app.window;
    await expect
      .poll(async () => (await endpoint(window)).problem, { timeout: 20_000 })
      .toContain("old InnyTypes helper is still running");
    expect((await endpoint(window)).served).toBeNull();

    // Quit the "old helper" (forget the lock) and retry: Restart re-checks it.
    fs.rmSync(lockFile, { force: true });
    await restartServices(app.app);
    await expect
      .poll(async () => (await endpoint(window)).served, { timeout: 20_000 })
      .not.toBeNull();
  } finally {
    if (app !== undefined) {
      await quit(app.app);
    }
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
