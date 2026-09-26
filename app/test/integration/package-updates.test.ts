// The version check and the update (application/update-package.ts; WI-0018-17) with the real
// disk adapters: signed archives verified with the real minisign verifier, swapped into a real
// sealed live root, content hashes and blocked versions in real files, and the real NoticeBoard
// of WI-0018-21 deciding what is told once. The catalogue, the fetch, the runtime's restart and
// its answer to `package.ready` are stand-ins, on a fake clock.
//
// The old tests this answers are tests/test_plugin_version_check.py's and
// tests/test_plugin_update_apply.py's per-package rows, the window's update rows
// (test_application_window.py, test_plugin_page.py, test_toolkit_desktop.py) through the page's
// state, and plan 0013's moved version.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsBlockedUpdates } from "../../src/adapters/fs/blocked-updates";
import { FsContentHashes } from "../../src/adapters/fs/content-hashes";
import { FsPackageRoots, unsealTree } from "../../src/adapters/fs/package-roots";
import { FsPackageSource } from "../../src/adapters/fs/package-source";
import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import { PackageEnvironmentBuilder } from "../../src/adapters/process/env-builder";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { sha256Hex } from "../../src/adapters/signature/digest";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import {
  OneAtATime,
  PackageInstaller,
  type ListedPackage,
  type PackageInstallerPorts,
  type PackageOutcome,
} from "../../src/application/install-package";
import { NoticeBoard } from "../../src/application/notices";
import { readSources } from "../../src/application/package-sources";
import {
  PackageUpdates,
  READY_WINDOW_MS,
  type PackageUpdatesPorts,
  type Readiness,
} from "../../src/application/update-package";
import type { CatalogueEntry, PackageCatalogue } from "../../src/domain/packages/catalogue";
import type { Message } from "../../src/domain/notices/notices";
import { parsePackagePolicy } from "../../src/domain/packages/versions";
import type { HttpGetResult } from "../../src/ports/http-client";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger } from "../fakes/children";
import { Signer } from "../fakes/minisign-signer";
import { signedArchive, type Files } from "../fakes/package-archive";

const CATALOGUE = "https://catalogue.test/catalogue.json";
const archiveUrl = (name: string, version: string) =>
  `https://catalogue.test/packages/${name}-${version}.tgz`;

let base: string;
let roots: FsPackageRoots;
let logger: RecordingLogger;
let signer: Signer;
let served: Map<string, Uint8Array>;
let entries: CatalogueEntry[];
let catalogueFails: Error | null;
let restarts: string[];
let restartTook: number | null;
let readiness: (packages: readonly string[]) => Promise<Readiness>;
let told: Message[];
let settings: JsonSettingsStore;
let clock: FakeClock;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-update-")));
  roots = new FsPackageRoots(path.join(base, "node-packages"));
  logger = new RecordingLogger();
  signer = new Signer();
  served = new Map();
  entries = [];
  catalogueFails = null;
  restarts = [];
  restartTook = 250;
  // One deployed instance, ready at once: a healthy update.
  readiness = () => Promise.resolve({ deployed: ["n1"], ready: ["n1"] });
  told = [];
  settings = new JsonSettingsStore(path.join(base, "shell-settings.json"));
  clock = new FakeClock();
});

afterEach(() => {
  unsealTree(base);
  fs.rmSync(base, { recursive: true, force: true });
});

function declaration(name: string, version: string): string {
  return JSON.stringify({
    protocol: 2,
    package: name,
    version,
    environment: { kind: "node", node: ">=22" },
    types: [
      {
        id: "ping",
        kind: "node",
        label: "Ping",
        command: ["{node}", "{package}/node.js"],
        config: { type: "object" },
        outputs: [{ port: "out", event: `${name}.out.v1` }],
      },
    ],
  });
}

const packageFiles = (name: string, version: string, body = "// v\n"): Files => ({
  "inny-package.json": declaration(name, version),
  "node.js": `process.stdout.write('')\n${body}`,
});

/** Publish `name` at `version` in the official catalogue, signed. */
function publish(name: string, version: string, options: { declares?: string } = {}): void {
  const url = archiveUrl(name, version);
  served.set(url, signedArchive(packageFiles(name, options.declares ?? version), signer));
  entries = [
    ...entries.filter((entry) => entry.packageId !== name),
    {
      packageId: name,
      summary: `The ${name} package.`,
      installSource: "index",
      catalogue: "official",
      verified: true,
      archive: url,
      version,
    },
  ];
}

const builder = new PackageEnvironmentBuilder({
  locator: {
    uv: () => {
      throw new Error("uv was asked for");
    },
    python: () => {
      throw new Error("python was asked for");
    },
  },
  parentEnvironment: {},
  cacheDir: "unused",
  wheels: { kind: "default" },
  timeoutMs: 1,
  platform: process.platform,
});

function reads() {
  return {
    catalogue: (): Promise<PackageCatalogue> =>
      catalogueFails === null
        ? Promise.resolve({
            name: "official",
            url: CATALOGUE,
            verified: true,
            fetchedAt: 0,
            entries,
          })
        : Promise.reject(catalogueFails),
    catalogueKey: signer.publicKeyText,
    sources: () => readSources(settings),
    registered: () => Promise.reject(new Error("no registered source is served here")),
    http: {
      get: (url: string): Promise<HttpGetResult> => {
        const body = served.get(url);
        return Promise.resolve(
          body === undefined
            ? { ok: false, failure: "status", detail: `${url} answered 404` }
            : { ok: true, body },
        );
      },
    },
    saveDownload: (name: string, bytes: Uint8Array) => {
      const file = path.join(base, "downloads", `${name}.tgz`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return file;
    },
  };
}

function setUp(overrides: Partial<PackageUpdatesPorts> = {}) {
  const environment = {
    source: new FsPackageSource(),
    verifier: new MinisignVerifier(),
    validator: new AjvSchemaValidator(),
    contentHashes: new FsContentHashes(path.join(base, "content-hashes.json")),
    roots,
    builder,
    logger,
    sha256: sha256Hex,
    target: { platform: process.platform, arch: process.arch },
  };
  const restartRuntime = (reason: string) => {
    restarts.push(reason);
    return Promise.resolve(restartTook);
  };
  const one = new OneAtATime();
  const installerPorts: PackageInstallerPorts = {
    ...reads(),
    environment,
    shipped: () => [],
    restartRuntime,
    logger,
  };
  const installer = new PackageInstaller(installerPorts, one);
  const notifier = new NoticeBoard({
    deliver: (message) => told.push(message),
    store: null,
    logger,
  });
  const updates = new PackageUpdates(
    {
      ...reads(),
      environment,
      policy: () => parsePackagePolicy(settings.readPackages()),
      restartRuntime,
      readiness: (packages) => readiness(packages),
      blocked: new FsBlockedUpdates(path.join(base, "node-packages", "blocked-updates.json")),
      notifier,
      clock,
      now: () => 1_758_190_000_000,
      logger,
      ...overrides,
    },
    one,
  );
  return { installer, updates, notifier };
}

/** Run `work` to its end, moving the fake clock on while it waits. */
async function drive<T>(work: Promise<T>): Promise<T> {
  const done = { settled: false };
  void work.finally(() => {
    done.settled = true;
  });
  for (let turn = 0; turn < 400; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (done.settled) {
      break;
    }
    clock.advance(500);
  }
  return work;
}

/** The page's line for `name`. */
async function line(
  installer: PackageInstaller,
  updates: PackageUpdates,
  name: string,
): Promise<ListedPackage | undefined> {
  return updates.decorate(await installer.state()).packages.find((listed) => listed.name === name);
}

function writePackages(section: unknown): void {
  fs.writeFileSync(
    path.join(base, "shell-settings.json"),
    JSON.stringify({ ...JSON.parse(readSettingsText()), packages: section }),
  );
}

function readSettingsText(): string {
  const file = path.join(base, "shell-settings.json");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}";
}

async function installed(name: string, version: string) {
  publish(name, version);
  const parts = setUp();
  expect(await parts.installer.installFromCatalogue(name)).toMatchObject({ ok: true });
  restarts = [];
  return parts;
}

describe("the version check", () => {
  it("shows a newer catalogue version on the page, with Apply, and tells it in exactly one notice", async () => {
    const { installer, updates } = await installed("pinger", "0.1.0");
    expect((await line(installer, updates, "pinger"))?.update).toBeNull();
    publish("pinger", "0.2.0");
    expect(await updates.check()).toEqual({
      ok: true,
      message: "Checked: pinger has a newer version.",
    });
    expect(await updates.check()).toMatchObject({ ok: true });
    const listed = await line(installer, updates, "pinger");
    expect(listed).toMatchObject({
      from: "official",
      mode: "manual",
      update: { kind: "newer", version: "0.2.0", detail: null, apply: true },
    });
    expect(updates.decorate(await installer.state()).checkedAt).toBe(1_758_190_000_000);
    // Two checks, one notice: the NoticeBoard tells a condition once.
    expect(told).toEqual([
      { title: "pinger 0.2.0 is available", body: "Install it on the Packages page." },
    ]);
    // Manual: nothing was applied by the check.
    expect(roots.installed("pinger")?.version).toBe("0.1.0");
    expect(restarts).toEqual([]);
  });

  it("never offers an older or the same version, and says up to date", async () => {
    const { installer, updates } = await installed("pinger", "0.2.0");
    publish("pinger", "0.1.0");
    expect(await updates.check()).toEqual({
      ok: true,
      message: "Checked: every installed package is up to date.",
    });
    expect((await line(installer, updates, "pinger"))?.update).toBeNull();
    expect(told).toEqual([]);
  });

  it("asks nothing at all when checking is off in the settings", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    writePackages({ auto_check_versions: false });
    catalogueFails = new Error("asked, and must not have been");
    expect(await updates.check()).toEqual({
      ok: false,
      error:
        "Not checked: checking for updates is off in the settings " +
        "(packages.auto_check_versions), so no catalogue and no folder was asked.",
    });
  });

  it("refuses to check with settings it cannot read, and says why", async () => {
    const { updates, installer } = await installed("pinger", "0.1.0");
    writePackages({ update_mode: "sometimes" });
    expect(await updates.check()).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "Not checked: the packages settings cannot be read",
      ) as unknown,
    });
    // The page still lists the package, with no mode to show.
    expect(await line(installer, updates, "pinger")).toMatchObject({ mode: null, update: null });
  });

  it("says why a package could not be checked, and one such package leaves the others checked", async () => {
    const { installer, updates } = await installed("pinger", "0.1.0");
    publish("other", "1.0.0");
    expect(await installer.installFromCatalogue("other")).toMatchObject({ ok: true });
    entries = entries.filter((entry) => entry.packageId !== "pinger");
    publish("other", "1.1.0");
    await updates.check();
    expect((await line(installer, updates, "pinger"))?.update).toEqual({
      kind: "unchecked",
      version: null,
      detail: "the official catalogue no longer lists it",
      apply: false,
    });
    expect((await line(installer, updates, "other"))?.update).toMatchObject({
      kind: "newer",
      version: "1.1.0",
    });

    entries = entries.map((entry) =>
      Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "version")),
    ) as unknown as CatalogueEntry[];
    await updates.check();
    expect((await line(installer, updates, "other"))?.update?.detail).toBe(
      "its catalogue entry names no version",
    );
    catalogueFails = new Error("the server is down");
    await updates.check();
    expect((await line(installer, updates, "other"))?.update?.detail).toBe(
      "the official catalogue cannot be read: the server is down",
    );
  });

  it("cannot check a package whose record says nothing of where it came from", async () => {
    const { installer, updates } = await installed("pinger", "0.1.0");
    const recordFile = path.join(roots.live, "pinger", "installed.json");
    unsealTree(path.join(roots.live, "pinger"));
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as Record<string, unknown>;
    delete record["origin"];
    fs.writeFileSync(recordFile, JSON.stringify(record));
    await updates.check();
    expect((await line(installer, updates, "pinger"))?.update?.detail).toContain(
      "installed before InnyTypes recorded where from",
    );
    expect(await updates.apply("pinger", "person")).toMatchObject({ ok: false });
  });
});

describe("applying an update", () => {
  it("builds the new version, restarts only the runtime, waits for ready, and keeps the old one", async () => {
    const { installer, updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0");
    await updates.check();
    const asked: (readonly string[])[] = [];
    let polls = 0;
    readiness = (packages) => {
      asked.push(packages);
      polls += 1;
      // Not ready on the first ask, ready on the next: it waits within the window.
      return Promise.resolve({ deployed: ["n1"], ready: polls > 1 ? ["n1"] : [] });
    };
    expect(await drive(updates.apply("pinger", "person"))).toEqual({
      ok: true,
      message: "pinger is updated from 0.1.0 to 0.2.0.",
    });
    expect(roots.installed("pinger")).toMatchObject({
      version: "0.2.0",
      origin: { kind: "catalogue", source: "official", id: "pinger" },
    });
    expect(restarts).toEqual(["pinger was updated to 0.2.0"]);
    expect(asked[0]).toEqual(["pinger"]);
    expect(fs.existsSync(path.join(roots.previous, "pinger"))).toBe(true);
    expect((await line(installer, updates, "pinger"))?.update).toBeNull();
    expect(logger.lines).toContainEqual(
      expect.stringContaining("update: pinger 0.1.0 → 0.2.0 is live; only the runtime restarted"),
    );
  });

  it("swaps the old version back when an instance sends no ready in 30 s, restarts again, blocks it, and says so", async () => {
    const { installer, updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0");
    await updates.check();
    readiness = () => Promise.resolve({ deployed: ["n1", "n2"], ready: ["n1"] });
    const started = clock.now();
    const outcome = await drive(updates.apply("pinger", "person"));
    expect(clock.now() - started).toBeGreaterThanOrEqual(READY_WINDOW_MS);
    const reason =
      "it was rolled back to 0.1.0: instance n2 of its types sent no ready within 30 s";
    expect(outcome).toEqual({ ok: false, error: `Not updated: pinger 0.2.0 ${reason}.` });
    expect(roots.installed("pinger")?.version).toBe("0.1.0");
    expect(restarts).toEqual([
      "pinger was updated to 0.2.0",
      "pinger 0.2.0 was rolled back to 0.1.0",
    ]);
    expect(told.at(-1)).toEqual({
      title: "pinger 0.2.0 is being held back",
      body: `${reason}. Nothing on your machine has changed.`,
    });
    // Held: shown with its reason, no Apply, and never applied again, even in auto mode.
    writePackages({ update_mode: "auto" });
    expect((await line(installer, updates, "pinger"))?.update).toEqual({
      kind: "failed",
      version: "0.2.0",
      detail: "instance n2 of its types sent no ready within 30 s",
      apply: false,
    });
    restarts = [];
    await drive(updates.check());
    expect(restarts).toEqual([]);
    expect(await updates.apply("pinger", "person")).toEqual({
      ok: false,
      error:
        "Not updated: pinger 0.2.0 failed here before (instance n2 of its types sent no ready " +
        "within 30 s), and is held back.",
    });
    // Blocking one version does not block the next.
    publish("pinger", "0.3.0");
    readiness = () => Promise.resolve({ deployed: ["n1", "n2"], ready: ["n1", "n2"] });
    await drive(updates.check());
    expect(roots.installed("pinger")?.version).toBe("0.3.0");
  });

  it("updates a package no flow uses at once, and leaves every other package as it was", async () => {
    const { updates, installer } = await installed("pinger", "0.1.0");
    publish("other", "1.0.0");
    expect(await installer.installFromCatalogue("other")).toMatchObject({ ok: true });
    publish("other", "1.1.0");
    publish("pinger", "0.2.0");
    await updates.check();
    readiness = () => Promise.resolve({ deployed: [], ready: [] });
    const started = clock.now();
    expect(await drive(updates.apply("pinger", "person"))).toMatchObject({ ok: true });
    expect(clock.now() - started).toBeLessThan(READY_WINDOW_MS);
    expect(roots.installed("pinger")?.version).toBe("0.2.0");
    expect(roots.installed("other")?.version).toBe("1.0.0");
  });

  it("says, and keeps what is live, when the old version cannot be put back", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0");
    await updates.check();
    readiness = () => {
      // What the swap kept is gone by the time it is needed.
      const kept = path.join(roots.previous, "pinger");
      unsealTree(kept);
      fs.rmSync(kept, { recursive: true, force: true });
      return Promise.resolve({ deployed: ["n1"], ready: [] });
    };
    const outcome = await drive(updates.apply("pinger", "person"));
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "Not updated: pinger 0.2.0 failed (instance n1 of its types sent no ready within 30 s), " +
          "and 0.1.0 could not be put back: pinger cannot be rolled back",
      ) as unknown,
    });
    expect(roots.installed("pinger")?.version).toBe("0.2.0");
    expect(logger.lines).toContainEqual(
      expect.stringContaining("ERROR update: pinger 0.2.0 failed"),
    );
  });

  it("rolls back, without blocking, when the runtime does not come back to be asked", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0");
    await updates.check();
    restartTook = null;
    expect(await drive(updates.apply("pinger", "person"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("the runtime did not come back running") as unknown,
    });
    expect(roots.installed("pinger")?.version).toBe("0.1.0");
    // Not the version's fault: it is offered again.
    restartTook = 250;
    expect(await drive(updates.apply("pinger", "person"))).toMatchObject({ ok: true });
  });

  it("keeps asking a runtime that cannot answer yet, and says so at the end of the window", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0");
    await updates.check();
    readiness = () => Promise.reject(new Error("the InnyTypes runtime is still starting"));
    expect(await drive(updates.apply("pinger", "person"))).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "the runtime could not say which instances are ready: the InnyTypes runtime is still starting",
      ) as unknown,
    });
  });

  it("stops nothing when the new version cannot be built, and the old one keeps running", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0", { declares: "0.2.0" });
    await updates.check();
    served.set(archiveUrl("pinger", "0.2.0"), new TextEncoder().encode("not an archive"));
    expect(await updates.apply("pinger", "person")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Not updated: it cannot be read") as unknown,
    });
    expect(restarts).toEqual([]);
    expect(roots.installed("pinger")?.version).toBe("0.1.0");
  });

  it("refuses an archive whose declaration disagrees about its version", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0", { declares: "0.1.0" });
    await updates.check();
    expect(await updates.apply("pinger", "person")).toMatchObject({
      ok: false,
      error: expect.stringContaining("which is not newer than 0.1.0") as unknown,
    });
    expect(restarts).toEqual([]);
  });

  it("refuses when the catalogue moved on since the check", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0");
    await updates.check();
    publish("pinger", "0.3.0");
    expect(await updates.apply("pinger", "person")).toMatchObject({
      ok: false,
      error: expect.stringContaining("now offers 0.3.0, not 0.2.0") as unknown,
    });
    entries = [];
    expect(await updates.apply("pinger", "person")).toMatchObject({
      ok: false,
      error: expect.stringContaining("no longer lists pinger") as unknown,
    });
  });

  it("refuses a package that is not installed, or has no newer version known", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    expect(await updates.apply("ghost", "person")).toMatchObject({ ok: false });
    expect(await updates.apply("pinger", "person")).toEqual({
      ok: false,
      error: "Not updated: no newer version of pinger is known; check for updates first.",
    });
  });
});

describe("the modes", () => {
  it("auto: the check applies the newer version by itself, and tells no update as waiting", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    writePackages({ update_mode: "auto" });
    publish("pinger", "0.2.0");
    await drive(updates.check());
    expect(told).toEqual([]);
    expect(roots.installed("pinger")?.version).toBe("0.2.0");
    expect(restarts).toEqual(["pinger was updated to 0.2.0"]);
  });

  it("manual: shown with Apply, applied only when the person presses it", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0");
    await drive(updates.check());
    expect(roots.installed("pinger")?.version).toBe("0.1.0");
    expect(await updates.apply("pinger", "auto")).toEqual({
      ok: false,
      error: "Not updated: pinger is updated only when you press Apply.",
    });
    expect(await drive(updates.apply("pinger", "person"))).toMatchObject({ ok: true });
  });

  it("pinned: shown, never applied, not by the check and not by a press, and not news", async () => {
    const { installer, updates } = await installed("pinger", "0.1.0");
    writePackages({ update_mode: "auto", overrides: { pinger: { update_mode: "pinned" } } });
    publish("pinger", "0.2.0");
    await drive(updates.check());
    // Only a manual package's newer version is a notice (notification.py rule 4).
    expect(told).toEqual([]);
    expect(roots.installed("pinger")?.version).toBe("0.1.0");
    expect(restarts).toEqual([]);
    expect(await line(installer, updates, "pinger")).toMatchObject({
      mode: "pinned",
      update: {
        kind: "newer",
        version: "0.2.0",
        detail: "pinger is pinned at 0.1.0",
        apply: false,
      },
    });
    expect(await updates.apply("pinger", "person")).toEqual({
      ok: false,
      error: "Not updated: pinger is pinned at 0.1.0; its mode must change before it is updated.",
    });
    // Unpinned: the next check moves it.
    writePackages({ update_mode: "auto" });
    await drive(updates.check());
    expect(roots.installed("pinger")?.version).toBe("0.2.0");
  });

  it("reads the modes at the moment they are needed, and offers Apply in manual mode only", async () => {
    const { installer, updates } = await installed("pinger", "0.1.0");
    publish("pinger", "0.2.0");
    await updates.check();
    expect((await line(installer, updates, "pinger"))?.update?.apply).toBe(true);
    // Auto: the machine's to apply at its next check, not a button for the person.
    writePackages({ update_mode: "auto" });
    expect(await line(installer, updates, "pinger")).toMatchObject({
      mode: "auto",
      update: { kind: "newer", version: "0.2.0", apply: false },
    });
    writePackages({ overrides: { pinger: { update_mode: "pinned" } } });
    expect(await updates.apply("pinger", "person")).toMatchObject({ ok: false });
    writePackages({ update_mode: "sometimes" });
    expect(await updates.apply("pinger", "person")).toMatchObject({
      ok: false,
      error: expect.stringContaining("one of auto, manual, pinned") as unknown,
    });
  });
});

describe("a path install (plan 0013)", () => {
  function folder(version: string, body: string): string {
    const where = path.join(base, "monty");
    fs.mkdirSync(where, { recursive: true });
    for (const [file, data] of Object.entries(packageFiles("monty", version, body))) {
      fs.writeFileSync(path.join(where, file), data);
    }
    return where;
  }

  it("refuses and reports content that changed under the same version, then updates to a new version", async () => {
    const where = folder("0.1.0", "// the first build\n");
    const { installer, updates } = setUp();
    expect(await installer.installFromFile(where, true)).toMatchObject({ ok: true });
    await updates.check();
    expect((await line(installer, updates, "monty"))?.update).toBeNull();

    // monty's case: a new behaviour, and the same version.
    folder("0.1.0", "// a new event kind\n");
    expect(await updates.check()).toEqual({
      ok: true,
      message: "Checked: every installed package is up to date.",
    });
    const moved = (await line(installer, updates, "monty"))?.update;
    expect(moved).toMatchObject({ kind: "moved", version: "0.1.0", apply: false });
    expect(moved?.detail).toContain(`the content at ${where} changed and its version did not`);
    expect(told).toEqual([
      {
        title: "monty 0.1.0 is being held back",
        body: expect.stringContaining("changed and its version did not") as unknown,
      },
    ]);
    expect(await updates.apply("monty", "person")).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed and its version did not") as unknown,
    });
    expect(restarts).toEqual(["monty was installed"]);

    // A new version: an update, applied from the folder.
    folder("0.2.0", "// a new event kind\n");
    await updates.check();
    expect((await line(installer, updates, "monty"))?.update).toMatchObject({
      kind: "newer",
      version: "0.2.0",
      apply: true,
    });
    expect(await drive(updates.apply("monty", "person"))).toMatchObject({ ok: true });
    expect(roots.installed("monty")).toMatchObject({
      version: "0.2.0",
      signed: false,
      origin: { kind: "file", path: where },
    });
  });

  it("cannot check a folder that is gone, or that now declares another package", async () => {
    const where = folder("0.1.0", "");
    const { installer, updates } = setUp();
    await installer.installFromFile(where, true);
    fs.writeFileSync(path.join(where, "inny-package.json"), declaration("other", "0.1.0"));
    await updates.check();
    expect((await line(installer, updates, "monty"))?.update?.detail).toBe(
      `${where} now declares other, not monty`,
    );
    fs.rmSync(where, { recursive: true });
    await updates.check();
    expect((await line(installer, updates, "monty"))?.update?.detail).toContain(
      `${where} cannot be read`,
    );
  });
});

describe("the schedule", () => {
  it("checks after the first delay, then every interval the settings name, and not when off", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    writePackages({ check_interval: 600 });
    updates.schedule(1000);
    const checks = () => logger.lines.filter((text) => text.includes("update check: 1 installed"));
    clock.advance(999);
    expect(checks()).toHaveLength(0);
    clock.advance(1);
    await drive(Promise.resolve());
    expect(checks()).toHaveLength(1);
    writePackages({ check_interval: 600, auto_check_versions: false });
    clock.advance(600_000);
    await drive(Promise.resolve());
    expect(checks()).toHaveLength(1);
    expect(logger.lines).toContainEqual("INFO update check: off in the settings; nothing is asked");
    writePackages({ update_mode: "never" });
    clock.advance(600_000);
    expect(logger.lines).toContainEqual(
      expect.stringContaining("WARN update check: the packages settings"),
    );
    updates.stop();
    expect(clock.pending).toBe(0);
  });

  it("logs a check the scheduler could not make", async () => {
    const { updates } = await installed("pinger", "0.1.0");
    updates.schedule(0);
    fs.writeFileSync(path.join(base, "shell-settings.json"), "{ not json");
    clock.advance(0);
    await drive(Promise.resolve());
    updates.stop();
    expect(logger.lines).toContainEqual(expect.stringContaining("WARN update check:"));
  });
});

describe("the blocked record", () => {
  it("keeps every version it was given, once each, in this user's data", () => {
    const file = path.join(base, "user-data", "blocked-updates.json");
    const blocked = new FsBlockedUpdates(file);
    expect(blocked.reason("pinger", "0.2.0")).toBeNull();
    blocked.block("pinger", "0.2.0", "no ready");
    blocked.block("pinger", "0.2.0", "no ready");
    blocked.block("pinger", "0.3.0", "crashed");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      blocked: { pinger: { "0.2.0": "no ready", "0.3.0": "crashed" } },
    });
    expect(blocked.reason("pinger", "0.3.0")).toBe("crashed");
  });

  it("refuses a record it cannot read rather than reading it as empty, and holds the update", async () => {
    const file = path.join(base, "blocked.json");
    fs.writeFileSync(file, "not json");
    expect(() => new FsBlockedUpdates(file).reason("p", "1")).toThrow("is not JSON");
    fs.writeFileSync(file, JSON.stringify({ blocked: { p: ["1"] } }));
    expect(() => new FsBlockedUpdates(file).reason("p", "1")).toThrow("not a record");
    fs.writeFileSync(file, JSON.stringify([]));
    expect(() => new FsBlockedUpdates(file).reason("p", "1")).toThrow("not a record");

    await installed("pinger", "0.1.0");
    const broken = setUp({ blocked: new FsBlockedUpdates(file) }).updates;
    publish("pinger", "0.2.0");
    await broken.check();
    const outcome: PackageOutcome = await broken.apply("pinger", "person");
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("the record of failed updates cannot be read") as unknown,
    });
    // Held, so it was not told as available either.
    expect(told).toEqual([]);
  });
});
