// Install, removal and verified hot-add in the real app (WI-0018-16), driven through the real
// shell/main.ts bundle and Configuration › General's Packages.
//
// - A signed package installed from the catalogue (a local HTTPS server with its own signing
//   key) has its types in the canvas's palette, deploys, and runs from its own uv environment;
//   the node's attempts to write into its package folder and the live root fail. Only the
//   runtime restarted, and its time is logged.
// - A tampered archive is refused and nothing of it is written.
// - Removal is refused while a deployed flow uses its types, naming the flow and the step, and
//   is then allowed: its types leave the palette.
import fs from "node:fs";
import * as os from "node:os";
import * as http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expect,
  test,
  type ElectronApplication,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import { unsealTree } from "../../src/adapters/fs/package-roots";
import { Signer } from "../fakes/minisign-signer";
import { signedArchive, type Files } from "../fakes/package-archive";
import { STRINGS } from "../../src/ui/strings";
import {
  cleanUp,
  isAlive,
  launchApp,
  openCanvas,
  openGeneral,
  quit,
  processesNaming,
  scratchDirectories,
  shellOf,
  waitForRunning,
} from "./app-harness";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

const PROBE = "inny-probekit-probe";
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

const palette = (editor: FrameLocator, type: string) =>
  editor.locator(`.red-ui-palette-node[data-palette-type="${type}"]`);

/** Every inny-package.json under the install base: none may be written before verification. */
function declarationsUnder(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => path.basename(file) === "inny-package.json");
}

test("a signed package from the catalogue: refused tampered, installed, in the canvas's palette, run from its own environment, removed only when no flow uses it", async () => {
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
    // quit-question.e2e.ts): a dialog nobody listens for is dismissed by the driver.
    window.on("dialog", () => undefined);
    const said = () => output.join("");
    const shellPid = shellOf(app).pid ?? 0;
    const first = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");
    const port = Number(first.port);
    let general = await openGeneral(window);
    const message = () => general.getByTestId("packages-message");
    const offer = (id: string) => general.locator(`[data-testid="package-offer"][data-id="${id}"]`);

    // Add a package… › From the catalogue: both entries are offered.
    await general.getByTestId("packages-add").click();
    await window.getByRole("menuitem", { name: STRINGS["packages.fromCatalogue"] }).click();
    await expect(general.getByTestId("package-offer")).toHaveCount(2, { timeout: 30_000 });

    // Tampered: refused, nothing of it written, nothing restarted.
    await offer("tampered").getByTestId("package-offer-install").click();
    await expect(message()).toHaveText(STRINGS["packages.installFailed"], { timeout: 30_000 });
    expect(said()).toContain("node.py does not match its sha256 in files.json");
    expect(declarationsUnder(path.join(userData, "node-packages"))).toEqual([]);
    expect((await waitForRunning(window, "runtime")).generation).toBe(first.generation);

    // Signed: installed, listed as installed and signed; only the runtime restarted.
    await offer("probekit").getByTestId("package-offer-install").click();
    const row = packageRow(general, "probekit");
    await expect(row).toContainText(STRINGS["packages.installed"], { timeout: INSTALL_MS });
    await expect(row).not.toContainText(STRINGS["packages.unsigned"]);
    const second = await waitForRunning(window, "runtime", first.generation + 1);
    expect(second.port).toBe(first.port);
    expect(isAlive(shellPid)).toBe(true); // the same shell: never relaunched
    expect((await waitForRunning(window, "services")).pid).toBe(services.pid);
    expect(said()).toMatch(
      /install: probekit 0\.1\.0 is live; only the runtime restarted, in \d+ ms \(P11a\)/,
    );

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
      { id: "pr", type: PROBE, z: "tab1", name: "Probe", wires: [[]] },
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

    // Its type is in the canvas's palette.
    await expect(palette(await openCanvas(window, "tab1"), PROBE)).toHaveCount(1, {
      timeout: 15_000,
    });

    // Removal: refused while the deployed flow uses its type, naming the flow and the step.
    general = await openGeneral(window);
    await packageRow(general, "probekit").getByTestId("package-remove").click();
    await expect(message()).toContainText("Can't remove probekit: the flow Flow 1 uses its");
    expect(fs.existsSync(live)).toBe(true);

    // Deployed without it: removed, and only the runtime restarted.
    expect((await request(port, "POST", "/red/flows", [flows[0]])).status).toBe(204);
    const before = await waitForRunning(window, "runtime");
    await packageRow(general, "probekit").getByTestId("package-remove").click();
    await expect(packageRow(general, "probekit")).toHaveCount(0, { timeout: 60_000 });
    await waitForRunning(window, "runtime", before.generation + 1);
    expect(isAlive(shellPid)).toBe(true); // the same shell: never relaunched
    expect(fs.existsSync(live)).toBe(false);
    expect(
      fs
        .readdirSync(path.join(userData, "node-red", "generated"))
        .filter((file) => file.startsWith("inny-probekit-")),
    ).toEqual([]);
    await expect(palette(await openCanvas(window, "tab1"), PROBE)).toHaveCount(0, {
      timeout: 15_000,
    });

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
    await catalogue.close();
  }
});

// ── Configuration › General › Packages (plan 0022 §F; WI-0022-19) ───────────────────────────
//
// The four cases of plan 0022's acceptance, driven through the redesigned screen: an unregister
// refused while used names every flow and step; install from a folder (unsigned, asked first)
// and plan 0013's case, a folder whose code changed while its version did not, shown as changed
// on Check for changes and at the next start; Go back within seven days and not after; and no
// state shown without when it was checked.

/** A node that writes its package's version into its data folder at start, then sends ready. */
function versionNode(version: string): string {
  return `const fs = require("fs");
const path = require("path");
const readline = require("readline");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.t === "start") {
    fs.mkdirSync(frame.data_dir, { recursive: true });
    fs.writeFileSync(path.join(frame.data_dir, "version.txt"), ${JSON.stringify(version)});
    send({ t: "ready" });
  } else if (frame.t === "close") {
    send({ t: "closed" });
    process.exit(0);
  }
});
`;
}

/** Write a package folder: its declaration at `version` and its node, `body`. */
function writePackageFolder(folder: string, name: string, version: string, body: string): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "inny-package.json"),
    JSON.stringify({
      protocol: 2,
      package: name,
      version,
      environment: { kind: "node", node: ">=22" },
      types: [
        {
          id: "step",
          kind: "node",
          label: `${name} step`,
          command: ["{node}", "{package}/node.js"],
          config: { type: "object" },
          outputs: [{ port: "out", event: `${name}.out.v1` }],
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(folder, "node.js"), body);
}

/** The shell's folder chooser, answered as a person choosing `folder` would. */
async function choosing(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
}

const packageRow = (general: Locator, name: string) =>
  general.locator(`[data-testid="package-row"][data-name="${name}"]`);

/** Add a package… › From a folder on this Mac…: the unsigned dialog opens. */
async function addFromFolder(window: Page, general: Locator): Promise<Locator> {
  await general.getByTestId("packages-add").click();
  await window.getByRole("menuitem", { name: STRINGS["packages.fromFolderMenu"] }).click();
  const dialog = window.getByRole("alertdialog");
  await expect(dialog).toContainText(STRINGS["packages.unsigned.title"]);
  await expect(dialog).toContainText(STRINGS["packages.unsigned.body"]);
  return dialog;
}

/** Install `folder` from General, confirmed unsigned, and wait for its row. */
async function installFolder(
  app: ElectronApplication,
  window: Page,
  general: Locator,
  name: string,
  folder: string,
): Promise<Locator> {
  await choosing(app, folder);
  const dialog = await addFromFolder(window, general);
  await dialog.getByRole("button", { name: STRINGS["packages.installAnyway"] }).click();
  const row = packageRow(general, name);
  await expect(row).toContainText(STRINGS["packages.installed"], { timeout: INSTALL_MS });
  return row;
}

/** The update fact of a row: its words, as the pill says them. */
const facets = (row: Locator) => row.getByTestId("package-facet");

const tab = (id: string, label: string) => ({ id, type: "tab", label });
const step = (id: string, type: string, z: string, name: string) => ({
  id,
  type,
  z,
  name,
  x: 200,
  y: 100,
  wires: [[]],
});

test("unregister refused while used, naming every flow and step", async () => {
  test.setTimeout(4 * 60_000);
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    window.on("dialog", () => undefined);
    const port = Number((await waitForRunning(window, "runtime")).port);
    const general = await openGeneral(window);
    const folder = path.join(scratch, "usekit");
    writePackageFolder(folder, "usekit", "0.1.0", versionNode("0.1.0"));
    const row = await installFolder(app, window, general, "usekit", folder);
    await expect(row).toContainText(STRINGS["packages.registered"], { timeout: 30_000 });
    const type = "inny-usekit-step";
    const flows = [
      tab("ta", "Recordings to Anytype"),
      step("sa", type, "ta", "Transcribe"),
      tab("tb", "Invoices from the mailbox"),
      step("sb", type, "tb", "Read PDF"),
    ];
    const unregister = () => row.getByTestId("package-unregister").click();
    const message = general.getByTestId("packages-message");

    // Two uses: one sentence naming both, ending "Remove those steps first."
    expect((await request(port, "POST", "/red/flows", flows)).status).toBe(204);
    await unregister();
    await expect(message).toHaveText(
      "Can't unregister usekit: Recordings to Anytype uses its Transcribe step and Invoices " +
        "from the mailbox uses its Read PDF step. Remove those steps first.",
      { timeout: 15_000 },
    );
    // The names are drawn as names (ux-writing's italics).
    await expect(message.locator("em")).toHaveText([
      "usekit",
      "Recordings to Anytype",
      "Transcribe",
      "Invoices from the mailbox",
      "Read PDF",
    ]);

    // One use: ux-writing's sentence.
    expect((await request(port, "POST", "/red/flows", flows.slice(0, 3))).status).toBe(204);
    await unregister();
    await expect(message).toHaveText(
      "Can't unregister usekit: the flow Recordings to Anytype uses its Transcribe step. " +
        "Remove that step first.",
      { timeout: 15_000 },
    );
    expect(fs.existsSync(path.join(userData, "shell-settings.json"))).toBe(true);
    const stored = () =>
      (
        JSON.parse(fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8")) as {
          packages?: { unregistered?: string[] };
        }
      ).packages?.unregistered ?? [];
    expect(stored()).toEqual([]);

    // No use left: unregistered, its files kept, and the row says so once the runtime is back.
    expect((await request(port, "POST", "/red/flows", [flows[0], flows[2]])).status).toBe(204);
    await unregister();
    await expect(row).toContainText(STRINGS["packages.notRegistered"], { timeout: 60_000 });
    await expect(message).toHaveCount(0);
    expect(stored()).toEqual(["usekit"]);
    expect(fs.existsSync(path.join(userData, "node-packages", "packages", "usekit"))).toBe(true);
    await expect(row.getByTestId("package-register")).toBeVisible();

    // Registered again: offered again.
    await row.getByTestId("package-register").click();
    await expect(row).toContainText(STRINGS["packages.registered"], { timeout: 60_000 });
    await expect(row).not.toContainText(STRINGS["packages.notRegistered"]);
    expect(stored()).toEqual([]);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
  }
});

test("install from a folder, check for changes", async () => {
  test.setTimeout(4 * 60_000);
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const first = await launchApp(env);
    apps.push(first.app);
    await waitForRunning(first.window, "runtime");
    let general = await openGeneral(first.window);
    const folder = path.join(scratch, "monty");
    writePackageFolder(folder, "monty", "0.1.0", versionNode("0.1.0"));
    await choosing(first.app, folder);

    // Unsigned: asked first; Cancel installs nothing.
    const dialog = await addFromFolder(first.window, general);
    await dialog.getByRole("button", { name: STRINGS["dialog.cancel"] }).click();
    await expect(dialog).toHaveCount(0);
    await expect(packageRow(general, "monty")).toHaveCount(0);
    expect(fs.existsSync(path.join(userData, "node-packages", "packages", "monty"))).toBe(false);

    // Install anyway: its phases are pushed in order, and its row says "Installing · n%".
    await first.window.evaluate(() => {
      const seen = { phases: [] as unknown[][], shown: [] as string[] };
      (window as unknown as { innySeen: typeof seen }).innySeen = seen;
      (
        window as unknown as {
          inny: { app: { onPackages(listener: (changed: unknown) => void): void } };
        }
      ).inny.app.onPackages((changed) => {
        const c = changed as { name: string | null; phase: string; percent: number } | null;
        if (c !== null) seen.phases.push([c.name, c.phase, c.percent]);
      });
      new MutationObserver(() => {
        for (const facet of document.querySelectorAll('[data-testid="package-facet"]')) {
          const text = facet.textContent;
          const match = /Installing · \d+%/.exec(text);
          if (match !== null && seen.shown.at(-1) !== match[0]) seen.shown.push(match[0]);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    let row = await installFolder(first.app, first.window, general, "monty", folder);
    const seen = await first.window.evaluate(
      () => (window as unknown as { innySeen: { phases: unknown[][]; shown: string[] } }).innySeen,
    );
    expect(seen.phases).toEqual([
      [null, "fetching", 0],
      ["monty", "verifying", 25],
      ["monty", "building", 50],
      ["monty", "swapping", 90],
    ]);
    // Drawn as they came (a phase may pass between two paints), always forward, ending at 90%.
    expect(seen.shown.length).toBeGreaterThan(0);
    expect(seen.shown.at(-1)).toBe("Installing · 90%");
    const percents = seen.shown.map((text) => Number(/(\d+)%/.exec(text)?.[1]));
    expect(percents).toEqual([...percents].sort((a, b) => a - b));

    // Marked unsigned and from its folder, offering Check for changes.
    await expect(row).toContainText(`From a folder: ${folder}`);
    await expect(row.locator("em")).toHaveText(folder);
    await expect(row).toContainText(STRINGS["packages.unsigned"]);
    await expect(row.getByTestId("package-check-for-changes")).toHaveText(
      STRINGS["packages.checkForChanges"],
    );
    await expect(row.getByTestId("package-update")).toHaveCount(0);
    await expect(facets(row).last()).toContainText(STRINGS["packages.upToDate"]);

    // Plan 0013: new code, the same declared version. Check for changes says it changed.
    writePackageFolder(folder, "monty", "0.1.0", `${versionNode("0.1.0")}// a new event kind\n`);
    await row.getByTestId("package-check-for-changes").click();
    await expect(facets(row).last()).toContainText(STRINGS["packages.changed"], {
      timeout: 30_000,
    });
    await expect(row).toContainText("0.1.0");
    await expect(row.getByTestId("package-update")).toHaveCount(0);
    await quit(first.app);

    // At the next start, before anything is pressed, the row says so too.
    const second = await launchApp(env);
    apps.push(second.app);
    await waitForRunning(second.window, "runtime");
    general = await openGeneral(second.window);
    row = packageRow(general, "monty");
    await expect(facets(row).last()).toContainText(STRINGS["packages.changed"], {
      timeout: 30_000,
    });
    await expect(facets(row).last().getByTestId("package-checked")).toHaveText(
      /^checked today \d\d:\d\d$/,
    );

    await quit(second.app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
  }
});

/** A local HTTPS catalogue offering `verkit` at the versions published so far, signed. */
async function serveVerkit(): Promise<{
  url: string;
  key: string;
  publish(version: string): void;
  close(): Promise<void>;
}> {
  const signer = new Signer();
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
  const base = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const files = (version: string): Files => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "inny-verkit-"));
    writePackageFolder(folder, "verkit", version, versionNode(version));
    const read = (file: string) => fs.readFileSync(path.join(folder, file), "utf8");
    const out = { "inny-package.json": read("inny-package.json"), "node.js": read("node.js") };
    fs.rmSync(folder, { recursive: true });
    return out;
  };
  return {
    url: `${base}/catalogue.json`,
    key: signer.publicKeyLine,
    publish: (version) => {
      published.set(`/verkit-${version}.tgz`, signedArchive(files(version), signer));
      const document = new TextEncoder().encode(
        JSON.stringify({
          catalogue: 1,
          plugins: [
            {
              id: "verkit",
              summary: "Says its version.",
              source: "index",
              version,
              archive: `verkit-${version}.tgz`,
            },
          ],
        }),
      );
      published.set("/catalogue.json", document);
      published.set("/catalogue.json.minisig", new TextEncoder().encode(signer.sign(document)));
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

test("go back within seven days, not after", async () => {
  test.setTimeout(6 * 60_000);
  const { scratch, userData, env } = scratchDirectories();
  const catalogue = await serveVerkit();
  const withCatalogue = {
    ...env,
    INNYTYPES_E2E_HOOKS: "1",
    INNYTYPES_CATALOGUE_URL: catalogue.url,
    INNYTYPES_CATALOGUE_KEY: catalogue.key,
    INNYTYPES_TEST_CATALOGUE_CA: CERT,
  };
  const apps: ElectronApplication[] = [];
  const live = path.join(userData, "node-packages", "packages", "verkit");
  const kept = path.join(userData, "node-packages", "previous", "verkit");
  /** Move the live version's swap back by `days`, as if it was updated then. */
  const updatedDaysAgo = (days: number): void => {
    const record = path.join(live, "installed.json");
    unsealTree(live);
    const text = JSON.parse(fs.readFileSync(record, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      record,
      JSON.stringify({ ...text, installedAt: Date.now() - days * 24 * 60 * 60 * 1000 }),
    );
  };
  const launch = async () => {
    const running = await launchApp(withCatalogue);
    apps.push(running.app);
    running.window.on("dialog", () => undefined);
    const port = Number((await waitForRunning(running.window, "runtime")).port);
    const general = await openGeneral(running.window);
    return { ...running, port, general, row: packageRow(general, "verkit") };
  };
  const said = path.join(userData, "instances", "vk", "version.txt");
  const running = (version: string) =>
    expect
      .poll(() => fs.existsSync(said) && fs.readFileSync(said, "utf8"), { timeout: 60_000 })
      .toBe(version);
  try {
    // Installed from the catalogue, and run by a deployed flow.
    catalogue.publish("0.1.0");
    const first = await launch();
    await first.general.getByTestId("packages-add").click();
    await first.window.getByRole("menuitem", { name: STRINGS["packages.fromCatalogue"] }).click();
    await first.general
      .locator('[data-testid="package-offer"][data-id="verkit"]')
      .getByTestId("package-offer-install")
      .click();
    await expect(first.row).toContainText(STRINGS["packages.installed"], { timeout: INSTALL_MS });
    const flows = [tab("t1", "Flow 1"), step("vk", "inny-verkit-step", "t1", "Say version")];
    expect((await request(first.port, "POST", "/red/flows", flows)).status).toBe(204);
    await running("0.1.0");
    catalogue.publish("0.2.0");
    await quit(first.app);

    // The next start asks the catalogue: 0.2.0 is offered, and Update applies it.
    const second = await launch();
    let row = second.row;
    await expect(facets(row).last()).toContainText("Update to 0.2.0 available", {
      timeout: 30_000,
    });
    fs.rmSync(said);
    await row.getByTestId("package-update").click();
    await expect(facets(row).last()).toContainText("Updated to 0.2.0 on today", {
      timeout: INSTALL_MS,
    });
    await running("0.2.0");

    // Go back confirms once, swaps 0.1.0 back, and its node runs it; 0.2.0 is offered again.
    await expect(row.getByTestId("package-go-back")).toHaveText("Go back to 0.1.0");
    await row.getByTestId("package-go-back").click();
    const confirm = second.window.locator(`[data-component="dialog"][data-variant="kind=neutral"]`);
    await expect(confirm).toContainText(
      "Go back to verkit 0.1.0? The flows that use it keep running.",
    );
    fs.rmSync(said);
    await confirm.getByRole("button", { name: STRINGS["general.goBack.yes"] }).click();
    await expect(facets(row).last()).toContainText("Update to 0.2.0 available", {
      timeout: INSTALL_MS,
    });
    await running("0.1.0");
    await expect(row.getByTestId("package-go-back")).toHaveCount(0);
    // Never blocked: Update applies the version it left.
    expect(fs.existsSync(path.join(userData, "node-packages", "blocked-updates.json"))).toBe(false);
    await row.getByTestId("package-update").click();
    await expect(facets(row).last()).toContainText("Updated to 0.2.0 on today", {
      timeout: INSTALL_MS,
    });
    await quit(second.app);

    // Six days on: still offered.
    updatedDaysAgo(6);
    const third = await launch();
    row = third.row;
    await expect(row.getByTestId("package-go-back")).toHaveText("Go back to 0.1.0", {
      timeout: 30_000,
    });
    await quit(third.app);

    // Eight days on: not offered, and what was kept is pruned at start.
    updatedDaysAgo(8);
    const fourth = await launch();
    row = fourth.row;
    await expect(row).toContainText(STRINGS["packages.installed"], { timeout: 30_000 });
    await expect(row).toContainText(STRINGS["packages.upToDate"], { timeout: 30_000 });
    await expect(row.getByTestId("package-go-back")).toHaveCount(0);
    expect(fs.existsSync(kept)).toBe(false);

    await quit(fourth.app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
    await catalogue.close();
  }
});

test("no state without checked-when", async () => {
  test.setTimeout(3 * 60_000);
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window } = await launchApp(env);
    apps.push(app);
    await waitForRunning(window, "runtime");
    const general = await openGeneral(window);
    const folder = path.join(scratch, "checkkit");
    writePackageFolder(folder, "checkkit", "0.1.0", versionNode("0.1.0"));
    await installFolder(app, window, general, "checkkit", folder);
    const rows = general.getByTestId("package-row");
    // The shipped packages and the one installed, each with its verified facts.
    // The shipped packages pass their check against this build's manifest.
    for (const shipped of ["anytype", "folder"]) {
      await expect(packageRow(general, shipped)).toContainText(STRINGS["packages.installed"], {
        timeout: 30_000,
      });
      await expect(packageRow(general, shipped)).not.toContainText(STRINGS["packages.failedCheck"]);
    }
    await expect(packageRow(general, "checkkit").getByTestId("package-facet")).toHaveCount(3, {
      timeout: 30_000,
    });
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(3);
    await expect(general.getByTestId("general-packages-state")).toHaveText(
      `${String(count)} installed`,
    );
    const when =
      /^checked (today|yesterday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) \d\d:\d\d$/;
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const pills = row.locator('[data-component="status-pill"]');
      const checked = row.getByTestId("package-checked");
      // Every state word has its "checked when" beside it: as many of one as of the other.
      const shown = await pills.count();
      expect(shown).toBeGreaterThan(0);
      await expect(checked).toHaveCount(shown);
      for (let fact = 0; fact < shown; fact += 1) {
        await expect(row.getByTestId("package-facet").nth(fact)).toContainText(
          await pills.nth(fact).innerText(),
        );
        await expect(checked.nth(fact)).toHaveText(when);
      }
    }

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
  }
});
