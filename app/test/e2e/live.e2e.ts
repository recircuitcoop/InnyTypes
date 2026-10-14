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
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
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

/**
 * The flow: an inject feeding a question ("Name the speakers"), then a result ("Filed"), then,
 * after the redeploy, a second question ("Approve sending"): wired in that order, so the places
 * come in that order.
 */
function flowNodes(withApproval: boolean): object[] {
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
      wires: [withApproval ? ["approve"] : []],
    },
    ...(withApproval
      ? [
          {
            id: "approve",
            type: "inny-viewts-ask",
            z: FLOW,
            name: "Approve sending",
            wires: [[], []],
          },
        ]
      : []),
  ];
  return nodes.map((node, n) => (n === 0 ? node : { x: 120, y: 40 * n, ...node }));
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
async function launchOnBoard(apps: ElectronApplication[], env: Record<string, string>) {
  const running = await launchApp(env);
  apps.push(running.app);
  const { window } = running;
  const port = Number((await waitForRunning(window, "runtime")).port);
  expect(
    (await window.evaluate(() => (window as unknown as Inny).inny.app.completeSetup())).ok,
  ).toBe(true);
  expect(await deploy(port, flowNodes(false))).toBe(204);
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
    expect(await deploy(port, flowNodes(true))).toBe(204);
    await expect
      .poll(async () => (await boardOf(window)).layout.slots.length, { timeout: 30_000 })
      .toBe(4);
    const after = await boardOf(window);
    expect(after.layout.tabs).toEqual(arranged.tabs);
    expect(after.layout.slots.slice(0, 3)).toEqual(arranged.slots);
    // The new place goes to the end of the last tab, at the size it suggests (M).
    expect(await placeOf(window, "approve")).toBe("tab-2:1 M");
    expect(after.fresh).toEqual(["approve"]);

    // "New on the board" is said once, in the Edit-layout bar, and forgotten after Done.
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await expect(window.getByTestId("board-new-places")).toHaveText(
      "New on the board: Approve sending.",
    );
    await expect(window.getByTestId("board-new-places").locator("em")).toHaveText(
      "Approve sending",
    );
    await bar(window).getByRole("button", { name: STRINGS["board.done"] }).click();
    await board(window).getByRole("button", { name: STRINGS["board.editLayout"] }).click();
    await expect(bar(window)).toBeVisible();
    await expect(window.getByTestId("board-new-places")).toHaveCount(0);
    await bar(window).getByRole("button", { name: STRINGS["board.done"] }).click();

    // ── and the next launch reads the same board from boards.json ───────────────────────────
    const kept = await boardOf(window);
    await quit(app);
    const again = await launchApp(env);
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
    await board(w).getByRole("button", { name: STRINGS["board.removeTab"] }).click();
    await expect(board(w).getByRole("status")).toHaveText(STRINGS["board.lastTab"]);
    await expect(board(w).getByRole("tab")).toHaveCount(1);
    await quit(again.app);
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
  } finally {
    await cleanUp(apps, scratch);
  }
});
