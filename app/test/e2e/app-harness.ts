// Starting the real app for an e2e spec, and looking at its processes the way the spike's
// P11d and P11e runs did: by pid, and with pgrep scoped to this run's temporary userData.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

/** A temp home and userData unique to one run; Electron names userData in every helper. */
export function scratchDirectories(): {
  scratch: string;
  userData: string;
  env: Record<string, string>;
} {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-e2e-")));
  const userData = path.join(scratch, "user-data");
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
    },
  };
}

export interface RunningApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  /** Everything the shell and its children printed, for assertions on the log lines. */
  readonly output: string[];
}

export async function launchApp(env: Record<string, string>): Promise<RunningApp> {
  const app = await electron.launch({ args: [APP], env });
  const output: string[] = [];
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  app.process().stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const window = await app.firstWindow();
  return { app, window, output };
}

/** One child's status, read off the page by test id. */
export async function childOnPage(window: Page, child: "runtime" | "services") {
  const text = (id: string) => window.getByTestId(`child-${id}-${child}`).textContent();
  return {
    state: await text("state"),
    generation: Number(await text("generation")),
    pid: Number(await text("pid")),
    port: (await text("port")) ?? "",
  };
}

/** Wait until the page shows `child` running at `generation` (or any, when omitted). */
export async function waitForRunning(
  window: Page,
  child: "runtime" | "services",
  generation?: number,
): Promise<{ generation: number; pid: number; port: string }> {
  await expect(window.getByTestId(`child-state-${child}`)).toHaveText("running", {
    timeout: 15_000,
  });
  if (generation !== undefined) {
    await expect(window.getByTestId(`child-generation-${child}`)).toHaveText(String(generation), {
      timeout: 15_000,
    });
    await expect(window.getByTestId(`child-state-${child}`)).toHaveText("running");
  }
  const status = await childOnPage(window, child);
  return { generation: status.generation, pid: status.pid, port: status.port };
}

/** Quit the way the app quits, and wait for the main process to be gone. */
export async function quit(app: ElectronApplication): Promise<void> {
  const exited = new Promise<void>((resolve) =>
    app.process().once("exit", () => {
      resolve();
    }),
  );
  await app.evaluate(({ app: shell }) => {
    shell.quit();
  });
  await exited;
}
