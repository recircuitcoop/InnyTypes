// The component gallery (plan 0022 §L, decision D11): every atom and molecule in every Penpot
// variant, light and dark, compared with committed macOS screenshots in test/e2e/baselines/;
// an axe pass over the whole gallery in both themes; dark mode sampled for light fills.
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
 * (02 Atoms, 03 Molecules; the icon groups are the 37 Lucide names at 16 and at 20). Menu item
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
