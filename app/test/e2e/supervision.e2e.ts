// The shell's supervision of the real runtime and services utilityProcesses, driven through
// the real shell/main.ts bundle (plan 0018 WI-03), by the spike's P11d and P11e method:
// kill -9 by pid, then look for every process by pid and by pgrep scoped to this run's
// temporary userData.
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { t } from "../../src/ui/strings";
import {
  APP,
  ELECTRON_BINARY,
  isAlive,
  launchApp,
  quit,
  processesNaming,
  scratchDirectories,
  shellOf,
  waitForRunning,
  exitOf,
} from "./app-harness";

/** The runtime back: Running, or Needs attention for the Anytype nothing in a run can reach. */
const BACK = /^(running|needsAttention)\/none$/;

/**
 * Every state the frame's status pill and runtime banner pass through (WI-0022-11), as
 * "pill/banner" ("none" when there is no banner), recorded in the page by a MutationObserver so a
 * state that lasts a moment is not missed between two looks.
 */
async function recordFrame(window: Page): Promise<() => Promise<string[]>> {
  await expect(window.getByTestId("status-pill")).toBeVisible({ timeout: 15_000 });
  await window.evaluate(() => {
    const seen: string[] = [];
    (globalThis as unknown as { frameSeen: string[] }).frameSeen = seen;
    const note = (): void => {
      const pill = document.querySelector('[data-testid="status-pill"]')?.getAttribute("data-pill");
      const banner = document
        .querySelector('[data-testid="runtime-banner"]')
        ?.getAttribute("data-banner");
      const entry = `${pill ?? "none"}/${banner ?? "none"}`;
      if (seen[seen.length - 1] !== entry) {
        seen.push(entry);
      }
    };
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    note();
  });
  return () =>
    window.evaluate(() => [...(globalThis as unknown as { frameSeen: string[] }).frameSeen]);
}

test("kill -9 of the runtime restarts it on the same port, and leaves no orphan", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const { app, window } = await launchApp(env);
    const before = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");
    const seen = await recordFrame(window);
    expect(Number(before.port)).toBeGreaterThan(0);
    // The pgrep scope sees the children: Electron names userData in their command lines.
    expect(processesNaming(userData).join("\n")).toContain(String(before.pid));

    process.kill(before.pid, "SIGKILL");
    const after = await waitForRunning(window, "runtime", before.generation + 1);

    expect(after.pid).not.toBe(before.pid);
    expect(after.port).toBe(before.port); // the stable port, across a generation
    expect(isAlive(before.pid)).toBe(false); // no orphan
    // The frame followed: Restarting… with the banner while the runtime came back, then back.
    await expect.poll(seen).toContain("restarting/restarting");
    await expect.poll(async () => (await seen()).at(-1)).toMatch(BACK);
    // Exactly one runtime, the new one; the services process never noticed.
    const utilities = await app.evaluate(({ app: shell }) =>
      shell.getAppMetrics().filter((metric) => metric.type === "Utility"),
    );
    expect(utilities.filter((m) => m.name === "InnyTypes runtime").map((m) => m.pid)).toEqual([
      after.pid,
    ]);
    expect(utilities.filter((m) => m.name === "InnyTypes services").map((m) => m.pid)).toEqual([
      services.pid,
    ]);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the crash-loop limit shows an error with Restart, and Restart brings the runtime back", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const { app, window, output } = await launchApp(env);
    let current = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");
    const port = current.port;
    const seen = await recordFrame(window);

    // Five crashes well inside two minutes; each kill waits for the next generation first.
    for (let crash = 1; crash <= 5; crash++) {
      process.kill(current.pid, "SIGKILL");
      if (crash < 5) {
        current = await waitForRunning(window, "runtime", current.generation + 1);
      }
    }

    await expect(window.getByTestId("child-error-runtime")).toContainText(
      "stopped unexpectedly 5 times in 2 minutes",
    );
    await expect(window.getByTestId("child-restart-runtime")).toBeVisible();
    await expect(window.getByTestId("child-state-runtime")).toHaveText("stopped");
    // Told once (WI-0018-21), and recorded in the notice file until Restart clears it.
    expect(output.join("").match(/notice: InnyTypes stopped restarting the runtime/g)).toHaveLength(
      1,
    );
    const noticeFile = path.join(userData, "notices.json");
    const recorded = (): unknown => JSON.parse(fs.readFileSync(noticeFile, "utf8"));
    expect(recorded()).toEqual([
      expect.objectContaining({ kind: "child-stopped", subject: "runtime" }),
    ]);
    // Only the runtime was stopped: the shell and the services process carry on untouched.
    expect(await waitForRunning(window, "services")).toEqual(services);

    // The frame (WI-0022-11): the pill says Stopped, the banner is Down with ux-writing's
    // sentence and Restart as its Primary button; it said Restarting… while the crashes went on.
    await expect(window.getByTestId("status-pill")).toHaveAttribute("data-pill", "stopped");
    await expect(window.getByTestId("status-pill")).toHaveText(t("status.stopped"));
    const banner = window.getByTestId("runtime-banner");
    await expect(banner).toHaveAttribute("data-banner", "down");
    await expect(banner).toContainText(t("error.runtimeDown", { count: 5, minutes: 2 }));
    const restart = banner.getByRole("button", { name: t("notify.restart"), exact: true });
    await expect(restart).toHaveAttribute("data-variant", /kind=primary/);
    expect(await seen()).toContain("restarting/restarting");
    expect((await seen()).at(-1)).toBe("stopped/down");

    // The banner's Restart brings the runtime back, and the pill and banner with it.
    await restart.click();
    const back = await waitForRunning(window, "runtime", current.generation + 1);
    expect(back.port).toBe(port);
    await expect(window.getByTestId("child-restart-runtime")).toHaveCount(0);
    await expect(window.getByTestId("runtime-banner")).toHaveCount(0);
    await expect.poll(async () => (await seen()).at(-1)).toMatch(BACK);
    expect(recorded()).toEqual([]);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("quit stops both children with stop quit, and leaves no process", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const { app, window, output } = await launchApp(env);
    const runtime = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");

    await quit(app);

    const log = output.join("");
    for (const child of ["runtime", "services"]) {
      expect(log).toContain(`${child} stopping (quit)`);
      expect(log).toContain(`the ${child} exited (code 0) on quit`);
    }
    expect(log).toContain("quit complete");
    expect(log).not.toContain("killing it");
    expect(isAlive(runtime.pid)).toBe(false);
    expect(isAlive(services.pid)).toBe(false);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("kill -9 of the shell leaves no process", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const { app, window } = await launchApp(env);
    const runtime = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");
    const shellPid = shellOf(app).pid;
    if (shellPid === undefined) {
      throw new Error("the shell has no pid");
    }

    const exited = exitOf(app);
    process.kill(shellPid, "SIGKILL");
    await exited;

    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    expect(isAlive(runtime.pid)).toBe(false);
    expect(isAlive(services.pid)).toBe(false);

    // The single-instance lock the dead shell held never locks the next launch out.
    const relaunched = await launchApp(env);
    await waitForRunning(relaunched.window, "runtime");
    await waitForRunning(relaunched.window, "services");
    await quit(relaunched.app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("SIGTERM, as a logout sends it, runs the same quit", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const { app, window, output } = await launchApp(env);
    await waitForRunning(window, "runtime");
    await waitForRunning(window, "services");
    const shellPid = shellOf(app).pid;
    if (shellPid === undefined) {
      throw new Error("the shell has no pid");
    }

    const exited = exitOf(app);
    process.kill(shellPid, "SIGTERM");
    expect(await exited).toBe(0);

    const log = output.join("");
    for (const child of ["runtime", "services"]) {
      expect(log).toContain(`${child} stopping (quit)`);
      expect(log).toContain(`the ${child} exited (code 0) on quit`);
    }
    expect(log).toContain("quit complete");
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("closing the window does not quit, and a second launch brings the window forward", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const { app, window } = await launchApp(env);
    const runtime = await waitForRunning(window, "runtime");
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
    ).toBe(false);

    // Closing is not quitting: the window goes, the app and its children stay.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0);
    expect(isAlive(runtime.pid)).toBe(true);

    // A second launch finds the lock taken, hands over, and ends at once.
    const second = spawn(ELECTRON_BINARY, [APP], { env, stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));
    expect(code).toBe(0);

    // The first instance shows its one window, in front; nothing was started twice.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible() })),
        ),
      )
      .toEqual([{ visible: true }]);
    const utilities = await app.evaluate(({ app: shell }) =>
      shell
        .getAppMetrics()
        .filter((metric) => metric.type === "Utility")
        .map((m) => m.name ?? ""),
    );
    expect(utilities.filter((name) => name.startsWith("InnyTypes")).sort()).toEqual([
      "InnyTypes runtime",
      "InnyTypes services",
    ]);
    expect(isAlive(runtime.pid)).toBe(true);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
