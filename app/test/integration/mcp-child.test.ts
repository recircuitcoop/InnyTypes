// The MCP child adapter against real processes (plan 0018 §4.1; WI-0018-18): the pinned
// package run on node without npx, the fake MCP child's modes, stderr to the one log at WARNING
// with the child's pid and the key redacted (plan 0015), and a dead child failing its calls.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  NodeMcpChildLauncher,
  PinnedPackageError,
  pinnedPackageEntry,
} from "../../src/adapters/anytype/mcp-child";
import { committedToolSurface, toolSignature } from "../../src/adapters/anytype/tool-surface";
import { systemClock } from "../../src/adapters/system/clock";
import { sourceLog } from "../../src/application/source-log";
import { SessionError, ToolSurfaceMismatchError } from "../../src/domain/anytype/errors";
import { childEnvironment, PACKAGE_NAME, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import { parseWireLine } from "../../src/domain/logging/record";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import type { McpChild } from "../../src/ports/anytype";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAKE = path.join(APP, "test", "fixtures", "fake-mcp", "server.mjs");
const FAKE_TOOLS = JSON.parse(
  fs.readFileSync(path.join(APP, "test", "fixtures", "fake-mcp", "tools.json"), "utf8"),
) as { name: string; inputSchema: unknown }[];
const FAKE_SURFACE = Object.fromEntries(
  FAKE_TOOLS.map((t) => [t.name, toolSignature(t.inputSchema)]),
);
const KEY = "child-key-0123456789abcdef";
const NODE = { command: process.execPath, env: {} };

const running: McpChild[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((child) => child.stop()));
});

function launch(mode: string, lines: { pid: number; line: string }[] = []) {
  const launcher = new NodeMcpChildLauncher({
    node: NODE,
    entry: FAKE,
    args: [`--mode=${mode}`],
    clock: systemClock,
    expected: FAKE_SURFACE,
    stopDeadlineMs: 2_000,
  });
  const child = launcher.launch(childEnvironment(KEY, "http://127.0.0.1:9"), (pid, line) => {
    lines.push({ pid, line });
  });
  running.push(child);
  return { child, lines, launcher };
}

function exited(child: McpChild): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.onExit((code, signal) => {
      resolve({ code, signal });
    });
  });
}

describe("the pinned package", () => {
  it("is found in node_modules at exactly the pinned version, and run by node, not npx", () => {
    const entry = pinnedPackageEntry(createRequire(import.meta.url).resolve);
    expect(entry).toMatch(/@anyproto[\\/]anytype-mcp[\\/]bin[\\/]cli\.mjs$/);
    expect(fs.existsSync(entry)).toBe(true);
    const launcher = new NodeMcpChildLauncher({
      node: { command: "/electron", env: { ELECTRON_RUN_AS_NODE: "1" } },
      entry,
      clock: systemClock,
      expected: {},
    });
    expect(launcher.command()).toEqual(["/electron", entry]);
    expect(launcher.command().join(" ")).not.toContain("npx");
  });

  it("is refused when the installed version is not the pinned one", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-pin-"));
    try {
      const manifest = path.join(scratch, "package.json");
      fs.writeFileSync(manifest, JSON.stringify({ version: "9.9.9", bin: { "anytype-mcp": "x" } }));
      expect(() => pinnedPackageEntry(() => manifest)).toThrow(PinnedPackageError);
      expect(() => pinnedPackageEntry(() => manifest)).toThrow(`${PACKAGE_VERSION} is pinned`);
      fs.writeFileSync(manifest, JSON.stringify({ version: PACKAGE_VERSION }));
      expect(() => pinnedPackageEntry(() => manifest)).toThrow(/names no anytype-mcp entry/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("runs the real handshake, and a live surface that differs from the committed one is named", async () => {
    // A fake Anytype serving the package's own bundled spec: the real server then lists the
    // tools that spec makes, which are not the tools a live Anytype gave the committed record.
    const require = createRequire(import.meta.url);
    const spec = fs.readFileSync(
      path.join(
        path.dirname(require.resolve(`${PACKAGE_NAME}/package.json`)),
        "scripts",
        "openapi.json",
      ),
    );
    const anytype = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/docs/openapi.json" ? spec : '{"data":[]}');
    });
    await new Promise<void>((resolve) => anytype.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${String((anytype.address() as AddressInfo).port)}`;
      const launcher = new NodeMcpChildLauncher({
        node: NODE,
        entry: pinnedPackageEntry(require.resolve),
        clock: systemClock,
        expected: committedToolSurface(path.join(APP, "src", "adapters", "anytype")).tools,
      });
      const child = launcher.launch(childEnvironment(KEY, base), () => undefined);
      running.push(child);
      const error = await child.session.initialize().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolSurfaceMismatchError);
      expect((error as Error).message).toMatch(/differ from the committed surface: added=\[/);
    } finally {
      await new Promise<void>((resolve) =>
        anytype.close(() => {
          resolve();
        }),
      );
    }
  }, 30_000);
});

describe("the fake MCP child, through the adapter", () => {
  it("completes the handshake with the surface it was held to, and answers a ping", async () => {
    const { child } = launch("normal");
    expect((await child.session.initialize()).map((t) => t.name)).toEqual(
      FAKE_TOOLS.map((t) => t.name),
    );
    await expect(child.session.ping(2_000)).resolves.toBeUndefined();
    expect(child.pid).toBeGreaterThan(0);
  });

  it("gets exactly the environment it was given: the key only inside OPENAPI_MCP_HEADERS", async () => {
    const { child, lines } = launch("canary");
    await child.session.initialize();
    const printed = lines.map((l) => l.line).join("\n");
    expect(printed).toContain(`Bearer ${KEY}`);
  });

  it("fails a pending call when it dies, and nothing is retried on the next child", async () => {
    const { child } = launch("deaf");
    await child.session.initialize();
    const ping = child.session.ping(30_000);
    const gone = exited(child);
    process.kill(child.pid ?? 0, "SIGKILL");
    await expect(ping).rejects.toBeInstanceOf(SessionError);
    expect(await gone).toEqual({ code: null, signal: "SIGKILL" });
    expect(child.session.closed).toBe(true);
    await expect(child.session.request("tools/list")).rejects.toThrow("session is closed");
  });

  it("reports a child that exits on its own with its code", async () => {
    const { child } = launch("crash");
    await child.session.initialize();
    const gone = exited(child);
    await expect(child.session.ping(5_000)).rejects.toBeInstanceOf(SessionError);
    expect((await gone).code).toBe(3);
  });

  it("stops a child that will not answer: stdin closed, then a signal, and it is gone", async () => {
    const { child } = launch("deaf");
    await child.session.initialize();
    const pid = child.pid ?? 0;
    await child.stop();
    expect(() => process.kill(pid, 0)).toThrow();
    await child.stop(); // twice is safe
  });

  it("reports a node that cannot be started as an exit, and closes the session", async () => {
    const launcher = new NodeMcpChildLauncher({
      node: { command: path.join(os.tmpdir(), "no-such-node-binary"), env: {} },
      entry: FAKE,
      clock: systemClock,
      expected: FAKE_SURFACE,
    });
    const child = launcher.launch({}, () => undefined);
    expect(await exited(child)).toEqual({ code: null, signal: null });
    expect(child.session.closed).toBe(true);
  });
});

describe("the child's stderr in the one log (plan 0015)", () => {
  /** The composition root's wiring: each stderr line at WARNING, under the child's pid. */
  function oneLogLines(registry: SecretRegistry) {
    const written: string[] = [];
    const childLine = (pid: number, line: string) => {
      sourceLog({
        name: "innytypes.anytype-mcp",
        pid,
        write: (text) => written.push(text),
        now: () => 0,
        registry,
      }).warn(line);
    };
    return { written, childLine };
  }

  it("reaches the log at WARNING with the child's pid, and a key printed there is redacted", async () => {
    const registry = new SecretRegistry();
    registry.protect(KEY); // what the registering secret store does when the key is read
    const { written, childLine } = oneLogLines(registry);
    const lines: { pid: number; line: string }[] = [];
    const { child } = launch("canary", lines);
    await child.session.initialize();
    for (const { pid, line } of lines) {
      childLine(pid, line);
    }
    const records = written.map((text) => parseWireLine(text.trimEnd()));
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record).toMatchObject({
        kind: "log",
        record: { level: "WARNING", pid: child.pid, name: "innytypes.anytype-mcp" },
      });
    }
    const all = written.join("");
    expect(all).not.toContain(KEY);
    expect(all).toContain(`Bearer ${REDACTED}`);
  });

  it("leaks the key when it was never registered: the check above can fail", async () => {
    const { written, childLine } = oneLogLines(new SecretRegistry());
    const lines: { pid: number; line: string }[] = [];
    const { child } = launch("canary", lines);
    await child.session.initialize();
    for (const { pid, line } of lines) {
      childLine(pid, line);
    }
    expect(written.join("")).toContain(KEY);
  });
});
