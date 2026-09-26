// Event types created in the real app (WI-0018-13; spec §9; arch_pivot P9, P11a/b), driven
// through the Events page of the real shell/main.ts bundle.
//
// One session, one shell process throughout, and an editor page that is never reloaded:
// - created from the field editor (enums, a nested object), it reaches the palette with only
//   the runtime restarted; the user-events package is regenerated;
// - fired from the page, it arrives downstream with `topic` the type and a runtime-stamped
//   envelope; an invalid fire is refused with the reason; an invalid payload on the source's
//   input fails that input (Catch sees it); a snapshot action wired to the input starts a run;
// - a changed schema makes v2 and leaves v1 as it was; an unchanged one is refused;
// - a deletion is refused while a deployed node uses the version, AND while only an undeployed
//   node in the editor does, each naming the node; once unused, it is deleted;
// - the editor's undeployed edit survives every one of those runtime restarts.
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launchApp, processesNaming, scratchDirectories, waitForRunning } from "./app-harness";

const V1 = "inny-user-events-meeting_note-v1";
const V2 = "inny-user-events-meeting_note-v2";
/** A second created type, every field optional: what a snapshot action sends fits it. */
const PING = "inny-user-events-ping-v1";
const EDIT_ID = "undeployed-edit";
const DRAFT_ID = "draft-src";

function request(port: number, method: string, route: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
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

async function cleanUp(apps: readonly ElectronApplication[], scratch: string): Promise<void> {
  for (const app of apps) {
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
      // A signal quits without the quit question a dirty editor would ask.
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

const palette = (window: Page, type: string) =>
  window
    .frameLocator('[data-testid="editor"]')
    .locator(`.red-ui-palette-node[data-palette-type="${type}"]`);

function editorPage(window: Page, port: string) {
  const editor = window.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${port}/red/`));
  if (editor === undefined) {
    throw new Error("the editor frame is not loaded");
  }
  return editor;
}

interface EditorRed {
  view: {
    importNodes(nodes: unknown[], options: Record<string, unknown>): void;
    redraw(full?: boolean): void;
  };
  nodes: {
    dirty(set?: boolean): boolean;
    node(id: string): unknown;
    remove(id: string): unknown;
  };
}

/** Undeployed edits in the editor, made again until they hold (a flows load may replace them). */
async function editInTheEditor(window: Page, port: string, nodes: object[]): Promise<void> {
  const edit = () =>
    editorPage(window, port).evaluate(async (wanted) => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      const missing = wanted.filter((n) => !RED.nodes.node((n as { id: string }).id));
      if (missing.length > 0) {
        RED.view.importNodes(missing, { touchImport: true, notify: false });
        RED.nodes.dirty(true);
      }
      (window as unknown as { innyMark: string }).innyMark = "this page was never reloaded";
      await new Promise((resolve) => setTimeout(resolve, 300));
      return (
        wanted.every((n) => Boolean(RED.nodes.node((n as { id: string }).id))) &&
        (wanted.length === 0 || RED.nodes.dirty())
      );
    }, nodes);
  await expect.poll(edit, { timeout: 15_000 }).toBe(true);
}

function editorState(window: Page, port: string) {
  return editorPage(window, port).evaluate((id) => {
    const RED = (window as unknown as { RED: EditorRed }).RED;
    return {
      mark: (window as unknown as { innyMark?: string }).innyMark ?? null,
      dirty: RED.nodes.dirty(),
      edit: Boolean(RED.nodes.node(id)),
    };
  }, EDIT_ID);
}

const debug = (id: string, name: string, complete: string) => ({
  id,
  type: "debug",
  z: "tab1",
  name,
  active: true,
  tosidebar: false,
  console: true,
  complete,
  targetType: "msg",
  wires: [],
});

const inject = (id: string, target: string, payload: string) => ({
  id,
  type: "inject",
  z: "tab1",
  props: [{ p: "payload" }],
  payload,
  payloadType: "json",
  repeat: "",
  once: false,
  wires: [[target]],
});

/**
 * The created source, what it emits, an input fed badly, and a snapshot action wired to the
 * input of a second created source (Node-RED's own nodes are locked to core/common, so the
 * snapshot's `{state, values}` goes to a type whose fields are all optional).
 */
function flow(): object[] {
  const outputs = ["dbg-topic", "dbg-event", "dbg-payload", "dbg-run"];
  const nodes: object[] = [
    { id: "tab1", type: "tab", label: "Created events" },
    { id: "src1", type: V1, z: "tab1", name: "", wires: [outputs] },
    debug("dbg-topic", "topic", "topic"),
    debug("dbg-event", "envelope", "inny.event"),
    debug("dbg-payload", "payload", "payload"),
    debug("dbg-run", "run", "inny.run"),
    inject("go-bad", "src1", '{"minutes":3}'),
    {
      id: "catch",
      type: "catch",
      z: "tab1",
      scope: null,
      uncaught: false,
      wires: [["dbg-caught"]],
    },
    debug("dbg-caught", "caught", "error"),
    inject("go-rec", "rec", '{"from":"a snapshot"}'),
    { id: "rec", type: "inny-viewts-record", z: "tab1", name: "Rec", wires: [[], ["ping1"], []] },
    { id: "ping1", type: PING, z: "tab1", name: "", wires: [["dbg-ping", "dbg-run"]] },
    debug("dbg-ping", "ping payload", "payload"),
  ];
  return nodes.map((node, n) => (n === 0 ? node : { x: 100, y: 40 * n, ...node }));
}

/** Every stored version, as the runtime wrote them. */
function stored(userData: string): { type: string; schema: unknown }[] {
  const file = path.join(userData, "event-types.json");
  return (
    JSON.parse(fs.readFileSync(file, "utf8")) as { types: { type: string; schema: unknown }[] }
  ).types;
}

/** The regenerated user-events package's type ids. */
function declared(userData: string): string[] {
  const file = path.join(userData, "user-events", "inny-package.json");
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { types: { id: string }[] }).types.map(
    (t) => t.id,
  );
}

const message = (window: Page) => window.getByTestId("events-message");
const item = (window: Page, type: string) =>
  window.locator(`[data-testid="event-type"][data-type="${type}"]`);

/** Fill field-editor row `n`. */
async function fillRow(
  window: Page,
  n: number,
  path: string,
  type: string,
  required = false,
  options = "",
) {
  await window.getByTestId(`field-path-${String(n)}`).fill(path);
  await window.getByTestId(`field-type-${String(n)}`).selectOption(type);
  await window.getByTestId(`field-required-${String(n)}`).setChecked(required);
  await window.getByTestId(`field-options-${String(n)}`).fill(options);
}

const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

test("created event types: create, fire, version, delete refused and allowed; only the runtime restarts and the editor keeps its edits", async () => {
  test.setTimeout(300_000);
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp(env);
    apps.push(app);
    const said = () => output.join("");
    const shell: ChildProcess = app.process();
    // A dialog nobody listens for is dismissed by the driver; the editor's beforeunload guard is
    // one, and dismissing it would hold an unload the app lets through. Counted, never answered.
    const dialogs: string[] = [];
    window.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
    });
    const shellPid = shell.pid;
    const first = await waitForRunning(window, "runtime");
    const port = first.port;
    await expect(palette(window, "inject")).toHaveCount(1, { timeout: 20_000 });
    await editInTheEditor(window, port, []);

    // ── create, from the field editor ───────────────────────────────────────────────────
    await window.getByTestId("nav-events").click();
    await expect(window.getByTestId("events-empty")).toBeVisible();
    await window.getByTestId("event-name").fill("meeting_note");
    await window.getByTestId("event-label").fill("Meeting note");
    for (let n = 0; n < 3; n += 1) {
      await window.getByTestId("event-add-field").click();
    }
    await fillRow(window, 0, "title", "string", true);
    await fillRow(window, 1, "minutes", "integer");
    await fillRow(window, 2, "kind", "string", false, "standup, review");
    await fillRow(window, 3, "where", "object");
    await fillRow(window, 4, "where.room", "string", true);
    await window.getByTestId("event-submit").click();
    await expect(message(window)).toContainText("Created user.meeting_note.v1.");
    await waitForRunning(window, "runtime", first.generation + 1);
    await expect(palette(window, V1)).toHaveCount(1, { timeout: 15_000 });
    expect(declared(userData)).toEqual(["meeting_note-v1"]);
    const v1 = stored(userData)[0];
    expect(v1?.schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        title: { type: "string" },
        minutes: { type: "integer" },
        kind: { type: "string", enum: ["standup", "review"] },
        where: {
          type: "object",
          properties: { room: { type: "string" } },
          additionalProperties: true,
          required: ["room"],
        },
      },
      additionalProperties: true,
      required: ["title"],
    });
    expect((await editorState(window, port)).mark).toBe("this page was never reloaded");

    // A second type, through the same AppApi call the page makes.
    const ping = await window.evaluate(() =>
      (
        window as unknown as {
          inny: { app: { createEventType(n: string, l: string, s: object): Promise<unknown> } };
        }
      ).inny.app.createEventType("ping", "Ping", {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { note: { type: "string" } },
        additionalProperties: true,
      }),
    );
    expect(ping).toMatchObject({ ok: true, value: { type: "user.ping.v1" } });
    const created = await waitForRunning(window, "runtime", first.generation + 2);
    await expect(palette(window, PING)).toHaveCount(1, { timeout: 15_000 });

    // ── deploy a flow using them ────────────────────────────────────────────────────────
    expect(await request(Number(port), "POST", "/red/flows", flow())).toBe(204);
    await expect.poll(said, { timeout: 20_000 }).toMatch(new RegExp(`\\[${V1} src1\\] ready`));

    // ── fire from the page: topic, payload and a runtime-stamped envelope downstream ────
    await window.getByTestId("events-refresh").click();
    await expect(item(window, "user.meeting_note.v1")).toContainText("Deployed in src1.", {
      timeout: 15_000,
    });
    await item(window, "user.meeting_note.v1").getByTestId("event-fire").click();
    await window.getByTestId("fire-minutes").fill("45");
    await window.getByTestId("fire-kind").selectOption("standup");
    await window.getByTestId("fire-where.room").fill("A");
    await window.getByTestId("fire-submit").click();
    // Validated by ajv before anything is sent: the title is required.
    await expect(message(window)).toHaveText("Field title is required.");
    expect(said()).not.toMatch(/\[debug:topic\]/);
    await window.getByTestId("fire-title").fill("Weekly sync");
    await window.getByTestId("fire-submit").click();
    await expect(message(window)).toHaveText("Fired from src1.");
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/\[debug:topic\] \n?'?user\.meeting_note\.v1/);
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(
        /\[debug:payload\]\s*\{\s*title: 'Weekly sync',\s*minutes: 45,\s*kind: 'standup',\s*where: \{ room: 'A' \}\s*\}/,
      );
    await expect.poll(said, { timeout: 10_000 }).toMatch(/\[debug:envelope\]/);
    const envelope = said().slice(
      said().indexOf("[debug:envelope]"),
      said().indexOf("[debug:envelope]") + 600,
    );
    expect(envelope).toContain("specversion: '1.0'");
    expect(envelope).toContain("source: 'inny://user-events/meeting_note-v1/src1'");
    expect(envelope).toContain("type: 'user.meeting_note.v1'");
    expect(envelope).toContain("datacontenttype: 'application/json'");
    // An object at the API: a type mismatch is refused too, and nothing is sent.
    const refused = await window.evaluate(() =>
      (
        window as unknown as {
          inny: { app: { fireEvent(t: string, v: object): Promise<unknown> } };
        }
      ).inny.app.fireEvent("user.meeting_note.v1", { title: "x", minutes: "abc" }),
    );
    expect(refused).toEqual({ ok: false, error: "Field minutes must be integer." });

    // ── the source's input: an invalid payload fails the input; a snapshot action runs ──
    expect(await request(Number(port), "POST", "/red/inject/go-bad")).toBe(200);
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(/\[debug:caught\][\s\S]{0,200}Field title is required/);
    const runsBefore = count(said(), /\[debug:run\]/g);
    expect(await request(Number(port), "POST", "/red/inject/go-rec")).toBe(200);
    const recorded = /snapshot (\S+) recorded from \[inny-viewts-record rec\]/;
    await expect.poll(() => recorded.exec(said())?.[1], { timeout: 10_000 }).toBeDefined();
    const snapshotId = recorded.exec(said())?.[1] as string;
    const pressed = await window.evaluate(
      (id) =>
        (
          window as unknown as {
            inny: { app: { pressAction(i: string, a: string, v: object): Promise<unknown> } };
          }
        ).inny.app.pressAction(id, "again", { note: "again" }),
      snapshotId,
    );
    expect(pressed).toEqual({ ok: true, value: null });
    await expect
      .poll(said, { timeout: 10_000 })
      .toMatch(
        /\[debug:ping payload\]\s*\{\s*state: \{ from: 'a snapshot' \},\s*values: \{ note: 'again' \}\s*\}/,
      );
    await expect.poll(() => count(said(), /\[debug:run\]/g)).toBe(runsBefore + 1);
    const runs = [...said().matchAll(/\[debug:run\] \n?'?([0-9a-f-]{36})/g)].map((m) => m[1]);
    expect(new Set(runs).size).toBe(runs.length);

    // ── a schema change makes v2; v1 is unchanged; an unchanged schema is refused ───────
    await item(window, "user.meeting_note.v1").getByTestId("event-new-version").click();
    await expect(window.getByTestId("event-version-of")).toHaveText(
      "New version of user.meeting_note",
    );
    await expect(window.getByTestId("field-path-4")).toHaveValue("where.room");
    await fillRow(window, 5, "recorded_by", "string");
    await window.getByTestId("event-submit").click();
    await expect(message(window)).toContainText("Created user.meeting_note.v2.");
    const versioned = await waitForRunning(window, "runtime", created.generation + 1);
    await expect(palette(window, V2)).toHaveCount(1, { timeout: 15_000 });
    await expect(palette(window, V1)).toHaveCount(1);
    expect(stored(userData)[0]).toEqual(v1);
    expect(declared(userData)).toEqual(["meeting_note-v1", "meeting_note-v2", "ping-v1"]);
    await item(window, "user.meeting_note.v2").getByTestId("event-new-version").click();
    await window.getByTestId("event-submit").click();
    await expect(message(window)).toHaveText(
      "The schema is unchanged from user.meeting_note.v2; no new version was made.",
    );
    expect(stored(userData)).toHaveLength(3);

    // ── deletion refused: a deployed node, and an undeployed node in the editor ─────────
    await editInTheEditor(window, port, [
      { id: EDIT_ID, type: "comment", name: "UNDEPLOYED EDIT", x: 200, y: 100, z: "tab1" },
      { id: DRAFT_ID, type: V2, x: 200, y: 160, z: "tab1", wires: [[]] },
    ]);
    await window.getByTestId("nav-editor").click();
    await window.getByTestId("nav-events").click();
    await expect(item(window, "user.meeting_note.v2")).toContainText(
      `In the editor, not deployed: ${DRAFT_ID}.`,
      { timeout: 10_000 },
    );
    await item(window, "user.meeting_note.v2").getByTestId("event-delete").click();
    await expect(message(window)).toHaveText(
      `Refused: user.meeting_note.v2 is used by node(s) ${DRAFT_ID} in the editor, not yet ` +
        "deployed; remove them from the flow (and deploy) first.",
    );
    await item(window, "user.meeting_note.v1").getByTestId("event-delete").click();
    await expect(message(window)).toHaveText(
      "Refused: user.meeting_note.v1 is used by deployed node(s) src1; remove them from the flow " +
        "(and deploy) first.",
    );
    expect(stored(userData)).toHaveLength(3);
    expect((await waitForRunning(window, "runtime")).generation).toBe(versioned.generation);

    // ── once unused, deleted: only the runtime restarts, the editor keeps its edit ──────
    await editorPage(window, port).evaluate((id) => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      RED.nodes.remove(id);
      RED.view.redraw(true);
    }, DRAFT_ID);
    await item(window, "user.meeting_note.v2").getByTestId("event-delete").click();
    await expect(message(window)).toContainText("Deleted user.meeting_note.v2.");
    await waitForRunning(window, "runtime", versioned.generation + 1);
    await expect(palette(window, V2)).toHaveCount(0, { timeout: 15_000 });
    await expect(palette(window, V1)).toHaveCount(1);
    expect(stored(userData).map((t) => t.type)).toEqual(["user.meeting_note.v1", "user.ping.v1"]);
    expect(declared(userData)).toEqual(["meeting_note-v1", "ping-v1"]);
    await expect(item(window, "user.meeting_note.v2")).toHaveCount(0, { timeout: 10_000 });

    // Throughout: the same shell, and an editor never reloaded, its undeployed edit kept.
    expect(shell.pid).toBe(shellPid);
    expect(await app.evaluate(() => process.pid)).toBe(shellPid);
    expect(await editorState(window, port)).toEqual({
      mark: "this page was never reloaded",
      dirty: true,
      edit: true,
    });
    expect(said()).toContain("restarting the runtime only, for its node types");
    // No unload was attempted while the edit was held: the editor was never reloaded.
    expect(dialogs).toEqual([]);

    await window.getByTestId("quit").click();
    await window.getByTestId("quit-discard").click();
    await expect.poll(() => shell.exitCode, { timeout: 20_000 }).toBe(0);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch);
  }
});
