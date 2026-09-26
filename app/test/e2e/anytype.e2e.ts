// The Anytype core service through the real app (WI-0018-18, plan 0018 §4.1): pairing over
// AppApi, the key given to the runtime's redactor over the direct channel and kept on disk only
// in its owner-only file, the MCP child's stderr redacted in the one log, the heartbeat's
// staleness restart, the pinned package run on Electron's node, and a runtime restarted for a
// type change leaving the services process and the MCP child alone.
//
// Never the owner's Anytype or key: a fake Anytype on a free loopback port, a scratch HOME, and
// a fake MCP child (test/fixtures/fake-mcp) wherever the real package is not the subject.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import {
  anytypeKeyFile,
  APP,
  isAlive,
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const KEY = "e2e-anytype-key-0123456789abcdef";
const FAKE = path.join(APP, "test", "fixtures", "fake-mcp");

interface Status {
  readonly state: string;
  readonly detail: string | null;
  readonly childPid: number | null;
  readonly beats: number;
  readonly pairing: boolean;
}

type AnytypeApi = {
  anytypeStatus(): Promise<Status>;
  startAnytypePairing(): Promise<Status>;
  completeAnytypePairing(code: string): Promise<Status>;
};

function anytypeStatus(window: Page): Promise<Status> {
  return window.evaluate(() =>
    (window as unknown as { inny: { app: AnytypeApi } }).inny.app.anytypeStatus(),
  );
}

/** A fake Anytype: the spaces probe, pairing, and the spec the real package fetches. */
async function fakeAnytype(): Promise<{ url: string; close: () => Promise<void> }> {
  const require = createRequire(import.meta.url);
  const spec = fs.readFileSync(
    path.join(
      path.dirname(require.resolve("@anyproto/anytype-mcp/package.json")),
      "scripts",
      "openapi.json",
    ),
  );
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/docs/openapi.json") {
        response.end(spec);
      } else if (request.url === "/v1/auth/challenges") {
        response.end('{"challenge_id":"e2e-challenge"}');
      } else if (request.url === "/v1/auth/api_keys") {
        const sent = JSON.parse(body) as { code?: string };
        response.statusCode = sent.code === "1234" ? 201 : 400;
        response.end(sent.code === "1234" ? JSON.stringify({ api_key: KEY }) : "{}");
      } else {
        response.end('{"data":[]}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

/** The fake child's surface, recorded the way the committed one is, for it to be held to. */
function fakeSurface(scratch: string): string {
  const file = path.join(scratch, "fake-surface.json");
  const tools = JSON.parse(fs.readFileSync(path.join(FAKE, "tools.json"), "utf8")) as {
    name: string;
    inputSchema: unknown;
  }[];
  // Signed by the app's own rule, in the test process: the same canonical JSON and sha256.
  const require = createRequire(import.meta.url);
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : typeof value === "object" && value !== null
        ? `{${Object.keys(value)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
            .join(",")}}`
        : JSON.stringify(value);
  const signed = Object.fromEntries(
    tools.map((t) => [
      t.name,
      `sha256:${createHash("sha256").update(canonical(t.inputSchema)).digest("hex")}`,
    ]),
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
      package_version: PACKAGE_VERSION,
      anytype_version: ANYTYPE_VERSION,
      source: "bundled-spec",
      captured_at: "e2e",
      tools: signed,
    }),
  );
  return file;
}

/** The canonical key file under a scratch HOME, written the way pairing writes it. */
const keyFile = anytypeKeyFile;

function writeKey(scratch: string): void {
  fs.mkdirSync(path.dirname(keyFile(scratch)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile(scratch), KEY, { mode: 0o600 });
}

/** Every regular file below `root` whose bytes hold `needle`. */
function filesHolding(root: string, needle: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((relative) => path.join(root, relative))
    .filter((file) => fs.lstatSync(file).isFile())
    .filter((file) => fs.readFileSync(file).includes(needle));
}

test("pairing stores the key owner-only, the runtime's redactor gets it directly, and a type-change restart leaves the services process and the MCP child alone", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  const logFile = path.join(scratch, "anytype.log");
  try {
    // No key at all to start with: the scratch home's canary goes, and the paired key is the
    // one other key this run may read.
    fs.rmSync(keyFile(scratch));
    const { app, window } = await launchApp(
      {
        ...env,
        INNYTYPES_LOG_FILE: logFile,
        INNYTYPES_E2E_HOOKS: "1",
        ANYTYPE_API_BASE_URL: anytype.url,
        INNYTYPES_TEST_ANYTYPE: JSON.stringify({
          entry: path.join(FAKE, "server.mjs"),
          args: ["--mode=canary"],
          surface: fakeSurface(scratch),
          heartbeatMs: 500,
        }),
      },
      { allowedKeys: [KEY] },
    );
    const runtime = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");
    await expect.poll(async () => (await anytypeStatus(window)).state).toBe("no-key");

    // Pairing, as the Settings page will drive it: the key never reaches the page.
    const started = await window.evaluate(() =>
      (window as unknown as { inny: { app: AnytypeApi } }).inny.app.startAnytypePairing(),
    );
    expect(started.pairing).toBe(true);
    const refused = await window
      .evaluate(() =>
        (window as unknown as { inny: { app: AnytypeApi } }).inny.app.completeAnytypePairing("12"),
      )
      .catch((error: unknown) => String(error));
    expect(refused).toContain("Enter the four-digit code shown by Anytype.");
    const paired = await window.evaluate(() =>
      (window as unknown as { inny: { app: AnytypeApi } }).inny.app.completeAnytypePairing("1234"),
    );
    expect(JSON.stringify(paired)).not.toContain(KEY);
    expect(fs.readFileSync(keyFile(scratch), "utf8")).toBe(KEY);
    expect(fs.statSync(keyFile(scratch)).mode & 0o777).toBe(0o600);

    await expect
      .poll(async () => (await anytypeStatus(window)).state, { timeout: 15_000 })
      .toBe("ready");
    await expect.poll(async () => (await anytypeStatus(window)).beats).toBeGreaterThanOrEqual(2);
    const before = await anytypeStatus(window);
    expect(before.childPid).not.toBeNull();

    // A runtime restart for a type change, the way the shell's supervisor plans one.
    expect(
      await app.evaluate(() =>
        (
          globalThis as unknown as {
            innytypesE2E: { restart(child: string, reason: string): boolean };
          }
        ).innytypesE2E.restart("runtime", "types"),
      ),
    ).toBe(true);
    const after = await waitForRunning(window, "runtime", runtime.generation + 1);
    expect(after.pid).not.toBe(runtime.pid);
    expect(await waitForRunning(window, "services")).toEqual(services);
    const later = await anytypeStatus(window);
    expect(later.childPid).toBe(before.childPid);
    expect(isAlive(before.childPid ?? 0)).toBe(true);
    await expect.poll(async () => (await anytypeStatus(window)).beats).toBeGreaterThan(later.beats);

    // Both runtime generations had the key registered, over the direct channel.
    await expect
      .poll(() => fs.readFileSync(logFile, "utf8").split("the Anytype key arrived").length - 1)
      .toBeGreaterThanOrEqual(2);

    // The child printed the key on stderr: in the log at WARNING, with its pid, redacted.
    const log = fs.readFileSync(logFile, "utf8");
    const printed = log.split("\n").filter((line) => line.includes("fake MCP child starting with"));
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) {
      expect(line).toContain("WARNING");
      expect(line).toContain("innytypes.anytype-mcp");
      expect(line).toContain(String(before.childPid));
      expect(line).toContain("Bearer [redacted]");
    }

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    expect(isAlive(before.childPid ?? 0)).toBe(false);
    // Kept in the canonical file and nowhere else: not in the log, not in userData.
    expect(filesHolding(scratch, KEY)).toEqual([keyFile(scratch)]);
  } finally {
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("an MCP child that stops answering pings but stays alive is restarted, with a notice naming it", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  writeKey(scratch);
  try {
    const { app, window, output } = await launchApp({
      ...env,
      ANYTYPE_API_BASE_URL: anytype.url,
      INNYTYPES_TEST_ANYTYPE: JSON.stringify({
        entry: path.join(FAKE, "server.mjs"),
        args: ["--mode=deaf"],
        surface: fakeSurface(scratch),
        heartbeatMs: 300,
      }),
    });
    await waitForRunning(window, "services");
    await expect
      .poll(async () => (await anytypeStatus(window)).state, { timeout: 15_000 })
      .toBe("ready");
    const deaf = await anytypeStatus(window);
    expect(deaf.beats).toBe(0);

    await expect
      .poll(() => output.join(""), { timeout: 20_000 })
      .toContain(
        // Raised in the services process, told by the shell's notice board (WI-0018-21).
        `notice: InnyTypes restarted the Anytype MCP child: It (pid ${String(deaf.childPid)})`,
      );
    await expect
      .poll(async () => (await anytypeStatus(window)).childPid, { timeout: 15_000 })
      .not.toBe(deaf.childPid);
    await expect.poll(() => isAlive(deaf.childPid ?? 0)).toBe(false);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the pinned package runs on Electron's node with no npx, and a surface that does not match is a named degradation", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const anytype = await fakeAnytype();
  writeKey(scratch);
  try {
    const { app, window, output } = await launchApp({ ...env, ANYTYPE_API_BASE_URL: anytype.url });
    await waitForRunning(window, "services");
    await expect
      .poll(async () => (await anytypeStatus(window)).state, { timeout: 30_000 })
      .toBe("tool-surface-mismatch");
    const status = await anytypeStatus(window);
    expect(status.detail).toMatch(/differ from the committed surface: added=\[/);
    expect(status.childPid).toBeNull();
    const log = output.join("");
    expect(log).toMatch(
      /starting the Anytype MCP child \(.*Electron.* \S*@anyproto[\\/]anytype-mcp[\\/]bin[\\/]cli\.mjs\)/,
    );
    expect(log).not.toContain("npx");
    expect(log).not.toContain(KEY);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await anytype.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
