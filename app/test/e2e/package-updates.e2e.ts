// Package updates and registered catalogue sources in the real app (WI-0018-17), driven through
// the real shell/main.ts bundle and the Packages page.
//
// - An update is found by "Check for updates", shown on the Packages page with Apply and told in
//   exactly one notice; Apply builds it, restarts ONLY the runtime, and the deployed node runs
//   the new version. A broken update (its node never sends ready) is swapped back after 30 s,
//   the runtime restarted again, and a notice names the package and the reason.
// - Plan 0013: a package installed from a folder whose content changed under the same version is
//   refused and reported, on the page and in a notice, and offers no Apply.
// - A second source is registered on the page, its package listed with its publisher and
//   installed; a source that fails leaves the official catalogue listed as it is.
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
  cleanUp,
  isAlive,
  launchApp,
  quit,
  processesNaming,
  scratchDirectories,
  shellOf,
  waitForRunning,
} from "./app-harness";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

const NAME = "verkit";
const TYPE = "inny-verkit-vers";
const BUILD_MS = 60_000;

/**
 * A node that writes its package's version into its data folder at start and then sends ready;
 * `broken` exits at start instead, never ready.
 */
function nodeScript(version: string, broken = false): string {
  return `const fs = require("fs");
const path = require("path");
const readline = require("readline");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.t === "start") {
    ${broken ? "process.exit(3);" : ""}
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

function packageFiles(name: string, version: string, body: string): Files {
  return {
    "inny-package.json": JSON.stringify({
      protocol: 2,
      package: name,
      version,
      environment: { kind: "node", node: ">=22" },
      types: [
        {
          id: "vers",
          kind: "node",
          label: `${name} vers`,
          command: ["{node}", "{package}/node.js"],
          config: { type: "object" },
          outputs: [{ port: "out", event: `${name}.out.v1` }],
        },
      ],
    }),
    "node.js": body,
  };
}

/** A local HTTPS server whose published files a test changes as it goes. */
async function serve(): Promise<{
  base: string;
  published: Map<string, Uint8Array>;
  close(): Promise<void>;
}> {
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
  return {
    base: `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    published,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Publish a signed catalogue at `/<at>/catalogue.json` offering each package at its version. */
function publishCatalogue(
  server: { published: Map<string, Uint8Array> },
  at: string,
  signer: Signer,
  offers: { name: string; version: string; body: string; summary: string }[],
): void {
  const document = new TextEncoder().encode(
    JSON.stringify({
      catalogue: 1,
      plugins: offers.map(({ name, version, summary }) => ({
        id: name,
        summary,
        source: "index",
        version,
        archive: `${name}-${version}.tgz`,
      })),
    }),
  );
  server.published.set(`/${at}/catalogue.json`, document);
  server.published.set(
    `/${at}/catalogue.json.minisig`,
    new TextEncoder().encode(signer.sign(document)),
  );
  for (const { name, version, body } of offers) {
    server.published.set(
      `/${at}/${name}-${version}.tgz`,
      signedArchive(packageFiles(name, version, body), signer),
    );
  }
}

function deploy(port: number, flows: unknown[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(flows);
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/red/flows",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
        },
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

async function openPackages(window: Page): Promise<void> {
  await window.getByTestId("nav-packages").click();
  await expect(window.getByTestId("page-packages")).toBeVisible();
}

const item = (window: Page, name: string) =>
  window.locator(`[data-testid="package-item"][data-name="${name}"]`);

/** Count the log's notice lines that start with `title`. */
const notices = (output: string[], title: string): number =>
  output
    .join("")
    .split("\n")
    .filter((line) => line.includes(`notice: ${title}:`)).length;

test("an update is shown and applied, only the runtime restarts and the node runs it, and a broken one is rolled back with a notice", async () => {
  test.setTimeout(6 * 60_000);
  const { scratch, userData, env } = scratchDirectories();
  const signer = new Signer();
  const server = await serve();
  const apps: ElectronApplication[] = [];
  const release = (version: string, broken = false) => ({
    name: NAME,
    version,
    body: nodeScript(version, broken),
    summary: "Says its version.",
  });
  try {
    publishCatalogue(server, "official", signer, [release("0.1.0")]);
    const { app, window, output } = await launchApp({
      ...env,
      INNYTYPES_CATALOGUE_URL: `${server.base}/official/catalogue.json`,
      INNYTYPES_CATALOGUE_KEY: signer.publicKeyLine,
      INNYTYPES_E2E_HOOKS: "1",
      INNYTYPES_TEST_CATALOGUE_CA: CERT,
    });
    apps.push(app);
    window.on("dialog", () => undefined);
    const shellPid = shellOf(app).pid ?? 0;
    const first = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");
    const port = Number(first.port);

    await openPackages(window);
    await window
      .locator(
        `[data-testid="catalogue-item"][data-id="${NAME}"] [data-testid="catalogue-install"]`,
      )
      .click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      `${NAME} 0.1.0 is installed. Its types are in the editor's palette.`,
      { timeout: BUILD_MS },
    );
    const installed = await waitForRunning(window, "runtime", first.generation + 1);
    expect(
      await deploy(port, [
        { id: "tab1", type: "tab", label: "Flow 1" },
        { id: "vk", type: TYPE, z: "tab1", wires: [[]] },
        // Never constructed, so never ready: neither may hold an update back.
        { id: "vk-disabled", type: TYPE, z: "tab1", d: true, wires: [[]] },
        { id: "tab2", type: "tab", label: "Flow 2", disabled: true },
        { id: "vk-on-disabled-tab", type: TYPE, z: "tab2", wires: [[]] },
      ]),
    ).toBe(204);
    const said = path.join(userData, "instances", "vk", "version.txt");
    await expect
      .poll(() => fs.existsSync(said) && fs.readFileSync(said, "utf8"), {
        timeout: 30_000,
      })
      .toBe("0.1.0");

    // A newer version is published: the check shows it, with Apply, and tells it once.
    publishCatalogue(server, "official", signer, [release("0.2.0")]);
    await window.getByTestId("packages-check").click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      `Checked: ${NAME} has a newer version.`,
      { timeout: 30_000 },
    );
    await expect(item(window, NAME).getByTestId("package-update")).toHaveText(
      "update available: 0.2.0",
    );
    await window.getByTestId("packages-check").click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      `Checked: ${NAME} has a newer version.`,
      { timeout: 30_000 },
    );
    expect(notices(output, `${NAME} 0.2.0 is available`)).toBe(1);
    expect(fs.readFileSync(said, "utf8")).toBe("0.1.0");

    // Apply: only the runtime restarts, and the deployed node runs the new version.
    fs.rmSync(said);
    await item(window, NAME).getByTestId("package-apply").click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      `${NAME} is updated from 0.1.0 to 0.2.0.`,
      { timeout: BUILD_MS },
    );
    const updated = await waitForRunning(window, "runtime", installed.generation + 1);
    expect(updated.port).toBe(first.port);
    expect(isAlive(shellPid)).toBe(true); // the same shell: never relaunched
    expect((await waitForRunning(window, "services")).pid).toBe(services.pid);
    await expect
      .poll(() => fs.existsSync(said) && fs.readFileSync(said, "utf8"), {
        timeout: 30_000,
      })
      .toBe("0.2.0");
    await expect(item(window, NAME).getByTestId("package-update")).toHaveCount(0);
    await expect(item(window, NAME)).toContainText(`${NAME} 0.2.0 (installed, from official)`);

    // A broken version: its node never sends ready. After 30 s the old one is back.
    publishCatalogue(server, "official", signer, [release("0.3.0", true)]);
    await window.getByTestId("packages-check").click();
    await expect(item(window, NAME).getByTestId("package-apply")).toBeVisible({ timeout: 30_000 });
    fs.rmSync(said);
    await item(window, NAME).getByTestId("package-apply").click();
    const reason = `it was rolled back to 0.2.0: instance vk of its types sent no ready within 30 s`;
    await expect(window.getByTestId("packages-message")).toHaveText(
      `Not updated: ${NAME} 0.3.0 ${reason}.`,
      { timeout: 2 * 60_000 },
    );
    expect(notices(output, `${NAME} 0.3.0 is being held back`)).toBe(1);
    expect(output.join("")).toContain(
      `notice: ${NAME} 0.3.0 is being held back: ${reason}. Nothing on your machine has changed.`,
    );
    const live = JSON.parse(
      fs.readFileSync(
        path.join(userData, "node-packages", "packages", NAME, "installed.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(live.version).toBe("0.2.0");
    // The runtime restarted twice (the update, the swap back), and the old version runs again.
    await waitForRunning(window, "runtime", updated.generation + 2);
    expect(isAlive(shellPid)).toBe(true); // the same shell: never relaunched
    await expect
      .poll(() => fs.existsSync(said) && fs.readFileSync(said, "utf8"), {
        timeout: 30_000,
      })
      .toBe("0.2.0");
    await expect(item(window, NAME).getByTestId("package-update")).toHaveAttribute(
      "data-kind",
      "failed",
    );
    await expect(item(window, NAME).getByTestId("package-apply")).toHaveCount(0);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
    await server.close();
  }
});

test("plan 0013: a folder whose content changed under the same version is refused and reported", async () => {
  test.setTimeout(3 * 60_000);
  const { scratch, userData, env } = scratchDirectories();
  const apps: ElectronApplication[] = [];
  try {
    const { app, window, output } = await launchApp(env);
    apps.push(app);
    await waitForRunning(window, "runtime");
    const folder = path.join(scratch, "monty");
    const write = (body: string): void => {
      fs.mkdirSync(folder, { recursive: true });
      for (const [file, data] of Object.entries(packageFiles("monty", "0.1.0", body))) {
        fs.writeFileSync(path.join(folder, file), data);
      }
    };
    write(nodeScript("0.1.0"));
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
    }, folder);
    await openPackages(window);
    await window.getByTestId("packages-install-file").click();
    await window.getByTestId("unsigned-confirm").click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      "monty 0.1.0 is installed, unsigned. Its types are in the editor's palette.",
      { timeout: BUILD_MS },
    );
    await window.getByTestId("packages-check").click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      "Checked: every installed package is up to date.",
    );
    await expect(item(window, "monty").getByTestId("package-update")).toHaveCount(0);

    // monty's case: new behaviour, the same declared version.
    write(`${nodeScript("0.1.0")}// a new event kind\n`);
    await window.getByTestId("packages-check").click();
    await expect(item(window, "monty").getByTestId("package-update")).toHaveAttribute(
      "data-kind",
      "moved",
      { timeout: 30_000 },
    );
    await expect(item(window, "monty").getByTestId("package-update")).toContainText(
      `not updated: 0.1.0 changed without a new version: the content at ${folder} changed and ` +
        "its version did not",
    );
    await expect(item(window, "monty").getByTestId("package-apply")).toHaveCount(0);
    expect(notices(output, "monty 0.1.0 is being held back")).toBe(1);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
  }
});

test("a second source is registered, listed with its publisher and installed from, and a failing source leaves the official one intact", async () => {
  test.setTimeout(4 * 60_000);
  const { scratch, userData, env } = scratchDirectories();
  const official = new Signer();
  const acme = new Signer();
  const server = await serve();
  const apps: ElectronApplication[] = [];
  try {
    publishCatalogue(server, "official", official, [
      { name: "monty", version: "1.0.0", body: nodeScript("1.0.0"), summary: "Files things." },
    ]);
    publishCatalogue(server, "acme", acme, [
      { name: "whodunnit", version: "1.0.0", body: nodeScript("1.0.0"), summary: "Finds authors." },
      { name: "monty", version: "9.0.0", body: nodeScript("9.0.0"), summary: "Impostor." },
    ]);
    const { app, window } = await launchApp({
      ...env,
      INNYTYPES_CATALOGUE_URL: `${server.base}/official/catalogue.json`,
      INNYTYPES_CATALOGUE_KEY: official.publicKeyLine,
      INNYTYPES_E2E_HOOKS: "1",
      INNYTYPES_TEST_CATALOGUE_CA: CERT,
    });
    apps.push(app);
    await waitForRunning(window, "runtime");
    await openPackages(window);
    await expect(window.getByTestId("sources-empty")).toBeVisible();

    const register = async (name: string, url: string, key: string): Promise<void> => {
      await window.getByTestId("source-name").fill(name);
      await window.getByTestId("source-url").fill(url);
      await window.getByTestId("source-key").fill(key);
      await window.getByTestId("source-register").click();
    };
    // A mistyped key is refused, and nothing is registered.
    await register("acme", `${server.base}/acme/catalogue.json`, "not-a-key");
    await expect(window.getByTestId("packages-message")).toContainText(
      "Not changed: the public key is not a minisign public key",
    );
    await expect(window.getByTestId("sources-empty")).toBeVisible();

    await register("acme", `${server.base}/acme/catalogue.json`, acme.publicKeyLine);
    await expect(window.getByTestId("packages-message")).toHaveText(
      "The source acme is registered.",
    );
    await register("down", `${server.base}/nowhere/catalogue.json`, "");
    await expect(window.getByTestId("packages-message")).toHaveText(
      "The source down is registered.",
    );

    const source = (name: string) =>
      window.locator(`[data-testid="source-item"][data-name="${name}"]`);
    await expect(source("acme").getByTestId("source-publisher")).toHaveText(
      server.base.replace("https://", ""),
    );
    await expect(source("acme")).toContainText("verified with its public key");
    await expect(source("down").getByTestId("source-problem")).toContainText("404");
    await expect(source("down").getByTestId("source-unverified")).toBeVisible();
    // The official list is intact, and wins over acme's same-named entry without hiding it.
    await expect(
      window.locator('#packages-catalogue [data-testid="catalogue-item"][data-id="monty"]'),
    ).toContainText("monty 1.0.0: Files things.");
    await expect(
      source("acme").locator('[data-testid="catalogue-item"][data-id="monty"]'),
    ).toContainText("the official catalogue's monty is the one installed");

    await source("acme")
      .locator(
        '[data-testid="catalogue-item"][data-id="whodunnit"] [data-testid="catalogue-install"]',
      )
      .click();
    await expect(window.getByTestId("packages-message")).toHaveText(
      "whodunnit 1.0.0 is installed. Its types are in the editor's palette.",
      { timeout: BUILD_MS },
    );
    await expect(item(window, "whodunnit")).toContainText("whodunnit 1.0.0 (installed, from acme)");
    await expect(item(window, "whodunnit").getByTestId("package-mode")).toHaveText("manual");
    // The source's switch is its package's update policy.
    await source("acme").getByTestId("source-auto-switch").click();
    await expect(source("acme").getByTestId("source-auto")).toHaveText("on");
    await expect(item(window, "whodunnit").getByTestId("package-mode")).toHaveText("auto");
    const stored = JSON.parse(
      fs.readFileSync(path.join(userData, "shell-settings.json"), "utf8"),
    ) as { sources: Record<string, unknown> };
    expect(Object.keys(stored.sources)).toEqual(["acme", "down"]);

    await source("down").getByTestId("source-remove").click();
    await expect(window.getByTestId("packages-message")).toHaveText("The source down is removed.");
    await expect(source("down")).toHaveCount(0);

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
    await server.close();
  }
});
