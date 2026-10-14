// Live's board in the real app (plan 0022 §A, §C, §P; ux-writing "Live: the board"), driven
// through the real shell/main.ts bundle and the embedded Node-RED: one board per flow, kept in
// boards.json by the shell and reconciled with the flow's view nodes at read time, arranged in
// Edit layout with the mouse or with the keyboard alone.
//
// The flow is the viewts fixture (test/fixtures/viewts): an action view (a question place) and a
// snapshot view (a result place), deployed through Node-RED's own admin API, as the canvas does.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import {
  expect,
  test,
  type BrowserContext,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { VIEW_CSP } from "../../src/domain/views/popout";
import { STRINGS } from "../../src/ui/strings";
import { cleanUp, launchApp, quit, scratchDirectories, waitForRunning } from "./app-harness";

const FLOW = "liveflow1";
const FLOW_NAME = "Recordings to Anytype";

interface Slot {
  viewNodeId: string;
  kind: string;
  size: string;
  hidden: boolean;
  tabId: string;
  order: number;
}
interface Board {
  layout: { flowId: string; tabs: { id: string; name: string; order: number }[]; slots: Slot[] };
  fresh: string[];
}
type Inny = {
  inny: {
    app: {
      board(flowId: string): Promise<{ ok: boolean; value?: Board }>;
      completeSetup(): Promise<{ ok: boolean }>;
    };
  };
};

const OTHER_FLOW = "liveflow2";
const OTHER_FLOW_NAME = "Invoices from the mailbox";

/**
 * The flow: an inject feeding a question ("Name the speakers"), then a result ("Filed"), then,
 * from the first redeploy, a second question ("Approve sending") and, from the second, another
 * result ("Archived"): wired in that order, so the places come in that order. A second, empty
 * flow sits beside it, for the Flow picker.
 */
function flowNodes(stage: 0 | 1 | 2): object[] {
  const nodes: object[] = [
    { id: FLOW, type: "tab", label: FLOW_NAME },
    {
      id: "go",
      type: "inject",
      z: FLOW,
      props: [{ p: "payload" }],
      payload: "{}",
      payloadType: "json",
      repeat: "",
      once: false,
      wires: [["speakers"]],
    },
    {
      id: "speakers",
      type: "inny-viewts-ask",
      z: FLOW,
      name: "Name the speakers",
      wires: [["filed"], []],
    },
    {
      id: "filed",
      type: "inny-viewts-record",
      z: FLOW,
      name: "Filed",
      wires: [stage >= 1 ? ["approve"] : []],
    },
    ...(stage >= 1
      ? [
          {
            id: "approve",
            type: "inny-viewts-ask",
            z: FLOW,
            name: "Approve sending",
            wires: [stage >= 2 ? ["archived"] : [], []],
          },
        ]
      : []),
    ...(stage >= 2
      ? [{ id: "archived", type: "inny-viewts-record", z: FLOW, name: "Archived", wires: [[]] }]
      : []),
  ];
  return [
    ...nodes.map((node, n) => (n === 0 ? node : { x: 120, y: 40 * n, ...node })),
    { id: OTHER_FLOW, type: "tab", label: OTHER_FLOW_NAME },
  ];
}

function deploy(port: number, nodes: object[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(nodes);
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/red/flows",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });
}

/** The board as the shell answers it now. */
async function boardOf(window: Page): Promise<Board> {
  const answer = await window.evaluate(
    (flowId) => (window as unknown as Inny).inny.app.board(flowId),
    FLOW,
  );
  expect(answer.ok).toBe(true);
  return answer.value as Board;
}

/** Where a place sits: `tabId:order size hidden`, for one-line comparisons. */
const placeOf = async (window: Page, viewNodeId: string) => {
  const slot = (await boardOf(window)).layout.slots.find((each) => each.viewNodeId === viewNodeId);
  return slot === undefined
    ? "none"
    : `${slot.tabId}:${String(slot.order)} ${slot.size}${slot.hidden ? " hidden" : ""}`;
};

/** Launch on a scratch home, close Setup, deploy the flow, and open its board. */
// ── a trace of every app a test launched, kept only when the test fails ──────────────────────
// Playwright's `use.trace` does not reach an Electron app, so each test traces its apps itself
// and writes trace-<n>.zip into its own folder under test-results/ (git-ignored) when it fails.
const traced: BrowserContext[] = [];

test.beforeEach(() => {
  traced.length = 0;
});

async function trace(app: ElectronApplication): Promise<void> {
  const context = app.context();
  await context.tracing.start({ screenshots: true, snapshots: true });
  traced.push(context);
}

/** Write the traces of a failed test; an app that already quit has none to give. */
async function keepTraces(): Promise<void> {
  for (const [index, context] of traced.entries()) {
    await context.tracing
      .stop({ path: test.info().outputPath(`trace-${String(index)}.zip`) })
      .catch(() => undefined);
  }
  traced.length = 0;
}

async function launchOnBoard(apps: ElectronApplication[], env: Record<string, string>) {
  const running = await launchApp(env);
  await trace(running.app);
  apps.push(running.app);
  const { window } = running;
  const port = Number((await waitForRunning(window, "runtime")).port);
  expect(
    (await window.evaluate(() => (window as unknown as Inny).inny.app.completeSetup())).ok,
  ).toBe(true);
  expect(await deploy(port, flowNodes(0))).toBe(204);
  await openBoard(window);
  return { ...running, port };
}

async function openBoard(window: Page): Promise<void> {
  await window.evaluate((flowId) => {
    globalThis.location.hash = `#/live/${flowId}`;
  }, FLOW);
  await expect(window.getByTestId("live-board")).toHaveAttribute("data-flow", FLOW, {
    timeout: 30_000,
  });
}

const board = (window: Page) => window.getByTestId("live-board");

/** What boards.json holds as not yet named for the flow, read from the file itself. */
const storedFresh = (userData: string): unknown =>
  (
    JSON.parse(fs.readFileSync(path.join(userData, "boards.json"), "utf8")) as Record<
      string,
      { fresh: unknown }
    >
  )[FLOW]?.fresh;

/** Switch the board with the Flow picker. */
async function pickFlow(window: Page, name: string): Promise<void> {
  await board(window).getByRole("combobox", { name: STRINGS["live.flowPicker"] }).click();
  await window.getByRole("option", { name }).click();
}
const arrange = (window: Page, place: string) =>
  board(window).getByRole("button", { name: `${STRINGS["board.arrange"]}: ${place}` });
const places = (window: Page) => board(window).locator('[data-component="slot"]');
const bar = (window: Page) => board(window).locator('[data-component="edit-layout-bar"]');

/** Open a place's ⋯ menu with the mouse and choose `item` (a menu item or a size). */
async function choose(window: Page, place: string, item: string): Promise<void> {
  await arrange(window, place).click();
  await window
    .getByRole("menuitem", { name: item })
    .or(window.getByRole("menuitemradio", { name: item }))
    .first()
    .click();
}

test("edit layout survives a redeploy", async () => {
  test.setTimeout(240_000);
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port } = await launchOnBoard(apps, env);

    // ── a new board: one tab, the run cards' place and one place per view node ─────────────
    await expect(board(window).getByRole("tab")).toHaveText([STRINGS["board.firstTab"]]);
    await expect(places(window)).toHaveCount(3);
    expect(await placeOf(window, "runs")).toBe("tab-1:0 L");
    expect(await placeOf(window, "speakers")).toBe("tab-1:1 M");
    expect(await placeOf(window, "filed")).toBe("tab-1:2 M");
    // Kept by the shell at once, in boards.json beside the other shell state.
    expect(fs.existsSync(path.join(userData, "boards.json"))).toBe(true);

    // ── Edit layout: the bar, Add tab (named "New tab", its name selected for typing) ───────
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await expect(bar(window)).toContainText(
      `Editing the layout of ${FLOW_NAME}. Drag to move, drag a corner to resize.`,
    );
    await expect(bar(window).locator("em")).toHaveText(FLOW_NAME);
    // Nothing hidden yet: no Hidden (n). Nothing new: no "New on the board".
    await expect(bar(window).getByRole("button", { name: /^Hidden/ })).toHaveCount(0);
    await expect(window.getByTestId("board-new-places")).toHaveCount(0);
    await bar(window).getByRole("button", { name: STRINGS["board.addTab"] }).click();
    await expect(board(window).getByRole("tab")).toHaveText([
      STRINGS["board.firstTab"],
      STRINGS["board.newTab"],
    ]);
    await expect(board(window).getByRole("tab", { name: STRINGS["board.newTab"] })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const nameField = board(window).getByRole("textbox", { name: STRINGS["board.tabName"] });
    await expect(nameField).toBeFocused({ timeout: 15_000 });
    expect(
      await nameField.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([0, STRINGS["board.newTab"].length]);
    await window.keyboard.type("Customers");
    await expect(board(window).getByRole("tab", { name: "Customers" })).toBeVisible({
      timeout: 15_000,
    });
    // The new tab is empty, and says so.
    await expect(board(window)).toContainText(STRINGS["live.tabEmpty"]);

    // ── arrange: a place to the new tab, one resized, one hidden (Hidden (1) lists it) ──────
    await board(window).getByRole("tab", { name: STRINGS["board.firstTab"] }).click();
    await arrange(window, "Name the speakers").click();
    await window.getByRole("menuitem", { name: STRINGS["board.moveToTab"] }).click();
    await window.getByRole("menuitem", { name: "Customers" }).click();
    await expect.poll(() => placeOf(window, "speakers")).toBe("tab-2:0 M");
    await choose(window, "Filed", "Size L");
    await expect.poll(() => placeOf(window, "filed")).toBe("tab-1:1 L");
    await choose(window, STRINGS["board.place.runs"], STRINGS["board.hide"]);
    await expect.poll(() => placeOf(window, "runs")).toBe("tab-1:0 L hidden");
    const hiddenButton = bar(window).getByRole("button", { name: "Hidden (1)" });
    await expect(hiddenButton).toBeVisible();
    // In Edit layout a hidden place is still drawn, inert, with its pill.
    await expect(
      board(window).locator('[data-component="slot"][data-variant*="hidden=yes"]'),
    ).toHaveCount(1);
    await hiddenButton.click();
    await expect(
      window.getByRole("menuitem", { name: `${STRINGS["board.place.runs"]} · Show` }),
    ).toBeVisible();
    await window.keyboard.press("Escape");

    // ── Remove tab on a tab that holds a place asks first; Cancel keeps it ──────────────────
    await board(window).getByRole("tab", { name: "Customers" }).click();
    await board(window).getByRole("button", { name: STRINGS["board.removeTab"] }).click();
    const dialog = window.getByRole("dialog", { name: "Remove the tab Customers?" });
    await expect(dialog).toContainText("Remove the tab Customers?");
    await expect(dialog).toContainText(STRINGS["board.removeTab.body"]);
    await dialog.getByRole("button", { name: STRINGS["dialog.cancel"] }).click();
    await expect(dialog).toBeHidden();
    await expect(board(window).getByRole("tab")).toHaveCount(2);

    await bar(window).getByRole("button", { name: STRINGS["board.done"] }).click();
    await expect(bar(window)).toHaveCount(0);
    // Viewing: the hidden place is not drawn.
    await board(window).getByRole("tab", { name: STRINGS["board.firstTab"] }).click();
    await expect(places(window)).toHaveCount(1);
    const arranged = (await boardOf(window)).layout;

    // ── a redeploy that adds a view node keeps everything arranged ───────────────────────────
    expect(await deploy(port, flowNodes(1))).toBe(204);
    await expect
      .poll(async () => (await boardOf(window)).layout.slots.length, { timeout: 30_000 })
      .toBe(4);
    const after = await boardOf(window);
    expect(after.layout.tabs).toEqual(arranged.tabs);
    expect(after.layout.slots.slice(0, 3)).toEqual(arranged.slots);
    // The new place goes to the end of the last tab, at the size it suggests (M).
    expect(await placeOf(window, "approve")).toBe("tab-2:1 M");
    expect(after.fresh).toEqual(["approve"]);

    // The board on screen has the new place too: the last tab now holds two places.
    await board(window).getByRole("tab", { name: "Customers" }).click();
    await expect(places(window)).toHaveCount(2);
    // "New on the board" is said once, in the Edit-layout bar: entering Edit layout forgets it,
    // however Edit layout is left. Here, by switching flow in the picker and back, without Done.
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await expect(window.getByTestId("board-new-places")).toHaveText(
      "New on the board: Approve sending.",
    );
    await expect(window.getByTestId("board-new-places").locator("em")).toHaveText(
      "Approve sending",
    );
    await expect.poll(async () => (await boardOf(window)).fresh).toEqual([]);
    expect(storedFresh(userData)).toEqual([]);
    await pickFlow(window, OTHER_FLOW_NAME);
    await expect(board(window)).toHaveAttribute("data-flow", OTHER_FLOW);
    await pickFlow(window, FLOW_NAME);
    await expect(board(window)).toHaveAttribute("data-flow", FLOW);
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await expect(bar(window)).toBeVisible();
    await expect(window.getByTestId("board-new-places")).toHaveCount(0);
    await bar(window).getByRole("button", { name: STRINGS["board.done"] }).click();

    // A second redeploy adds a place: said once again, then forgotten when Edit layout is left
    // by going to another screen and back.
    expect(await deploy(port, flowNodes(2))).toBe(204);
    await expect
      .poll(async () => (await boardOf(window)).fresh, { timeout: 30_000 })
      .toEqual(["archived"]);
    // The board on screen has it too: the last tab now holds three places.
    await board(window).getByRole("tab", { name: "Customers" }).click();
    await expect(places(window)).toHaveCount(3);
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await expect(window.getByTestId("board-new-places")).toHaveText("New on the board: Archived.");
    await expect.poll(async () => (await boardOf(window)).fresh).toEqual([]);
    await window.getByRole("button", { name: STRINGS["nav.configuration"] }).click();
    await expect(window.getByTestId("frame")).toHaveAttribute("data-route", "flows");
    await openBoard(window);
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await expect(bar(window)).toBeVisible();
    await expect(window.getByTestId("board-new-places")).toHaveCount(0);
    expect(storedFresh(userData)).toEqual([]);
    await bar(window).getByRole("button", { name: STRINGS["board.done"] }).click();

    // ── and the next launch reads the same board from boards.json ───────────────────────────
    const kept = await boardOf(window);
    await quit(app);
    const again = await launchApp(env);
    await trace(again.app);
    apps.push(again.app);
    await waitForRunning(again.window, "runtime");
    await openBoard(again.window);
    await expect.poll(async () => (await boardOf(again.window)).layout).toEqual(kept.layout);
    expect((await boardOf(again.window)).fresh).toEqual([]);
    await expect(board(again.window).getByRole("tab")).toHaveText([
      STRINGS["board.firstTab"],
      "Customers",
    ]);

    // ── Remove tab: what was on it moves to the first tab; the last tab stays ───────────────
    const w = again.window;
    await board(w).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await board(w).getByRole("tab", { name: "Customers" }).click();
    await board(w).getByRole("button", { name: STRINGS["board.removeTab"] }).click();
    await w
      .getByRole("dialog", { name: "Remove the tab Customers?" })
      .getByRole("button", { name: STRINGS["board.removeTab"] })
      .click();
    await expect(board(w).getByRole("tab")).toHaveText([STRINGS["board.firstTab"]]);
    expect(await placeOf(w, "speakers")).toBe("tab-1:2 M");
    expect(await placeOf(w, "approve")).toBe("tab-1:3 M");
    expect(await placeOf(w, "archived")).toBe("tab-1:4 M");
    await board(w).getByRole("button", { name: STRINGS["board.removeTab"] }).click();
    await expect(board(w).getByRole("status")).toHaveText(STRINGS["board.lastTab"]);
    await expect(board(w).getByRole("tab")).toHaveCount(1);
    await quit(again.app);
  } catch (error) {
    await keepTraces();
    throw error;
  } finally {
    await cleanUp(apps, scratch);
  }
});

/** Press Tab (or `key`) until `target` has the focus: the keyboard's own way there. */
async function tabTo(window: Page, target: Locator, key = "Tab"): Promise<void> {
  for (let presses = 0; presses < 120; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await window.keyboard.press(key);
  }
  throw new Error("the keyboard never reached the control");
}

/**
 * In an open menu, move with the arrow keys to `label` and press Enter (or `key`). A submenu's
 * trigger stays highlighted while its submenu is open, so the item is looked for by its words.
 */
async function pick(window: Page, label: string, key = "Enter"): Promise<void> {
  for (let presses = 0; presses < 20; presses += 1) {
    const texts = await window
      .locator("[role^='menuitem'][data-highlighted]")
      .evaluateAll((items) => items.map((item) => (item as HTMLElement).innerText.trim()));
    if (texts.includes(label)) {
      // The keys go to the menu that has the focus: wait until it is the item's own menu (a
      // submenu, drawn inside its parent menu, takes the focus a frame after it opens).
      await expect
        .poll(() =>
          window.evaluate(
            (words) =>
              [...document.querySelectorAll("[role^='menuitem'][data-highlighted]")].some(
                (item) =>
                  (item as HTMLElement).innerText.trim() === words &&
                  item.closest("[role='menu']") === document.activeElement,
              ),
            label,
          ),
        )
        .toBe(true);
      await window.keyboard.press(key);
      return;
    }
    await window.keyboard.press("ArrowDown");
  }
  throw new Error(`no menu item ${label}`);
}

test("keyboard move and resize", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchOnBoard(apps, env);
    await expect(places(window)).toHaveCount(3);
    expect(await placeOf(window, "speakers")).toBe("tab-1:1 M");

    // Edit layout and Add tab, from the keyboard.
    await tabTo(window, board(window).getByRole("button", { name: STRINGS["board.editLayout"] }));
    await window.keyboard.press("Enter");
    await tabTo(window, bar(window).getByRole("button", { name: STRINGS["board.addTab"] }));
    await window.keyboard.press("Enter");
    await expect(board(window).getByRole("tab")).toHaveCount(2);
    // The new tab's name field has the cursor, its name selected: typing replaces it.
    await expect(
      board(window).getByRole("textbox", { name: STRINGS["board.tabName"] }),
    ).toBeFocused({ timeout: 15_000 });
    await window.keyboard.type("Later");
    await expect(board(window).getByRole("tab", { name: "Later" })).toBeVisible({
      timeout: 15_000,
    });
    // Back from the name field to the tabs, the way Shift+Tab goes.
    await tabTo(window, board(window).getByRole("tab", { name: "Later" }), "Shift+Tab");
    await window.keyboard.press("ArrowLeft");
    await expect(
      board(window).getByRole("tab", { name: STRINGS["board.firstTab"] }),
    ).toHaveAttribute("aria-selected", "true");

    // Move later: the question place goes after the result place.
    await tabTo(window, arrange(window, "Name the speakers"));
    await window.keyboard.press("Enter");
    await pick(window, STRINGS["board.moveLater"]);
    await expect.poll(() => placeOf(window, "speakers")).toBe("tab-1:2 M");
    expect(await placeOf(window, "filed")).toBe("tab-1:1 M");
    await expect(places(window).nth(2).getByRole("button")).toHaveAccessibleName(
      `${STRINGS["board.arrange"]}: Name the speakers`,
    );

    // Move earlier: and back.
    await tabTo(window, arrange(window, "Name the speakers"));
    await window.keyboard.press("Enter");
    await pick(window, STRINGS["board.moveEarlier"]);
    await expect.poll(() => placeOf(window, "speakers")).toBe("tab-1:1 M");

    // Size S, then L: the place spans 4, then 12 of the 12 columns.
    await tabTo(window, arrange(window, "Filed"));
    await window.keyboard.press("Enter");
    await pick(window, "Size S");
    await expect.poll(() => placeOf(window, "filed")).toBe("tab-1:2 S");
    await expect(places(window).nth(2)).toHaveAttribute("data-variant", /size=s/);
    await expect(places(window).nth(2)).toHaveClass(/col-span-4/);
    await tabTo(window, arrange(window, "Filed"));
    await window.keyboard.press("Enter");
    await pick(window, "Size L");
    await expect.poll(() => placeOf(window, "filed")).toBe("tab-1:2 L");
    await expect(places(window).nth(2)).toHaveAttribute("data-variant", /size=l/);
    await expect(places(window).nth(2)).toHaveClass(/col-span-12/);

    // Move to tab ›: the submenu opens with the right arrow.
    await tabTo(window, arrange(window, "Filed"));
    await window.keyboard.press("Enter");
    await pick(window, STRINGS["board.moveToTab"], "ArrowRight");
    await pick(window, "Later");
    await expect.poll(() => placeOf(window, "filed")).toBe("tab-2:0 L");
    await expect(places(window)).toHaveCount(2);

    // Hide, then Show again from Hidden (1), all from the keyboard.
    await tabTo(window, arrange(window, "Name the speakers"));
    await window.keyboard.press("Enter");
    await pick(window, STRINGS["board.hide"]);
    await expect.poll(() => placeOf(window, "speakers")).toBe("tab-1:1 M hidden");
    await tabTo(window, bar(window).getByRole("button", { name: "Hidden (1)" }));
    await window.keyboard.press("Enter");
    await pick(window, `Name the speakers · ${STRINGS["board.show"]}`);
    await expect.poll(() => placeOf(window, "speakers")).toBe("tab-1:1 M");
    await expect(bar(window).getByRole("button", { name: /^Hidden/ })).toHaveCount(0);

    await tabTo(window, bar(window).getByRole("button", { name: STRINGS["board.done"] }));
    await window.keyboard.press("Enter");
    await expect(bar(window)).toHaveCount(0);
    await quit(app);
  } catch (error) {
    await keepTraces();
    throw error;
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("the new tab's name takes the cursor once, and a later board change never moves it", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchOnBoard(apps, env);
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await choose(window, "Filed", STRINGS["board.hide"]);
    const hiddenButton = bar(window).getByRole("button", { name: "Hidden (1)" });
    await expect(hiddenButton).toBeVisible();

    // Add tab: the cursor is in the new tab's name, once.
    await bar(window).getByRole("button", { name: STRINGS["board.addTab"] }).click();
    const nameField = board(window).getByRole("textbox", { name: STRINGS["board.tabName"] });
    await expect(nameField).toBeFocused({ timeout: 15_000 });

    // The person moves on with Tab, then shows the hidden place: the cursor stays theirs.
    await window.keyboard.press("Tab");
    await expect(nameField).not.toBeFocused();
    const theirs = await window.evaluate(() => document.activeElement?.outerHTML ?? "");
    await hiddenButton.click();
    await window.getByRole("menuitem", { name: `Filed · ${STRINGS["board.show"]}` }).click();
    await expect.poll(() => placeOf(window, "filed")).toBe("tab-1:2 M");
    await expect(bar(window).getByRole("button", { name: /^Hidden/ })).toHaveCount(0);
    await expect(nameField).not.toBeFocused();
    expect(await window.evaluate(() => document.activeElement?.id)).not.toBe("board-tab-name");
    expect(theirs).not.toContain("board-tab-name");

    // With the focus nowhere, a board change pushed from elsewhere leaves it nowhere.
    await window.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await window.evaluate(
      (flowId) =>
        (
          window as unknown as {
            inny: { app: { saveBoard(f: string, c: object): Promise<unknown> } };
          }
        ).inny.app.saveBoard(flowId, { kind: "size", viewNodeId: "filed", size: "S" }),
      FLOW,
    );
    await expect.poll(() => placeOf(window, "filed")).toBe("tab-1:2 S");
    // The new tab draws none of it, so nothing on screen says the push arrived: give it time.
    await window.waitForTimeout(1_500);
    expect(await window.evaluate(() => document.activeElement?.id ?? "")).not.toBe(
      "board-tab-name",
    );
    // The name, never typed into, is still the one Add tab gave.
    await expect(board(window).getByRole("tab", { name: STRINGS["board.newTab"] })).toBeVisible();
    await quit(app);
  } catch (error) {
    await keepTraces();
    throw error;
  } finally {
    await cleanUp(apps, scratch);
  }
});

/** Make the shell refuse one channel's calls, as a restarting runtime does, or answer again. */
async function refuseChannel(app: ElectronApplication, channel: string, refuse: boolean) {
  await app.evaluate(
    ({ ipcMain }, [name, on]) => {
      // Electron keeps invoke handlers in this map; the original is put back after.
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })
        ._invokeHandlers;
      const kept = globalThis as unknown as { keptHandlers?: Map<string, unknown> };
      kept.keptHandlers ??= new Map();
      if (on) {
        kept.keptHandlers.set(name, handlers.get(name));
        ipcMain.removeHandler(name);
        ipcMain.handle(name, () => ({
          ok: false,
          refused: { reason: "restarting", sentence: "refused.restarting" },
        }));
        return;
      }
      ipcMain.removeHandler(name);
      handlers.set(name, kept.keptHandlers.get(name));
    },
    [channel, refuse] as const,
  );
}

/** Tell the page a channel's read changed, so its store reads again. */
async function push(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [name, flowId]) => {
      for (const each of BrowserWindow.getAllWindows()) {
        each.webContents.send(name, { flowId });
      }
    },
    [channel, FLOW] as const,
  );
}

test("a refused read keeps the board and Edit layout, with the refusal above them", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchOnBoard(apps, env);
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await expect(bar(window)).toBeVisible();
    await expect(places(window)).toHaveCount(3);
    const refusedLine = window.getByTestId("live-refused");

    // The board's read is refused: the bar and the places stay, the refusal is said above.
    for (const [call, changed] of [
      ["inny:board-call", "inny:board-changed"],
      ["inny:flow-call", "inny:flows-changed"],
    ] as const) {
      await refuseChannel(app, call, true);
      await push(app, changed);
      await expect(refusedLine, call).toHaveText(STRINGS["refused.restarting"]);
      await expect(bar(window), call).toBeVisible();
      await expect(places(window), call).toHaveCount(3);
      await expect(arrange(window, "Filed"), call).toBeVisible();

      // The next good read: the refusal goes, and Edit layout is still open.
      await refuseChannel(app, call, false);
      await push(app, changed);
      await expect(refusedLine, call).toHaveCount(0);
      await expect(bar(window), call).toBeVisible();
      await expect(places(window), call).toHaveCount(3);
    }
    await bar(window).getByRole("button", { name: STRINGS["board.done"] }).click();
    await expect(bar(window)).toHaveCount(0);
    await quit(app);
  } catch (error) {
    await keepTraces();
    throw error;
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("a refused move never gives the focus back later", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchOnBoard(apps, env);
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await expect(bar(window)).toBeVisible();

    // Move later while the shell refuses the board's calls: nothing moves, and it says why.
    await refuseChannel(app, "inny:board-call", true);
    await choose(window, "Name the speakers", STRINGS["board.moveLater"]);
    await expect(
      board(window).getByRole("status").filter({ hasText: STRINGS["refused.restarting"] }),
    ).toBeVisible();
    await refuseChannel(app, "inny:board-call", false);
    expect(await placeOf(window, "speakers")).toBe("tab-1:1 M");

    // The person leaves the focus nowhere; an unrelated change arrives and is drawn.
    await window.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await window.evaluate(
      (flowId) =>
        (
          window as unknown as {
            inny: { app: { saveBoard(f: string, c: object): Promise<unknown> } };
          }
        ).inny.app.saveBoard(flowId, { kind: "size", viewNodeId: "filed", size: "S" }),
      FLOW,
    );
    await push(app, "inny:board-changed");
    await expect(board(window).locator('[data-place="filed"]')).toHaveAttribute(
      "data-variant",
      /size=s/,
    );
    // The refused move's ⋯ button did not take the focus back: it is still nowhere.
    expect(await window.evaluate(() => document.activeElement === document.body)).toBe(true);
    await quit(app);
  } catch (error) {
    await keepTraces();
    throw error;
  } finally {
    await cleanUp(apps, scratch);
  }
});

// ── run cards, questions and notifications (WI-0022-13) ──────────────────────────────────────
// The flow is the livekit fixture (test/fixtures/livekit): a recorder source, Copy and
// Transcribe steps the test paces with gate files, a Node-RED delay between them (the moment the
// recorder is safe to unplug), then, when asked for, the viewts question and result. Every
// notification goes through the shell's own notifier and delivery; the gate's hidden runs show
// none, and the e2e hooks read them and press their buttons through the very handlers a press
// on the desktop runs.

const RUNS_FLOW = "runsflow";
const RUNS_FLOW_NAME = "Recordings to Anytype";

function runsFlow(folder: string, question: boolean): object[] {
  const at = (n: number) => ({ x: 120, y: 40 * n });
  return [
    { id: RUNS_FLOW, type: "tab", label: RUNS_FLOW_NAME },
    {
      id: "rec",
      type: "inny-livekit-recorder",
      z: RUNS_FLOW,
      name: "Recorder",
      folder,
      ...at(1),
      wires: [["copy"]],
    },
    {
      id: "copy",
      type: "inny-livekit-copy",
      z: RUNS_FLOW,
      name: "Copy",
      folder,
      ...at(2),
      wires: [["hold"]],
    },
    {
      id: "hold",
      type: "delay",
      z: RUNS_FLOW,
      pauseType: "delay",
      timeout: "1500",
      timeoutUnits: "milliseconds",
      rate: "1",
      nbRateUnits: "1",
      rateUnits: "second",
      randomFirst: "1",
      randomLast: "5",
      randomUnits: "seconds",
      drop: false,
      allowrate: false,
      outputs: 1,
      ...at(3),
      wires: [["work"]],
    },
    {
      id: "work",
      type: "inny-livekit-work",
      z: RUNS_FLOW,
      name: "Transcribe",
      folder,
      ...at(4),
      wires: [question ? ["speakers"] : []],
    },
    ...(question
      ? [
          {
            id: "speakers",
            type: "inny-viewts-ask",
            z: RUNS_FLOW,
            name: "Name the speakers",
            ...at(5),
            wires: [["filed"], []],
          },
          {
            id: "filed",
            type: "inny-viewts-record",
            z: RUNS_FLOW,
            name: "Filed",
            ...at(6),
            wires: [[]],
          },
        ]
      : []),
  ];
}

interface Delivered {
  title: string;
  body: string;
  flowId?: string;
  actions?: { label: string; kind: string; flowId: string; runId: string; viewId?: string }[];
}
interface Hooks {
  innytypesE2E: {
    notices: { list(): Delivered[]; press(index: number, button: number): boolean };
    badge(): number;
    popouts(): string[];
  };
}
const delivered = (app: ElectronApplication): Promise<Delivered[]> =>
  app.evaluate(() => (globalThis as unknown as Hooks).innytypesE2E.notices.list());
const pressNotice = (app: ElectronApplication, index: number, button: number) =>
  app.evaluate(
    (_electron, [i, b]) => (globalThis as unknown as Hooks).innytypesE2E.notices.press(i, b),
    [index, button] as const,
  );
const dockBadge = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => (globalThis as unknown as Hooks).innytypesE2E.badge());
const openPopouts = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as Hooks).innytypesE2E.popouts());
const popoutPages = (app: ElectronApplication): Page[] =>
  app.windows().filter((page) => page.url().startsWith("inny-view://"));

/** Launch with the e2e hooks, deploy the livekit flow watching `folder`, open its board. */
async function launchOnRuns(
  apps: ElectronApplication[],
  env: Record<string, string>,
  folder: string,
  question: boolean,
) {
  fs.mkdirSync(folder, { recursive: true });
  const running = await launchApp({ ...env, INNYTYPES_E2E_HOOKS: "1" });
  await trace(running.app);
  apps.push(running.app);
  const { window, output } = running;
  const port = Number((await waitForRunning(window, "runtime")).port);
  expect(
    (await window.evaluate(() => (window as unknown as Inny).inny.app.completeSetup())).ok,
  ).toBe(true);
  expect(await deploy(port, runsFlow(folder, question))).toBe(204);
  await expect
    .poll(() => output.join(""), { timeout: 30_000 })
    .toMatch(/\[inny-livekit-recorder rec\] ready/);
  await window.evaluate((flowId) => {
    globalThis.location.hash = `#/live/${flowId}`;
  }, RUNS_FLOW);
  await expect(board(window)).toHaveAttribute("data-flow", RUNS_FLOW, { timeout: 30_000 });
  return { ...running, port };
}

const cards = (window: Page) => board(window).getByTestId("run-card");
const cardOf = (window: Page, title: string) =>
  cards(window).filter({ has: window.getByRole("heading", { name: `${title} · 48 min` }) });
/** A gate file the livekit steps wait for. */
const gate = (folder: string, name: string) => {
  fs.writeFileSync(path.join(folder, name), "");
};

test("three runs, three cards", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const folder = path.join(scratch, "recorder");
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchOnRuns(apps, env, folder, true);
    await expect(board(window)).toContainText(STRINGS["live.idle"]);
    // Every step line a card ever draws, so a moment shorter than a poll is still seen.
    await window.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as { seenLines: Set<string> }).seenLines = seen;
      const look = () => {
        for (const line of document.querySelectorAll('[data-component="run-card"] > p')) {
          seen.add(line.textContent ?? "");
        }
      };
      new MutationObserver(look).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    const seenLines = () =>
      window.evaluate(() => [...(window as unknown as { seenLines: Set<string> }).seenLines]);

    // ── one recording: one card, Copying, then Safe to unplug on phase copied ──────────────
    gate(folder, "client-call.wav");
    await expect(cards(window)).toHaveCount(1, { timeout: 15_000 });
    const call = cardOf(window, "client-call");
    await expect(call).toHaveAttribute("data-state", "copying");
    await expect(call).toContainText("Copying from BOYA…");
    // Its start was told, once, with no estimate yet (no good run to take one from).
    await expect
      .poll(async () => (await delivered(app)).map((n) => `${n.title}: ${n.body}`))
      .toContain("client-call: Processing client-call.");
    gate(folder, "client-call.copied");
    await expect.poll(seenLines, { timeout: 10_000 }).toContain(STRINGS["card.step.safeToUnplug"]);
    // Then the next step, by its name on the canvas, with its words and its count.
    await expect(call).toContainText("Transcribe in Renaissance (1 of 3).", { timeout: 10_000 });
    await expect(call).toHaveAttribute("data-state", "running");

    // ── two more: three cards, one per recording, never merged, newest first ───────────────
    gate(folder, "standup.wav");
    gate(folder, "interview.wav");
    await expect(cards(window)).toHaveCount(3, { timeout: 15_000 });
    await expect(cards(window).getByRole("heading")).toHaveText([
      "interview · 48 min",
      "standup · 48 min",
      "client-call · 48 min",
    ]);
    const runIds = await cards(window).evaluateAll((all) =>
      all.map((card) => card.getAttribute("data-run")),
    );
    expect(new Set(runIds).size).toBe(3);

    // ── waiting, with Answer; failed, with the step's own sentence ─────────────────────────
    gate(folder, "client-call.worked");
    await expect(call).toHaveAttribute("data-state", "waiting", { timeout: 15_000 });
    await expect(call).toContainText("Waiting for you: Answer the TypeScript view");
    gate(folder, "standup.copied");
    gate(folder, "standup.fail");
    const standup = cardOf(window, "standup");
    await expect(standup).toHaveAttribute("data-state", "failed", { timeout: 15_000 });
    await expect(standup).toContainText("Failed at Transcribe: Mistral refused the key.");

    // ── Answer opens the question in its pop-out: the Question pop-out, with the tokens ────
    await call.getByRole("button", { name: STRINGS["card.answer"] }).click();
    await expect.poll(() => popoutPages(app).length, { timeout: 15_000 }).toBe(1);
    const popout = popoutPages(app)[0] as Page;
    const question = popout.locator('[data-component="question-popout"]');
    await expect(question).toBeVisible();
    await expect(question.getByTestId("view-title")).toHaveText("Answer the TypeScript view");
    await expect(question.getByTestId("view-continue")).toHaveText(STRINGS["question.continue"]);
    await expect(question.getByTestId("view-later")).toHaveText(STRINGS["question.later"]);
    await expect(question.getByTestId("view-dismiss")).toHaveText(STRINGS["question.skip"]);
    // Drawn with the tokens: the panel is the token's colour, not the browser's default.
    const panel = await question.evaluate((element) => ({
      token: getComputedStyle(document.documentElement).getPropertyValue("--inny-surface-panel"),
      fill: getComputedStyle(element).backgroundColor,
    }));
    expect(panel.token.trim()).not.toBe("");
    expect(panel.fill).not.toBe("rgba(0, 0, 0, 0)");
    await popout.getByTestId("field-answer").fill("Ada");
    await question.getByTestId("view-continue").click();
    await expect(call).toHaveAttribute("data-state", "done", { timeout: 15_000 });
    await expect(call).toContainText("Moved client-call to Archive");

    // ── the three cards, each in its own state; ends told with their buttons ───────────────
    await expect(cards(window)).toHaveCount(3);
    expect(
      await cards(window).evaluateAll((all) => all.map((card) => card.getAttribute("data-state"))),
    ).toEqual(["copying", "failed", "done"]);
    const told = (await delivered(app)).map((n) => `${n.title}: ${n.body}`);
    expect(told).toContain("standup: Couldn't finish standup. Transcribe: Mistral refused the key");
    expect(told).toContain("client-call: Done: Moved client-call to Archive.");
    await quit(app);
  } catch (error) {
    await keepTraces();
    throw error;
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("a hidden question still notifies and counts", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const folder = path.join(scratch, "recorder");
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchOnRuns(apps, env, folder, true);

    // ── the question's place hidden in Edit layout ─────────────────────────────────────────
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await choose(window, "Name the speakers", STRINGS["board.hide"]);
    await bar(window).getByRole("button", { name: STRINGS["board.done"] }).click();
    await expect(board(window).locator('[data-place="speakers"]')).toHaveCount(0);

    // ── two recordings, both waiting for the person ───────────────────────────────────────
    for (const name of ["first", "second"]) {
      gate(folder, `${name}.wav`);
      await expect(cardOf(window, name)).toHaveCount(1, { timeout: 15_000 });
      gate(folder, `${name}.copied`);
      gate(folder, `${name}.worked`);
      await expect(cardOf(window, name)).toHaveAttribute("data-state", "waiting", {
        timeout: 15_000,
      });
    }
    // Still hidden: the questions are on no place of the board.
    await expect(board(window).getByTestId("question-inline")).toHaveCount(0);

    // ── counted: the dock badge and Live's badge, from run records ────────────────────────
    await expect.poll(() => dockBadge(app), { timeout: 10_000 }).toBe(2);
    await expect(window.locator('[data-component="badge"]')).toHaveText("2");

    // ── notified: one notification each, its buttons bound to its own run ─────────────────
    const runOf = async (name: string) => cardOf(window, name).getAttribute("data-run");
    const questions = async () =>
      (await delivered(app))
        .map((notice, index) => ({ notice, index }))
        .filter(({ notice }) => notice.title === "InnyTypes is waiting for you");
    await expect.poll(async () => (await questions()).length, { timeout: 10_000 }).toBe(2);
    const asked = await questions();
    const bindings = asked.map(({ notice }) => notice.actions?.map((a) => `${a.label} ${a.runId}`));
    const first = await runOf("first");
    const second = await runOf("second");
    expect(bindings).toEqual([
      [`Answer ${String(first)}`, `Later ${String(first)}`],
      [`Answer ${String(second)}`, `Later ${String(second)}`],
    ]);
    for (const { notice } of asked) {
      expect(notice.flowId).toBe(RUNS_FLOW);
      expect(notice.actions?.[0]?.viewId).toBe(notice.actions?.[1]?.viewId);
    }
    const [firstAsked, secondAsked] = asked;
    expect(firstAsked?.notice.actions?.[0]?.viewId).not.toBe(
      secondAsked?.notice.actions?.[0]?.viewId,
    );

    // ── Later leaves it waiting; Answer opens that run's question, and no other ──────────
    expect(await pressNotice(app, firstAsked?.index ?? -1, 1)).toBe(true);
    expect(await openPopouts(app)).toEqual([]);
    expect(await pressNotice(app, secondAsked?.index ?? -1, 0)).toBe(true);
    await expect
      .poll(() => openPopouts(app), { timeout: 15_000 })
      .toEqual([`view:${String(secondAsked?.notice.actions?.[0]?.viewId)}`]);
    expect(await dockBadge(app)).toBe(2);
    await expect.poll(() => popoutPages(app).length, { timeout: 15_000 }).toBe(1);
    const popout = popoutPages(app)[0] as Page;
    await popout.getByTestId("field-answer").fill("Grace");
    await popout.getByTestId("view-continue").click();
    await expect(cardOf(window, "second")).not.toHaveAttribute("data-state", "waiting", {
      timeout: 15_000,
    });
    await expect.poll(() => dockBadge(app), { timeout: 10_000 }).toBe(1);
    await expect(window.locator('[data-component="badge"]')).toHaveText("1");
    await quit(app);
  } catch (error) {
    await keepTraces();
    throw error;
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("clear done is undoable", async () => {
  test.setTimeout(240_000);
  const { scratch, env } = scratchDirectories();
  const folder = path.join(scratch, "recorder");
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchOnRuns(apps, env, folder, false);
    gate(folder, "finished.wav");
    await expect(cardOf(window, "finished")).toHaveCount(1, { timeout: 15_000 });
    gate(folder, "finished.copied");
    gate(folder, "finished.worked");
    const finished = cardOf(window, "finished");
    await expect(finished).toHaveAttribute("data-state", "done", { timeout: 20_000 });
    await expect(finished).toContainText("Moved finished to Archive");
    gate(folder, "pending.wav");
    await expect(cardOf(window, "pending")).toHaveAttribute("data-state", "copying", {
      timeout: 15_000,
    });

    // ── its end was told with Open, bound to its run: pressed, it opens Live on its flow ───
    const doneIndex = await expect
      .poll(async () =>
        (await delivered(app)).findIndex((n) => n.body === "Done: Moved finished to Archive."),
      )
      .not.toBe(-1)
      .then(async () =>
        (await delivered(app)).findIndex((n) => n.body === "Done: Moved finished to Archive."),
      );
    const told = (await delivered(app))[doneIndex];
    expect(told?.actions).toEqual([
      {
        label: STRINGS["notify.open"],
        kind: "open-live",
        flowId: RUNS_FLOW,
        runId: await finished.getAttribute("data-run"),
      },
    ]);
    await window.evaluate(() => {
      globalThis.location.hash = "#/configuration/flows";
    });
    await expect(board(window)).toHaveCount(0);
    expect(await pressNotice(app, doneIndex, 0)).toBe(true);
    await expect(board(window)).toHaveAttribute("data-flow", RUNS_FLOW, { timeout: 15_000 });

    // ── Clear done: the done card leaves the board, the running one stays ─────────────────
    await board(window).getByTestId("runs-clear-done").click();
    await expect(cards(window)).toHaveCount(1);
    await expect(cardOf(window, "pending")).toHaveCount(1);
    // Never a delete: the run is still kept, flagged cleared.
    const kept = await window.evaluate(
      (flowId) =>
        (
          window as unknown as {
            inny: {
              app: {
                runs(
                  q: object,
                ): Promise<{ value: { runs: { title: string; cleared: boolean }[] } }>;
              };
            };
          }
        ).inny.app.runs({ flowId }),
      RUNS_FLOW,
    );
    expect(kept.value.runs.map((run) => `${run.title} ${String(run.cleared)}`)).toEqual([
      "pending false",
      "finished true",
    ]);

    // ── Undo, within the minute: it comes back ────────────────────────────────────────────
    await board(window).getByTestId("runs-undo").click();
    await expect(cards(window)).toHaveCount(2);
    await expect(cardOf(window, "finished")).toHaveAttribute("data-state", "done");
    await expect(board(window).getByTestId("runs-undo")).toHaveCount(0);
    await quit(app);
  } catch (error) {
    await keepTraces();
    throw error;
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("the pop-out page draws the Question pop-out with tokens.css, and every Ark widget works under its unchanged CSP", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const running = await launchApp({ ...env, INNYTYPES_E2E_HOOKS: "1" });
    apps.push(running.app);
    const { app, window } = running;
    await waitForRunning(window, "runtime");
    // The pop-outs' own session serves the page, its tokens and styles, under one CSP.
    const served = await app.evaluate(async ({ session }) => {
      const views = session.fromPartition("inny-views");
      const out: Record<string, string | null> = {};
      for (const name of ["view.html", "view.js", "tokens.css", "app.css"]) {
        const response = await views.fetch(`inny-view://app/${name}`);
        out[name] = response.ok ? response.headers.get("content-security-policy") : null;
      }
      return out;
    });
    expect(served).toEqual({
      "view.html": VIEW_CSP,
      "view.js": VIEW_CSP,
      "tokens.css": VIEW_CSP,
      "app.css": VIEW_CSP,
    });
    // A window in the pop-outs' partition, on the pop-out page, drawing every Ark widget.
    await app.evaluate(async ({ BrowserWindow }) => {
      const probe = new BrowserWindow({
        show: false,
        width: 900,
        height: 900,
        webPreferences: { partition: "inny-views", sandbox: true, contextIsolation: true },
      });
      await probe.loadURL("inny-view://app/view.html#ark-widgets");
    });
    await expect.poll(() => popoutPages(app).length, { timeout: 15_000 }).toBe(1);
    const page = popoutPages(app)[0] as Page;
    await expect(page.locator('[data-probe="ark-widgets"]')).toBeVisible({ timeout: 15_000 });
    // Every CSP violation from here on, as the page reports it.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { violations: string[] }).violations = seen;
      document.addEventListener("securitypolicyviolation", (event) => {
        seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
    });
    const exercised = await exerciseArkWidgets(page);
    expect(exercised.length).toBeGreaterThan(0);
    const violations = await page.evaluate(
      () => (window as unknown as { violations: string[] }).violations,
    );
    // Fonts are refused by `default-src 'none'` in the app window too (no font-src): that is
    // the CSP as it stands, unchanged. Nothing an Ark widget does is refused.
    expect(violations.filter((v) => !v.startsWith("font-src"))).toEqual([]);
    await quit(app);
  } catch (error) {
    await keepTraces();
    throw error;
  } finally {
    await cleanUp(apps, scratch);
  }
});

/** Open, use and close each kind of Ark widget on the probe page; the kinds it exercised. */
async function exerciseArkWidgets(page: Page): Promise<string[]> {
  const done: string[] = [];
  // Select and Combobox: the trigger opens its list, an option is chosen.
  const combos = page.getByRole("combobox");
  for (let n = 0; n < Math.min(await combos.count(), 4); n += 1) {
    const combo = combos.nth(n);
    if (!(await combo.isVisible()) || !(await combo.isEnabled())) continue;
    await combo.click();
    await expect(page.getByRole("listbox").first()).toBeVisible();
    await page.getByRole("option").first().click();
    await page.keyboard.press("Escape");
    done.push("combobox");
  }
  // Menu: its trigger opens it.
  const menu = page.locator('[aria-haspopup="menu"]').first();
  if (await menu.isVisible()) {
    await menu.click();
    await expect(page.getByRole("menu").first()).toBeVisible();
    await page.keyboard.press("Escape");
    done.push("menu");
  }
  // Switch and Checkbox: a press changes them.
  for (const role of ["switch", "checkbox"] as const) {
    const control = page.getByRole(role).first();
    if ((await control.count()) > 0 && (await control.isEnabled())) {
      const before = await control.isChecked();
      await control.click({ force: true });
      expect(await control.isChecked()).toBe(!before);
      done.push(role);
    }
  }
  // Number input and Slider: the keyboard moves them.
  for (const role of ["spinbutton", "slider"] as const) {
    const control = page.getByRole(role).first();
    if ((await control.count()) > 0 && (await control.isEnabled())) {
      await control.focus();
      const before = await control.getAttribute("aria-valuenow");
      await page.keyboard.press("ArrowUp");
      await expect(control).not.toHaveAttribute("aria-valuenow", before ?? "");
      done.push(role);
    }
  }
  // Tabs and segmented controls: another tab or radio is selected.
  const tabs = page.getByRole("tab");
  if ((await tabs.count()) > 1) {
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    done.push("tabs");
  }
  // Tooltip: hovering its trigger shows it.
  const tipped = page.locator('[data-scope="tooltip"][data-part="trigger"]').first();
  if ((await tipped.count()) > 0) {
    await tipped.hover();
    await expect(page.getByRole("tooltip").first()).toBeVisible({ timeout: 5_000 });
    done.push("tooltip");
  }
  // The modal Dialog: opened, then closed with Escape.
  await page.getByTestId("open-dialog").click();
  await expect(page.getByRole("alertdialog").or(page.getByRole("dialog")).first()).toBeVisible();
  await page.keyboard.press("Escape");
  done.push("dialog");
  return done;
}
