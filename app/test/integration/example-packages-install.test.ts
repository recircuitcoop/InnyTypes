// The two example packages (WI-0018-26, docs/authors/README.md) install into the app for
// real, through the same PackageInstaller.installFromFile use case the Packages page's
// "install from a folder" calls (application/install-package.ts) -- not a synthetic fixture,
// but sdk/python/examples/echo and sdk/ts/examples/echo exactly as an author would keep them.
//
// sdk-ts ships source only (src/main.ts): generated build output does not live in the source
// tree, so this test bundles it with esbuild into a throwaway temp copy of the package, the
// same way docs/authors/packaging.md tells an author to before publishing -- never into
// sdk/ts/examples/echo itself. It needs neither uv nor Python, so it otherwise uses the same
// "runtimes throw" builder app/test/integration/package-install.test.ts does. sdk-py's
// uv-python package has no requirements.lock (it vendors innytypes_node rather than depending
// on an unpublished index entry -- docs/authors/python-sdk.md), so building its environment is
// `uv venv` on a real system Python 3.13 and nothing to sync: the same real builder
// app/test/integration/package-environments.test.ts uses, offline, no index reached.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FsContentHashes } from "../../src/adapters/fs/content-hashes";
import { FsPackageRoots, unsealTree } from "../../src/adapters/fs/package-roots";
import { FsPackageSource } from "../../src/adapters/fs/package-source";
import { PackageEnvironmentBuilder } from "../../src/adapters/process/env-builder";
import { SystemRuntimeLocator } from "../../src/adapters/process/runtime-locator";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { sha256Hex } from "../../src/adapters/signature/digest";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import {
  OneAtATime,
  PackageInstaller,
  type PackageInstallerPorts,
} from "../../src/application/install-package";
import type { EnvironmentBuilder } from "../../src/ports/environment-builder";
import { RecordingLogger } from "../fakes/children";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let base: string;
let roots: FsPackageRoots;
let logger: RecordingLogger;
let restarts: string[];

const NODE_NEVER_ASKED: EnvironmentBuilder = new PackageEnvironmentBuilder({
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

function installerWith(builder: EnvironmentBuilder): PackageInstaller {
  const ports: PackageInstallerPorts = {
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
    catalogue: () => Promise.reject(new Error("no catalogue in this test")),
    catalogueKey: null,
    sources: () => [],
    registered: () => Promise.reject(new Error("no source is registered here")),
    http: { get: () => Promise.resolve({ ok: false, failure: "status", detail: "unused" }) },
    saveDownload: () => {
      throw new Error("not exercised: only installFromFile is used here");
    },
    shipped: () => [],
    restartRuntime: (reason: string) => {
      restarts.push(reason);
      return Promise.resolve(null);
    },
    logger,
  };
  return new PackageInstaller(ports, new OneAtATime());
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-example-install-")));
  roots = new FsPackageRoots(path.join(base, "node-packages"));
  logger = new RecordingLogger();
  restarts = [];
});

afterEach(() => {
  unsealTree(base);
  fs.rmSync(base, { recursive: true, force: true });
});

/**
 * A throwaway copy of sdk/ts/examples/echo, bundled with esbuild exactly as
 * docs/authors/packaging.md tells an author to before publishing: generated output never
 * lands in the source tree, not even under its gitignored dist/, only under a temp directory
 * this test owns and removes.
 */
function bundledEchoTsCopy(): string {
  const source = path.join(REPO, "sdk", "ts", "examples", "echo");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "inny-example-echots-"));
  fs.copyFileSync(path.join(source, "inny-package.json"), path.join(copy, "inny-package.json"));
  // esbuild runs on the ORIGINAL src/main.ts (so "@innytypes/node" resolves through this
  // workspace's own node_modules symlink, exactly as it would for a real author's checkout),
  // writing only its output into the temp copy: nothing generated ever touches sdk/ts itself.
  const esbuild = path.join(REPO, "node_modules", ".bin", "esbuild");
  execFileSync(esbuild, [
    path.join(source, "src", "main.ts"),
    "--bundle",
    "--platform=node",
    "--target=node22",
    "--format=cjs",
    `--outfile=${path.join(copy, "dist", "main.cjs")}`,
    "--log-level=warning",
  ]);
  return copy;
}

describe("the TypeScript example package (sdk/ts/examples/echo)", () => {
  it("installs, bundled at build time, through the real install-from-file use case", async () => {
    const bundled = bundledEchoTsCopy();
    try {
      const outcome = await installerWith(NODE_NEVER_ASKED).installFromFile(bundled, true);
      expect(outcome).toEqual({
        ok: true,
        message: "echots 0.1.0 is installed, unsigned. Its types are in the editor's palette.",
      });
      expect(roots.installed("echots")).toMatchObject({ package: "echots", version: "0.1.0" });
      expect(restarts).toEqual(["echots was installed"]);
    } finally {
      fs.rmSync(bundled, { recursive: true, force: true });
    }
  });
});

describe("the Python example package (sdk/python/examples/echo)", () => {
  let hasSystemPython313 = false;
  let sharedCache: string;

  beforeAll(() => {
    // Its own cache dir throughout, including the discovery probe below: the home guard
    // refuses any test that writes into the real ~/.cache, and uv writes there by default.
    sharedCache = fs.mkdtempSync(path.join(os.tmpdir(), "inny-example-uv-cache-"));
    try {
      execFileSync("uv", ["python", "find", "--no-project", "--no-config", "--system", "3.13"], {
        env: { ...process.env, UV_CACHE_DIR: sharedCache, UV_PYTHON_DOWNLOADS: "never" },
        stdio: "ignore",
      });
      hasSystemPython313 = true;
    } catch {
      hasSystemPython313 = false; // this machine has no system Python 3.13; skip below
    }
  });

  afterAll(() => {
    fs.rmSync(sharedCache, { recursive: true, force: true });
  });

  it(
    "installs from its folder through the real install-from-file use case, on a real uv venv",
    { timeout: 120_000 },
    async () => {
      if (!hasSystemPython313) {
        return; // WI-0018-23's bundled Python stands in for this on the real machine
      }
      const builder = new PackageEnvironmentBuilder({
        locator: new SystemRuntimeLocator(process.env, process.platform, sharedCache),
        parentEnvironment: process.env,
        cacheDir: sharedCache,
        wheels: { kind: "default" },
        timeoutMs: 120_000,
        platform: process.platform,
      });
      const outcome = await installerWith(builder).installFromFile(
        path.join(REPO, "sdk", "python", "examples", "echo"),
        true,
      );
      expect(outcome).toEqual({
        ok: true,
        message: "echopy 0.1.0 is installed, unsigned. Its types are in the editor's palette.",
      });
      expect(roots.installed("echopy")).toMatchObject({ package: "echopy", version: "0.1.0" });
    },
  );
});
