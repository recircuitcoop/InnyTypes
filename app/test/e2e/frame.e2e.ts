// The app frame in the real app (plan 0022 §M; WI-0022-11), driven through the real shell/main.ts
// bundle: the window opens on Setup until Setup is completed and on Live after that, launch after
// launch, and every route of section M resolves to its screen's template. The frame is the whole
// window's page, served by the shell: it fills the window, and reloads whole while the runtime is
// killed and while it is down for good.
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { STRINGS } from "../../src/ui/strings";
import {
  cleanUp,
  launchApp,
  openGeneral,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const frame = (window: Page) => window.getByTestId("frame");
const hashOf = (window: Page) => window.evaluate(() => globalThis.location.hash);

/** Close Setup for good through AppApi, as Ready's closing choice does (WI-0022-16 draws it). */
async function completeSetup(window: Page): Promise<void> {
  const answer = await window.evaluate(() =>
    (
      globalThis as unknown as { inny: { app: { completeSetup(): Promise<{ ok: boolean }> } } }
    ).inny.app.completeSetup(),
  );
  expect(answer.ok).toBe(true);
}

test("the window opens on Setup until Setup is completed, then on Live, launch after launch", async () => {
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const first = await launchApp(env);
    apps.push(first.app);
    const window = first.window;
    await expect(frame(window)).toHaveAttribute("data-route", "setup", { timeout: 15_000 });
    expect(await hashOf(window)).toBe("#/setup/welcome");
    await expect(window.locator('[data-component="window-setup"]')).toBeVisible();
    // Setup has no navigation: its sidebar lists the walkthrough, the first entry current.
    const sidebar = window.locator('[data-component="sidebar"]');
    await expect(sidebar).toHaveAttribute("data-variant", "mode=setup");
    await expect(sidebar.locator("li")).toHaveText([
      STRINGS["setup.nav.welcome"],
      STRINGS["setup.nav.reports"],
      STRINGS["setup.nav.anytype"],
      STRINGS["setup.nav.folder"],
      STRINGS["setup.nav.steps"],
      STRINGS["setup.nav.ready"],
    ]);
    await expect(sidebar.locator('li[aria-current="step"]')).toHaveText(
      STRINGS["setup.nav.welcome"],
    );
    // An address of another screen lands back on Setup's step while Setup is not completed.
    await window.evaluate(() => {
      globalThis.location.hash = "#/configuration/general";
    });
    await expect.poll(() => hashOf(window)).toBe("#/setup/welcome");
    await expect(frame(window)).toHaveAttribute("data-route", "setup");

    await completeSetup(window);
    await expect(frame(window)).toHaveAttribute("data-route", "live");
    expect(await hashOf(window)).toBe("#/live");
    await expect(window.locator('[data-component="page-live"]')).toBeVisible();
    await quit(first.app);

    // The next launch opens on Live: Setup never shows again.
    const second = await launchApp(env);
    apps.push(second.app);
    await expect(frame(second.window)).toHaveAttribute("data-route", "live", { timeout: 15_000 });
    expect(await hashOf(second.window)).toBe("#/live");
    await expect(second.window.locator('[data-component="window-setup"]')).toHaveCount(0);
    await quit(second.app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("every section M route resolves to its screen, and the sidebar and tabs move between them", async () => {
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    await expect(frame(window)).toHaveAttribute("data-route", "setup", { timeout: 15_000 });
    await completeSetup(window);
    await expect(frame(window)).toHaveAttribute("data-route", "live");

    const routes: readonly (readonly [string, string, string])[] = [
      ["#/live", "live", "page-live"],
      ["#/live/flow-1?tab=tab-1", "live", "page-live"],
      ["#/configuration/flows", "flows", "page-configuration"],
      ["#/configuration/flows/flow-1/canvas", "canvas", "page-canvas"],
      ["#/configuration/flows/flow-1/history", "history", "page-configuration"],
      ["#/configuration/general", "general", "page-configuration"],
    ];
    for (const [hash, screen, template] of routes) {
      await window.evaluate((address) => {
        globalThis.location.hash = address;
      }, hash);
      await expect(frame(window), hash).toHaveAttribute("data-route", screen);
      await expect(frame(window).locator(`[data-component="${template}"]`), hash).toBeVisible();
      expect(await hashOf(window)).toBe(hash);
    }
    // A Setup address, once Setup is completed, and an address that names no screen open Live.
    for (const hash of ["#/setup/welcome", "#/editor"]) {
      await window.evaluate((address) => {
        globalThis.location.hash = address;
      }, hash);
      await expect.poll(() => hashOf(window), { message: hash }).toBe("#/live");
    }
    // The gallery, in this development build.
    await window.evaluate(() => {
      globalThis.location.hash = "#/gallery";
    });
    await expect(frame(window)).toHaveAttribute("data-route", "gallery");
    await expect(window.locator('[data-gallery="innytypes-component-gallery"]')).toBeAttached({
      timeout: 15_000,
    });

    // Live's empty state goes to Flows; the sidebar and the tab strip move between the surfaces.
    await window.evaluate(() => {
      globalThis.location.hash = "#/live";
    });
    await frame(window).getByRole("button", { name: STRINGS["live.empty.goToFlows"] }).click();
    await expect.poll(() => hashOf(window)).toBe("#/configuration/flows");
    await frame(window).getByRole("tab", { name: STRINGS["nav.general"] }).click();
    await expect.poll(() => hashOf(window)).toBe("#/configuration/general");
    await frame(window).getByRole("button", { name: STRINGS["nav.live"] }).click();
    await expect.poll(() => hashOf(window)).toBe("#/live");
    await frame(window).getByRole("button", { name: STRINGS["nav.configuration"] }).click();
    await expect.poll(() => hashOf(window)).toBe("#/configuration/flows");
    await expect(
      frame(window).locator('[data-component="nav-item"][aria-current="page"]'),
    ).toHaveText(STRINGS["nav.configuration"]);

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("a 0.2.1 installation with saved flows opens on Live, launch after launch, and never shows Setup", async () => {
  const { scratch, userData, env } = scratchDirectories();
  // A 0.2.1 user's Node-RED folder: one flow (a tab) saved, nothing of Setup stored.
  fs.mkdirSync(path.join(userData, "node-red"), { recursive: true });
  fs.writeFileSync(
    path.join(userData, "node-red", "flows.json"),
    JSON.stringify([{ id: "a1b2c3d4e5f60718", type: "tab", label: "Recordings to Anytype" }]),
  );
  const apps: ElectronApplication[] = [];
  try {
    for (const launch of [1, 2]) {
      const { app, window } = await launchApp(env);
      apps.push(app);
      await expect(frame(window), `launch ${String(launch)}`).toHaveAttribute(
        "data-route",
        "live",
        { timeout: 15_000 },
      );
      expect(await hashOf(window)).toBe("#/live");
      await expect(window.locator('[data-component="window-setup"]')).toHaveCount(0);
      const stored = JSON.parse(
        fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"),
      ) as { setup?: { completed?: boolean } };
      expect(stored.setup?.completed).toBe(true);
      await quit(app);
    }
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("the quit question shows and is answered even when Setup's state cannot be read", async () => {
  const { scratch, userData, env } = scratchDirectories();
  // shell-settings.json is not JSON: setup.get is refused, and the frame cannot place Setup.
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "shell-settings.json"), "{ not json");
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    // The person's answer, as the shell receives it.
    await app.evaluate(({ ipcMain }) => {
      const answers: unknown[] = [];
      (globalThis as unknown as { quitAnswers: unknown[] }).quitAnswers = answers;
      ipcMain.removeHandler("inny:quit-answer");
      ipcMain.handle("inny:quit-answer", (_event, choice: unknown) => {
        answers.push(choice);
      });
    });
    // A quit whose Save failed asks again, saying why (shell/quit-question.ts ask(problem)).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("inny:quit-question", {
        problem: "The deploy <b>failed</b>.",
      });
    });
    const question = window.getByTestId("quit-question");
    await expect(question).toBeVisible({ timeout: 15_000 });
    // The problem is shown as text, escaped: no element is made of it.
    await expect(question.getByRole("alert")).toHaveText("The deploy <b>failed</b>.");
    await expect(question.locator("b")).toHaveCount(0);
    await question.getByRole("button", { name: STRINGS["dialog.cancel"], exact: true }).click();
    await expect(question).toBeHidden();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { quitAnswers: unknown[] }).quitAnswers),
      )
      .toEqual(["cancel"]);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("the frame fills the window, and reloads whole while the runtime is killed and while it is down for good", async () => {
  test.setTimeout(150_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    let runtime = await waitForRunning(window, "runtime");
    await openGeneral(window);

    // The window is its own height again, and the frame is all of it: no band above or below.
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds()),
    ).toMatchObject({ width: 960, height: 640 });
    const size = await window.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));
    expect(await frame(window).boundingBox()).toEqual({ x: 0, y: 0, ...size });

    // kill -9, and the page reloaded at once: it is the shell's, so it comes back whole.
    process.kill(runtime.pid, "SIGKILL");
    await window.reload();
    expect(window.url().split("#")[0]).toBe("inny-app://app/index.html");
    await expect(frame(window)).toHaveAttribute("data-route", "general", { timeout: 15_000 });
    runtime = await waitForRunning(window, "runtime", runtime.generation + 1);

    // Down for good (the crash-loop limit, five in two minutes, the kill above the first).
    for (let crash = 2; crash <= 5; crash++) {
      process.kill(runtime.pid, "SIGKILL");
      if (crash < 5) {
        runtime = await waitForRunning(window, "runtime", runtime.generation + 1);
      }
    }
    const general = window.getByTestId("general");
    await expect(general.getByTestId("general-child-runtime")).toHaveAttribute(
      "data-state",
      "down-for-good",
      { timeout: 15_000 },
    );
    await window.reload();
    await expect(frame(window)).toHaveAttribute("data-route", "general", { timeout: 15_000 });
    await expect(window.getByTestId("runtime-banner")).toHaveAttribute("data-banner", "down");
    await expect(general.getByTestId("general-child-runtime")).toHaveAttribute(
      "data-state",
      "down-for-good",
    );
    await expect(general.getByTestId("general-advanced-secrets")).toBeAttached();
    // The other surfaces still open while the runtime is down.
    for (const [hash, screen] of [
      ["#/configuration/flows", "flows"],
      ["#/live", "live"],
    ] as const) {
      await window.evaluate((address) => {
        globalThis.location.hash = address;
      }, hash);
      await expect(frame(window), hash).toHaveAttribute("data-route", screen);
    }

    // The banner's Restart: the runtime is back.
    await window
      .getByTestId("runtime-banner")
      .getByRole("button", { name: STRINGS["notify.restart"], exact: true })
      .click();
    await waitForRunning(window, "runtime", runtime.generation + 1);

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
