// Starting the real app for an e2e spec, and looking at its processes the way the spike's
// P11d and P11e runs did: by pid, and with pgrep scoped to this run's temporary userData.
import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type FrameLocator,
  type Page,
} from "@playwright/test";

// ── the shell's process, taken at launch ────────────────────────────────────────────────
// Playwright hands out an app's process only while its driver holds the app: once the app has
// quit, `app.process()` can throw ("reading '_object'"), depending on how far the driver's own
// teardown got. So each app's Electron process is taken once, as it launches, and every later
// question (its pid, whether it still runs, its exit) is asked of that. No spec calls
// `.process()` itself; test/unit/e2e-process-guard.test.ts holds them to it.

const shells = new WeakMap<ElectronApplication, ChildProcess>();

/** Launch Electron and keep its main process. Every e2e launch goes through here. */
export async function launchTracked(
  options: Parameters<typeof electron.launch>[0],
): Promise<ElectronApplication> {
  const app = await electron.launch(options);
  shells.set(app, app.process());
  return app;
}

/** The app's Electron main process, as taken at launch. */
export function shellOf(app: ElectronApplication): ChildProcess {
  const shell = shells.get(app);
  if (shell === undefined) {
    throw new Error("this app was not launched through launchTracked or launchApp");
  }
  return shell;
}

const isRunning = (shell: ChildProcess): boolean =>
  shell.exitCode === null && shell.signalCode === null;

/** The shell's exit, or at once when it has already exited. */
export function exitOf(app: ElectronApplication): Promise<number | null> {
  const shell = shellOf(app);
  if (!isRunning(shell)) {
    return Promise.resolve(shell.exitCode);
  }
  return new Promise((resolve) => {
    shell.once("exit", (code) => {
      resolve(code);
    });
  });
}

/** How long a SIGTERM quit may take before the shell is killed. */
const TERM_GRACE_MS = 15_000;

/**
 * Stop every app still running: SIGTERM first, which runs the one quit without asking the quit
 * question a dirty editor would (so a failed test leaves nothing waiting for an answer), then
 * SIGKILL for one that has not exited within the grace. Each wait ends on the process's own
 * exit event.
 */
export async function stopApps(apps: readonly ElectronApplication[]): Promise<void> {
  for (const app of apps) {
    const shell = shellOf(app);
    if (!isRunning(shell)) {
      continue;
    }
    const exited = exitOf(app);
    shell.kill("SIGTERM");
    let grace: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => {
      grace = setTimeout(() => {
        resolve("late");
      }, TERM_GRACE_MS);
    });
    const outcome = await Promise.race([exited, late]);
    clearTimeout(grace);
    if (outcome === "late" && isRunning(shell)) {
      shell.kill("SIGKILL");
      await exited;
    }
  }
}

/** A spec's `finally`: stop what still runs, then remove the scratch folder. */
export async function cleanUp(
  apps: readonly ElectronApplication[],
  scratch: string,
  beforeRemoving?: () => void,
): Promise<void> {
  await stopApps(apps);
  beforeRemoving?.();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The install record (`appUpdate` in shell-settings.json) the first start on this dev build writes
 * (plan 0022 §G): this version, nothing checked, nothing to go back to.
 */
export const FIRST_START_RECORD = {
  appUpdate: {
    lastVersion: (
      JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")) as {
        version: string;
      }
    ).version,
    lastCheckedAt: null,
    previous: null,
    goingBackTo: null,
  },
};

/** The Electron binary the workspace pins (the `electron` package's main is its path). */
export const ELECTRON_BINARY = createRequire(import.meta.url)("electron") as string;

/** Every process whose command line names `marker`, as pgrep lists them. */
export function processesNaming(marker: string): string[] {
  try {
    return execFileSync("pgrep", ["-fl", marker], { encoding: "utf8" }).trim().split("\n");
  } catch (error) {
    // pgrep exits 1 when nothing matches; anything else is a failure to look, not an answer.
    if ((error as { status?: number }).status === 1) {
      return [];
    }
    throw error;
  }
}

/** Whether a pid is a live process (signal 0 checks without sending anything). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

/**
 * A loopback port that was free a moment ago, found synchronously (a short node run), so
 * scratchDirectories can hand every run an MCP endpoint of its own: no run may bind the default
 * 31010, which a person's own InnyTypes may be serving (WI-0018-19).
 */
export function freePortNow(): number {
  const script =
    "const s=require('net').createServer();" +
    "s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();})";
  return Number(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
}

/** Where the services process keeps the Anytype key under a (scratch) home. */
export function anytypeKeyFile(home: string): string {
  return path.join(home, ".config", "innytypes", "anytype_api_key");
}

/**
 * A temp home and userData unique to one run; Electron names userData in every helper.
 *
 * The scratch home holds a canary Anytype key, unique to the run, where the real key would be:
 * a process that reads any other key is caught by launchApp and quit (WI-0018-18's incident).
 * Anytype's API is pointed at a port nothing listens on, so no run ever talks to the owner's
 * Anytype; a spec that wants one starts its own fake and overrides ANYTYPE_API_BASE_URL.
 */
export function scratchDirectories(): {
  scratch: string;
  userData: string;
  env: Record<string, string>;
  canaryKey: string;
} {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-e2e-")));
  const userData = path.join(scratch, "user-data");
  const canaryKey = `e2e-canary-key-${randomUUID()}`;
  fs.mkdirSync(path.dirname(anytypeKeyFile(scratch)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(anytypeKeyFile(scratch), canaryKey, { mode: 0o600 });
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return {
    scratch,
    userData,
    env: {
      ...Object.fromEntries(inherited),
      HOME: scratch,
      // The one log's default path follows these where they are set (Linux, Windows): a run
      // must never write into the log of this user's own installation.
      XDG_STATE_HOME: path.join(scratch, ".local", "state"),
      LOCALAPPDATA: path.join(scratch, "AppData", "Local"),
      INNYTYPES_USER_DATA: userData,
      INNYTYPES_HIDDEN_WINDOWS: "1",
      // safeStorage against Chromium's in-memory mock keychain: no run writes to this
      // user's real one (WI-0018-06).
      INNYTYPES_MOCK_KEYCHAIN: "1",
      // Port 9 (discard): nothing answers, so the services process never reaches an Anytype.
      ANYTYPE_API_BASE_URL: "http://127.0.0.1:9",
      // The MCP endpoint's default for this run: a free port, never the default 31010.
      INNYTYPES_MCP_PORT: String(freePortNow()),
    },
    canaryKey,
  };
}

export interface RunningApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  /** Everything the shell and its children printed, for assertions on the log lines. */
  readonly output: string[];
}

/** What launchApp and quit hold each run to: its home, and the keys it may read. */
interface Hermetic {
  readonly home: string;
  readonly output: string[];
  /** sha256 prefixes (as the services process logs them) of the keys this run may read. */
  readonly allowed: ReadonlySet<string>;
}
const hermetic = new WeakMap<ElectronApplication, Hermetic>();

const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);

/**
 * Every process ran in the scratch home, read the key only from under it, and read no key but
 * one this run put there. Any other key read is a real one reached through a leak.
 */
export function assertHermetic(app: ElectronApplication): void {
  const run = hermetic.get(app);
  if (run === undefined) {
    return;
  }
  const log = run.output.join("");
  for (const [, who, home] of log.matchAll(/(innytypes\.\w+): this process's HOME is (.*)/g)) {
    expect(`${String(who)} HOME ${String(home).trim()}`).toBe(`${String(who)} HOME ${run.home}`);
  }
  for (const [, file] of log.matchAll(/the Anytype key is read from (\S+)/g)) {
    expect(
      String(file).startsWith(run.home + path.sep),
      `the Anytype key was looked for at ${String(file)}, outside the scratch home`,
    ).toBe(true);
  }
  for (const [, read] of log.matchAll(/the Anytype key was read \(sha256 ([0-9a-f]+)\)/g)) {
    expect(
      run.allowed,
      `a key this run did not provide was read (sha256 ${String(read)})`,
    ).toContain(read);
  }
}

export async function launchApp(
  env: Record<string, string>,
  options: { readonly allowedKeys?: readonly string[] } = {},
): Promise<RunningApp> {
  const home = env["HOME"];
  if (home === undefined) {
    throw new Error("launchApp needs a scratch HOME (scratchDirectories)");
  }
  // The key under the scratch home is the one a run may read, plus any the spec says it adds.
  const keyFile = anytypeKeyFile(home);
  const present = fs.existsSync(keyFile) ? [fs.readFileSync(keyFile, "utf8").trim()] : [];
  const allowed = new Set([...present, ...(options.allowedKeys ?? [])].map(fingerprint));
  const app = await launchTracked({ args: [APP], env });
  const output: string[] = [];
  shellOf(app).stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  shellOf(app).stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  hermetic.set(app, { home, output, allowed });
  const window = await app.firstWindow();
  // Every process says its HOME as it starts, at INFO: all three must be in the scratch home.
  // A run that logs above INFO cannot show the children's lines; the shell is still asked.
  const quiet = /^(warning|error|critical)$/i.test(env["INNYTYPES_LOG_LEVEL"] ?? "");
  if (!quiet) {
    await expect
      .poll(
        () =>
          [...output.join("").matchAll(/(innytypes\.\w+): this process's HOME is (.*)/g)]
            .map(([, who]) => who)
            .filter((who) => who !== undefined)
            .sort(),
        { timeout: 15_000 },
      )
      .toEqual(expect.arrayContaining(["innytypes.runtime", "innytypes.services"]));
  }
  // The shell's own line is written before this driver is listening, so it is asked directly;
  // the shell hands its children os.homedir(), which is this.
  expect(await app.evaluate(() => process.env["HOME"])).toBe(home);
  assertHermetic(app);
  return { app, window, output };
}

/**
 * One child's status, as the shell hands it to the app window (AppApi `childStatus`, the status
 * the frame's pill, banner and General › Advanced are drawn from). Asked of the page's own bridge,
 * so it needs no route: Setup, Live and Configuration alike.
 */
export async function childOnPage(window: Page, child: "runtime" | "services") {
  const statuses = await window.evaluate(() =>
    (
      globalThis as unknown as {
        inny: {
          app: {
            childStatus(): Promise<
              readonly {
                child: string;
                state: string;
                generation: number;
                pid: number | null;
                port: number | null;
              }[]
            >;
          };
        };
      }
    ).inny.app.childStatus(),
  );
  const status = statuses.find((each) => each.child === child);
  return {
    state: status?.state ?? "",
    generation: status?.generation ?? 0,
    pid: status?.pid ?? 0,
    port: status?.port === null || status?.port === undefined ? "" : String(status.port),
  };
}

/** Wait until `child` runs at `generation` (or any, when omitted), as the shell tells the page. */
export async function waitForRunning(
  window: Page,
  child: "runtime" | "services",
  generation?: number,
): Promise<{ generation: number; pid: number; port: string }> {
  let running = { generation: 0, pid: 0, port: "" };
  await expect
    .poll(
      async () => {
        const status = await childOnPage(window, child);
        running = status;
        return (
          status.state === "running" &&
          (generation === undefined || status.generation === generation)
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return { generation: running.generation, pid: running.pid, port: running.port };
}

/**
 * Setup closed for good through AppApi (as Ready's closing choice does), and the frame settled on
 * a screen past it: Live, as a completed Setup opens, or wherever it already was. An address set
 * before that would be replaced by it.
 */
async function closeSetup(window: Page): Promise<void> {
  const answer = await window.evaluate(() =>
    (
      globalThis as unknown as { inny: { app: { completeSetup(): Promise<{ ok: boolean }> } } }
    ).inny.app.completeSetup(),
  );
  expect(answer.ok).toBe(true);
  await expect(window.getByTestId("frame")).not.toHaveAttribute("data-route", /^(loading|setup)$/, {
    timeout: 15_000,
  });
}

/** Send the frame to `hash`. */
async function go(window: Page, hash: string): Promise<void> {
  await window.evaluate((to) => {
    globalThis.location.hash = to;
  }, hash);
}

/** Configuration › General in the app frame, Setup closed for good first. Answers its root. */
export async function openGeneral(window: Page) {
  await closeSetup(window);
  await go(window, "#/configuration/general");
  const general = window.getByTestId("general");
  await expect(general).toBeVisible({ timeout: 15_000 });
  return general;
}

/** A flow's board in Live, Setup closed for good first. Answers the board. */
export async function openLive(window: Page, flowId: string) {
  await closeSetup(window);
  await go(window, `#/live/${encodeURIComponent(flowId)}`);
  const board = window.getByTestId("live-board");
  await expect(board).toBeVisible({ timeout: 15_000 });
  return board;
}

/**
 * A flow's canvas in the app frame (Configuration › Flows › Edit), Setup closed for good first:
 * Node-RED's editor in the canvas frame, once its palette is drawn. Answers the editor's frame.
 */
export async function openCanvas(window: Page, flowId: string): Promise<FrameLocator> {
  await closeSetup(window);
  await go(window, `#/configuration/flows/${encodeURIComponent(flowId)}/canvas`);
  await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "canvas", {
    timeout: 15_000,
  });
  const editor = window.getByTestId("canvas-editor").contentFrame();
  await expect(editor.locator('.red-ui-palette-node[data-palette-type="inject"]')).toHaveCount(1, {
    timeout: 20_000,
  });
  return editor;
}

/** Quit the way the app quits, and wait for the main process to be gone. */
export async function quit(app: ElectronApplication): Promise<void> {
  assertHermetic(app);
  const exited = exitOf(app);
  await app.evaluate(({ app: shell }) => {
    shell.quit();
  });
  await exited;
  assertHermetic(app);
}
