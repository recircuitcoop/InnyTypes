// Configuration › Flows and the canvas in the real app (plan 0022 §D, §M; WI-0022-14), clicked
// through as a person would, against the real embedded Node-RED:
// (a) a flow's row: its switch, Last run, health, Edit, Run history, and the ⋯ menu's Rename,
//     Duplicate, Export flow… and Delete flow;
// (b) Delete flow asks in the Destructive dialog: Cancel keeps the flow, Delete removes it;
// (c) New flow › From a template shows a card per template, and Use this template opens the new
//     flow's canvas frame: Unsaved changes while the editor is dirty, Save and run deploys, and
//     the palette's categories are Sources, Steps, Questions and results.
//
// The flow with a run is the every-control fixture's ticker feeding its probe, as flows.e2e.ts.
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Frame, type Page } from "@playwright/test";
import { STRINGS } from "../../src/ui/strings";
import { cleanUp, launchApp, quit, scratchDirectories, waitForRunning } from "./app-harness";

const FLOW = "configuration-e2e";
const FLOW_NODES = [
  { id: FLOW, type: "tab", label: "Probe flow" },
  {
    id: "tk",
    type: "inny-everycontrol-ticker",
    z: FLOW,
    greeting: "hi",
    delay_ms: "200",
    x: 120,
    y: 60,
    wires: [["pr"]],
  },
  {
    id: "pr",
    type: "inny-everycontrol-probe",
    z: FLOW,
    name: "probe",
    label: "the label",
    count: "2",
    volumes: [{ name: "media", path: "/Volumes/media" }],
    credentials: { token: "s3cret-configuration-e2e", apikey: "second-configuration-e2e" },
    x: 320,
    y: 60,
    wires: [[], []],
  },
];

type Answer = { ok: boolean; value?: unknown };
interface Inny {
  inny: {
    app: {
      completeSetup(): Promise<Answer>;
      editorPalette(): Promise<unknown>;
      runs(query: object): Promise<Answer>;
    };
  };
}

const frame = (window: Page) => window.getByTestId("frame");
const hashOf = (window: Page) => window.evaluate(() => globalThis.location.hash);
const go = (window: Page, hash: string) =>
  window.evaluate((address) => {
    globalThis.location.hash = address;
  }, hash);

/** Node-RED's deployed flows, as its admin API lists them. */
async function deployed(port: number): Promise<{ id: string; type: string; disabled?: boolean }[]> {
  const answer = await fetch(`http://127.0.0.1:${String(port)}/red/flows`);
  return (await answer.json()) as { id: string; type: string; disabled?: boolean }[];
}

async function runsOf(window: Page, flowId: string): Promise<{ state: string }[]> {
  const answer = await window.evaluate(
    (id) => (window as unknown as Inny).inny.app.runs({ flowId: id, limit: 50 }),
    flowId,
  );
  return (answer.value as { runs: { state: string }[] }).runs;
}

/**
 * Launch with Setup completed, the editor readable (a flow write is refused while it loads), and
 * the probe flow deployed with its first run done.
 */
async function launched(apps: ElectronApplication[], env: Record<string, string>) {
  const running = await launchApp(env);
  apps.push(running.app);
  const { window } = running;
  await expect(frame(window)).toHaveAttribute("data-route", "setup", { timeout: 15_000 });
  expect(
    (await window.evaluate(() => (window as unknown as Inny).inny.app.completeSetup())).ok,
  ).toBe(true);
  const port = Number((await waitForRunning(window, "runtime")).port);
  await expect
    .poll(() => window.evaluate(() => (window as unknown as Inny).inny.app.editorPalette()), {
      timeout: 30_000,
    })
    .not.toBeNull();
  const posted = await fetch(`http://127.0.0.1:${String(port)}/red/flows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(FLOW_NODES),
  });
  expect(posted.status).toBe(204);
  await expect
    .poll(async () => (await runsOf(window, FLOW)).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await go(window, "#/configuration/flows");
  await expect(frame(window)).toHaveAttribute("data-route", "flows");
  return { ...running, port };
}

/** A flow's row in the Flows list, by its name. */
const rowOf = (window: Page, name: string) =>
  frame(window)
    .locator('[data-component="list-row"]')
    .filter({ has: window.getByText(name, { exact: true }) });

test("(a) a flow's row: switch, Last run, health, Edit, Run history and the ⋯ menu", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port } = await launched(apps, env);
    const row = rowOf(window, "Probe flow");
    await expect(row).toHaveCount(1);

    // Last run and health; the row follows the run as it finishes, without a reload.
    await expect(row).toContainText(/Last run: today, \d\d:\d\d · done/, { timeout: 30_000 });
    await expect(row.locator('[data-component="status-pill"]')).toHaveText(
      STRINGS["flows.health.ready"],
    );

    // The switch turns the flow's tab off and on.
    const toggle = row.getByRole("checkbox", { name: `Probe flow ${STRINGS["flows.on"]}` });
    await expect(toggle).toBeChecked();
    await row.locator('[data-component="switch"]').click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(async () => (await deployed(port)).find((node) => node.id === FLOW)?.disabled)
      .toBe(true);
    await row.locator('[data-component="switch"]').click();
    await expect(toggle).toBeChecked();
    await expect
      .poll(async () => (await deployed(port)).find((node) => node.id === FLOW)?.disabled)
      .toBe(false);

    // Edit opens the canvas, Run history the flow's history.
    await row.getByRole("button", { name: STRINGS["flows.edit"], exact: true }).click();
    await expect.poll(() => hashOf(window)).toBe(`#/configuration/flows/${FLOW}/canvas`);
    await go(window, "#/configuration/flows");
    await row.getByRole("button", { name: STRINGS["flows.runHistory"] }).click();
    await expect.poll(() => hashOf(window)).toBe(`#/configuration/flows/${FLOW}/history`);
    await go(window, "#/configuration/flows");

    // The ⋯ menu: Rename, Duplicate, Export flow…, then, set apart, Delete flow in danger.
    const more = row.getByRole("button", { name: `${STRINGS["flows.more"]}: Probe flow` });
    await more.click();
    const menu = window.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      STRINGS["flows.rename"],
      STRINGS["flows.duplicate"],
      STRINGS["flows.export"],
      STRINGS["flows.delete"],
    ]);
    await expect(menu.locator('[role="separator"]')).toHaveCount(1);
    await expect(menu.getByRole("menuitem", { name: STRINGS["flows.delete"] })).toHaveAttribute(
      "data-variant",
      /state=danger/,
    );

    // Rename, in its dialog.
    await menu.getByRole("menuitem", { name: STRINGS["flows.rename"] }).click();
    const rename = window.getByRole("dialog");
    await rename.getByRole("textbox", { name: STRINGS["flows.rename.name"] }).fill("Renamed flow");
    await rename.getByRole("button", { name: STRINGS["flows.rename"], exact: true }).click();
    const renamed = rowOf(window, "Renamed flow");
    await expect(renamed).toHaveCount(1);
    expect(
      (await deployed(port)).find((node) => node.id === FLOW) as { label?: string } | undefined,
    ).toMatchObject({ label: "Renamed flow" });

    // Duplicate: a copy, off, its secret not copied.
    await renamed.getByRole("button", { name: `${STRINGS["flows.more"]}: Renamed flow` }).click();
    await window.getByRole("menuitem", { name: STRINGS["flows.duplicate"] }).click();
    const copy = rowOf(window, "Renamed flow (copy)");
    await expect(copy).toHaveCount(1);
    await expect(copy.getByRole("checkbox")).not.toBeChecked();
    await expect(copy.locator('[data-component="status-pill"]')).toHaveText("1 step not set up");

    // Export flow…, through the shell's save dialog.
    const saved = path.join(scratch, "exported.json");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
    }, saved);
    await renamed.getByRole("button", { name: `${STRINGS["flows.more"]}: Renamed flow` }).click();
    await window.getByRole("menuitem", { name: STRINGS["flows.export"] }).click();
    await expect.poll(() => fs.existsSync(saved)).toBe(true);
    expect((JSON.parse(fs.readFileSync(saved, "utf8")) as { id: string }[])[0]?.id).toBe(FLOW);

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("(b) Delete flow asks in the Destructive dialog: Cancel keeps the flow, Delete removes it", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port } = await launched(apps, env);
    const row = rowOf(window, "Probe flow");
    const askDelete = async () => {
      await row.getByRole("button", { name: `${STRINGS["flows.more"]}: Probe flow` }).click();
      await window.getByRole("menuitem", { name: STRINGS["flows.delete"] }).click();
      const dialog = window.locator('[data-component="dialog"][data-state="open"]');
      await expect(dialog).toHaveAttribute("data-variant", "kind=destructive");
      await expect(dialog.locator("h2")).toHaveText("Delete Probe flow?");
      await expect(dialog).toContainText(
        "Its run history is deleted too. Runs in progress are stopped.",
      );
      return dialog;
    };

    // Cancel: nothing is deleted.
    const first = await askDelete();
    await first.getByRole("button", { name: STRINGS["dialog.cancel"] }).click();
    await expect(first).toHaveCount(0);
    await expect(row).toHaveCount(1);
    expect((await deployed(port)).map((node) => node.id)).toContain(FLOW);

    // Delete: the row, the tab and its runs go.
    const second = await askDelete();
    await second.getByRole("button", { name: STRINGS["flows.delete.yes"], exact: true }).click();
    await expect(row).toHaveCount(0);
    expect((await deployed(port)).map((node) => node.id)).not.toContain(FLOW);
    expect(await runsOf(window, FLOW)).toEqual([]);

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});

/** The canvas's editor frame, by the flow's address. */
function canvasEditor(window: Page, port: number, flowId: string): Frame {
  const found = window
    .frames()
    .find((each) => each.url() === `http://127.0.0.1:${String(port)}/red/#flow/${flowId}`);
  if (found === undefined) {
    throw new Error("the canvas's editor frame is not loaded");
  }
  return found;
}

test("(c) template cards make a flow and open its canvas: Unsaved changes, Save and run, the palette's categories", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port } = await launched(apps, env);

    // New flow › From a template: a card per template, name and one line, Use this template.
    await frame(window).getByRole("button", { name: STRINGS["flows.new"] }).click();
    await window.getByRole("menuitem", { name: STRINGS["flows.new.template"] }).click();
    const cards = frame(window).getByTestId("template-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Folder to Anytype: file each new file in Anytype");
    await expect(cards.nth(1)).toContainText(
      "Recordings to Anytype: transcribe, summarise, file, approve, send, schedule",
    );
    for (const index of [0, 1]) {
      await expect(
        cards.nth(index).getByRole("button", { name: STRINGS["flows.template.use"] }),
      ).toBeVisible();
    }
    await cards
      .filter({ hasText: "Folder to Anytype" })
      .getByRole("button", { name: STRINGS["flows.template.use"] })
      .click();

    // The new flow's canvas frame: its name, Save and run, clean.
    await expect(frame(window)).toHaveAttribute("data-route", "canvas");
    const flowId = decodeURIComponent(
      /#\/configuration\/flows\/([^/]+)\/canvas/.exec(await hashOf(window))?.[1] ?? "",
    );
    const canvas = frame(window).locator('[data-component="canvas-frame"]');
    await expect(canvas.locator("h2")).toHaveText("Folder to Anytype");
    await expect(canvas).toHaveAttribute("data-variant", "state=clean");
    await expect(canvas.getByRole("button", { name: STRINGS["canvas.saveAndRun"] })).toBeVisible();
    await expect(canvas.getByTestId("canvas-editor")).toHaveAttribute(
      "src",
      `http://127.0.0.1:${String(port)}/red/#flow/${flowId}`,
    );

    // The palette's categories, in the app's words.
    const editorLocator = window.frameLocator('[data-testid="canvas-editor"]');
    for (const category of [
      STRINGS["canvas.palette.sources"],
      STRINGS["canvas.palette.steps"],
      STRINGS["canvas.palette.questions"],
    ]) {
      await expect(
        editorLocator.locator(".red-ui-palette-header").filter({ hasText: category }),
        category,
      ).toHaveCount(1, { timeout: 30_000 });
    }

    // An unsaved edit on the canvas: Unsaved changes shows.
    type EditorRed = {
      view: { importNodes(nodes: unknown[], options: Record<string, unknown>): void };
      nodes: { dirty(set?: boolean): boolean; node(id: string): unknown };
    };
    const markDirty = () =>
      canvasEditor(window, port, flowId).evaluate(async () => {
        const RED = (window as unknown as { RED: EditorRed }).RED;
        if (!RED.nodes.node("unsaved-edit")) {
          RED.view.importNodes([{ id: "unsaved-edit", type: "comment", x: 200, y: 100 }], {
            touchImport: true,
            notify: false,
          });
          RED.nodes.dirty(true);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        return RED.nodes.dirty();
      });
    await expect.poll(markDirty, { timeout: 15_000 }).toBe(true);
    await expect(canvas).toHaveAttribute("data-variant", "state=dirty");
    await expect(canvas.getByRole("status")).toHaveText(STRINGS["canvas.unsaved"]);

    // Save and run: the editor's Deploy, the edit deployed, the frame clean again.
    await canvas.getByRole("button", { name: STRINGS["canvas.saveAndRun"] }).click();
    await expect(canvas).toHaveAttribute("data-variant", "state=clean", { timeout: 15_000 });
    await expect(canvas.getByText(STRINGS["canvas.unsaved"])).toHaveCount(0);
    await expect
      .poll(async () => (await deployed(port)).map((node) => node.id))
      .toContain("unsaved-edit");

    await quit(app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
