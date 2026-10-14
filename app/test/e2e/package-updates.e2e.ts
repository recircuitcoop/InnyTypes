// Package updates and registered catalogue sources in the real app (WI-0018-17), driven through
// the real shell/main.ts bundle and Configuration › General's Packages (plan 0022 §F).
//
// - An update is found by the checks after the next start, shown on its row with Update and told
//   in exactly one notice; Update builds it, restarts ONLY the runtime, and the deployed node runs
//   the new version. A broken update (its node never sends ready) is swapped back after 30 s,
//   the runtime restarted again, and a notice names the package and the reason.
// - A second source in the settings: its package offered and installed, by its publisher; the
//   official catalogue's entry wins over its same-named one; a source that fails leaves the
//   official catalogue offered as it is. (A plan 0013 folder, changed under the same version, is
//   packages.e2e.ts's "install from a folder, check for changes".)
import fs from "node:fs";
import * as http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { STRINGS } from "../../src/ui/strings";
import { unsealTree } from "../../src/adapters/fs/package-roots";
import { Signer } from "../fakes/minisign-signer";
import { signedArchive, type Files } from "../fakes/package-archive";
import {
  cleanUp,
  isAlive,
  launchApp,
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

const packageRow = (general: Locator, name: string) =>
  general.locator(`[data-testid="package-row"][data-name="${name}"]`);

/** A row's last fact: its update, with when it was checked. */
const updateFact = (row: Locator) => row.getByTestId("package-facet").last();

/** Add a package… › From the catalogue, then Install on `id`'s offer. */
async function installOffer(window: Page, general: Locator, id: string): Promise<void> {
  await general.getByTestId("packages-add").click();
  await window.getByRole("menuitem", { name: STRINGS["packages.fromCatalogue"] }).click();
  await general
    .locator(`[data-testid="package-offer"][data-id="${id}"]`)
    .getByTestId("package-offer-install")
    .click();
}

/** Count the log's notice lines that start with `title`. */
const notices = (output: string[], title: string): number =>
  output
    .join("")
    .split("\n")
    .filter((line) => line.includes(`notice: ${title}:`)).length;

test("an update is offered and applied, only the runtime restarts and the node runs it, and a broken one is rolled back with a notice", async () => {
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
  const withCatalogue = {
    ...env,
    INNYTYPES_CATALOGUE_URL: `${server.base}/official/catalogue.json`,
    INNYTYPES_CATALOGUE_KEY: signer.publicKeyLine,
    INNYTYPES_E2E_HOOKS: "1",
    INNYTYPES_TEST_CATALOGUE_CA: CERT,
  };
  const launch = async () => {
    const running = await launchApp(withCatalogue);
    apps.push(running.app);
    running.window.on("dialog", () => undefined);
    const runtime = await waitForRunning(running.window, "runtime");
    const general = await openGeneral(running.window);
    return { ...running, runtime, general, row: packageRow(general, NAME) };
  };
  const said = path.join(userData, "instances", "vk", "version.txt");
  const running = (version: string) =>
    expect
      .poll(() => fs.existsSync(said) && fs.readFileSync(said, "utf8"), { timeout: 30_000 })
      .toBe(version);
  try {
    publishCatalogue(server, "official", signer, [release("0.1.0")]);
    const first = await launch();
    await installOffer(first.window, first.general, NAME);
    await expect(first.row).toContainText(STRINGS["packages.installed"], { timeout: BUILD_MS });
    await waitForRunning(first.window, "runtime", first.runtime.generation + 1);
    expect(
      await deploy(Number(first.runtime.port), [
        { id: "tab1", type: "tab", label: "Flow 1" },
        { id: "vk", type: TYPE, z: "tab1", wires: [[]] },
        // Never constructed, so never ready: neither may hold an update back.
        { id: "vk-disabled", type: TYPE, z: "tab1", d: true, wires: [[]] },
        { id: "tab2", type: "tab", label: "Flow 2", disabled: true },
        { id: "vk-on-disabled-tab", type: TYPE, z: "tab2", wires: [[]] },
      ]),
    ).toBe(204);
    await running("0.1.0");
    await quit(first.app);

    // A newer version is published: the next start's check offers it, and tells it once.
    publishCatalogue(server, "official", signer, [release("0.2.0")]);
    const second = await launch();
    await expect(updateFact(second.row)).toContainText("Update to 0.2.0 available", {
      timeout: 30_000,
    });
    // The scheduled check, a minute after the start, tells it in a notice.
    await expect
      .poll(() => notices(second.output, `${NAME} 0.2.0 is available`), { timeout: 90_000 })
      .toBe(1);
    expect(fs.readFileSync(said, "utf8")).toBe("0.1.0");

    // Update: only the runtime restarts, and the deployed node runs the new version.
    const shellPid = shellOf(second.app).pid ?? 0;
    const services = await waitForRunning(second.window, "services");
    const before = await waitForRunning(second.window, "runtime");
    fs.rmSync(said);
    await second.row.getByTestId("package-update").click();
    await expect(updateFact(second.row)).toContainText("Updated to 0.2.0 on today", {
      timeout: BUILD_MS,
    });
    const updated = await waitForRunning(second.window, "runtime", before.generation + 1);
    expect(updated.port).toBe(before.port);
    expect(isAlive(shellPid)).toBe(true); // the same shell: never relaunched
    expect((await waitForRunning(second.window, "services")).pid).toBe(services.pid);
    await running("0.2.0");
    expect(notices(second.output, `${NAME} 0.2.0 is available`)).toBe(1);
    await quit(second.app);

    // A broken version: its node never sends ready. After 30 s the old one is back.
    publishCatalogue(server, "official", signer, [release("0.3.0", true)]);
    const third = await launch();
    await expect(updateFact(third.row)).toContainText("Update to 0.3.0 available", {
      timeout: 30_000,
    });
    const thirdShell = shellOf(third.app).pid ?? 0;
    const from = await waitForRunning(third.window, "runtime");
    fs.rmSync(said);
    await third.row.getByTestId("package-update").click();
    await expect(third.general.getByTestId("packages-message")).toHaveText(
      `${NAME} wasn't updated. The version you had keeps running.`,
      { timeout: 2 * 60_000 },
    );
    const reason = `it was rolled back to 0.2.0: instance vk of its types sent no ready within 30 s`;
    expect(notices(third.output, `${NAME} 0.3.0 is being held back`)).toBe(1);
    expect(third.output.join("")).toContain(
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
    await waitForRunning(third.window, "runtime", from.generation + 2);
    expect(isAlive(thirdShell)).toBe(true); // the same shell: never relaunched
    await running("0.2.0");

    await quit(third.app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
    await server.close();
  }
});

test("a registered source's package is offered and installed by its publisher, the official entry wins over its namesake, and a failing source leaves the official one intact", async () => {
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
    // Two sources registered in the settings: acme with its key, and one that fails to answer.
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      path.join(userData, "shell-settings.json"),
      JSON.stringify({
        sources: {
          acme: { url: `${server.base}/acme/catalogue.json`, public_key: acme.publicKeyLine },
          down: { url: `${server.base}/nowhere/catalogue.json` },
        },
      }),
    );
    const { app, window } = await launchApp({
      ...env,
      INNYTYPES_CATALOGUE_URL: `${server.base}/official/catalogue.json`,
      INNYTYPES_CATALOGUE_KEY: official.publicKeyLine,
      INNYTYPES_E2E_HOOKS: "1",
      INNYTYPES_TEST_CATALOGUE_CA: CERT,
    });
    apps.push(app);
    await waitForRunning(window, "runtime");
    const general = await openGeneral(window);
    await general.getByTestId("packages-add").click();
    await window.getByRole("menuitem", { name: STRINGS["packages.fromCatalogue"] }).click();
    const offer = (id: string) => general.locator(`[data-testid="package-offer"][data-id="${id}"]`);

    // The official catalogue is offered as it is, though "down" fails; its monty wins over
    // acme's same-named one, which is not offered beside it.
    await expect(offer("monty")).toHaveCount(1, { timeout: 30_000 });
    await expect(offer("monty")).toContainText("1.0.0");
    await expect(offer("monty")).toContainText("Files things.");
    await expect(offer("whodunnit")).toContainText("Finds authors.");
    await expect(general.getByTestId("package-offer")).toHaveCount(2);

    // acme's package installs, and its row names acme as its publisher.
    await offer("whodunnit").getByTestId("package-offer-install").click();
    const row = packageRow(general, "whodunnit");
    await expect(row).toContainText(STRINGS["packages.installed"], { timeout: BUILD_MS });
    await expect(row).toContainText("by acme");
    const record = JSON.parse(
      fs.readFileSync(
        path.join(userData, "node-packages", "packages", "whodunnit", "installed.json"),
        "utf8",
      ),
    ) as { version: string; origin: { kind: string; source: string } };
    expect(record).toMatchObject({
      version: "1.0.0",
      origin: { kind: "catalogue", source: "acme" },
    });

    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
  } finally {
    await cleanUp(apps, scratch, () => {
      unsealTree(scratch);
    });
    await server.close();
  }
});
