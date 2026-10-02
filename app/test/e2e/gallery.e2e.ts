// The component gallery (plan 0022 §L, decision D11): every atom, molecule, organism and
// template in every Penpot variant, light and dark, compared with committed macOS screenshots in
// test/e2e/baselines/; an axe pass over the whole gallery in both themes; dark mode sampled for
// light fills; and the place's ⋯ menu driven from the keyboard alone (plan 0022 §P).
//
// BASELINES. The screenshots are macOS renders (font rasterising differs elsewhere), so on any
// other platform this spec skips and says so. A difference above the threshold fails the gate.
// They are regenerated only on an intentional visual change, on a Mac, with
//
//   INNYTYPES_UPDATE_BASELINES=1 npx playwright test gallery
//
// (playwright.config.ts turns that variable into updateSnapshots "all"; without it a missing
// baseline is a failure, never silently written). Playwright's own --update-snapshots (-u) is
// refused here without the variable, so no flag alone rewrites a baseline. Commit the changed
// PNGs with the change.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { APP, ELECTRON_BINARY, launchTracked, stopApps } from "./app-harness";

const WINDOW = path.join(APP, "test", "e2e", "gallery-window.cjs");
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/**
 * Every Penpot component in the gallery and how many variants Penpot's library holds for it
 * (02 Atoms, 03 Molecules, 04 Organisms, 05 Templates; the icon groups are the 37 Lucide names
 * at 16 and at 20). Run card's nine are its six states with Done's Notes, Warnings and Both. Menu item
 * shows its four states inside one open menu; Penpot's list-row has ten (a Run row has one
 * action only). Result line has the protocol's four sinks (anytype, file, scheduled, plain),
 * one more than Penpot's stale drawing.
 */
const VARIANTS = new Map<string, number>(
  Object.entries({
    "icon-16": 37,
    "icon-20": 37,
    button: 40,
    "icon-button": 8,
    switch: 4,
    checkbox: 6,
    radio: 4,
    "text-field": 10,
    textarea: 5,
    "number-field": 5,
    select: 5,
    range: 3,
    chip: 3,
    "status-pill": 5,
    badge: 3,
    progress: 2,
    spinner: 2,
    skeleton: 3,
    link: 3,
    kbd: 3,
    code: 2,
    divider: 1,
    tooltip: 1,
    field: 6,
    "search-field": 2,
    combobox: 2,
    "multi-select": 2,
    "date-field": 3,
    "file-drop": 3,
    "list-row": 10,
    "table-row": 3,
    "key-value": 3,
    "result-line": 4,
    "nav-item": 6,
    tab: 3,
    "tab-strip": 1,
    "segmented-control": 2,
    "menu-item": 1,
    menu: 1,
    "dialog-buttons": 2,
    "notification-actions": 3,
    toast: 4,
    "inline-message": 4,
    stepper: 3,
    // 04 Organisms (Tab strip is the molecule above, composed by Board and Configuration).
    "run-card": 9,
    slot: 18,
    board: 2,
    "edit-layout-bar": 1,
    "empty-state": 4,
    "question-popout": 2,
    "runtime-banner": 2,
    dialog: 3,
    sidebar: 2,
    "flows-list": 1,
    "run-history": 4,
    "general-section": 8,
    "package-row": 9,
    "canvas-frame": 2,
    "setup-step": 1,
    // 05 Templates.
    "page-configuration": 1,
    "page-live": 1,
    "page-canvas": 1,
    "window-popout": 1,
    "window-setup": 1,
  }),
);

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate(async (wanted) => {
    document.documentElement.setAttribute("data-theme", wanted);
    // Two frames: the style recalculation, then the paint.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
}

async function openGallery(): Promise<{ page: Page; stop: () => Promise<void> }> {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-gallery-")));
  const app = await launchTracked({
    executablePath: ELECTRON_BINARY,
    args: [WINDOW],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      HOME: scratch,
      INNYTYPES_USER_DATA: path.join(scratch, "user-data"),
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector("[data-gallery-group]");
  // Fonts before any pixel is judged: Plex in each weight the components use.
  await page.evaluate(async () => {
    await Promise.all(
      ["400", "500", "600"].map((weight) => document.fonts.load(`${weight} 14px "IBM Plex Sans"`)),
    );
    await document.fonts.load('400 13px "IBM Plex Mono"');
    await document.fonts.ready;
  });
  return {
    page,
    stop: async () => {
      await stopApps([app]);
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

test.describe("gallery", () => {
  // Baselines change only on purpose: Playwright's -u / --update-snapshots without the variable
  // would rewrite them, so it fails here before any screenshot is taken.
  test.beforeAll(() => {
    const updating = test.info().config.updateSnapshots !== "none";
    if (updating && process.env["INNYTYPES_UPDATE_BASELINES"] !== "1") {
      throw new Error("Baselines are regenerated only with INNYTYPES_UPDATE_BASELINES=1");
    }
  });

  test.skip(
    process.platform !== "darwin",
    "the gallery baselines are macOS renders; on other platforms the screenshots are not compared",
  );

  test("every component, every variant, light and dark", async () => {
    const { page, stop } = await openGallery();
    try {
      // Every Penpot component has its group, and each group every variant, each cell labelled
      // with the data-variant its component really rendered, none twice.
      const groups = await page.$$eval("[data-gallery-group]", (sections) =>
        sections.map((section) => ({
          group: section.getAttribute("data-gallery-group") ?? "",
          labels: [...section.querySelectorAll("[data-gallery-label]")].map(
            (label) => label.textContent,
          ),
        })),
      );
      expect(groups.map(({ group }) => group).sort()).toEqual([...VARIANTS.keys()].sort());
      for (const { group, labels } of groups) {
        expect(labels, `${group}: one cell per Penpot variant`).toHaveLength(
          VARIANTS.get(group) ?? -1,
        );
        expect(
          labels.filter((label) => label === ""),
          `${group}: unlabelled cells`,
        ).toEqual([]);
        if (!group.startsWith("icon-")) {
          expect(new Set(labels).size, `${group}: a variant drawn twice`).toBe(labels.length);
        }
      }
      expect(await page.locator('[data-component="menu-item"]').count()).toBeGreaterThanOrEqual(4);

      for (const theme of THEMES) {
        await setTheme(page, theme);
        for (const { group } of groups) {
          await expect(page.locator(`[data-gallery-group="${group}"]`)).toHaveScreenshot(
            `${group}-${theme}.png`,
            // Tight on both counts: at most 0.1% of the pixels may differ, and a pixel counts as
            // different at a 2% colour distance. Playwright's default per-pixel threshold (20%)
            // let a status pill's soft fill change from one state colour to another pass.
            {
              maxDiffPixelRatio: 0.001,
              threshold: 0.02,
              animations: "disabled",
              caret: "hide",
              scale: "css",
            },
          );
        }
      }
    } finally {
      await stop();
    }
  });

  test("no serious or critical accessibility finding, light and dark", async () => {
    const { page, stop } = await openGallery();
    try {
      for (const theme of THEMES) {
        await setTheme(page, theme);
        // Legacy mode runs axe inside the page itself: its default mode opens a blank page to
        // merge frame results, which Electron's driver does not support (Target.createTarget).
        const results = await new AxeBuilder({ page })
          .setLegacyMode(true)
          .include("main")
          .analyze();
        const findings = results.violations
          .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
          .map((violation) => ({
            rule: violation.id,
            impact: violation.impact,
            where: violation.nodes.map((node) => node.target.join(" ")),
          }));
        expect(findings, `axe in ${theme}`).toEqual([]);
      }
    } finally {
      await stop();
    }
  });

  // Plan 0022 §P: in Edit layout, drag has a menu alternative on each place, fully keyboard
  // operable. Focus the ⋯ of one place on the Edit-layout board, then move it, resize it and hide
  // it with keys only, reading the result back from the places' own data-variant and order.
  test("a place is moved, resized and hidden from the keyboard alone", async () => {
    const { page, stop } = await openGallery();
    try {
      const board = page.locator(
        '[data-gallery-group="board"] [data-component="board"][data-variant="mode=edit-layout"]',
      );
      const arrange = (name: string) => board.getByRole("button", { name: `Arrange: ${name}` });
      const filed = board
        .locator('[data-component="slot"]')
        .filter({ has: page.locator('button[aria-label="Arrange: Filed"]') });
      const order = () =>
        board
          .locator('[data-component="slot"] button[aria-label^="Arrange: "]')
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
      /** Opens the place's ⋯ menu with Enter, walks it with keys, checks the item, presses Enter. */
      const choose = async (keys: readonly string[], item: string) => {
        const trigger = arrange("Filed");
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        const menu = page.locator(`[id="${(await trigger.getAttribute("aria-controls")) ?? ""}"]`);
        await expect(menu.locator("[role^=menuitem][data-highlighted]")).toHaveCount(1);
        // Ark UI moves focus into the opened menu a frame later; under load a key pressed before
        // then goes to the trigger instead.
        await expect(menu).toBeFocused();
        for (const key of keys) {
          await page.keyboard.press(key);
        }
        await expect(menu.locator("[role^=menuitem][data-highlighted]")).toHaveText(item);
        await page.keyboard.press("Enter");
      };

      expect(await order()).toEqual([
        "Arrange: Runs",
        "Arrange: Name the speakers",
        "Arrange: Filed",
        "Arrange: Transcript",
      ]);
      await expect(filed).toHaveAttribute("data-variant", "hidden=no;kind=result;size=m");

      // Home is Move to tab, the next is Move earlier.
      await choose(["Home", "ArrowDown"], "Move earlier");
      await expect
        .poll(order)
        .toEqual([
          "Arrange: Runs",
          "Arrange: Filed",
          "Arrange: Name the speakers",
          "Arrange: Transcript",
        ]);

      // End is Hide; the one before it is Size L.
      await choose(["End", "ArrowUp"], "Size L");
      await expect(filed).toHaveAttribute("data-variant", "hidden=no;kind=result;size=l");

      await choose(["End"], "Hide");
      await expect(filed).toHaveAttribute("data-variant", "hidden=yes;kind=result;size=l");
      await expect(board.getByRole("button", { name: "Hidden (2)" })).toBeVisible();

      // A hidden place's last item is Show, still reached from the keyboard.
      await choose(["End"], "Show");
      await expect(filed).toHaveAttribute("data-variant", "hidden=no;kind=result;size=l");
      await expect(board.getByRole("button", { name: "Hidden (1)" })).toBeVisible();

      // Three up from Hide is Size S.
      await choose(["End", "ArrowUp", "ArrowUp", "ArrowUp"], "Size S");
      await expect(filed).toHaveAttribute("data-variant", "hidden=no;kind=result;size=s");

      // Home is Move to tab, then Move earlier, then Move later: back where it started.
      // (Move to tab › opens the tab list; the gallery draws one tab, so moving there is a no-op.)
      await choose(["Home", "ArrowDown", "ArrowDown"], "Move later");
      await expect
        .poll(order)
        .toEqual([
          "Arrange: Runs",
          "Arrange: Name the speakers",
          "Arrange: Filed",
          "Arrange: Transcript",
        ]);
    } finally {
      await stop();
    }
  });

  test("no light fill in dark", async () => {
    const { page, stop } = await openGallery();
    try {
      /** A surface token's colour as the page computes it in the current theme. */
      const surface = (token: string) =>
        page.evaluate((name) => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = `var(${name})`;
          document.body.append(probe);
          const colour = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return colour;
        }, token);
      await setTheme(page, "light");
      const lightFills = [
        await surface("--inny-surface-panel"),
        await surface("--inny-surface-canvas"),
      ];
      await setTheme(page, "dark");
      expect(await surface("--inny-surface-panel")).not.toBe(lightFills[0]);
      const fills = await page.$$eval(
        "main [data-component], main [data-component] *",
        (elements) =>
          elements.map((element) => ({
            component: element.closest("[data-component]")?.getAttribute("data-component") ?? "",
            fill: getComputedStyle(element).backgroundColor,
          })),
      );
      expect(fills.length).toBeGreaterThan(500);
      const light = fills.filter(({ fill }) => lightFills.includes(fill));
      expect(light, "elements still on a light surface in dark").toEqual([]);
    } finally {
      await stop();
    }
  });
});

// Plan 0022 §P, owner decision 11: the Dialog's focus trap and Escape = Cancel, on a real modal
// instance (the gallery draws its dialogs contained, untrapped). Not a screenshot, so on every
// platform.
test.describe("the modal dialog", () => {
  test("traps focus inside while open, and Escape is Cancel", async () => {
    const { page, stop } = await openGallery();
    try {
      await page.evaluate(() => {
        window.location.hash = "#/gallery/modal-dialog";
        window.location.reload();
      });
      await page.waitForSelector('[data-probe="modal-dialog"]');
      const probe = page.locator('[data-probe="modal-dialog"]');
      const dialog = page.locator('[data-component="dialog"]');
      const focusInside = () =>
        page.evaluate(
          () =>
            document.querySelector('[data-component="dialog"]')?.contains(document.activeElement) ??
            false,
        );

      await page.getByTestId("open-dialog").click();
      await expect(dialog).toBeVisible();
      await expect.poll(focusInside).toBe(true);
      // Forwards and backwards past every control: focus never leaves the dialog.
      for (const key of [
        "Tab",
        "Tab",
        "Tab",
        "Tab",
        "Tab",
        "Shift+Tab",
        "Shift+Tab",
        "Shift+Tab",
      ]) {
        await page.keyboard.press(key);
        expect(await focusInside(), `after ${key}`).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(probe).toHaveAttribute("data-probe-outcome", "cancel");

      // Cancel itself ends the same way; the main action is the only other outcome.
      await page.getByTestId("open-dialog").click();
      await dialog.getByRole("button", { name: "Remove tab" }).click();
      await expect(probe).toHaveAttribute("data-probe-outcome", "confirm");
      await page.getByTestId("open-dialog").click();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(probe).toHaveAttribute("data-probe-outcome", "cancel");
    } finally {
      await stop();
    }
  });
});
