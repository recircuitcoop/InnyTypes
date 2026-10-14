// General's Packages board (application/package-board.ts; plan 0022 §F, D5, D6, plan 0013) with
// the real disk adapters: packages installed from folders into a real sealed live root, their
// content re-hashed, kept versions pruned after seven days, and the `packages.unregistered`
// setting in a real settings file. The runtime's restart, its loaded types and its readiness
// are stand-ins; wall-clock time is a number the test moves.
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
import { OneAtATime, PackageInstaller } from "../../src/application/install-package";
import { NoticeBoard } from "../../src/application/notices";
import { PackageBoard, type Board } from "../../src/application/package-board";
import { PackageRemover } from "../../src/application/remove-package";
import { PackageUpdates } from "../../src/application/update-package";
import { ROLLBACK_WINDOW_MS, type Package } from "../../src/domain/packages/states";
import { parsePackagePolicy, unregisteredOf } from "../../src/domain/packages/versions";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger } from "../fakes/children";
import { Signer } from "../fakes/minisign-signer";
import { signedArchive } from "../fakes/package-archive";

const DAY = 24 * 60 * 60 * 1000;
const START = 1_760_000_000_000;

let base: string;
let roots: FsPackageRoots;
let settings: JsonSettingsStore;
let logger: RecordingLogger;
let now: number;
let restarts: string[];
let types: readonly string[] | null;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-board-")));
  roots = new FsPackageRoots(path.join(base, "node-packages"));
  settings = new JsonSettingsStore(path.join(base, "shell-settings.json"));
  logger = new RecordingLogger();
  now = START;
  published = null;
  restarts = [];
  types = [];
});

afterEach(() => {
  unsealTree(base);
  fs.rmSync(base, { recursive: true, force: true });
});

/** A package folder at `version`; `body` is its node's code. */
function writeFolder(name: string, version: string, body = "// one\n"): string {
  const folder = path.join(base, "sources", name);
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
          id: "ping",
          kind: "node",
          label: "Ping",
          command: ["{node}", "{package}/node.js"],
          config: { type: "object" },
          outputs: [{ port: "out", event: `${name}.out.v1` }],
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(folder, "node.js"), body);
  return folder;
}

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

/** The official catalogue this test serves: one signed archive, or none. */
let published: { signer: Signer; archive: Uint8Array } | null;

function setUp(shipped: { name: string; version: string }[] = []) {
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
    now: () => now,
  };
  const restartRuntime = (reason: string) => {
    restarts.push(reason);
    return Promise.resolve(100);
  };
  const reads = {
    catalogue: () =>
      published === null
        ? Promise.reject(new Error("no catalogue in this build"))
        : Promise.resolve({
            name: "official",
            url: "https://catalogue.test/catalogue.json",
            verified: true,
            fetchedAt: 0,
            entries: [
              {
                packageId: "verkit",
                summary: "Says its version.",
                installSource: "index",
                catalogue: "official",
                verified: true,
                archive: "https://catalogue.test/verkit.tgz",
                version: "0.1.0",
              },
            ],
          }),
    catalogueKey: published?.signer.publicKeyText ?? null,
    sources: () => [],
    registered: () => Promise.reject(new Error("no registered source")),
    http: {
      get: () =>
        Promise.resolve(
          published === null
            ? { ok: false as const, failure: "status" as const, detail: "404" }
            : { ok: true as const, body: published.archive },
        ),
    },
    saveDownload: (name: string, bytes: Uint8Array) => {
      const file = path.join(base, "downloads", `${name}.tgz`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return file;
    },
  };
  const one = new OneAtATime();
  const installer = new PackageInstaller(
    { ...reads, environment, shipped: () => shipped, restartRuntime, logger },
    one,
  );
  const updates = new PackageUpdates(
    {
      ...reads,
      environment,
      policy: () => parsePackagePolicy(settings.readPackages()),
      restartRuntime,
      readiness: () => Promise.resolve({ deployed: ["n1"], ready: ["n1"] }),
      blocked: new FsBlockedUpdates(path.join(base, "blocked-updates.json")),
      notifier: new NoticeBoard({ deliver: () => undefined, store: null, logger }),
      clock: new FakeClock(),
      now: () => now,
      logger,
    },
    one,
  );
  const remover = new PackageRemover(
    {
      roots,
      typesInUse: () => Promise.resolve({ deployed: [], undeployed: null }),
      forgetGenerated: () => undefined,
      shipped: () => shipped.map((listed) => listed.name),
      restartRuntime,
      logger,
    },
    one,
  );
  const board = new PackageBoard({
    roots,
    environment,
    shipped: () => shipped,
    installer,
    updates,
    remover,
    settings,
    loadedTypes: () => Promise.resolve(types),
    restartRuntime,
    one,
    now: () => now,
    logger,
  });
  return { board, installer };
}

const row = (board: Board, name: string): Package => {
  const found = board.rows.find((entry) => entry.package.name === name);
  if (found === undefined) throw new Error(`${name} is not listed`);
  return found.package;
};

describe("from a folder (plan 0013)", () => {
  it("a folder whose code changed under the same version is changed: on Check for changes and at start", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    expect(await board.installFolder(folder)).toEqual({ ok: true });
    expect(await board.checkFolder("monty")).toEqual({ ok: true });
    const fresh = row(await board.board(), "monty");
    expect(fresh).toMatchObject({
      source: { kind: "folder", path: folder },
      signed: false,
      installation: { state: "installed" },
      update: { state: "up-to-date" },
    });

    // New behaviour, the same declared version.
    writeFolder("monty", "0.1.0", "// one\n// a new event kind\n");
    now += 60_000;
    expect(await board.checkFolder("monty")).toEqual({ ok: true });
    const changed = row(await board.board(), "monty");
    expect(changed.update).toEqual({
      state: "changed",
      version: "0.1.0",
      verifiedAt: new Date(now),
    });

    // At start: a new board, as the next launch builds it, says so before anything is pressed.
    const next = setUp().board;
    await next.start();
    expect(row(await next.board(), "monty").update?.state).toBe("changed");
  });

  it("the installed copy is re-hashed: a live file changed fails its check", async () => {
    const { board } = setUp();
    await board.start();
    await board.installFolder(writeFolder("monty", "0.1.0"));
    const live = roots.list()[0]?.folder.packageDir ?? "";
    unsealTree(live);
    fs.writeFileSync(path.join(live, "node.js"), "// tampered\n");
    await board.checkFolder("monty");
    expect(row(await board.board(), "monty").installation).toMatchObject({
      state: "failed-check",
      reason: "content-moved",
    });
  });
});

describe("from the catalogue", () => {
  it("a signed archive's live copy re-hashes to the hash recorded at install", async () => {
    const signer = new Signer();
    const folder = writeFolder("verkit", "0.1.0");
    const files = Object.fromEntries(
      ["inny-package.json", "node.js"].map((file) => [
        file,
        fs.readFileSync(path.join(folder, file), "utf8"),
      ]),
    );
    published = { signer, archive: signedArchive(files, signer) };
    const { board } = setUp();
    await board.start();
    expect(await board.install("official", "verkit")).toEqual({ ok: true });
    const { rows, offers } = await board.board();
    expect(offers).toEqual([]);
    expect(rows.find((entry) => entry.package.name === "verkit")).toMatchObject({
      publisher: "InnyTypes",
      package: {
        signed: true,
        source: { kind: "catalogue" },
        installation: { state: "installed" },
      },
    });
  });
});

describe("update and Go back (D5)", () => {
  it("a newer folder version is updated; Go back within seven days returns it and offers the left version again", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    writeFolder("monty", "0.2.0");
    await board.checkFolder("monty");
    expect(row(await board.board(), "monty").update).toMatchObject({
      state: "available",
      version: "0.2.0",
    });
    restarts = [];
    expect(await board.update("monty")).toEqual({ ok: true });
    expect(row(await board.board(), "monty")).toMatchObject({
      version: "0.2.0",
      update: {
        state: "updated",
        version: "0.2.0",
        previous: "0.1.0",
        rollbackUntil: new Date(now + ROLLBACK_WINDOW_MS),
      },
    });

    now += 6 * DAY;
    expect(await board.goBack("monty")).toEqual({ ok: true });
    expect(restarts.at(-1)).toBe("monty went back to 0.1.0");
    const back = row(await board.board(), "monty");
    // Never blocked: the version it left is offered again, and can be applied again.
    expect(back).toMatchObject({
      version: "0.1.0",
      update: { state: "available", version: "0.2.0" },
    });
    expect(fs.existsSync(path.join(base, "blocked-updates.json"))).toBe(false);
    expect(await board.update("monty")).toEqual({ ok: true });
    expect(row(await board.board(), "monty").version).toBe("0.2.0");
  });

  it("after seven days Go back is refused, and the next start prunes what was kept", async () => {
    const folder = writeFolder("monty", "0.1.0");
    const { board } = setUp();
    await board.start();
    await board.installFolder(folder);
    writeFolder("monty", "0.2.0");
    await board.update("monty");
    expect(roots.kept("monty")?.version).toBe("0.1.0");

    now += 7 * DAY;
    expect(row(await board.board(), "monty").update?.state).not.toBe("updated");
    expect(await board.goBack("monty")).toEqual({
      ok: false,
      refusal: { reason: "rollback-expired" },
    });
    await setUp().board.start();
    expect(roots.kept("monty")).toBeUndefined();
    expect(logger.lines.some((line) => line.includes("past its seven days: pruned"))).toBe(true);
  });
});

describe("register and unregister (D6)", () => {
  it("unregister is refused while used, naming every use; otherwise stored, and only the runtime restarts", async () => {
    const { board } = setUp([{ name: "anytype", version: "1.0.0" }]);
    await board.start();
    types = ["inny-anytype-create", "inject"];
    const uses = [
      { flow: "Recordings to Anytype", step: "File" },
      { flow: "Invoices from the mailbox", step: "File invoice" },
    ];
    expect(await board.unregister("anytype", uses)).toEqual({
      ok: false,
      refusal: { reason: "in-use", action: "unregister", uses },
    });
    expect(row(await board.board(), "anytype").registration?.state).toBe("registered");

    expect(await board.unregister("anytype", [])).toEqual({ ok: true });
    expect(unregisteredOf(settings.readPackages())).toEqual(["anytype"]);
    expect(restarts).toEqual(["anytype was unregistered"]);
    types = ["inject"];
    expect(row(await board.board(), "anytype").registration).toEqual({
      state: "not-registered",
      verifiedAt: new Date(now),
    });
    // A shipped package is unregistered, never removed.
    expect(await board.remove("anytype", [])).toEqual({
      ok: false,
      refusal: { reason: "shipped" },
    });

    expect(await board.register("anytype")).toEqual({ ok: true });
    expect(unregisteredOf(settings.readPackages())).toEqual([]);
  });

  it("no state without when it was checked; registration unverified while the runtime is not running", async () => {
    const { board } = setUp([{ name: "anytype", version: "1.0.0" }]);
    await board.start();
    await board.installFolder(writeFolder("monty", "0.1.0"));
    types = null;
    const listed = await board.board();
    for (const { package: pkg } of listed.rows) {
      expect(pkg.registration).toBeNull();
      for (const facet of [pkg.installation, pkg.update]) {
        if (facet !== null) expect(facet.verifiedAt).toBeInstanceOf(Date);
      }
    }
  });
});
