// Node-RED embedded in the real runtime, locked and guarded (plan 0018 WI-08), driven through
// the real shell/main.ts bundle: the editor in the app window, the palette lock (spec 11.4,
// 11.5), the deploy guard (11.3) and the Host check (plan 0018 §2.2).
import fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import {
  APP,
  isAlive,
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const FIXTURES = path.join(APP, "test", "fixtures");

/**
 * After a test, pass or fail: close an app a failure left running, so its children stop
 * writing into userData, then remove the scratch folder. Otherwise a failed assertion is
 * reported as the ENOTEMPTY of this cleanup, and the real failure is never seen.
 */
async function cleanUp(launched: readonly ElectronApplication[], scratch: string): Promise<void> {
  for (const app of launched) {
    const shell = app.process();
    if (shell.exitCode === null && shell.signalCode === null) {
      await app.close().catch(() => undefined);
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Node-RED's `core/common` (spec 11.5): the only types the palette may hold. */
const CORE_COMMON_TYPES = [
  "catch",
  "comment",
  "complete",
  "debug",
  "global-config",
  "inject",
  "junction",
  "link call",
  "link in",
  "link out",
  "status",
  "unknown",
];

interface Answer {
  readonly status: number;
  readonly text: string;
}

/** A request to the runtime with any Host header, which fetch() does not allow setting. */
function send(
  port: number,
  options: { method?: string; path: string; host?: string; body?: string; type?: string },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: options.host ?? `127.0.0.1:${String(port)}`,
      accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["content-type"] = options.type ?? "application/json";
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }
    const request = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, text });
        });
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

/** The status line a WebSocket handshake to the editor's comms gets back. */
function upgrade(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/red/comms",
      headers: {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(String(response.statusCode));
    });
    request.on("response", (response) => {
      response.resume();
      resolve(String(response.statusCode));
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      // A refused handshake may end before Node's parser reads the status line.
      if (error.code === "ECONNRESET" || error.code === "HPE_INVALID_CONSTANT") {
        resolve("reset");
        return;
      }
      reject(error);
    });
    request.end();
  });
}

const deploy = (port: number, nodes: unknown[]) =>
  send(port, { method: "POST", path: "/red/flows", body: JSON.stringify(nodes) });

/** Every type Node-RED has registered, by the admin API. */
async function registeredTypes(port: number): Promise<string[]> {
  const answer = await send(port, { path: "/red/nodes" });
  expect(answer.status).toBe(200);
  const sets = JSON.parse(answer.text) as { types: string[]; enabled: boolean }[];
  return sets.flatMap((set) => set.types).sort();
}

/** The pids the sleeper instances wrote, by node id. */
function sleeperPids(userData: string): Record<string, number> {
  const dir = path.join(userData, "pids");
  if (!fs.existsSync(dir)) {
    return {};
  }
  return Object.fromEntries(
    fs.readdirSync(dir).map((id) => [id, Number(fs.readFileSync(path.join(dir, id), "utf8"))]),
  );
}

/** userData prepared before the app starts: the sleeper types, and a module planted by hand. */
function plant(userData: string): { marker: string } {
  const nodeRed = path.join(userData, "node-red");
  fs.cpSync(path.join(FIXTURES, "node-red-sleeper"), path.join(nodeRed, "generated"), {
    recursive: true,
  });
  const planted = path.join(nodeRed, "node_modules", "node-red-contrib-inny-probe");
  fs.cpSync(path.join(FIXTURES, "node-red-probe-module"), planted, { recursive: true });
  // Listed as a user-installed module too, the strongest case: still never loaded.
  fs.writeFileSync(
    path.join(nodeRed, "package.json"),
    JSON.stringify({
      name: "node-red-project",
      dependencies: { "node-red-contrib-inny-probe": "1.0.0" },
    }),
  );
  return { marker: path.join(planted, "LOADED") };
}

/** The editor's frame in the app window, once Node-RED's editor has drawn its palette. */
async function editorFrame(window: Page, port: string) {
  await expect(window.getByTestId("editor")).toHaveAttribute(
    "src",
    `http://127.0.0.1:${port}/red/`,
  );
  const frame = window.frameLocator('[data-testid="editor"]');
  await expect(frame.locator('.red-ui-palette-node[data-palette-type="inject"]')).toHaveCount(1, {
    timeout: 20_000,
  });
  return frame;
}

test("the editor loads in the app window, and a kill -9 of the runtime brings it back on the same port", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    launched.push(app);
    const before = await waitForRunning(window, "runtime");
    const frame = await editorFrame(window, before.port);
    // The palette holds core/common and nothing else: no function, exec or template.
    for (const type of ["function", "exec", "template", "switch", "http request"]) {
      await expect(frame.locator(`.red-ui-palette-node[data-palette-type="${type}"]`)).toHaveCount(
        0,
      );
    }

    process.kill(before.pid, "SIGKILL");
    const after = await waitForRunning(window, "runtime", before.generation + 1);
    expect(after.port).toBe(before.port);
    expect(isAlive(before.pid)).toBe(false);
    // The frame was never pointed elsewhere, and the editor in it reaches the new runtime.
    await expect(window.getByTestId("editor")).toHaveAttribute(
      "src",
      `http://127.0.0.1:${before.port}/red/`,
    );
    const editor = window
      .frames()
      .find((f) => f.url().startsWith(`http://127.0.0.1:${before.port}/red/`));
    expect(editor).toBeDefined();
    await expect
      .poll(() => editor?.evaluate(async () => (await fetch("settings")).status), {
        timeout: 15_000,
      })
      .toBe(200);
    await expect(frame.locator('.red-ui-palette-node[data-palette-type="inject"]')).toHaveCount(1);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});

test("the palette lock: no install route, no planted module, only core/common of Node-RED's own", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { marker } = plant(userData);
    const { app, window } = await launchApp(env);
    launched.push(app);
    const { port: shown } = await waitForRunning(window, "runtime");
    const port = Number(shown);

    // Spec 11.4: install by name, by URL and by upload all answer 404.
    const byName = JSON.stringify({ module: "node-red-contrib-anything" });
    const byUrl = JSON.stringify({ module: "x", url: "https://example.invalid/x-1.0.0.tgz" });
    expect((await send(port, { method: "POST", path: "/red/nodes", body: byName })).status).toBe(
      404,
    );
    expect((await send(port, { method: "POST", path: "/red/nodes", body: byUrl })).status).toBe(
      404,
    );
    const boundary = "innyboundary";
    const upload =
      `--${boundary}\r\nContent-Disposition: form-data; name="tarball"; filename="x-1.0.0.tgz"\r\n` +
      `Content-Type: application/gzip\r\n\r\nnot really a tarball\r\n--${boundary}--\r\n`;
    const uploaded = await send(port, {
      method: "POST",
      path: "/red/nodes",
      body: upload,
      type: `multipart/form-data; boundary=${boundary}`,
    });
    expect(uploaded.status).toBe(404);

    // Spec 11.5 and the planted module: exactly core/common, the two planted sleeper types in
    // the generated folder, and the types the runtime generated there from the fixture
    // packages (WI-0018-09), the reference view nodes among them (WI-0018-10), and the
    // pop-out kit (WI-0018-11); and the first-party Anytype package with its e2e fixture
    // (WI-0018-20).
    expect(await registeredTypes(port)).toEqual(
      [
        ...CORE_COMMON_TYPES,
        "inny-anytype-create-object",
        "inny-anytype-read-object",
        "inny-anytype-read-space",
        "inny-anytype-search",
        "inny-anytype-update-object",
        "inny-everycontrol-probe",
        "inny-everycontrol-ticker",
        "inny-folderflow-link",
        "inny-folderflow-watch",
        "inny-popoutkit-ask",
        "inny-popoutkit-record",
        "inny-popoutkit-slow",
        "inny-rawnode-raw",
        "inny-rawnode-sleeper",
        "inny-rogue-sleeper",
        "inny-viewpy-ask",
        "inny-viewpy-record",
        "inny-viewts-ask",
        "inny-viewts-record",
      ].sort(),
    );
    expect(fs.existsSync(marker)).toBe(false);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});

test("the deploy guard refuses function, exec and template, and every running instance keeps its pid", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    plant(userData);
    const { app, window, output } = await launchApp(env);
    launched.push(app);
    const runtime = await waitForRunning(window, "runtime");
    const port = Number(runtime.port);

    const running = [
      { id: "tab1", type: "tab", label: "Flow 1" },
      { id: "s1", type: "inny-rawnode-sleeper", z: "tab1", wires: [] },
      { id: "s2", type: "inny-rawnode-sleeper", z: "tab1", wires: [] },
      { id: "i1", type: "inject", z: "tab1", wires: [["s1"]] },
    ];
    expect((await deploy(port, running)).status).toBe(204);
    await expect.poll(() => Object.keys(sleeperPids(userData)).sort()).toEqual(["s1", "s2"]);
    const pids = sleeperPids(userData);
    const flowsBefore = (await send(port, { path: "/red/flows" })).text;

    // Spec 11.3's answer, exactly.
    const excluded = await deploy(port, [
      ...running,
      { id: "f1", type: "function", z: "tab1", func: "return msg;", wires: [] },
      { id: "e1", type: "exec", z: "tab1", command: "touch", wires: [] },
      { id: "t1", type: "template", z: "tab1", wires: [] },
    ]);
    expect(excluded.status).toBe(400);
    expect(JSON.parse(excluded.text)).toEqual({
      code: "unknown_types",
      message: "Not installed in InnyTypes: function, exec, template",
    });

    // A registered type whose package is not in the store is refused the same way.
    const rogue = await deploy(port, [
      ...running,
      { id: "r1", type: "inny-rogue-sleeper", z: "tab1" },
    ]);
    expect(rogue.status).toBe(400);
    expect(JSON.parse(rogue.text)).toEqual({
      code: "unknown_types",
      message: "Not installed in InnyTypes: inny-rogue-sleeper",
    });

    // The single-flow routes, and a url-encoded deploy, cannot go round the guard.
    const oneFlow = JSON.stringify({ label: "x", nodes: [{ id: "e2", type: "exec" }] });
    expect((await send(port, { method: "POST", path: "/red/flow", body: oneFlow })).status).toBe(
      400,
    );
    expect(
      (await send(port, { method: "PUT", path: "/red/flow/tab1", body: oneFlow })).status,
    ).toBe(400);
    const encoded = await send(port, {
      method: "POST",
      path: "/red/flows",
      body: "flows[0][id]=e3&flows[0][type]=exec",
      type: "application/x-www-form-urlencoded",
    });
    expect(encoded.status).toBe(400);

    // Nothing stopped: the same instances, the same processes, the same runtime, the same flows.
    expect(sleeperPids(userData)).toEqual(pids);
    for (const pid of Object.values(pids)) {
      expect(isAlive(pid)).toBe(true);
    }
    expect((await waitForRunning(window, "runtime")).pid).toBe(runtime.pid);
    expect((await send(port, { path: "/red/flows" })).text).toBe(flowsBefore);
    expect(output.join("")).not.toContain("Waiting for missing types");

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    // Quitting closed the instances, and their processes with them.
    for (const pid of Object.values(pids)) {
      expect(isAlive(pid)).toBe(false);
    }
  } finally {
    await cleanUp(launched, scratch);
  }
});

test("a request whose Host header is not the loopback address and port is refused", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const launched: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    launched.push(app);
    const port = Number((await waitForRunning(window, "runtime")).port);

    for (const host of [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]) {
      expect((await send(port, { path: "/red/settings", host })).status).toBe(200);
    }
    for (const host of [
      `evil.example:${String(port)}`,
      "127.0.0.1:1",
      `127.0.0.1`,
      `[::1]:${String(port)}`,
    ]) {
      const refused = await send(port, { path: "/red/settings", host });
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.text)).toMatchObject({ code: "forbidden_host" });
    }
    // A deploy by DNS rebinding is refused before the guard even reads it.
    const rebound = await send(port, {
      method: "POST",
      path: "/red/flows",
      host: `evil.example:${String(port)}`,
      body: "[]",
    });
    expect(rebound.status).toBe(403);
    // The editor's WebSocket too, which never passes through Express.
    expect(await upgrade(port, `127.0.0.1:${String(port)}`)).toBe("101");
    expect(await upgrade(port, `evil.example:${String(port)}`)).not.toBe("101");

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(launched, scratch);
  }
});
