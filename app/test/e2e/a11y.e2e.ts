// Accessibility in the real app (plan 0022 §P, D12): WCAG 2.2 AA is a gate, not a review.
// (a) axe on every route and dialog, light and dark: Setup's steps, Live (empty and a board, in
//     Edit layout, a place's ⋯ menu), Configuration › Flows (its ⋯ menu, the Destructive Delete
//     dialog), the canvas frame, Run history (its ⋯ menu, its Delete dialog), General, the quit
//     question, the runtime banner and a pop-out (Preview a view…). A `serious` or `critical`
//     finding fails; `moderate` and `minor` ones are attached to the report, not failed on.
//     Every icon-only control met on the way is named, and by a strings.ts line.
// (b) The app window loads the IBM Plex faces app.css names (plan 0022 §J), from its own files.
// (c) The keyboard: Setup in tab order with a focus ring at every stop, a Flows row's ⋯ menu,
//     and a dialog that keeps the focus inside and closes on Escape as Cancel does. Edit layout's
//     keyboard arrangement is live.e2e.ts "keyboard move and resize".
// (d) prefers-reduced-motion: no transition and no animation runs anywhere on the page.
//
// Node-RED's own editor inside the canvas frame is left out of axe: it is unthemed and not drawn
// by InnyTypes (plan 0022 risk 1).
import fs from "node:fs";
import * as path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { STRINGS } from "../../src/ui/strings";
import { cleanUp, launchApp, quit, scratchDirectories, waitForRunning } from "./app-harness";
import { FLOW, go, withProbeFlow } from "./probe-flow";

const THEMES = ["light", "dark"] as const;
interface Finding {
  readonly where: string;
  readonly theme: string;
  readonly rule: string;
  readonly impact: string;
  readonly nodes: readonly string[];
}

/** axe's findings on the page as it stands, in both themes; the page is left in light. */
async function audit(page: Page, where: string): Promise<Finding[]> {
  const found: Finding[] = [];
  for (const theme of THEMES) {
    // Colours transition (quick): axe measures once the transitions the switch began are done.
    await page.evaluate(async (wanted) => {
      document.documentElement.setAttribute("data-theme", wanted);
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => animation.finished),
      );
    }, theme);
    // Legacy mode runs axe inside the page itself (gallery.e2e.ts says why).
    const results = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .exclude('[data-testid="canvas-editor"]')
      .analyze();
    for (const violation of results.violations) {
      found.push({
        where,
        theme,
        rule: violation.id,
        impact: violation.impact ?? "unknown",
        nodes: violation.nodes.map((node) => node.target.join(" ")),
      });
    }
  }
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
  });
  return found;
}

/** A strings.ts line as a pattern: its `{slots}` stand for any words, its `*` marks for none. */
const LINES = Object.values(STRINGS).map(
  (line) =>
    new RegExp(
      `^${line
        .replaceAll("*", "")
        .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
        .replace(/\{\w+\}/g, ".+")}(: .+)?$`,
    ),
);

/**
 * Every visible control with no words of its own (an icon button, a ⋯, a close), with the name
 * it is spoken by; the names that are not a strings.ts line (alone, or followed by ": " and the
 * name of what it acts on).
 */
async function unnamedIconControls(page: Page): Promise<string[]> {
  const controls = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'button, a[href], [role="button"], [role="menuitem"], [role="tab"]',
      ),
    ]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && element.textContent.trim() === "";
      })
      .map((element) => {
        const labelledBy = element.getAttribute("aria-labelledby");
        const name =
          element.getAttribute("aria-label") ??
          (labelledBy === null ? "" : (document.getElementById(labelledBy)?.textContent ?? ""));
        return `${element.getAttribute("data-testid") ?? element.tagName}: ${name.trim()}`;
      }),
  );
  return controls.filter((control) => {
    const name = control.slice(control.indexOf(": ") + 2);
    return name === "" || !LINES.some((line) => line.test(name));
  });
}

/** One stop on the walk: axe's findings, and its icon-only controls checked. */
async function stop(page: Page, where: string, findings: Finding[], unnamed: string[]) {
  findings.push(...(await audit(page, where)));
  unnamed.push(...(await unnamedIconControls(page)).map((control) => `${where} › ${control}`));
}

/** Welcome, Reports and Connect Anytype (skipped), to Source folder. */
async function toSourceFolder(window: Page, visit?: (where: string) => Promise<void>) {
  const step = window.getByTestId("setup-step");
  await expect(step).toHaveAttribute("data-step", "welcome", { timeout: 20_000 });
  await visit?.("setup welcome");
  await step.getByTestId("setup-continue").click();
  await expect(step).toHaveAttribute("data-step", "reports");
  await visit?.("setup reports");
  await step.getByTestId("setup-reports-dont-send").click();
  await expect(step).toHaveAttribute("data-step", "connect-anytype");
  await visit?.("setup connect anytype");
  await step.getByTestId("setup-anytype-skip").click();
  await expect(step).toHaveAttribute("data-step", "source-folder", { timeout: 20_000 });
}

/** Source folder chosen (the shell's chooser answers a scratch folder), to the step forms. */
async function toStepForms(app: ElectronApplication, window: Page, scratch: string) {
  const folder = path.join(scratch, "watched");
  fs.mkdirSync(folder);
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
  const choose = window.getByTestId("setup-choose-folder");
  await expect(choose).toHaveAttribute("data-variant", /state=default/, { timeout: 30_000 });
  await choose.click();
  await expect(window.getByTestId("setup-folder")).toHaveText(path.basename(folder));
  await window.getByTestId("setup-step").getByTestId("setup-continue").click();
  await expect(window.getByTestId("setup-step")).toHaveAttribute("data-step", "node-forms", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("setup-field-space_id-text-input")).toBeVisible({
    timeout: 15_000,
  });
}

/** Past the step forms to Ready, as the shell's own move does. */
async function toReady(window: Page) {
  await window.evaluate(() =>
    (
      globalThis as unknown as {
        inny: { app: { setSetupStep(move: { kind: "next" }): Promise<unknown> } };
      }
    ).inny.app.setSetupStep({ kind: "next" }),
  );
  await expect(window.getByTestId("setup-step")).toHaveAttribute("data-step", "ready", {
    timeout: 15_000,
  });
}

test("(a) every route and dialog, light and dark: no serious or critical axe finding, every icon-only control named", async () => {
  test.setTimeout(300_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  const findings: Finding[] = [];
  const unnamed: string[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    const visit = (where: string, page: Page = window) => stop(page, where, findings, unnamed);

    // ── Setup, step by step ──────────────────────────────────────────────────────────────
    await toSourceFolder(window, visit);
    await visit("setup source folder");
    await toStepForms(app, window, scratch);
    await visit("setup step forms");
    await toReady(window);
    await visit("setup ready");

    // ── Live: empty, a board, Edit layout and a place's ⋯ menu ───────────────────────────
    await withProbeFlow(window);
    await visit("live board");
    await window.getByTestId("board-edit-layout").click();
    await expect(window.getByTestId("edit-layout-bar")).toBeVisible();
    await visit("live edit layout");
    await window.getByTestId("place-runs").getByTestId("slot-arrange").click();
    await expect(window.getByTestId("slot-menu").first()).toBeVisible();
    await visit("live place menu");
    await window.keyboard.press("Escape");
    await window.getByTestId("edit-layout-done").click();
    await go(window, "#/live", "live");
    await visit("live");

    // ── Configuration › Flows, its ⋯ menu and the Destructive Delete dialog ──────────────
    await go(window, "#/configuration/flows", "flows");
    await expect(window.getByTestId("flow-more")).toBeVisible({ timeout: 15_000 });
    await visit("flows");
    await window.getByTestId("flow-more").click();
    await expect(window.getByTestId("flows-menu-delete")).toBeVisible();
    await visit("flows menu");
    await window.getByTestId("flows-menu-delete").click();
    const deleteFlow = window.getByTestId("flow-delete-dialog");
    await expect(deleteFlow).toHaveAttribute("data-state", "open");
    await visit("flows delete dialog");
    await deleteFlow.getByTestId("flow-delete-cancel").click();
    await expect(deleteFlow).toBeHidden();

    // ── Run history, its ⋯ menu and its Delete dialog ────────────────────────────────────
    await go(window, `#/configuration/flows/${FLOW}/history`, "history");
    await expect(window.getByTestId("history-row-more")).toBeVisible({ timeout: 15_000 });
    await visit("run history");
    await window.getByTestId("history-row-more").click();
    await expect(window.getByTestId("history-menu-delete")).toBeVisible();
    await visit("run history menu");
    await window.getByTestId("history-menu-delete").click();
    const deleteRun = window.getByTestId("history-delete-dialog");
    await expect(deleteRun).toBeVisible();
    await visit("run history delete dialog");
    await deleteRun.getByTestId("history-delete-cancel").click();
    await expect(deleteRun).toBeHidden();

    // ── General, the canvas frame ────────────────────────────────────────────────────────
    await go(window, "#/configuration/general", "general");
    await expect(window.getByTestId("general")).toBeVisible({ timeout: 15_000 });
    await visit("general");
    await go(window, `#/configuration/flows/${FLOW}/canvas`, "canvas");
    await expect(window.getByTestId("canvas-editor")).toBeVisible({ timeout: 15_000 });
    await visit("canvas frame");

    // ── the quit question (as the shell asks it) ─────────────────────────────────────────
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("inny:quit-question", {});
    });
    const question = window.getByTestId("quit-question");
    await expect(question).toBeVisible({ timeout: 15_000 });
    await visit("quit question");
    await question.getByTestId("quit-cancel").click();
    await expect(question).toBeHidden();

    // ── a pop-out: Preview a view…, the reorder widget picked in the native chooser ──────
    await app.evaluate(({ dialog }) => {
      Object.assign(dialog, {
        showMessageBox: (options: { readonly buttons?: string[] }) =>
          Promise.resolve({
            response: options.buttons?.indexOf("Reorder (widget kit)") ?? -1,
            checkboxChecked: false,
          }),
      });
    });
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("preview-a-view")?.click();
    });
    const popouts = () => app.windows().filter((page) => page.url().startsWith("inny-view://"));
    await expect.poll(() => popouts().length, { timeout: 15_000 }).toBe(1);
    const popout = popouts()[0] as Page;
    await expect(popout.getByTestId("question-popout")).toBeVisible({ timeout: 15_000 });
    await visit("pop-out", popout);
    await popout.getByTestId("view-dismiss").click();
    await expect(popout.getByTestId("skip-dialog")).toBeVisible();
    await visit("pop-out skip dialog", popout);

    // ── the runtime banner, while InnyTypes restarts itself ──────────────────────────────
    const runtime = await waitForRunning(window, "runtime");
    process.kill(runtime.pid, "SIGKILL");
    await expect(window.getByTestId("runtime-banner")).toBeVisible({ timeout: 15_000 });
    await visit("runtime banner");

    const lesser = findings.filter((f) => f.impact === "moderate" || f.impact === "minor");
    await test.info().attach("axe moderate and minor findings", {
      body: JSON.stringify(lesser, null, 2),
      contentType: "application/json",
    });
    expect(findings.filter((f) => f.impact === "serious" || f.impact === "critical")).toEqual([]);
    expect(unnamed).toEqual([]);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

/** The faces app.css declares (tools/fonts/copy.mjs copies exactly these). */
const FACES = [
  "400 IBM Plex Sans",
  "500 IBM Plex Sans",
  "600 IBM Plex Sans",
  "400 IBM Plex Mono",
] as const;

test("(b) the app window loads the IBM Plex faces it names, from its own files", async () => {
  test.setTimeout(120_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    await expect(window.getByTestId("setup-step")).toBeVisible({ timeout: 20_000 });
    // Each face asked for in Latin, as the window's own words ask for it; then what loaded.
    const loaded = await window.evaluate(async (faces) => {
      await Promise.all(
        faces.map((face) => {
          const [weight, family] = [face.slice(0, 3), face.slice(4)];
          return document.fonts.load(`${weight} 16px "${family}"`, "InnyTypes");
        }),
      );
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => `${face.weight} ${face.family.replaceAll('"', "")}`);
    }, FACES);
    expect([...new Set(loaded)].sort()).toEqual([...FACES].sort());
    // And the body is set in it.
    expect(
      await window.evaluate(() => getComputedStyle(document.body).fontFamily.split(",")[0]),
    ).toMatch(/IBM Plex Sans/);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

/** The focused element: its test id, and whether it draws a focus ring. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) {
      return { id: "body", ring: false, inDialog: false };
    }
    const style = getComputedStyle(element);
    return {
      id: element.getAttribute("data-testid") ?? element.tagName.toLowerCase(),
      ring: style.outlineStyle !== "none" && style.outlineWidth !== "0px",
      inDialog: element.closest('[role="dialog"], [role="alertdialog"]') !== null,
    };
  });

/** Press `key` until the focus is on `target` (at most `limit` presses); the stops on the way. */
async function tabTo(page: Page, target: string, limit = 25, key = "Tab") {
  const stops: { id: string; ring: boolean }[] = [];
  for (let n = 0; n < limit; n++) {
    await page.keyboard.press(key);
    const now = await focused(page);
    stops.push(now);
    if (now.id === target) {
      return stops;
    }
  }
  throw new Error(`the keyboard never reached ${target}: ${JSON.stringify(stops)}`);
}

test("(c) the keyboard: Setup in tab order, a Flows row's ⋯ menu, a dialog that traps the focus", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    const step = window.getByTestId("setup-step");
    await expect(step).toHaveAttribute("data-step", "welcome", { timeout: 20_000 });

    // Setup: Tab reaches each step's way on, with a focus ring at every stop, and Enter takes it.
    for (const [at, next, button] of [
      ["welcome", "reports", "setup-continue"],
      ["reports", "connect-anytype", "setup-reports-dont-send"],
      ["connect-anytype", "source-folder", "setup-anytype-skip"],
    ] as const) {
      await expect(step).toHaveAttribute("data-step", at, { timeout: 20_000 });
      const stops = await tabTo(window, button);
      expect(
        stops.filter((s) => s.id !== "body" && !s.ring),
        `${at}: stops with no ring`,
      ).toEqual([]);
      await window.keyboard.press("Enter");
      await expect(step).toHaveAttribute("data-step", next, { timeout: 20_000 });
    }

    await withProbeFlow(window);
    await go(window, "#/configuration/flows", "flows");
    const more = window.getByTestId("flow-more");
    await expect(more).toBeVisible({ timeout: 15_000 });

    // A Flows row's ⋯: reached by Tab, opened by Enter, walked by the arrows, closed by Escape
    // with the focus back on it.
    await tabTo(window, "flow-more", 40);
    expect((await focused(window)).ring).toBe(true);
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("flows-menu-rename")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("flows-menu-rename")).toBeHidden();
    expect((await focused(window)).id).toBe("flow-more");

    // Delete flow…, from the keyboard alone: the Destructive dialog takes the focus and keeps
    // it, forwards and back; Escape is Cancel, and the flow stays.
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("flows-menu-rename")).toBeVisible();
    const deleteItem = window.getByTestId("flows-menu-delete");
    for (let n = 0; n < 10 && (await deleteItem.getAttribute("data-highlighted")) === null; n++) {
      await window.keyboard.press("ArrowDown");
    }
    await expect(deleteItem).toHaveAttribute("data-highlighted", "");
    await window.keyboard.press("Enter");
    const dialog = window.getByTestId("flow-delete-dialog");
    await expect(dialog).toHaveAttribute("data-state", "open");
    await expect.poll(async () => (await focused(window)).inDialog).toBe(true);
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await window.keyboard.press(key);
      const now = await focused(window);
      expect(now.inDialog, `${key} left the dialog for ${now.id}`).toBe(true);
      expect(now.ring, `${now.id} has no focus ring`).toBe(true);
    }
    await window.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(window.getByTestId("flow-more")).toHaveCount(1);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

/** Every element whose computed transition or animation would take time. */
const moving = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("*")].flatMap((element) => {
      const style = getComputedStyle(element);
      const lasts = (durations: string) =>
        durations.split(",").some((duration) => Number.parseFloat(duration) > 0);
      const animated = style.animationName !== "none" && lasts(style.animationDuration);
      const transitioned = style.transitionProperty !== "none" && lasts(style.transitionDuration);
      return animated || transitioned
        ? [element.getAttribute("data-testid") ?? element.tagName.toLowerCase()]
        : [];
    }),
  );

test("(d) with reduced motion asked for, no transition or animation runs", async () => {
  test.setTimeout(120_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    await toSourceFolder(window);
    // The runtime banner's spinner is the one animation; buttons and fields transition.
    const runtime = await waitForRunning(window, "runtime");
    process.kill(runtime.pid, "SIGKILL");
    await expect(window.getByTestId("runtime-banner")).toHaveAttribute(
      "data-banner",
      "restarting",
      {
        timeout: 15_000,
      },
    );

    await window.emulateMedia({ reducedMotion: "no-preference" });
    expect((await moving(window)).length).toBeGreaterThan(0);
    await window.emulateMedia({ reducedMotion: "reduce" });
    expect(await moving(window)).toEqual([]);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
