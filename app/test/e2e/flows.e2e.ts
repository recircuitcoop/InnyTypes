// Flow administration in the real app (plan 0022 §D, WI-0022-08), through the page's AppApi, the
// shell's relay and the runtime's flow ops, against the real embedded Node-RED:
// (a) the list, a flow switched off and on through its tab's own flag, and its health, for a
//     running flow and for one made from a template;
// (b) a duplicate holds new ids and no credentials, and its export (through the shell's save
//     dialog) holds none either;
// (c) delete removes the tab and its runs, and is refused while the canvas has unsaved changes.
//
// The flow is the every-control fixture's ticker feeding its probe (test/fixtures/every-control):
// the ticker emits once after ready, so the flow has a run, and the probe has a secret.
import fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { APP, cleanUp, launchApp, quit, scratchDirectories, waitForRunning } from "./app-harness";

const TICKER = "inny-everycontrol-ticker";
const PROBE = "inny-everycontrol-probe";
const FLOW = "flows-e2e";
const SECRET = "s3cret-flows-e2e-41d7";
const SECOND_SECRET = "second-flows-e2e-8c03";
const DIRTY = "Save or discard your changes on the canvas first.";

const FLOW_NODES = [
  { id: FLOW, type: "tab", label: "Probe flow" },
  {
    id: "tk",
    type: TICKER,
    z: FLOW,
    greeting: "hi",
    delay_ms: "200",
    x: 120,
    y: 60,
    wires: [["pr"]],
  },
  {
    id: "pr",
    type: PROBE,
    z: FLOW,
    name: "probe",
    label: "the label",
    count: "2",
    volumes: [{ name: "media", path: "/Volumes/media" }],
    credentials: { token: SECRET, apikey: SECOND_SECRET },
    x: 320,
    y: 60,
    wires: [[], []],
  },
];

type Answer = { ok: boolean; value?: unknown; error?: string };

/** What the page's AppApi offers, as far as this spec calls it. */
interface Inny {
  inny: {
    app: {
      flowList(): Promise<Answer>;
      flowTemplates(): Promise<Answer>;
      flowSetOn(id: string, on: boolean): Promise<Answer>;
      flowRename(id: string, name: string): Promise<Answer>;
      editorPalette(): Promise<unknown>;
      flowDuplicate(id: string, name?: string): Promise<Answer>;
      flowExport(id: string): Promise<Answer>;
      flowDelete(id: string): Promise<Answer>;
      flowFromTemplate(templateId: string, name?: string): Promise<Answer>;
      runList(query: object): Promise<Answer>;
      onFlows(listener: () => void): void;
    };
  };
  heardFlows?: number;
}

interface Summary {
  id: string;
  name: string;
  on: boolean;
  health: { kind: string; count?: number };
  lastRun: { state: string } | null;
  steps: { id: string; name: string; setUp: boolean }[];
}

function request(port: number, method: string, url: string, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: url,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });
}

/** The deployed tabs, as Node-RED's admin API lists them. */
async function deployedTabs(port: number): Promise<{ id: string; disabled?: boolean }[]> {
  const answer = await request(port, "GET", "/red/flows");
  const nodes = JSON.parse(answer.body) as { id: string; type: string; disabled?: boolean }[];
  return nodes.filter((node) => node.type === "tab");
}

const app = (window: Page) => ({
  call: (name: keyof Inny["inny"]["app"], ...args: unknown[]) =>
    window.evaluate(
      ({ name, args }) =>
        (
          (window as unknown as Inny).inny.app[name] as unknown as (
            ...a: unknown[]
          ) => Promise<Answer>
        )(...args),
      { name, args },
    ),
});

async function flows(window: Page): Promise<Summary[]> {
  const answer = await app(window).call("flowList");
  expect(answer.ok, answer.error).toBe(true);
  return answer.value as Summary[];
}

const flowOf = async (window: Page, id: string) =>
  (await flows(window)).find((flow) => flow.id === id);

async function runsOf(window: Page, flowId: string): Promise<{ state: string }[]> {
  const answer = await app(window).call("runList", { flowId, limit: 50 });
  expect(answer.ok, answer.error).toBe(true);
  return (answer.value as { runs: { state: string }[] }).runs;
}

/**
 * Wait until the editor's palette can be read: a loaded editor that cannot be read yet counts
 * as dirty, and every flow write is refused while it loads.
 */
async function editorReady(window: Page): Promise<void> {
  await expect
    .poll(() => window.evaluate(() => (window as unknown as Inny).inny.app.editorPalette()), {
      timeout: 30_000,
    })
    .not.toBeNull();
}

/** Launch, deploy the probe flow, and wait for its first run to be done. */
async function withProbeFlow(apps: ElectronApplication[], env: Record<string, string>) {
  const running = await launchApp(env);
  apps.push(running.app);
  const port = Number((await waitForRunning(running.window, "runtime")).port);
  await editorReady(running.window);
  expect((await request(port, "POST", "/red/flows", FLOW_NODES)).status).toBe(204);
  await expect
    .poll(async () => (await runsOf(running.window, FLOW))[0]?.state, { timeout: 30_000 })
    .toBe("done");
  return { ...running, port };
}

test("(a) the list, a flow switched off and on by its tab's flag, and its health", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app: electronApp, window, port } = await withProbeFlow(apps, env);
    await window.evaluate(() => {
      const page = window as unknown as Inny;
      page.heardFlows = 0;
      page.inny.app.onFlows(() => {
        page.heardFlows = (page.heardFlows ?? 0) + 1;
      });
    });

    expect(await flowOf(window, FLOW)).toEqual({
      id: FLOW,
      name: "Probe flow",
      on: true,
      health: { kind: "ready" },
      lastRun: expect.objectContaining({ state: "done" }),
      viewNodes: [],
      steps: [{ id: "pr", name: "probe", type: PROBE, setUp: true }],
    });

    expect(await app(window).call("flowSetOn", FLOW, false)).toEqual({
      ok: true,
      value: { id: FLOW, on: false },
    });
    expect((await flowOf(window, FLOW))?.on).toBe(false);
    expect((await deployedTabs(port)).find((tab) => tab.id === FLOW)?.disabled).toBe(true);
    await expect
      .poll(() => window.evaluate(() => (window as unknown as Inny).heardFlows ?? 0))
      .toBeGreaterThan(0);

    expect(await app(window).call("flowSetOn", FLOW, true)).toEqual({
      ok: true,
      value: { id: FLOW, on: true },
    });
    expect((await flowOf(window, FLOW))?.on).toBe(true);
    expect((await deployedTabs(port)).find((tab) => tab.id === FLOW)?.disabled).toBe(false);
    // The switch kept the probe's secret: it is still set up.
    expect((await flowOf(window, FLOW))?.health).toEqual({ kind: "ready" });

    // Renamed: the list and the tab say the new name, and the secret is kept.
    expect(await app(window).call("flowRename", FLOW, "Renamed flow")).toEqual({
      ok: true,
      value: { id: FLOW, name: "Renamed flow" },
    });
    expect(await flowOf(window, FLOW)).toMatchObject({
      name: "Renamed flow",
      health: { kind: "ready" },
    });
    const renamed = await request(port, "GET", "/red/flows");
    expect(
      (JSON.parse(renamed.body) as { id: string; label?: string }[]).find((n) => n.id === FLOW)
        ?.label,
    ).toBe("Renamed flow");

    // A flow from the starter template: off, and its Anytype step not set up yet.
    const templates = await app(window).call("flowTemplates");
    expect(templates.value).toEqual([
      expect.objectContaining({ id: "folder-to-anytype", official: true }),
      expect.objectContaining({ id: "recordings-to-anytype", official: true }),
      expect.objectContaining({ id: "blank", official: true }),
    ]);
    const made = await app(window).call("flowFromTemplate", "folder-to-anytype");
    expect(made).toMatchObject({ ok: true, value: { name: "Folder to Anytype" } });
    const id = (made.value as { id: string }).id;
    expect(await flowOf(window, id)).toMatchObject({
      on: false,
      health: { kind: "steps-not-set-up", count: 1 },
      lastRun: null,
      steps: [{ name: "File in Anytype", setUp: false }],
    });

    await quit(electronApp);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("(b) a duplicate has new ids and no credentials, and its export holds none", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app: electronApp, window, port } = await withProbeFlow(apps, env);

    const duplicated = await app(window).call("flowDuplicate", FLOW);
    expect(duplicated).toMatchObject({ ok: true, value: { name: "Probe flow (copy)" } });
    const copyId = (duplicated.value as { id: string }).id;
    expect(copyId).not.toBe(FLOW);
    // Off, and the probe's secret was not copied: that step is not set up.
    expect(await flowOf(window, copyId)).toMatchObject({
      on: false,
      health: { kind: "steps-not-set-up", count: 1 },
      steps: [{ name: "probe", setUp: false }],
    });
    expect((await deployedTabs(port)).map((tab) => tab.id)).toContain(copyId);

    // The shell's save dialog, answered as a person choosing a file would.
    const saved = (name: string) => path.join(scratch, name);
    for (const [id, file] of [
      [copyId, "copy.json"],
      [FLOW, "original.json"],
    ] as const) {
      await electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
      }, saved(file));
      expect(await app(window).call("flowExport", id)).toEqual({
        ok: true,
        value: { saved: saved(file) },
      });
    }
    const copyText = fs.readFileSync(saved("copy.json"), "utf8");
    const originalText = fs.readFileSync(saved("original.json"), "utf8");
    for (const text of [copyText, originalText]) {
      expect(text).not.toContain("credentials");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SECOND_SECRET);
    }
    const copyIds = (JSON.parse(copyText) as { id: string }[]).map((node) => node.id);
    const originalIds = (JSON.parse(originalText) as { id: string }[]).map((node) => node.id);
    expect(originalIds).toEqual([FLOW, "tk", "pr"]);
    expect(copyIds).toHaveLength(3);
    expect(copyIds[0]).toBe(copyId);
    expect(copyIds.filter((id) => originalIds.includes(id))).toEqual([]);
    // The copy's wires follow its own ids.
    const copyNodes = JSON.parse(copyText) as { id: string; type: string; wires?: string[][] }[];
    const ticker = copyNodes.find((node) => node.type === TICKER);
    const probe = copyNodes.find((node) => node.type === PROBE);
    expect(ticker?.wires).toEqual([[probe?.id]]);

    await quit(electronApp);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("(c) delete removes the tab and its runs, and is refused while the canvas is dirty", async () => {
  test.setTimeout(180_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app: electronApp, window, port } = await withProbeFlow(apps, env);
    expect((await runsOf(window, FLOW)).length).toBeGreaterThan(0);

    // An unsaved edit on the canvas, made as editor-sync.e2e makes one.
    await expect(
      window
        .frameLocator('[data-testid="editor"]')
        .locator('.red-ui-palette-node[data-palette-type="inject"]'),
    ).toHaveCount(1, { timeout: 20_000 });
    const editor = () => {
      const frame = window
        .frames()
        .find((f) => f.url().startsWith(`http://127.0.0.1:${String(port)}/red/`));
      if (frame === undefined) {
        throw new Error("the editor frame is not loaded");
      }
      return frame;
    };
    type EditorRed = {
      view: { importNodes(nodes: unknown[], options: Record<string, unknown>): void };
      nodes: { dirty(set?: boolean): boolean; node(id: string): unknown };
    };
    const markDirty = () =>
      editor().evaluate(async () => {
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
    await expect.poll(markDirty, { timeout: 10_000 }).toBe(true);

    expect(await app(window).call("flowDelete", FLOW)).toEqual({
      ok: true,
      value: { refused: { reason: "dirty", sentence: DIRTY } },
    });
    expect((await deployedTabs(port)).map((tab) => tab.id)).toContain(FLOW);
    expect((await runsOf(window, FLOW)).length).toBeGreaterThan(0);

    // The edit discarded: the canvas is clean, and the delete goes through.
    await editor().evaluate(() => {
      (window as unknown as { RED: EditorRed }).RED.nodes.dirty(false);
    });
    const deleted = await app(window).call("flowDelete", FLOW);
    expect(deleted).toMatchObject({ ok: true, value: { id: FLOW } });
    expect((deleted.value as { runs: number }).runs).toBeGreaterThan(0);
    expect((await deployedTabs(port)).map((tab) => tab.id)).not.toContain(FLOW);
    expect(await flowOf(window, FLOW)).toBeUndefined();
    expect(await runsOf(window, FLOW)).toEqual([]);

    await quit(electronApp);
  } finally {
    await cleanUp(apps, scratch);
  }
});

test("(d) a template that fails the deploy guard is refused, and no tab is added", async () => {
  test.setTimeout(120_000);
  const { scratch, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    // A fixture templates folder in place of the build's: the e2e hooks hand it to the runtime.
    const fixture = path.join(APP, "test", "fixtures", "templates-guard");
    const running = await launchApp({
      ...env,
      INNYTYPES_E2E_HOOKS: "1",
      INNYTYPES_TEMPLATES_DIR: fixture,
    });
    apps.push(running.app);
    const { window } = running;
    const port = Number((await waitForRunning(window, "runtime")).port);
    await editorReady(window);
    expect((await app(window).call("flowTemplates")).value).toEqual([
      expect.objectContaining({ id: "refused", packages: ["nothere"] }),
    ]);
    const before = await deployedTabs(port);
    const listed = await flows(window);

    expect(await app(window).call("flowFromTemplate", "refused")).toEqual({
      ok: true,
      value: {
        refused: {
          reason: "not-installed",
          sentence: "Not installed in InnyTypes: inny-nothere-step.",
        },
      },
    });
    expect(await deployedTabs(port)).toEqual(before);
    expect(await flows(window)).toEqual(listed);

    await quit(running.app);
  } finally {
    await cleanUp(apps, scratch);
  }
});
