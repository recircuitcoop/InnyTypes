// A step's form choosing its space and type from Anytype, in the real app (plan 0022 §B, D9;
// WI-0022-09): a fixture type declaring `innytype.spaces` and `innytype.types.of`, opened on the
// real canvas. The form says "Reading your spaces…" while the services process reads a fake
// Anytype with the run's key, then lists the spaces; choosing one lists its types, and choosing
// another reads again. What the node keeps is the plain id and key. Not paired, the form shows
// the sentence instead. The canary key is in no page, no options answer and no log line.
//
// Never the owner's Anytype or key: a fake Anytype on a free loopback port, the fake MCP child,
// and the run's canary key under a scratch home.
import fs from "node:fs";
import * as path from "node:path";
import {
  expect,
  test,
  type ElectronApplication,
  type Frame,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import { toolSignature } from "../../src/adapters/anytype/tool-surface";
import { ANYTYPE_VERSION, PACKAGE_VERSION } from "../../src/domain/anytype/pins";
import { FakeAnytypeServer } from "../fakes/anytype";
import {
  anytypeKeyFile,
  APP,
  cleanUp,
  launchApp,
  openCanvas,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

/** test/fixtures/raw-node's one type: `space` (innytype.spaces) and `type` (types of space). */
const RAW = "inny-rawnode-raw";
const FAKE = path.join(APP, "test", "fixtures", "fake-mcp");

/** The fake MCP child's surface, so the services process comes up ready on it. */
function fakeSurface(scratch: string): string {
  const tools = JSON.parse(fs.readFileSync(path.join(FAKE, "tools.json"), "utf8")) as {
    name: string;
    inputSchema: unknown;
  }[];
  const file = path.join(scratch, "fake-surface.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      package_version: PACKAGE_VERSION,
      anytype_version: ANYTYPE_VERSION,
      source: "bundled-spec",
      captured_at: "e2e",
      tools: Object.fromEntries(tools.map((t) => [t.name, toolSignature(t.inputSchema)])),
    }),
  );
  return file;
}

/** The part of the editor's own RED this spec calls, in the editor's page. */
interface EditorNode {
  space?: unknown;
  type?: unknown;
}
interface EditorRed {
  view: { importNodes(nodes: unknown[]): void };
  nodes: { node(id: string): EditorNode; dirty(set: boolean): void };
  editor: { edit(node: EditorNode): void };
}

/** The canvas's editor frame once its palette holds the fixture type, and the editor's page. */
async function editorOf(window: Page, port: number): Promise<{ frame: FrameLocator; page: Frame }> {
  const origin = `http://127.0.0.1:${String(port)}/red/`;
  const frame = await openCanvas(window, "tab1");
  await expect(window.getByTestId("canvas-editor")).toHaveAttribute("src", `${origin}#flow/tab1`);
  await expect(frame.locator(`.red-ui-palette-node[data-palette-type="${RAW}"]`)).toHaveCount(1, {
    timeout: 20_000,
  });
  const page = window.frames().find((f) => f.url().startsWith(origin));
  if (page === undefined) {
    throw new Error("the editor frame is not loaded");
  }
  return { frame, page };
}

/** Put a fixture node on the canvas, with `values`, and open its form. */
/** A select's options, by the words each shows. */
const optionsOf = (select: Locator): Promise<string[]> =>
  select.evaluate((element: HTMLSelectElement) =>
    [...element.options].map((option) => option.text),
  );

/** The words of a select's chosen option. */
const chosenOf = (select: Locator): Promise<string | undefined> =>
  select.evaluate((element: HTMLSelectElement) => element.selectedOptions[0]?.text);

async function openForm(page: Frame, values: Record<string, string>): Promise<void> {
  await page.evaluate(
    ([type, given]) => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      RED.view.importNodes([{ id: "o1", type, x: 200, y: 100, ...given }]);
      RED.editor.edit(RED.nodes.node("o1"));
    },
    [RAW, values] as const,
  );
}

async function launch(env: Record<string, string>, scratch: string, url: string) {
  return launchApp({
    ...env,
    ANYTYPE_API_BASE_URL: url,
    INNYTYPES_LOG_FILE: path.join(scratch, "innytypes.log"),
    INNYTYPES_TEST_ANYTYPE: JSON.stringify({
      entry: path.join(FAKE, "server.mjs"),
      surface: fakeSurface(scratch),
    }),
  });
}

test("spaces and types in a step's form", async () => {
  test.setTimeout(120_000);
  const { scratch, env, canaryKey } = scratchDirectories();
  const anytype = new FakeAnytypeServer(canaryKey);
  anytype.spaces = [
    { id: "sp-work", name: "Work" },
    { id: "sp-home", name: "Home" },
  ];
  anytype.types.set("sp-work", [
    { key: "page", name: "Page" },
    { key: "meeting", name: "Meeting" },
  ]);
  anytype.types.set("sp-home", [
    { key: "page", name: "Page" },
    { key: "recipe", name: "Recipe" },
    { key: "old", name: "Old", archived: true },
  ]);
  // The spaces wait until the form has been seen reading them.
  let release: () => void = () => undefined;
  anytype.hold = new Promise((resolve) => {
    release = resolve;
  });
  const url = await anytype.start();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launch(env, scratch, url);
    launched.push(app);
    const port = Number((await waitForRunning(window, "runtime")).port);
    await waitForRunning(window, "services");
    const { frame, page } = await editorOf(window, port);

    await openForm(page, {});
    const form = frame.getByTestId(`inny-form-${RAW}`);
    const space = form.getByTestId("inny-field-space");
    const type = form.getByTestId("inny-field-type");
    const spaceNote = form.getByTestId("inny-note-space");

    // ── reading, then the spaces by name ─────────────────────────────────────────────────
    await expect(spaceNote).toHaveText("Reading your spaces…", { timeout: 15_000 });
    await expect(space).toBeDisabled();
    // No space yet: the type is empty and disabled.
    await expect(type).toBeDisabled();
    expect(await optionsOf(type)).toEqual([""]);
    release();
    await expect.poll(() => optionsOf(space), { timeout: 15_000 }).toEqual(["", "Work", "Home"]);
    await expect(space).toBeEnabled();
    await expect(spaceNote).toBeHidden();

    // ── a space chosen: its types; another chosen: read again, a type it lacks cleared ───
    await space.selectOption("sp-work");
    await expect.poll(() => optionsOf(type), { timeout: 15_000 }).toEqual(["", "Page", "Meeting"]);
    await type.selectOption("meeting");
    await space.selectOption("sp-home");
    await expect.poll(() => optionsOf(type), { timeout: 15_000 }).toEqual(["", "Page", "Recipe"]);
    await expect(type).toHaveValue("");
    await type.selectOption("recipe");
    await frame.locator("#node-dialog-ok").dispatchEvent("click");

    // What the node keeps is the plain id and key, never a name.
    const kept = await page.evaluate(() => {
      const node = (window as unknown as { RED: EditorRed }).RED.nodes.node("o1");
      return { space: node.space, type: node.type };
    });
    expect(kept).toEqual({ space: "sp-home", type: "recipe" });

    // Opened again: the stored choices shown by name, the types read for the stored space.
    await page.evaluate(() => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      RED.editor.edit(RED.nodes.node("o1"));
    });
    await expect.poll(() => chosenOf(space), { timeout: 15_000 }).toBe("Home");
    await expect.poll(() => chosenOf(type), { timeout: 15_000 }).toBe("Recipe");

    // ── the key: Anytype got it from the services process; nothing on this side holds it ─
    const lists = anytype.received.filter((request) => request.url.includes("offset="));
    expect(lists.length).toBeGreaterThan(0);
    for (const request of lists) {
      expect(request.authorization).toBe(`Bearer ${canaryKey}`);
    }
    const answers = await page.evaluate(async () => {
      const read = (query: string) => fetch(`inny/options?${query}`).then((r) => r.text());
      return [await read("source=spaces"), await read("source=types&space=sp-home")];
    });
    expect(answers[0]).toContain("Work");
    const editorHtml = await page.evaluate(() => document.documentElement.outerHTML);
    const appHtml = await window.evaluate(() => document.documentElement.outerHTML);
    for (const text of [...answers, editorHtml, appHtml]) {
      expect(text).not.toContain(canaryKey);
    }

    // The step is not deployed and is not meant to be: the canvas is marked clean, so the
    // quit asks nothing (the quit question is editor-sync's to test, not this spec's).
    await page.evaluate(() => {
      (window as unknown as { RED: EditorRed }).RED.nodes.dirty(false);
    });
    await quit(app);
    expect(output.join("")).not.toContain(canaryKey);
    expect(fs.readFileSync(path.join(scratch, "innytypes.log"), "utf8")).not.toContain(canaryKey);
  } finally {
    release();
    await cleanUp(launched, scratch);
    await anytype.close();
  }
});

test("not paired, a step's form says how to pair and keeps what the step stored", async () => {
  test.setTimeout(120_000);
  const { scratch, env, canaryKey } = scratchDirectories();
  // No key under the scratch home: InnyTypes is not paired.
  fs.rmSync(anytypeKeyFile(scratch));
  const anytype = new FakeAnytypeServer(canaryKey);
  anytype.spaces = [{ id: "sp-work", name: "Work" }];
  const url = await anytype.start();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window } = await launch(env, scratch, url);
    launched.push(app);
    const port = Number((await waitForRunning(window, "runtime")).port);
    await waitForRunning(window, "services");
    const { frame, page } = await editorOf(window, port);

    await openForm(page, { space: "sp-stored" });
    const form = frame.getByTestId(`inny-form-${RAW}`);
    await expect(form.getByTestId("inny-note-space")).toHaveText(
      "Pair with Anytype in Configuration › General to choose a space.",
      { timeout: 15_000 },
    );
    const space = form.getByTestId("inny-field-space");
    await expect(space).toHaveValue("sp-stored");
    await expect(space).toBeDisabled();
    // Anytype was asked for no list: there is no key to ask with.
    expect(anytype.received.filter((request) => request.url.includes("offset="))).toEqual([]);
    await quit(app);
  } finally {
    await cleanUp(launched, scratch);
    await anytype.close();
  }
});
