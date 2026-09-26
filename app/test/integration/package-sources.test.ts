// Registered catalogue sources (plan 0006 F1, F2; application/package-sources.ts,
// package-catalogues.ts; WI-0018-17), with the real settings file, the real catalogue reader
// and minisign verifier over an in-memory publishing host, and real signed installs.
//
// The old tests this answers are tests/test_plugin_lists.py's eight rows WI-0018-16 handed on:
// the three lists in config order, a mistyped key refused without writing, the official entry
// winning without hiding its shadow, one failed catalogue leaving the others intact, entries
// naming their source with only a keyless one unverified, registration, removal and refusals
// as messages, the switch round-tripping at once, and an install recording its source's policy.
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
import { CatalogueReader } from "../../src/application/catalogue-reader";
import { OneAtATime, PackageInstaller } from "../../src/application/install-package";
import { NoticeBoard } from "../../src/application/notices";
import type { CatalogueReads } from "../../src/application/package-catalogues";
import { PackageSources, readSources } from "../../src/application/package-sources";
import { PackageUpdates } from "../../src/application/update-package";
import { parsePackagePolicy } from "../../src/domain/packages/versions";
import type { CatalogueCacheStore } from "../../src/ports/catalogue-cache";
import { FakeClock } from "../fakes/clock";
import { RecordingLogger } from "../fakes/children";
import { Signer } from "../fakes/minisign-signer";
import { signedArchive, type Files } from "../fakes/package-archive";
import { PublishingHost } from "../fakes/publishing-host";

const OFFICIAL = "https://official.test/catalogue.json";
const ACME = "https://acme.test/catalogue.json";
const FRIENDS = "https://friends.test/catalogue.json";

let base: string;
let settingsFile: string;
let settings: JsonSettingsStore;
let logger: RecordingLogger;
let host: PublishingHost;
let official: Signer;
let acme: Signer;
let roots: FsPackageRoots;

class MemoryCache implements CatalogueCacheStore {
  readonly kept = new Map<string, string>();
  read(name: string): string | null {
    return this.kept.get(name) ?? null;
  }
  write(name: string, text: string): void {
    this.kept.set(name, text);
  }
  forget(name: string): void {
    this.kept.delete(name);
  }
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-sources-")));
  settingsFile = path.join(base, "shell-settings.json");
  settings = new JsonSettingsStore(settingsFile);
  logger = new RecordingLogger();
  host = new PublishingHost();
  official = new Signer();
  acme = new Signer();
  roots = new FsPackageRoots(path.join(base, "node-packages"));
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

const files = (name: string, version = "1.0.0"): Files => ({
  "inny-package.json": declaration(name, version),
  "node.js": "process.stdout.write('')\n",
});

/** Publish a catalogue at `url`, signed by `signer` (unsigned when null), with its archives. */
function catalogue(
  url: string,
  signer: Signer | null,
  plugins: { id: string; summary: string; version?: string }[],
): void {
  const document = new TextEncoder().encode(
    JSON.stringify({
      catalogue: 1,
      plugins: plugins.map((plugin) => ({
        ...plugin,
        source: "index",
        archive: `${plugin.id}.tgz`,
      })),
    }),
  );
  host.publish(url, document, signer === null ? undefined : signer.sign(document));
  for (const plugin of plugins) {
    const archive = signedArchive(
      files(plugin.id.replace(/-/g, "_"), plugin.version ?? "1.0.0"),
      signer ?? new Signer(),
    );
    host.responses.set(new URL(`${plugin.id}.tgz`, url).href, archive);
  }
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

function setUp() {
  const reader = new CatalogueReader({
    http: host,
    cache: new MemoryCache(),
    verifier: new MinisignVerifier(),
    now: () => Date.now(),
    maxAgeSeconds: () => 0,
    officialUrl: OFFICIAL,
    officialKey: official.publicKeyText,
  });
  const reads: CatalogueReads = {
    catalogue: () => reader.official(),
    catalogueKey: official.publicKeyText,
    sources: () => readSources(settings),
    registered: (source) => reader.registered(source),
    http: host,
    saveDownload: (name, bytes) => {
      const file = path.join(base, "downloads", `${name}.tgz`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return file;
    },
  };
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
  const one = new OneAtATime();
  const restartRuntime = () => Promise.resolve(10);
  const installer = new PackageInstaller(
    { ...reads, environment, shipped: () => [], restartRuntime, logger },
    one,
  );
  const updates = new PackageUpdates(
    {
      ...reads,
      environment,
      policy: () => parsePackagePolicy(settings.readPackages()),
      restartRuntime,
      readiness: () => Promise.resolve({ deployed: [], ready: [] }),
      blocked: new FsBlockedUpdates(path.join(base, "blocked.json")),
      notifier: new NoticeBoard({ deliver: () => undefined, store: null, logger }),
      clock: new FakeClock(),
      now: () => 0,
      logger,
    },
    one,
  );
  return { installer, updates, sources: new PackageSources(settings, logger) };
}

describe("registering sources", () => {
  it("registers, removes and refuses, each as a message, and writes only what passed", () => {
    const { sources } = setUp();
    expect(sources.register("new", "https://new.test/list.json", "")).toEqual({
      ok: true,
      message: "The source new is registered.",
    });
    expect(sources.register("acme", ACME, acme.publicKeyLine)).toMatchObject({ ok: true });
    expect(readSources(settings).map((source) => source.name)).toEqual(["new", "acme"]);
    expect(sources.remove("new")).toEqual({ ok: true, message: "The source new is removed." });

    const before = fs.readFileSync(settingsFile);
    const duplicate = sources.register("acme", "https://elsewhere.test/list.json", "");
    const insecure = sources.register("bad", "http://bad.test/list.json", "");
    const official = sources.register("official", "https://x.test/list.json", "");
    const badName = sources.register("Bad Name", "https://x.test/list.json", "");
    expect(duplicate).toEqual({
      ok: false,
      error: "Not changed: a source named acme is already registered.",
    });
    expect(insecure).toMatchObject({
      ok: false,
      error: expect.stringContaining("which is not an HTTPS URL") as unknown,
    });
    expect(official).toMatchObject({
      ok: false,
      error: expect.stringContaining("reserved") as unknown,
    });
    expect(badName).toMatchObject({ ok: false });
    expect(sources.remove("ghost")).toEqual({
      ok: false,
      error: "Not changed: no source named ghost is registered.",
    });
    expect(sources.setAutoUpdate("ghost", true)).toMatchObject({ ok: false });
    expect(fs.readFileSync(settingsFile)).toEqual(before);
    expect(logger.lines).toContainEqual("INFO sources: acme was registered");
    expect(logger.lines).toContainEqual(expect.stringContaining("WARN sources: bad was refused"));
  });

  it("refuses a mistyped public key before anything is written", () => {
    const { sources } = setUp();
    sources.register("acme", ACME, "");
    const before = fs.readFileSync(settingsFile);
    for (const key of ["not-a-key", acme.publicKeyLine.slice(0, -4), "RWQ=="]) {
      const outcome = sources.register("broken", "https://safe.test/list.json", key);
      expect(outcome).toMatchObject({
        ok: false,
        error: expect.stringContaining("the public key is not a minisign public key") as unknown,
      });
    }
    expect(fs.readFileSync(settingsFile)).toEqual(before);
  });

  it("round-trips the auto-update switch at once", () => {
    const { sources } = setUp();
    sources.register("acme", ACME, "");
    expect(sources.setAutoUpdate("acme", true)).toEqual({
      ok: true,
      message: "The source acme is set to update automatically.",
    });
    expect(readSources(settings)[0]?.autoUpdate).toBe(true);
    expect(sources.setAutoUpdate("acme", false).ok).toBe(true);
    expect(readSources(settings)[0]?.autoUpdate).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsFile, "utf8"))).toEqual({
      sources: { acme: { url: ACME, auto_update: false } },
    });
  });

  it("says a settings file it cannot write, and one it cannot read", () => {
    const { sources } = setUp();
    fs.mkdirSync(settingsFile);
    expect(sources.register("acme", ACME, "")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Not changed:") as unknown,
    });
    fs.rmdirSync(settingsFile);
    fs.writeFileSync(settingsFile, JSON.stringify({ sources: { acme: { url: "http://x" } } }));
    expect(sources.register("other", ACME, "")).toMatchObject({ ok: false });
  });
});

describe("the three lists", () => {
  it("are installed, official, then each source in the settings' order, each entry naming its source", async () => {
    catalogue(OFFICIAL, official, [{ id: "monty", summary: "Files things.", version: "1.0.0" }]);
    catalogue(ACME, acme, [{ id: "whodunnit", summary: "Finds authors." }]);
    catalogue(FRIENDS, null, [{ id: "summarize", summary: "Makes text short." }]);
    const { installer, sources } = setUp();
    sources.register("acme", ACME, acme.publicKeyLine);
    sources.register("friends", FRIENDS, "");
    const state = await installer.state();
    expect(state.catalogue.map((offer) => [offer.source, offer.id, offer.verified])).toEqual([
      ["official", "monty", true],
    ]);
    expect(state.catalogue[0]?.version).toBe("1.0.0");
    expect(state.sources.map((source) => source.name)).toEqual(["acme", "friends"]);
    const [signed, open] = state.sources;
    expect(signed).toMatchObject({ publisher: "acme.test", keyed: true, problem: null });
    expect(signed?.offers.map((offer) => [offer.source, offer.id, offer.verified])).toEqual([
      ["acme", "whodunnit", true],
    ]);
    // Only the keyless source is unverified.
    expect(open).toMatchObject({ publisher: "friends.test", keyed: false });
    expect(open?.offers.map((offer) => [offer.source, offer.id, offer.verified])).toEqual([
      ["friends", "summarize", false],
    ]);
  });

  it("let the official entry win over a same-named one, without hiding it", async () => {
    catalogue(OFFICIAL, official, [{ id: "monty", summary: "Official." }]);
    catalogue(ACME, null, [{ id: "monty", summary: "Impostor." }]);
    const { installer, sources } = setUp();
    sources.register("acme", ACME, "");
    const state = await installer.state();
    expect(state.catalogue[0]).toMatchObject({ id: "monty", installable: true, shadowedBy: null });
    expect(state.sources[0]?.offers[0]).toMatchObject({
      id: "monty",
      summary: "Impostor.",
      source: "acme",
      installable: false,
      shadowedBy: "official",
    });
    expect(await installer.installFromSource("acme", "monty", true)).toEqual({
      ok: false,
      error:
        "Not installed: the official catalogue offers monty too, and its entry is the one installed.",
    });
    expect(roots.list()).toEqual([]);
  });

  it("list one failed catalogue with its reason, and every other as it is", async () => {
    catalogue(OFFICIAL, official, [{ id: "monty", summary: "Official." }]);
    // Signed by someone else than the key registered for it.
    catalogue(ACME, new Signer(), [{ id: "whodunnit", summary: "Finds authors." }]);
    catalogue(FRIENDS, null, [{ id: "one", summary: "One." }]);
    const { installer, sources } = setUp();
    sources.register("acme", ACME, acme.publicKeyLine);
    sources.register("offline", "https://offline.test/list.json", "");
    sources.register("friends", FRIENDS, "");
    const state = await installer.state();
    expect(state.catalogue.map((offer) => offer.id)).toEqual(["monty"]);
    expect(state.sources.map((source) => [source.name, source.offers.length])).toEqual([
      ["acme", 0],
      ["offline", 0],
      ["friends", 1],
    ]);
    expect(state.sources[0]?.problem).toContain("failed its signature check");
    expect(state.sources[1]?.problem).toContain("could not be read");
    expect(state.sources[2]?.problem).toBeNull();
  });

  it("say when the sources cannot be read from the settings, and still list the rest", async () => {
    catalogue(OFFICIAL, official, [{ id: "monty", summary: "Official." }]);
    fs.writeFileSync(settingsFile, JSON.stringify({ sources: [] }));
    const state = await setUp().installer.state();
    expect(state.catalogue).toHaveLength(1);
    expect(state.sourcesProblem).toContain("the registered sources cannot be read");
  });
});

describe("installing from a registered source", () => {
  it("verifies a signed source's archive with its key, and records the source's update policy", async () => {
    catalogue(OFFICIAL, official, []);
    catalogue(ACME, acme, [{ id: "whodunnit", summary: "Finds authors.", version: "1.0.0" }]);
    const { installer, updates, sources } = setUp();
    sources.register("acme", ACME, acme.publicKeyLine);
    sources.setAutoUpdate("acme", true);
    expect(await installer.installFromSource("acme", "whodunnit", false)).toEqual({
      ok: true,
      message: "whodunnit 1.0.0 is installed. Its types are in the editor's palette.",
    });
    expect(roots.installed("whodunnit")).toMatchObject({
      signed: true,
      origin: { kind: "catalogue", source: "acme", id: "whodunnit" },
    });
    const mode = async () =>
      updates.decorate(await installer.state()).packages.find((p) => p.name === "whodunnit")?.mode;
    expect(await mode()).toBe("auto");
    // The source's switch is this package's too, read at once.
    sources.setAutoUpdate("acme", false);
    expect(await mode()).toBe("manual");
    // A package's own mode wins over its source's switch.
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(settingsFile, "utf8")),
        packages: { overrides: { whodunnit: { update_mode: "pinned" } } },
      }),
    );
    expect(await mode()).toBe("pinned");
  });

  it("asks before installing from a keyless source, and marks what it installs unsigned", async () => {
    catalogue(OFFICIAL, official, []);
    catalogue(FRIENDS, null, [{ id: "summarize", summary: "Makes text short." }]);
    const { installer, sources } = setUp();
    sources.register("friends", FRIENDS, "");
    expect(await installer.installFromSource("friends", "summarize", false)).toEqual({
      ok: false,
      error:
        "summarize comes from friends, a source registered with no public key: nobody vouches " +
        "for its code. It is installed only once you confirm that you want it anyway.",
      needsConfirmation: true,
    });
    expect(roots.list()).toEqual([]);
    expect(await installer.installFromSource("friends", "summarize", true)).toMatchObject({
      ok: true,
      message: "summarize 1.0.0 is installed, unsigned. Its types are in the editor's palette.",
    });
    expect(roots.installed("summarize")?.signed).toBe(false);
  });

  it("refuses a source that is not registered, an entry it does not list, and an archive it cannot fetch", async () => {
    catalogue(OFFICIAL, official, []);
    catalogue(ACME, acme, [{ id: "whodunnit", summary: "Finds authors." }]);
    const { installer, sources } = setUp();
    expect(await installer.installFromSource("ghost", "xyz", false)).toEqual({
      ok: false,
      error: "Not installed: the catalogue could not be read: no source named ghost is registered.",
    });
    sources.register("acme", ACME, acme.publicKeyLine);
    expect(await installer.installFromSource("acme", "other", false)).toMatchObject({
      ok: false,
      error: "Not installed: the catalogue does not list it.",
    });
    host.responses.delete(new URL("whodunnit.tgz", ACME).href);
    expect(await installer.installFromSource("acme", "whodunnit", false)).toMatchObject({
      ok: false,
      error: expect.stringContaining("its archive could not be fetched") as unknown,
    });
  });
});
