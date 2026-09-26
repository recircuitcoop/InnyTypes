// Install, removal and verified hot-add in the real app (WI-0018-16), driven through the real
// shell/main.ts bundle and the Packages page.
//
// - A signed package installed from the catalogue (a local HTTPS server with its own signing
//   key) has its types in the palette with no reload, deploys, and runs from its own uv
//   environment; the node's attempts to write into its package folder and the live root fail.
//   Only the runtime restarted, and its time is logged.
// - A tampered archive is refused and nothing of it is written.
// - Removal is refused while a deployed flow uses its types, then while only an undeployed one
//   in the editor does, and is then allowed: its types leave the palette.
// - An install from file is unsigned: it needs the confirmation, and is marked unsigned.
import fs from "node:fs";
import * as http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { unsealTree } from "../../src/adapters/fs/package-roots";
import { Signer } from "../fakes/minisign-signer";
import { signedArchive, type Files } from "../fakes/package-archive";
import {
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

const PROBE = "inny-probekit-probe";
const DEV = "inny-devkit-echo";
/** A uv venv is built at install: allow it its time. */
const INSTALL_MS = 120_000;

/**
 * The probe node: the protocol by hand, the standard library only. On an input it tries to
 * write into its own package folder and into the live root, and writes what happened, with
 * the interpreter it runs on, into its data folder.
 */
const PROBE_NODE = `import json, os, sys

def send(frame):
    sys.stdout.write(json.dumps(frame) + "\\n")
    sys.stdout.flush()

def attempt(target):
    try:
        with open(target, "w") as handle:
            handle.write("written by a node")
        return "written"
    except OSError as error:
        return type(error).__name__

start = json.loads(sys.stdin.readline())
send({"t": "ready"})
for line in sys.stdin:
    frame = json.loads(line)
    if frame.get("t") == "input":
        package = os.getcwd()
        result = {
            "executable": sys.executable,
            "prefix": sys.prefix,
            "package": package,
            "package_write": attempt(os.path.join(package, "written-by-node.txt")),
            "root_write": attempt(os.path.join(package, "..", "..", "dropped-by-node.json")),
        }
        os.makedirs(start["data_dir"], exist_ok=True)
        with open(os.path.join(start["data_dir"], "probe.json"), "w") as handle:
            json.dump(result, handle)
        send({"t": "emit", "port": "out", "data": result, "in": frame["id"]})
        send({"t": "done", "in": frame["id"]})
    elif frame.get("t") == "close":
        send({"t": "closed"})
        break
`;

function declaration(name: string, environment: unknown, command: string[], typeId: string) {
  return JSON.stringify({
    protocol: 2,
    package: name,
    version: "0.1.0",
    environment,
    types: [
      {
        id: typeId,
        kind: "node",
        label: `${name} ${typeId}`,
        command,
        config: { type: "object" },
        outputs: [{ port: "out", event: `${name}.out.v1` }],
      },
    ],
  });
}

const PROBE_FILES: Files = {
  "inny-package.json": declaration(
    "probekit",
    { kind: "uv-python", python: "3.13" },
    ["{python}", "{package}/node.py"],
    "probe",
  ),
  "node.py": PROBE_NODE,
};

const DEV_FILES: Files = {
  "inny-package.json": declaration(
    "devkit",
    { kind: "node", node: ">=22" },
    ["{node}", "{package}/node.js"],
    "echo",
  ),
  "node.js": "process.stdin.resume();\n",
};

/** A local HTTPS catalogue: its document and signature, and the archives it offers. */
async function serveCatalogue(signer: Signer): Promise<{ url: string; close(): Promise<void> }> {
  const published = new Map<string, Uint8Array>();
  const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
    const body = published.get(request.url ?? "");
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": String(body.length) }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const document = new TextEncoder().encode(
    JSON.stringify({
      catalogue: 1,
      plugins: [
        {
          id: "probekit",
          summary: "Probes where it runs.",
          source: "index",
          archive: "probekit.tgz",
        },
        {
          id: "tampered",
          summary: "Changed after it was signed.",
          source: "index",
          archive: "tampered.tgz",
        },
      ],
    }),
  );
  published.set("/catalogue.json", document);
  published.set("/catalogue.json.minisig", new TextEncoder().encode(signer.sign(document)));
  published.set("/probekit.tgz", signedArchive(PROBE_FILES, signer));
  const tampered = {
    ...PROBE_FILES,
    "inny-package.json": declaration(
      "tampered",
      { kind: "uv-python", python: "3.13" },
      ["{python}", "{package}/node.py"],
      "probe",
    ),
  };
  published.set(
    "/tampered.tgz",
    signedArchive(tampered, signer, {
      after: { "node.py": "import os\nos.system('echo evil')\n" },
    }),
  );
  return {
    url: `${url}/catalogue.json`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function request(port: number, method: string, route: string, body?: unknown) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          accept: "application/json",
          ...(text === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(text)),
              }),
        },
      },
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

const palette = (window: Page, type: string) =>
  window
    .frameLocator('[data-testid="editor"]')
    .locator(`.red-ui-palette-node[data-palette-type="${type}"]`);

function editorPage(window: Page, port: number) {
  const editor = window
    .frames()
    .find((f) => f.url().startsWith(`http://127.0.0.1:${String(port)}/red/`));
  if (editor === undefined) {
    throw new Error("the editor frame is not loaded");
  }
  return editor;
}

/** Every inny-package.json under the install base: none may be written before verification. */
function declarationsUnder(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => path.basename(file) === "inny-package.json");
}

async function cleanUp(apps: readonly ElectronApplication[], scratch: string): Promise<void> {
  for (const app of apps) {
    const shell = app.process();
    const running = (): boolean => shell.exitCode === null && shell.signalCode === null;
    if (running()) {
      shell.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (running()) {
        shell.kill("SIGKILL");
      }
    }
  }
  // The live packages are sealed; made writable again to be deleted.
  unsealTree(scratch);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function openPackages(window: Page): Promise<void> {
  await window.getByTestId("nav-packages").click();
  await expect(window.getByTestId("page-packages")).toBeVisible();
}

async function backToEditor(window: Page): Promise<void> {
  await window.getByTestId("nav-editor").click();
}

test("a signed package from the catalogue: refused tampered, installed, in the palette without reload, run from its own environment, removed only when no flow uses it", async () => {
  test.setTimeout(6 * 60_000);
  const { scratch, userData, env } = scratchDirectories();
  const signer = new Signer();
  const catalogue = await serveCatalogue(signer);
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp({
      ...env,
      INNYTYPES_E2E_HOOKS: "1",
      INNYTYPES_CATALOGUE_URL: catalogue.url,
      INNYTYPES_CATALOGUE_KEY: signer.publicKeyLine,
      INNYTYPES_TEST_CATALOGUE_CA: CERT,
    });
    apps.push(app);
    // The editor's beforeunload guard is left to the app, as with no driver attached (see
    // editor-sync.e2e.ts): a dialog nobody listens for is dismissed by the driver.
    window.on("dialog", () => undefined);
    const said = () => output.join("");
    const shellPid = app.process().pid;
    const first = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");
    const port = Number(first.port);
    await expect(palette(window, "inject")).toHaveCount(1, { timeout: 20_000 });
    // A mark on the editor's page: a reload would lose it.
    await editorPage(window, port).evaluate(() => {
      (window as unknown as { innyMark: string }).innyMark = "never reloaded";
    });

    await openPackages(window);
    await expect(window.locator('[data-testid="catalogue-item"]')).toHaveCount(2);

    // Tampered: refused, nothing of it written, nothing restarted.
    await window
      .locator(
        '[data-testid="catalogue-item"][data-id="tampered"] [data-testid="catalogue-install"]',
      )
      .click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      "Not installed: node.py does not match its sha256 in files.json",
      { timeout: 30_000 },
    );
    expect(declarationsUnder(path.join(userData, "node-packages"))).toEqual([]);
    expect((await waitForRunning(window, "runtime")).generation).toBe(first.generation);

    // Signed: installed; only the runtime restarted.
    await window
      .locator(
        '[data-testid="catalogue-item"][data-id="probekit"] [data-testid="catalogue-install"]',
      )
      .click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      "probekit 0.1.0 is installed. Its types are in the editor's palette.",
      { timeout: INSTALL_MS },
    );
    const second = await waitForRunning(window, "runtime", first.generation + 1);
    expect(second.port).toBe(first.port);
    expect(app.process().pid).toBe(shellPid);
    expect((await waitForRunning(window, "services")).pid).toBe(services.pid);
    expect(said()).toMatch(
      /install: probekit 0\.1\.0 is live; only the runtime restarted, in \d+ ms \(P11a\)/,
    );
    await expect(
      window.locator('[data-testid="package-item"][data-name="probekit"]'),
    ).toHaveAttribute("data-kind", "installed");
    await expect(
      window.locator(
        '[data-testid="package-item"][data-name="probekit"] [data-testid="package-unsigned"]',
      ),
    ).toHaveCount(0);

    // In the palette with no reload.
    await backToEditor(window);
    await expect(palette(window, PROBE)).toHaveCount(1, { timeout: 15_000 });
    expect(
      await editorPage(window, port).evaluate(
        () => (window as unknown as { innyMark?: string }).innyMark ?? null,
      ),
    ).toBe("never reloaded");

    // Deployed, and run from its own environment; its writes into the package folder fail.
    const flows = [
      { id: "tab1", type: "tab", label: "Flow 1" },
      {
        id: "go",
        type: "inject",
        z: "tab1",
        once: true,
        onceDelay: 0.1,
        repeat: "",
        payloadType: "date",
        wires: [["pr"]],
      },
      { id: "pr", type: PROBE, z: "tab1", wires: [[]] },
    ];
    expect((await request(port, "POST", "/red/flows", flows)).status).toBe(204);
    const probeFile = path.join(userData, "instances", "pr", "probe.json");
    await expect.poll(() => fs.existsSync(probeFile), { timeout: 30_000 }).toBe(true);
    const probe = JSON.parse(fs.readFileSync(probeFile, "utf8")) as Record<string, string>;
    const live = path.join(userData, "node-packages", "packages", "probekit");
    expect(probe["package"]).toBe(path.join(live, "package"));
    expect(probe["prefix"]).toBe(path.join(live, "environment", "venv"));
    expect(probe["package_write"]).toBe("PermissionError");
    expect(probe["root_write"]).toBe("PermissionError");
    expect(fs.existsSync(path.join(live, "package", "written-by-node.txt"))).toBe(false);

    // Removal: refused while the deployed flow uses its type.
    await openPackages(window);
    await window
      .locator('[data-testid="package-item"][data-name="probekit"] [data-testid="package-remove"]')
      .click();
    await expect(window.getByTestId("packages-message")).toContainText(
      "Not removed: the deployed flows use inny-probekit-probe",
    );
    // Deployed without it; the editor reloaded to show just that, then given an undeployed probe.
    expect((await request(port, "POST", "/red/flows", [flows[0]])).status).toBe(204);
    await backToEditor(window);
    await window.getByTestId("editor").evaluate((frame: HTMLIFrameElement) => {
      const address = frame.src;
      frame.src = address;
    });
    await expect(palette(window, PROBE)).toHaveCount(1, { timeout: 20_000 });
    await expect
      .poll(
        () =>
          editorPage(window, port).evaluate((type) => {
            const RED = (
              window as unknown as {
                RED: {
                  nodes: { node(id: string): unknown; dirty(set?: boolean): boolean };
                  view: { importNodes(nodes: unknown[], options: Record<string, unknown>): void };
                };
              }
            ).RED;
            if (!RED.nodes.node("undeployed-probe")) {
              RED.view.importNodes(
                [{ id: "undeployed-probe", type, x: 200, y: 100, z: "tab1", wires: [[]] }],
                { touchImport: true, notify: false },
              );
              RED.nodes.dirty(true);
            }
            return Boolean(RED.nodes.node("undeployed-probe"));
          }, PROBE),
        { timeout: 10_000 },
      )
      .toBe(true);
    await openPackages(window);
    await window
      .locator('[data-testid="package-item"][data-name="probekit"] [data-testid="package-remove"]')
      .click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      "Not removed: the editor's undeployed flows use inny-probekit-probe; delete those nodes " +
        "(and deploy) before removing it.",
    );
    expect(fs.existsSync(live)).toBe(true);

    // The undeployed node discarded (the editor reloaded from the deployed flows): removed.
    await backToEditor(window);
    await window.getByTestId("editor").evaluate((frame: HTMLIFrameElement) => {
      const address = frame.src;
      frame.src = address;
    });
    await expect(palette(window, "inject")).toHaveCount(1, { timeout: 20_000 });
    await openPackages(window);
    const before = await waitForRunning(window, "runtime");
    await window
      .locator('[data-testid="package-item"][data-name="probekit"] [data-testid="package-remove"]')
      .click();
    await expect(window.getByTestId("packages-message")).toHaveText("probekit 0.1.0 is removed.", {
      timeout: 60_000,
    });
    await waitForRunning(window, "runtime", before.generation + 1);
    expect(app.process().pid).toBe(shellPid);
    expect(fs.existsSync(live)).toBe(false);
    expect(
      fs
        .readdirSync(path.join(userData, "node-red", "generated"))
        .filter((file) => file.startsWith("inny-probekit-")),
    ).toEqual([]);
    await backToEditor(window);
    await expect(palette(window, PROBE)).toHaveCount(0, { timeout: 15_000 });

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch);
    await catalogue.close();
  }
});

test("install from file is unsigned: it asks first, Cancel installs nothing, and the package is marked unsigned", async () => {
  test.setTimeout(3 * 60_000);
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    const first = await waitForRunning(window, "runtime");
    // The editor is let finish loading before its page is hidden.
    await expect(palette(window, "inject")).toHaveCount(1, { timeout: 20_000 });
    const folder = path.join(scratch, "devkit");
    for (const [file, data] of Object.entries(DEV_FILES)) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, file), data);
    }
    // The shell's own file chooser, answered as a person choosing the folder would.
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, folder);

    await openPackages(window);
    await window.getByTestId("packages-install-file").click();
    await expect(window.getByTestId("unsigned-question")).toHaveText(
      `${folder} is not signed: nobody vouches for its code, and it will run with your permissions.`,
    );
    await window.getByTestId("unsigned-cancel").click();
    await expect(window.getByTestId("packages-message")).toHaveText("Nothing was installed.");
    expect(fs.existsSync(path.join(userData, "node-packages", "packages", "devkit"))).toBe(false);
    expect((await waitForRunning(window, "runtime")).generation).toBe(first.generation);

    await window.getByTestId("packages-install-file").click();
    await window.getByTestId("unsigned-confirm").click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      "devkit 0.1.0 is installed, unsigned. Its types are in the editor's palette.",
      { timeout: 60_000 },
    );
    await expect(
      window.locator(
        '[data-testid="package-item"][data-name="devkit"] [data-testid="package-unsigned"]',
      ),
    ).toHaveText("unsigned");
    await waitForRunning(window, "runtime", first.generation + 1);
    await backToEditor(window);
    await expect(palette(window, DEV)).toHaveCount(1, { timeout: 20_000 });

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch);
  }
});
