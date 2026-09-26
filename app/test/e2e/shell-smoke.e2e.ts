// The smoke test of the real app: the esbuild bundle of src/shell/main.ts, started by the
// Electron binary the workspace pins, opens its window and quits with no process left.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { exitOf, launchTracked } from "./app-harness";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every process whose command line names `marker`, as pgrep lists them. */
function processesNaming(marker: string): string[] {
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

test("the shell opens its window and quits with no process left", async () => {
  // A temp home and userData unique to this run. Electron passes --user-data-dir to every
  // helper process it starts, so this path is in the command line of the whole app.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-e2e-")));
  const userData = path.join(scratch, "user-data");

  try {
    const app = await launchTracked({
      args: [APP],
      env: {
        ...process.env,
        HOME: scratch,
        INNYTYPES_USER_DATA: userData,
        INNYTYPES_HIDDEN_WINDOWS: "1",
      },
    });
    const window = await app.firstWindow();
    await expect(window).toHaveTitle("InnyTypes");
    await expect(window.getByTestId("shell-ready")).toBeVisible();
    expect(await app.evaluate(({ app: shell }) => shell.getPath("userData"))).toBe(userData);
    expect(processesNaming(userData).length).toBeGreaterThan(0);

    // Quit the way the app quits, and wait for the main process to be gone.
    const exited = exitOf(app);
    await app.evaluate(({ app: shell }) => {
      shell.quit();
    });
    await exited;

    // Helpers (GPU, renderer, network) may take a moment after the main process.
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
