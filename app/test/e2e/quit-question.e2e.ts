// The quit question in the real app (WI-0018-12), driven through the real shell/main.ts bundle:
// a quit with undeployed edits on the canvas asks, in the frame's quit Dialog (WI-0022-11;
// ux-writing "Quit with unsaved canvas edits"): Save and quit, Quit without saving, or Cancel.
// Every quit that goes ahead runs RED.stop() and leaves no process; the editor's beforeunload
// guard never holds it (arch_pivot §4 surprise 1). A quit is the app menu's, the dock's or a
// logout's: each is Electron's app.quit().
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { STRINGS } from "../../src/ui/strings";
import {
  cleanUp,
  launchApp,
  openCanvas,
  processesNaming,
  type RunningApp,
  scratchDirectories,
  shellOf,
  waitForRunning,
} from "./app-harness";

const EDIT_ID = "undeployed-edit";

/** The editor's own page, to reach its RED from. */
function editorPage(window: Page, port: string) {
  const editor = window.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${port}/red/`));
  if (editor === undefined) {
    throw new Error("the editor frame is not loaded");
  }
  return editor;
}

/**
 * Launch with the e2e hooks, and open a flow's canvas: its editor has drawn its palette.
 *
 * Playwright dismisses a dialog nobody listens for, and the editor's beforeunload guard is one:
 * dismissing it would cancel the unload, standing in for the very thing under test. A listener
 * that does nothing leaves the guard to the app, as with no driver attached: only the shell's
 * will-prevent-unload handler can let the unload through. The guards seen are counted.
 */
async function launched(
  env: Record<string, string>,
): Promise<RunningApp & { port: string; unloadGuards: string[]; shell: ChildProcess }> {
  const running = await launchApp({ ...env, INNYTYPES_E2E_HOOKS: "1" });
  // Held since launch: once the app has exited, the driver no longer hands its process out.
  const shell = shellOf(running.app);
  const unloadGuards: string[] = [];
  running.window.on("dialog", (dialog) => {
    unloadGuards.push(dialog.type());
  });
  const { port } = await waitForRunning(running.window, "runtime");
  await openCanvas(running.window, "tab1");
  return { ...running, port, unloadGuards, shell };
}

interface EditorRed {
  view: { importNodes(nodes: unknown[], options: Record<string, unknown>): void };
  nodes: { dirty(set?: boolean): boolean; node(id: string): unknown };
}

/**
 * An undeployed edit in the editor: a comment on the canvas, and a mark on its page. The palette
 * can be drawn before the editor has loaded its flows, which then replace the canvas; the edit
 * is made again until it holds.
 */
async function editAndMark(window: Page, port: string): Promise<void> {
  const edit = () =>
    editorPage(window, port).evaluate(async (id) => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      if (!RED.nodes.node(id)) {
        RED.view.importNodes([{ id, type: "comment", name: "UNDEPLOYED EDIT", x: 200, y: 100 }], {
          touchImport: true,
          notify: false,
        });
        // A person's drop of the node marks the editor dirty; the import alone leaves that to
        // the drop, which a hidden test window never makes, so it is marked as the drop would.
        RED.nodes.dirty(true);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return Boolean(RED.nodes.node(id)) && RED.nodes.dirty();
    }, EDIT_ID);
  await expect.poll(edit, { timeout: 10_000 }).toBe(true);
  await mark(window, port);
}

/** Put a mark on the editor's page only: a reload loses it. */
async function mark(window: Page, port: string): Promise<void> {
  await editorPage(window, port).evaluate(() => {
    (window as unknown as { innyMark: string }).innyMark = "this page was never reloaded";
  });
}

/** What the editor's page holds now: the mark, dirty(), and the undeployed comment. */
function editorState(window: Page, port: string) {
  return editorPage(window, port).evaluate((id) => {
    const RED = (window as unknown as { RED: EditorRed }).RED;
    return {
      mark: (window as unknown as { innyMark?: string }).innyMark ?? null,
      dirty: RED.nodes.dirty(),
      edit: RED.nodes.node(id) !== undefined && RED.nodes.node(id) !== null,
    };
  }, EDIT_ID);
}

/** Quit, as the app menu's Quit does: Electron's app.quit(). */
function quitFromMenu(app: ElectronApplication): void {
  void app.evaluate(({ app: shell }) => {
    shell.quit();
  });
}

/** The quit Dialog's three buttons, by the ux-writing words each one says. */
const QUIT_BUTTON = {
  "quit.save": "quit-primary",
  "quit.discard": "quit-secondary",
  "dialog.cancel": "quit-cancel",
} as const;
const quitButton = (window: Page, key: keyof typeof QUIT_BUTTON) =>
  window.getByTestId("quit-question").getByTestId(QUIT_BUTTON[key]);

/** What Node-RED saved of the flows: the deployed ones. */
function savedFlows(userData: string): string {
  const file = path.join(userData, "node-red", "flows.json");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** Everything the run printed after `from`. */
const printedSince = (output: string[], from: number) => output.join("").slice(from);

/** A quit that went ahead ran RED.stop() in the runtime, and left no process behind. */
async function expectCleanQuit(shell: ChildProcess, userData: string, said: () => string) {
  await expect
    .poll(() => shell.exitCode, {
      timeout: 20_000,
      message: `the app did not exit; it last said:\n${said().slice(-3000)}`,
    })
    .toBe(0);
  const stopping = said().indexOf("innytypes.runtime: runtime stopping (quit)");
  expect(stopping).toBeGreaterThanOrEqual(0);
  // Node-RED's own line, said by RED.stop() as it stops the flows, after the quit's stop (a
  // deploy says it too, before).
  expect(said().slice(stopping)).toMatch(/innytypes\.node-red: Stopped flows/);
  expect(said()).toContain("quit complete");
  await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
}

test("quit with undeployed edits: Deploy and quit deploys them, then stops everything", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port, output, shell } = await launched(env);
    apps.push(app);
    await editAndMark(window, port);
    const from = output.join("").length;

    quitFromMenu(app);
    await expect(window.getByTestId("quit-question")).toBeVisible();
    const dialog = window.getByTestId("quit-question-dialog");
    await expect(dialog).toHaveAttribute("role", "alertdialog");
    await expect(dialog).toContainText(STRINGS["quit.title"]);
    await expect(dialog).toContainText(STRINGS["quit.body"]);
    // The three ux-writing buttons, the safe one Primary: Cancel, Quit without saving, Save and quit.
    for (const key of ["dialog.cancel", "quit.discard", "quit.save"] as const) {
      await expect(quitButton(window, key)).toHaveText(STRINGS[key]);
    }
    expect(
      await window
        .getByTestId("quit-question")
        .evaluate((element) => [...element.querySelectorAll("button")].map((b) => b.textContent)),
    ).toEqual([STRINGS["dialog.cancel"], STRINGS["quit.discard"], STRINGS["quit.save"]]);
    await expect(quitButton(window, "quit.save")).toHaveAttribute("data-variant", /kind=primary/);
    // Nothing stops while the person decides.
    expect(printedSince(output, from)).not.toContain("runtime stopping");
    await quitButton(window, "quit.save").click();

    await expectCleanQuit(shell, userData, () => printedSince(output, from));
    expect(printedSince(output, from)).toContain(
      "Deploy and quit: the editor's edits are deployed",
    );
    expect(savedFlows(userData)).toContain(EDIT_ID);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("quit with undeployed edits: Quit and discard stops everything, and the edits are not deployed", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port, output, shell, unloadGuards } = await launched(env);
    apps.push(app);
    await editAndMark(window, port);
    const from = output.join("").length;

    quitFromMenu(app);
    await quitButton(window, "quit.discard").click();

    await expectCleanQuit(shell, userData, () => printedSince(output, from));
    expect(printedSince(output, from)).toContain(
      "Quit and discard: the editor's undeployed edits are discarded",
    );
    expect(savedFlows(userData)).not.toContain(EDIT_ID);
    // The still-dirty editor's beforeunload guard fired as the window closed, and did not hold
    // the quit: the shell let the unload through.
    expect(unloadGuards).toContain("beforeunload");
    expect(printedSince(output, from)).toContain(
      "the editor held undeployed changes as it unloaded; the unload goes ahead",
    );
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("quit with undeployed edits: Cancel keeps the app, the runtime and the edits; a second quit asks again", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port, output, shell } = await launched(env);
    apps.push(app);
    const runtime = await waitForRunning(window, "runtime");
    await editAndMark(window, port);
    const from = output.join("").length;

    quitFromMenu(app);
    await quitButton(window, "dialog.cancel").click();
    await expect(window.getByTestId("quit-question")).toBeHidden();
    await expect
      .poll(() => printedSince(output, from))
      .toContain("quit cancelled: the editor keeps its undeployed edits");
    expect(printedSince(output, from)).not.toContain("runtime stopping");
    expect((await waitForRunning(window, "runtime")).pid).toBe(runtime.pid);
    expect(await editorState(window, port)).toEqual({
      mark: "this page was never reloaded",
      dirty: true,
      edit: true,
    });
    expect(shell.exitCode).toBeNull();

    quitFromMenu(app);
    await quitButton(window, "quit.discard").click();
    await expectCleanQuit(shell, userData, () => printedSince(output, from));
  } finally {
    await cleanUp(apps, scratch);
  }
});
