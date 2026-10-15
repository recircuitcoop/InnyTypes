// Dark mode in the real app (plan 0022 §Q): colour comes from tokens only.
// (a) With the system in dark (prefers-color-scheme, no data-theme on the page), the window draws
//     the dark tokens: the page's own fill and words are the dark canvas and primary text, and
//     body text (primary and secondary) reads at 4.5:1 or more on every surface.
// (b) With data-theme="dark" on every route (Setup, Live, Configuration › Flows, Run history,
//     General, the canvas frame, the quit question) and in a pop-out, the computed
//     background-color and color of every [data-component] and everything inside one are never a
//     light-theme surface.
// The expected values are read from the generated tokens.css itself, not from the page.
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { APP, cleanUp, launchApp, quit, scratchDirectories } from "./app-harness";
import { FLOW, go, withProbeFlow } from "./probe-flow";

const TOKENS = fs.readFileSync(path.join(APP, "dist", "generated", "tokens.css"), "utf8");

/** The custom properties one block of tokens.css declares, from its header to its brace. */
function declarations(header: string): Map<string, string> {
  const at = TOKENS.indexOf(header);
  expect(at, header).toBeGreaterThanOrEqual(0);
  const block = TOKENS.slice(at, TOKENS.indexOf("}", at));
  return new Map(
    [...block.matchAll(/(--inny-[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name as string,
      (value as string).trim(),
    ]),
  );
}

/** `:root` holds the base palette and the light set; the dark set overrides it. */
const ROOT = declarations(":root {");
const DARK = declarations(':root[data-theme="dark"] {');

/** A token's colour in a theme, as the page computes an opaque one: `rgb(r, g, b)`. */
function colour(token: string, theme: "light" | "dark"): string {
  const value = (theme === "dark" ? DARK.get(token) : undefined) ?? ROOT.get(token);
  if (value === undefined) {
    throw new Error(`${token} is not in tokens.css`);
  }
  const reference = /^var\((--inny-[\w-]+)\)$/.exec(value);
  if (reference !== null) {
    return colour(reference[1] as string, theme);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex === undefined) {
    throw new Error(`${token} is ${value}, not an opaque colour`);
  }
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

const SURFACES = ["canvas", "panel", "sunken", "line"].map((name) => `--inny-surface-${name}`);
const LIGHT_SURFACES = SURFACES.map((token) => colour(token, "light"));

/** WCAG's contrast ratio of two `rgb(…)` colours. */
function contrast(one: string, other: string): number {
  const luminance = (rgb: string) => {
    const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((channel) => {
      const c = Number(channel) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  };
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Tokens as the page computes them where it stands (a probe element, removed again). */
const computed = (page: Page, tokens: readonly string[]) =>
  page.evaluate((names) => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const values = names.map((name) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    });
    probe.remove();
    return values;
  }, tokens);

test("(a) the system's dark scheme draws the dark tokens, body text at 4.5:1 or more", async () => {
  test.setTimeout(120_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    await expect(window.getByTestId("setup-step")).toBeVisible({ timeout: 20_000 });
    expect(await window.evaluate(() => document.documentElement.hasAttribute("data-theme"))).toBe(
      false,
    );
    const page = () =>
      window.evaluate(() => {
        const style = getComputedStyle(document.body);
        return [style.backgroundColor, style.color];
      });

    await window.emulateMedia({ colorScheme: "light" });
    expect(await page()).toEqual([
      colour("--inny-surface-canvas", "light"),
      colour("--inny-text-primary", "light"),
    ]);

    await window.emulateMedia({ colorScheme: "dark" });
    expect(await page()).toEqual([
      colour("--inny-surface-canvas", "dark"),
      colour("--inny-text-primary", "dark"),
    ]);
    const surfaces = await computed(window, SURFACES);
    expect(surfaces).toEqual(SURFACES.map((token) => colour(token, "dark")));
    const words = await computed(window, ["--inny-text-primary", "--inny-text-secondary"]);
    // Body text on every surface it is set on; the line colour is a border, not a surface.
    for (const [w, text] of words.entries()) {
      for (const [s, surface] of surfaces.slice(0, 3).entries()) {
        const ratio = contrast(text, surface);
        expect(ratio, `text ${String(w)} on ${SURFACES[s] ?? ""}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

/** Every [data-component] on the page and everything inside one, with what it draws in. */
const painted = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-component], [data-component] *")].map((element) => {
      const style = getComputedStyle(element);
      return {
        where: `${element.closest("[data-component]")?.getAttribute("data-component") ?? ""} ${
          element.getAttribute("data-testid") ?? element.tagName.toLowerCase()
        }`,
        fill: style.backgroundColor,
        ink: style.color,
      };
    }),
  );

/** The page in data-theme dark: every element that still draws a light surface. */
async function lightInDark(page: Page, route: string): Promise<string[]> {
  // Colours transition (quick): sampled once the transitions the switch began are done.
  await page.evaluate(async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        // A transition cancelled or replaced on the way rejects; it is over either way.
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const elements = await painted(page);
  expect(elements.length, `${route}: components sampled`).toBeGreaterThan(5);
  return elements
    .filter(({ fill, ink }) => LIGHT_SURFACES.includes(fill) || LIGHT_SURFACES.includes(ink))
    .map(({ where, fill, ink }) => `${route}: ${where} (${fill} on ${ink})`);
}

test("(b) data-theme dark on every route and a pop-out: no component keeps a light surface", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  const light: string[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    await expect(window.getByTestId("setup-step")).toBeVisible({ timeout: 20_000 });
    light.push(...(await lightInDark(window, "setup")));

    await withProbeFlow(window);
    light.push(...(await lightInDark(window, "live board")));
    for (const [hash, screen, ready] of [
      ["#/live", "live", "frame"],
      ["#/configuration/flows", "flows", "flow-more"],
      [`#/configuration/flows/${FLOW}/history`, "history", "history-row-more"],
      ["#/configuration/general", "general", "general"],
      [`#/configuration/flows/${FLOW}/canvas`, "canvas", "canvas-editor"],
    ] as const) {
      await go(window, hash, screen);
      await expect(window.getByTestId(ready)).toBeVisible({ timeout: 15_000 });
      light.push(...(await lightInDark(window, screen)));
    }

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("inny:quit-question", {});
    });
    await expect(window.getByTestId("quit-question")).toBeVisible({ timeout: 15_000 });
    light.push(...(await lightInDark(window, "quit question")));
    await window.getByTestId("quit-question").getByTestId("quit-cancel").click();

    // A pop-out: Preview a view…, the reorder widget picked in the native chooser.
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
    light.push(...(await lightInDark(popout, "pop-out")));

    expect(light, "elements still on a light surface in dark").toEqual([]);
    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
