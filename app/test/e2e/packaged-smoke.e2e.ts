// The packaged smoke (plan 0018 §8.3 WI-0018-23): P8/P11g proved the spike's unsigned, arm64,
// one-shared-Python-and-npm package; this proves the real per-arch, bundled-runtimes,
// no-npm one, against an actual electron-builder output — not the dev bundle every other e2e
// spec drives.
//
// Needs a build already on disk (`npm run package:mac` from app/), so it never runs as part of
// the ordinary gate: every test here is skipped unless INNYTYPES_PACKAGED_APP names the .app
// (macOS) built for this machine's arch. A machine proof (WI-0018-28) sets it; nobody else's
// gate run is affected by its absence.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { exitOf, launchTracked, processesNaming, shellOf } from "./app-harness";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAKE_MCP = path.join(APP_ROOT, "test", "fixtures", "fake-mcp");

/** The .app electron-builder produced (macOS only; the other platforms have no bundle path
 * this uniform, and are proven by WI-0018-29's own machine instead). */
const PACKAGED_APP = process.env["INNYTYPES_PACKAGED_APP"];

test.skip(
  PACKAGED_APP === undefined || PACKAGED_APP === "",
  "INNYTYPES_PACKAGED_APP names no packaged .app; this spec proves an actual build, not the " +
    "dev bundle, so it is skipped rather than faked (run `npm run package:mac` first)",
);

/** The bundled runtimes electron-builder's extraResources copied beside app.asar. */
function resourcesDir(appPath: string): string {
  return path.join(appPath, "Contents", "Resources");
}

/** The real Mach-O Playwright must launch: `.app` is a directory, not an executable. */
function executablePathOf(appPath: string): string {
  const macOS = path.join(appPath, "Contents", "MacOS");
  const [name] = fs.readdirSync(macOS);
  if (name === undefined) {
    throw new Error(`no executable found under ${macOS}`);
  }
  return path.join(macOS, name);
}

function scratch(): { home: string; userData: string; env: Record<string, string> } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-pkg-e2e-")));
  const userData = path.join(home, "user-data");
  // Every other e2e spec's scratchDirectories() (app-harness.ts) spreads process.env too: a
  // packaged app launched with only these five variables (no PATH, no display/session vars)
  // is missing enough of its own environment that Electron never gets to a usable window.
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return {
    home,
    userData,
    env: {
      ...Object.fromEntries(inherited),
      HOME: home,
      INNYTYPES_USER_DATA: userData,
      INNYTYPES_HIDDEN_WINDOWS: "1",
      INNYTYPES_MOCK_KEYCHAIN: "1",
      ANYTYPE_API_BASE_URL: "http://127.0.0.1:9",
    },
  };
}

test("the fuses are set: RunAsNode and NodeCliInspect off, OnlyLoadAppFromAsar and asar integrity on", async () => {
  const { getCurrentFuseWire, FuseV1Options } = await import("@electron/fuses");
  const wire = await getCurrentFuseWire(PACKAGED_APP as string);
  const ENABLED = "1".charCodeAt(0);
  const DISABLED = "0".charCodeAt(0);
  const bit = (option: number) => (wire as unknown as Record<number, number>)[option];
  expect(bit(FuseV1Options.RunAsNode)).toBe(DISABLED);
  expect(bit(FuseV1Options.EnableNodeCliInspectArguments)).toBe(DISABLED);
  expect(bit(FuseV1Options.OnlyLoadAppFromAsar)).toBe(ENABLED);
  expect(bit(FuseV1Options.EnableEmbeddedAsarIntegrityValidation)).toBe(ENABLED);
});

test("node:sqlite loads inside the packaged runtime utilityProcess", async () => {
  const appPath = PACKAGED_APP as string;
  const { home, userData, env } = scratch();
  try {
    const app = await launchTracked({ executablePath: executablePathOf(appPath), env });
    const window = await app.firstWindow();
    await expect(window.getByTestId("shell-ready")).toBeVisible({ timeout: 20_000 });
    const output: string[] = [];
    // The runtime and services processes are utilityProcesses of this main process (no
    // separate handle Playwright exposes for them), so their stdout/stderr is read the way
    // the shell's own one-log writer sees it: this main process's own stdout/stderr, which the
    // shell relays every child's lines onto.
    const shell = shellOf(app);
    shell.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    shell.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    await expect
      .poll(() => output.join(""), { timeout: 20_000 })
      .toContain("journal: node:sqlite (SQLite");

    const exited = exitOf(app);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    await exited;
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the Anytype MCP child runs on the bundled Node, not Electron acting as node", async () => {
  const appPath = PACKAGED_APP as string;
  const { home, userData, env } = scratch();
  const bundledNode = path.join(resourcesDir(appPath), "runtimes", "node", "bin", "node");
  expect(fs.existsSync(bundledNode), `no bundled node at ${bundledNode}`).toBe(true);
  try {
    const app = await launchTracked({
      executablePath: executablePathOf(appPath),
      env: {
        ...env,
        INNYTYPES_TEST_ANYTYPE: JSON.stringify({
          entry: path.join(FAKE_MCP, "server.mjs"),
          args: ["--mode=normal"],
        }),
      },
    });
    const window = await app.firstWindow();
    await expect(window.getByTestId("shell-ready")).toBeVisible({ timeout: 20_000 });
    const output: string[] = [];
    const shell = shellOf(app);
    shell.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    shell.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    // The fake child prints this line itself, as soon as it starts: proof it was actually run,
    // not merely that a command line was constructed.
    await expect.poll(() => output.join(""), { timeout: 20_000 }).toContain("fake MCP child");
    const log = output.join("");
    const started = log
      .split("\n")
      .filter((line) => line.includes("starting the Anytype MCP child"));
    expect(started.length).toBeGreaterThan(0);
    for (const line of started) {
      expect(line).toContain(bundledNode);
      expect(line).not.toContain("Electron");
    }

    const exited = exitOf(app);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
    await exited;
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
