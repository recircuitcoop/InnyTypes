// Generated node types in the real app (plan 0018 WI-09), driven through the real
// shell/main.ts bundle: the every-control fixture package (test/fixtures/every-control) is
// generated into Node-RED's palette, deployed, and started with its config coerced and
// validated; a real flow carries a message from a fixture source through a fixture node to a
// debug node in the real editor; and the form draws in the real editor, rows and all, and
// deploys what it holds.
import fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import {
  expect,
  test,
  type ElectronApplication,
  type FrameLocator,
  type Page,
} from "@playwright/test";
import {
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const PROBE = "inny-everycontrol-probe";
const TICKER = "inny-everycontrol-ticker";
const SECRET = "s3cret-e2e-9f2c";

async function cleanUp(launched: readonly ElectronApplication[], scratch: string): Promise<void> {
  for (const app of launched) {
    const shell = app.process();
    if (shell.exitCode === null && shell.signalCode === null) {
      await app.close().catch(() => undefined);
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function request(
  port: number,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { accept: "application/json" };
    if (text !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(text));
    }
    const sent = http.request(
      { host: "127.0.0.1", port, method, path: route, headers },
      (response) => {
        let answer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (answer += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, text: answer });
        });
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });
}

/** The start frame a probe instance wrote to its data folder, once it has. */
function startFrame(userData: string, id: string): Record<string, unknown> | null {
  const file = path.join(userData, "instances", id, "start.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // still being written
  }
}

/** The editor's frame, once Node-RED's editor has drawn the generated types' palette. */
async function editorFrame(window: Page, port: number): Promise<FrameLocator> {
  await expect(window.getByTestId("editor")).toHaveAttribute(
    "src",
    `http://127.0.0.1:${String(port)}/red/`,
  );
  const frame = window.frameLocator('[data-testid="editor"]');
  await expect(frame.locator(`.red-ui-palette-node[data-palette-type="${PROBE}"]`)).toHaveCount(1, {
    timeout: 20_000,
  });
  return frame;
}

/** The editor's own page, to call its RED from. */
function editorPage(window: Page, port: number) {
  const editor = window
    .frames()
    .find((f) => f.url().startsWith(`http://127.0.0.1:${String(port)}/red/`));
  if (editor === undefined) {
    throw new Error("the editor frame is not loaded");
  }
  return editor;
}

/** The part of the editor's own RED the form test calls, in the editor's page. */
interface EditorNode {
  valid: boolean;
  validationErrors: string[];
  label: string;
  volumes: unknown;
}
interface EditorRed {
  view: { importNodes(nodes: unknown[]): void };
  nodes: { node(id: string): EditorNode };
  editor: { validateNode(node: EditorNode): void; edit(node: EditorNode): void };
}

/** A probe as Node-RED keeps it after the editor saved it: values as text. */
const PROBE_FIELDS = {
  label: "the label",
  ratio: "0.5",
  count: "",
  enabled: true,
  mode: "slow",
  level: "3",
  retry: { attempts: "2", backoff: "0.25" },
  volumes: [
    { name: "media", path: "/Volumes/media", size_gb: "1500", readonly: "true" },
    { name: "tmp", path: "/tmp", size_gb: "", readonly: false },
  ],
};

test("a fixture package with every control deploys, its start frame carries the coerced, validated config, and a real flow reaches debug", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp(env);
    launched.push(app);
    const port = Number((await waitForRunning(window, "runtime")).port);
    const frame = await editorFrame(window, port);

    // Each type is its own palette entry, in its kind's category.
    await expect(frame.locator(`.red-ui-palette-node[data-palette-type="${TICKER}"]`)).toHaveCount(
      1,
    );

    const flows = [
      { id: "tab1", type: "tab", label: "Flow 1" },
      { id: "tk", type: TICKER, z: "tab1", greeting: "hi", delay_ms: "2000", wires: [["pr"]] },
      {
        id: "pr",
        type: PROBE,
        z: "tab1",
        name: "probe",
        ...PROBE_FIELDS,
        credentials: { token: SECRET },
        wires: [["dbg-first"], ["dbg-second"]],
      },
      // Refused by its schema: it must start nothing.
      {
        id: "bad",
        type: PROBE,
        z: "tab1",
        ...PROBE_FIELDS,
        count: "three",
        credentials: { token: SECRET },
        wires: [[], []],
      },
      ...["first", "second"].map((port) => ({
        id: `dbg-${port}`,
        type: "debug",
        z: "tab1",
        name: `${port} port`,
        active: true,
        tosidebar: true,
        console: true,
        complete: "payload",
        targetType: "msg",
        wires: [],
      })),
    ];
    expect((await request(port, "POST", "/red/flows", flows)).status).toBe(204);

    // The start frame: every value its schema type, the default filled, the secret delivered.
    await expect.poll(() => startFrame(userData, "pr"), { timeout: 15_000 }).not.toBeNull();
    expect(startFrame(userData, "pr")).toEqual({
      t: "start",
      protocol: 2,
      node: { id: "pr", type: PROBE, name: "probe" },
      config: {
        label: "the label",
        ratio: 0.5,
        count: 3,
        enabled: true,
        mode: "slow",
        level: 3,
        retry: { attempts: 2, backoff: 0.25 },
        volumes: [
          { name: "media", path: "/Volumes/media", size_gb: 1500, readonly: true },
          { name: "tmp", path: "/tmp", readonly: false },
        ],
      },
      credentials: { token: SECRET },
      data_dir: path.join(userData, "instances", "pr"),
    });

    // The message path: ticker → probe, which answers on its SECOND port → the debug node
    // on that port only. The debug nodes write to Node-RED's log, which is the one log.
    const said = () => output.join("");
    await expect
      .poll(said, { timeout: 15_000 })
      .toMatch(/\[debug:second port\] \n\{ received: \{ greeting: 'hi' \}, label: 'the label' \}/);
    expect(said()).not.toContain("[debug:first port]");

    // The refused instance started no process, and said why.
    expect(startFrame(userData, "bad")).toBeNull();
    await expect
      .poll(() => output.join(""))
      .toContain(`[${PROBE} bad] not started: its configuration is refused: count must be integer`);

    // The secret is a credential: in flows_cred.json, encrypted, and never in flows.json.
    const nodeRed = path.join(userData, "node-red");
    expect(fs.readFileSync(path.join(nodeRed, "flows.json"), "utf8")).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(nodeRed, "flows_cred.json"), "utf8")).not.toContain(SECRET);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});

test("the form in the real editor: every control, required marked, rows added, removed and reordered, validated before deploy", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    launched.push(app);
    const port = Number((await waitForRunning(window, "runtime")).port);
    const frame = await editorFrame(window, port);
    const editor = editorPage(window, port);

    // A probe with an empty label: the editor's ajv check marks it invalid, naming the field.
    const judged = await editor.evaluate((type) => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      RED.view.importNodes([
        {
          id: "f1",
          type,
          x: 200,
          y: 100,
          label: "",
          volumes: [
            { name: "a", path: "/a" },
            { name: "b", path: "/b" },
          ],
        },
      ]);
      const node = RED.nodes.node("f1");
      RED.editor.validateNode(node);
      return { valid: node.valid, errors: node.validationErrors };
    }, PROBE);
    expect(judged.valid).toBe(false);
    expect(judged.errors).toEqual(["label must NOT have fewer than 1 characters"]);

    await editor.evaluate(() => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      RED.editor.edit(RED.nodes.node("f1"));
    });
    const form = frame.locator(`.inny-form[data-inny-type="${PROBE}"]`);
    await expect(form).toBeVisible();
    for (const field of ["label", "ratio", "count", "enabled", "mode", "level"]) {
      await expect(form.locator(`[data-inny-field="${field}"]`)).toHaveCount(1);
    }
    await expect(form.locator('[data-inny-field="retry.attempts"]')).toHaveCount(1);
    await expect(form.locator('[data-inny-field="volumes.1.name"]')).toHaveValue("b");
    // Required fields are marked: label, count, volumes, retry.attempts and each row's name
    // and path; the token, a credential, in the type's own template.
    await expect(form.locator(".inny-required")).toHaveCount(3 + 1 + 2 * 2);
    await expect(frame.locator('label[for="node-input-token"] .inny-required')).toHaveCount(1);
    await expect(frame.locator("#node-input-token")).toHaveAttribute("type", "password");

    // Clicks in the tray are dispatched: the hidden test window is small, and Node-RED's
    // sidebar can lie over the edit tray, which is layout, not the form under test. The
    // header's Deploy button is always in view, and is clicked.
    const table = form.locator('[data-inny-table="volumes"]');
    await table.locator('[data-inny-action="add"]').dispatchEvent("click");
    await expect(table.locator("[data-inny-row]")).toHaveCount(3);
    await table
      .locator('[data-inny-row="volumes.2"] [data-inny-action="remove"]')
      .dispatchEvent("click");
    await expect(table.locator("[data-inny-row]")).toHaveCount(2);
    await table
      .locator('[data-inny-row="volumes.1"] [data-inny-action="up"]')
      .dispatchEvent("click");
    await expect(form.locator('[data-inny-field="volumes.0.name"]')).toHaveValue("b");
    await form.locator('[data-inny-field="label"]').fill("Filled");
    await form.locator('[data-inny-field="count"]').fill("5");
    await form.locator('[data-inny-field="retry.attempts"]').fill("1");
    await frame.locator("#node-input-token").fill(SECRET);
    await frame.locator("#node-dialog-ok").dispatchEvent("click");

    const saved = await editor.evaluate(() => {
      const RED = (window as unknown as { RED: EditorRed }).RED;
      const node = RED.nodes.node("f1");
      RED.editor.validateNode(node);
      return { valid: node.valid, label: node.label, volumes: node.volumes };
    });
    expect(saved).toEqual({
      valid: true,
      label: "Filled",
      volumes: [
        { name: "b", path: "/b", size_gb: "", readonly: false },
        { name: "a", path: "/a", size_gb: "", readonly: false },
      ],
    });

    // Deployed from the editor: the start frame holds what the form held, coerced.
    await frame.locator("#red-ui-header-button-deploy").click();
    await expect.poll(() => startFrame(userData, "f1"), { timeout: 15_000 }).not.toBeNull();
    const started = startFrame(userData, "f1");
    expect(started?.["config"]).toMatchObject({
      label: "Filled",
      count: 5,
      retry: { attempts: 1 },
      volumes: [
        { name: "b", path: "/b", readonly: false },
        { name: "a", path: "/a", readonly: false },
      ],
    });
    expect(started?.["credentials"]).toEqual({ token: SECRET });

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});
