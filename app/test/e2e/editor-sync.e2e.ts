// The editor sync and the quit question in the real app (WI-0018-12), driven through the real
// shell/main.ts bundle.
//
// - A type added mid-session, with only the runtime restarted, reaches the palette with no
//   reload and the undeployed edit kept; a type taken away leaves it the same way (P11b).
// - With the runtime-event path disabled (as if Node-RED changed its convention), the 10 s
//   fallback reloads a clean editor, and asks before reloading a dirty one.
// - A quit with undeployed edits asks: Deploy and quit, Quit and discard, or Cancel. Every quit
//   that goes ahead runs RED.stop() and leaves no process; the editor's beforeunload guard
//   never holds it (arch_pivot §4 surprise 1).
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import {
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
  type RunningApp,
} from "./app-harness";

const LATE = "inny-late-arrival";
const EDIT_ID = "undeployed-edit";

async function cleanUp(launched: readonly ElectronApplication[], scratch: string): Promise<void> {
  for (const app of launched) {
    // An app whose driver connection already closed has no process handle left to ask.
    const shell = (() => {
      try {
        return app.process();
      } catch {
        return null;
      }
    })();
    const running = (): boolean =>
      shell !== null && shell.exitCode === null && shell.signalCode === null;
    if (shell !== null && running()) {
      // A signal, not app.close(): a quit from the driver would ask the quit question of a
      // dirty editor, and a failed test leaves nobody to answer it. A signal quits unasked.
      const exited = new Promise((resolve) => shell.once("exit", resolve));
      shell.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      if (running()) {
        shell.kill("SIGKILL");
      }
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** A Node-RED node file planted in the runtime's types folder, as a new type would arrive. */
function plantLateType(userData: string): () => void {
  const generated = path.join(userData, "node-red", "generated");
  const files = [
    path.join(generated, "late-arrival.js"),
    path.join(generated, "late-arrival.html"),
  ];
  fs.writeFileSync(
    files[0] as string,
    `module.exports = function (RED) {
  function Late(config) { RED.nodes.createNode(this, config); }
  RED.nodes.registerType(${JSON.stringify(LATE)}, Late);
};
`,
  );
  fs.writeFileSync(
    files[1] as string,
    `<script type="text/javascript">
  RED.nodes.registerType(${JSON.stringify(LATE)}, {
    category: "InnyTypes", defaults: { name: { value: "" } }, inputs: 1, outputs: 0,
    label: function () { return this.name || "late arrival"; },
  });
</script>
`,
  );
  return () => {
    for (const file of files) {
      fs.rmSync(file, { force: true });
    }
  };
}

/** The editor's own page, to reach its RED from. */
function editorPage(window: Page, port: string) {
  const editor = window.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${port}/red/`));
  if (editor === undefined) {
    throw new Error("the editor frame is not loaded");
  }
  return editor;
}

const palette = (window: Page, type: string) =>
  window
    .frameLocator('[data-testid="editor"]')
    .locator(`.red-ui-palette-node[data-palette-type="${type}"]`);

/**
 * Launch with the e2e hooks, and wait for the editor to have drawn its palette.
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
  // Held now: once the app has exited, the driver no longer hands its process out.
  const shell = running.app.process();
  const unloadGuards: string[] = [];
  running.window.on("dialog", (dialog) => {
    unloadGuards.push(dialog.type());
  });
  const { port } = await waitForRunning(running.window, "runtime");
  await expect(palette(running.window, "inject")).toHaveCount(1, { timeout: 20_000 });
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

/** Restart only the runtime, as a type change does; answers the new generation. */
async function restartRuntime(app: ElectronApplication, window: Page): Promise<number> {
  const before = await waitForRunning(window, "runtime");
  const restarted = await app.evaluate(() =>
    (
      globalThis as unknown as {
        innytypesE2E: { restart(child: string, reason: string): boolean };
      }
    ).innytypesE2E.restart("runtime", "types"),
  );
  expect(restarted).toBe(true);
  const after = await waitForRunning(window, "runtime", before.generation + 1);
  expect(after.port).toBe(before.port);
  return after.generation;
}

/** Break the runtime-event path: editor.sync then raises nothing. */
async function disableRuntimeEvents(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    (
      globalThis as unknown as { innytypesE2E: { editorEvents(on: boolean): void } }
    ).innytypesE2E.editorEvents(false);
  });
}

const syncState = (window: Page) => window.getByTestId("editor-sync");

test("a type added mid-session reaches the palette with no reload and the undeployed edit kept; a removed one leaves", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port, shell, output } = await launched(env);
    apps.push(app);
    const shellPid = shell.pid;
    await editAndMark(window, port);
    expect(await editorState(window, port)).toEqual({
      mark: "this page was never reloaded",
      dirty: true,
      edit: true,
    });
    await expect(palette(window, LATE)).toHaveCount(0);

    // Added: only the runtime restarts, and the palette catches up by itself.
    const unplant = plantLateType(userData);
    const added = await restartRuntime(app, window);
    await expect(palette(window, LATE)).toHaveCount(1, { timeout: 10_000 });
    await expect(syncState(window)).toHaveAttribute("data-generation", String(added));
    await expect(syncState(window)).toHaveAttribute("data-state", "matched", { timeout: 10_000 });
    expect(await editorState(window, port)).toEqual({
      mark: "this page was never reloaded",
      dirty: true,
      edit: true,
    });
    expect(shell.pid).toBe(shellPid);

    // Removed: its palette entry goes the same way, still with no reload.
    unplant();
    const removed = await restartRuntime(app, window);
    await expect(palette(window, LATE)).toHaveCount(0, { timeout: 10_000 });
    await expect(syncState(window)).toHaveAttribute("data-generation", String(removed));
    await expect(syncState(window)).toHaveAttribute("data-state", "matched", { timeout: 10_000 });
    expect(await editorState(window, port)).toEqual({
      mark: "this page was never reloaded",
      dirty: true,
      edit: true,
    });
    // Nothing fell back: no reload, no prompt, at any point.
    await expect(window.getByTestId("editor-reload")).toHaveCount(0);

    // Ending the run: the edit is discarded at the quit question.
    const from = output.join("").length;
    await window.getByTestId("quit").click();
    await window.getByTestId("quit-discard").click();
    await expectCleanQuit(shell, userData, () => printedSince(output, from));
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("the fallback, clean: with the runtime-event path broken, the editor reloads by itself after 10 s", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port, output } = await launched(env);
    apps.push(app);
    await disableRuntimeEvents(app);
    await mark(window, port);
    expect((await editorState(window, port)).dirty).toBe(false);

    plantLateType(userData);
    const started = Date.now();
    await restartRuntime(app, window);
    await expect(syncState(window)).toHaveAttribute("data-state", "reloaded", { timeout: 20_000 });
    // Not before its 10 s: the events were given their chance.
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    expect(output.join("")).toContain("editor sync: the runtime-event path is disabled");
    // The reloaded editor loaded the palette afresh: the new type is there, the mark is gone.
    await expect(palette(window, LATE)).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(async () => (await editorState(window, port)).mark).toBeNull();
    await expect(window.getByTestId("editor-reload")).toHaveCount(0);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("the fallback, dirty: the editor is not reloaded; the person is asked, and Reload reloads", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, port, output, unloadGuards } = await launched(env);
    apps.push(app);
    await disableRuntimeEvents(app);
    await editAndMark(window, port);

    plantLateType(userData);
    await restartRuntime(app, window);
    await expect(syncState(window)).toHaveAttribute("data-state", "stale", { timeout: 20_000 });
    await expect(window.getByTestId("editor-stale")).toBeVisible();
    // Asked, not reloaded: the edit and the page are as they were.
    expect(await editorState(window, port)).toEqual({
      mark: "this page was never reloaded",
      dirty: true,
      edit: true,
    });

    // The person chooses Reload: the editor's beforeunload guard does not hold it.
    await window.getByTestId("editor-reload").click();
    await expect(palette(window, LATE)).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(async () => (await editorState(window, port)).mark).toBeNull();
    expect((await editorState(window, port)).dirty).toBe(false);
    // The editor's guard did fire, and the shell let the reload through.
    expect(unloadGuards).toContain("beforeunload");
    expect(output.join("")).toContain(
      "the editor held undeployed changes as it unloaded; the unload goes ahead",
    );
    await expect(window.getByTestId("editor-stale")).toHaveCount(0);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch);
  }
});

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

    await window.getByTestId("quit").click();
    await expect(window.getByTestId("quit-question")).toBeVisible();
    await expect(window.getByTestId("quit-text")).toHaveText(
      "InnyTypes is quitting, and the editor has changes that are not deployed.",
    );
    // Nothing stops while the person decides.
    expect(printedSince(output, from)).not.toContain("runtime stopping");
    await window.getByTestId("quit-deploy").click();

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

    // The same question for a quit from the menu or the dock as from the page.
    void app.evaluate(({ app: shell }) => {
      shell.quit();
    });
    await window.getByTestId("quit-discard").click();

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

    await window.getByTestId("quit").click();
    await window.getByTestId("quit-cancel").click();
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

    await window.getByTestId("quit").click();
    await window.getByTestId("quit-discard").click();
    await expectCleanQuit(shell, userData, () => printedSince(output, from));
  } finally {
    await cleanUp(apps, scratch);
  }
});
