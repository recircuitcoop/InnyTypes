// application/package-environment.ts end to end, with the real adapters: signed archives
// read from disk, uv environments built on a system Python 3.13 from local wheels, offline,
// staged and swapped in. One verified environment per package (spec 2.3.3, 2.3.5; plan 0013).
//
// The wheels are written by the test (fakes/package-archive.ts) and served from a folder with
// `--no-index --offline`: no index is reached. uv's cache is a temp folder, never the user's.
// Needs `uv` on PATH and a Python 3.13 that `uv python find --system 3.13` finds; the bundled
// ones are WI-0018-23's.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FsContentHashes } from "../../src/adapters/fs/content-hashes";
import { FsPackageRoots, unsealTree } from "../../src/adapters/fs/package-roots";
import { FsPackageSource } from "../../src/adapters/fs/package-source";
import {
  PackageEnvironmentBuilder,
  venvPython,
  wheelArguments,
} from "../../src/adapters/process/env-builder";
import { SystemRuntimeLocator } from "../../src/adapters/process/runtime-locator";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { sha256Hex } from "../../src/adapters/signature/digest";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import {
  buildPackageEnvironment,
  type PackageEnvironmentPorts,
  type PackageOrigin,
} from "../../src/application/package-environment";
import { PackageRefusal } from "../../src/domain/packages/archive";
import type { EnvironmentBuilder } from "../../src/ports/environment-builder";
import type { RuntimeLocator } from "../../src/ports/runtime-locator";
import { RecordingLogger } from "../fakes/children";
import { Signer } from "../fakes/minisign-signer";
import { filesJson, sha256, signedArchive, tgz, wheel, type Files } from "../fakes/package-archive";

const UV_TIMEOUT_MS = 120_000;

let scratch: string;
let wheels: string;
let cacheDir: string;
let locator: RuntimeLocator;
const lockLine = new Map<string, string>();

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-envs-")));
  wheels = path.join(scratch, "wheels");
  cacheDir = path.join(scratch, "uv-cache");
  fs.mkdirSync(wheels);
  for (const [name, version] of [
    ["alpha", "1.0"],
    ["beta", "1.0"],
  ] as const) {
    const built = wheel(name, version);
    fs.writeFileSync(path.join(wheels, built.file), built.bytes);
    lockLine.set(name, `${name}==${version} --hash=sha256:${sha256(built.bytes)}\n`);
  }
  locator = new SystemRuntimeLocator(process.env, process.platform, cacheDir);
});

afterAll(() => {
  unsealTree(scratch);
  fs.rmSync(scratch, { recursive: true, force: true });
});

let base: string;
let signer: Signer;
let logger: RecordingLogger;
let ports: PackageEnvironmentPorts;
let roots: FsPackageRoots;

function portsWith(builder: EnvironmentBuilder): PackageEnvironmentPorts {
  return {
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
}

function realBuilder(): PackageEnvironmentBuilder {
  return new PackageEnvironmentBuilder({
    locator,
    parentEnvironment: process.env,
    cacheDir,
    wheels: { kind: "folder", findLinks: wheels },
    timeoutMs: UV_TIMEOUT_MS,
    platform: process.platform,
  });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(scratch, "base-"));
  roots = new FsPackageRoots(base);
  signer = new Signer();
  logger = new RecordingLogger();
  ports = portsWith(realBuilder());
});

function declaration(
  name: string,
  version: string,
  environment: Record<string, unknown>,
  command: unknown = ["{python}", "{package}/node.py"],
): string {
  return JSON.stringify({
    protocol: 2,
    package: name,
    version,
    environment,
    types: [
      {
        id: "watch",
        kind: "source",
        label: "Watch",
        command,
        config: { type: "object" },
        outputs: [{ port: "new", event: `${name}.new.v1` }],
      },
    ],
  });
}

function pythonPackage(name: string, version: string, extra: Files = {}): Files {
  return {
    "inny-package.json": declaration(name, version, { kind: "uv-python", python: "3.13" }),
    "node.py": "print('hello')\n",
    ...extra,
  };
}

let archives = 0;
function archiveOf(files: Files, options: Parameters<typeof signedArchive>[2] = {}): PackageOrigin {
  archives += 1;
  const file = path.join(base, `package-${String(archives)}.tgz`);
  fs.writeFileSync(file, signedArchive(files, signer, options));
  return { kind: "archive", path: file, publicKey: signer.publicKeyText };
}

function folderOf(files: Files): PackageOrigin {
  archives += 1;
  const folder = path.join(base, `folder-${String(archives)}`);
  for (const [file, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), data);
  }
  return { kind: "path", folder };
}

async function refusal(origin: PackageOrigin, with_ = ports): Promise<PackageRefusal> {
  try {
    await buildPackageEnvironment(origin, with_);
  } catch (error) {
    expect(error).toBeInstanceOf(PackageRefusal);
    return error as PackageRefusal;
  }
  throw new Error("the package was accepted");
}

/** The distributions a live package's own interpreter can see. */
function distributions(name: string): string[] {
  const record = roots.installed(name);
  const python = path.join(base, "packages", name, ...(record?.python ?? "").split("/"));
  const out = execFileSync(
    python,
    [
      "-c",
      "import importlib.metadata as m, json; " +
        "print(json.dumps(sorted(d.metadata['Name'] for d in m.distributions())))",
    ],
    { env: { PATH: process.env["PATH"] ?? "" }, encoding: "utf8", timeout: 30_000 },
  );
  return JSON.parse(out) as string[];
}

/** A builder that must never be reached: the refusal came first. */
const unreachable: EnvironmentBuilder = {
  build: () => Promise.reject(new Error("the builder was reached")),
};

describe("uv-python: one verified environment per package", () => {
  it(
    "builds a uv venv on Python 3.13 from the package's hash lock, in staging, then swaps it in",
    async () => {
      const built = await buildPackageEnvironment(
        archiveOf(
          pythonPackage("monty", "0.1.0", { "requirements.lock": lockLine.get("alpha") ?? "" }),
        ),
        ports,
      );
      expect(built.record).toMatchObject({
        package: "monty",
        version: "0.1.0",
        environment: "uv-python",
        python:
          process.platform === "win32"
            ? "environment/venv/Scripts/python.exe"
            : "environment/venv/bin/python",
      });
      expect(built.live).toBe(path.join(base, "packages", "monty"));
      expect(fs.readFileSync(path.join(built.live, "package", "node.py"), "utf8")).toBe(
        "print('hello')\n",
      );
      // Only the package's own files, never the two that describe the archive.
      expect(fs.readdirSync(path.join(built.live, "package")).sort()).toEqual([
        "inny-package.json",
        "node.py",
        "requirements.lock",
      ]);
      expect(fs.existsSync(path.join(base, "staging", "monty"))).toBe(false);
      // What it records is what it installed from: the lock as parsed, beside the venv, and
      // the record written last.
      expect(fs.readdirSync(built.live).sort()).toEqual([
        "environment",
        "installed.json",
        "package",
      ]);
      expect(
        fs.readFileSync(path.join(built.live, "environment", "requirements.lock"), "utf8"),
      ).toContain(
        `alpha==1.0 \\\n    --hash=sha256:${(lockLine.get("alpha") ?? "").split("sha256:")[1]?.trim() ?? ""}`,
      );
      const record = roots.installed("monty");
      const python = path.join(built.live, ...(record?.python ?? "").split("/"));
      const version = execFileSync(
        python,
        ["-c", "import sys, alpha; print('%d.%d' % sys.version_info[:2], alpha.VERSION)"],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(version.trim()).toBe("3.13 1.0");
      expect(logger.lines.some((line) => line.includes("monty 0.1.0 is installed"))).toBe(true);
    },
    UV_TIMEOUT_MS,
  );

  it(
    "a package environment holds only that package's declared dependencies (the contract layer)",
    async () => {
      await buildPackageEnvironment(
        archiveOf(
          pythonPackage("monty", "0.1.0", { "requirements.lock": lockLine.get("alpha") ?? "" }),
        ),
        ports,
      );
      await buildPackageEnvironment(
        archiveOf(
          pythonPackage("innyrize", "0.1.0", { "requirements.lock": lockLine.get("beta") ?? "" }),
        ),
        ports,
      );
      await buildPackageEnvironment(archiveOf(pythonPackage("bare", "0.1.0")), ports);
      // No host library, no other package's dependency, nothing the lock does not name.
      expect(distributions("monty")).toEqual(["alpha"]);
      expect(distributions("innyrize")).toEqual(["beta"]);
      expect(distributions("bare")).toEqual([]);
    },
    UV_TIMEOUT_MS,
  );

  it(
    "refuses a wheel whose hash is not the locked one, and the live package survives",
    async () => {
      await buildPackageEnvironment(
        archiveOf(
          pythonPackage("monty", "0.1.0", { "requirements.lock": lockLine.get("alpha") ?? "" }),
        ),
        ports,
      );
      const wrong = `alpha==1.0 --hash=sha256:${"0".repeat(64)}\n`;
      const refused = await refusal(
        archiveOf(pythonPackage("monty", "0.2.0", { "requirements.lock": wrong })),
      );
      expect(refused.reason).toBe("environment");
      expect(refused.message).toMatch(/its environment could not be built: uv pip sync failed: /);
      expect(roots.installed("monty")?.version).toBe("0.1.0");
      expect(distributions("monty")).toEqual(["alpha"]);
    },
    UV_TIMEOUT_MS,
  );

  it("refuses another Python version with a reason, before anything is built", async () => {
    const files = {
      ...pythonPackage("monty", "0.1.0"),
      "inny-package.json": declaration("monty", "0.1.0", { kind: "uv-python", python: "3.12" }),
    };
    const refused = await refusal(archiveOf(files), portsWith(unreachable));
    expect(refused.reason).toBe("environment");
    expect(refused.message).toBe(
      'monty: it asks for Python 3.12, and InnyTypes provides Python 3.13 only; declare "python": "3.13"',
    );
    expect(fs.existsSync(path.join(base, "staging"))).toBe(false);
    expect(logger.lines.some((line) => line.includes("was refused (environment)"))).toBe(true);
  });

  it("says which Python it could not find, when there is none to build with", async () => {
    const noPython = new PackageEnvironmentBuilder({
      locator: { uv: () => locator.uv(), python: () => undefined, node: () => locator.node() },
      parentEnvironment: process.env,
      cacheDir,
      wheels: { kind: "folder", findLinks: wheels },
      timeoutMs: UV_TIMEOUT_MS,
      platform: process.platform,
    });
    const refused = await refusal(archiveOf(pythonPackage("monty", "0.1.0")), portsWith(noPython));
    expect(refused.message).toBe(
      "monty: its environment could not be built: no Python 3.13 is available to build it with",
    );
  });
});

describe("the archive: signature, then per-file hashes, then the content hash", () => {
  const files = (): Files => pythonPackage("monty", "0.1.0");

  it("refuses an archive signed by another key, before reading files.json", async () => {
    const other = new Signer();
    const origin = archiveOf(files());
    const refused = await refusal(
      { ...origin, publicKey: other.publicKeyText } as PackageOrigin,
      portsWith(unreachable),
    );
    expect(refused.reason).toBe("signature");
    expect(refused.message).toMatch(/^files\.json is not signed by this source's key: /);
  });

  it("refuses a file changed with files.json changed to match it, after signing", async () => {
    const changed = { ...files(), "node.py": "import os; os.system('rm -rf ~')\n" };
    const refused = await refusal(
      archiveOf(files(), { after: changed, replaceListing: filesJson(changed) }),
      portsWith(unreachable),
    );
    expect(refused.reason).toBe("signature");
    expect(refused.message).toMatch(/^files\.json is not signed by this source's key: /);
  });

  it("refuses an archive with no signature, or no files.json", async () => {
    expect(
      (await refusal(archiveOf(files(), { unsigned: true }), portsWith(unreachable))).message,
    ).toBe("the archive holds no files.json.minisig, so nothing in it is signed");
    const bare = path.join(base, "bare.tgz");
    fs.writeFileSync(bare, tgz(files()));
    const unlisted = await refusal(
      { kind: "archive", path: bare, publicKey: signer.publicKeyText },
      portsWith(unreachable),
    );
    expect(unlisted.reason).toBe("signature");
    expect(unlisted.message).toBe("the archive holds no files.json, so nothing in it is signed");
  });

  it("refuses a file changed after signing, and a file nobody listed", async () => {
    const changed = await refusal(
      archiveOf(files(), { after: { "node.py": "import os; os.system('rm -rf ~')\n" } }),
      portsWith(unreachable),
    );
    expect(changed.reason).toBe("files");
    expect(changed.message).toBe("node.py does not match its sha256 in files.json");
    const extra = await refusal(
      archiveOf(files(), { after: { "sitecustomize.py": "print('boo')\n" } }),
      portsWith(unreachable),
    );
    expect(extra.message).toBe(
      "sitecustomize.py is in the package but not listed, so nothing signed it",
    );
  });

  it("refuses an archive that cannot be read, and a declaration that is not one", async () => {
    const missing = await refusal(
      { kind: "archive", path: path.join(base, "gone.tgz"), publicKey: signer.publicKeyText },
      portsWith(unreachable),
    );
    expect(missing.reason).toBe("unreadable");
    const broken = await refusal(
      archiveOf({ "inny-package.json": JSON.stringify({ protocol: 2, package: "monty" }) }),
      portsWith(unreachable),
    );
    expect(broken.reason).toBe("declaration");
    expect(broken.message).toContain("inny-package.json: version: is required");
    const notJson = await refusal(folderOf({ "inny-package.json": "{" }), portsWith(unreachable));
    expect(notJson.message).toMatch(/^inny-package\.json is not JSON/);
    const none = await refusal(folderOf({ "node.py": "" }), portsWith(unreachable));
    expect(none.message).toBe("the package has no inny-package.json");
  });
});

describe("plan 0013: one version, one content", () => {
  const accept: EnvironmentBuilder = { build: () => Promise.resolve({}) };

  it("refuses the same version with other content, reports it, and keeps the live one", async () => {
    const quick = portsWith(accept);
    await buildPackageEnvironment(archiveOf(pythonPackage("monty", "0.1.0")), quick);
    const moved = pythonPackage("monty", "0.1.0", { "node.py": "print('moved')\n" });
    const refused = await refusal(archiveOf(moved), quick);
    expect(refused.reason).toBe("content-moved");
    expect(refused.message).toContain("monty 0.1.0 is not the monty 0.1.0 installed before");
    expect(logger.lines.some((line) => line.includes("was refused (content-moved)"))).toBe(true);
    expect(
      fs.readFileSync(path.join(base, "packages", "monty", "package", "node.py"), "utf8"),
    ).toBe("print('hello')\n");
    // A new version with the new content is fine.
    const next = pythonPackage("monty", "0.2.0", { "node.py": "print('moved')\n" });
    expect((await buildPackageEnvironment(archiveOf(next), quick)).record.version).toBe("0.2.0");
  });

  it("compares a path install by content hash, the same as an archive", async () => {
    const quick = portsWith(accept);
    const archived = await buildPackageEnvironment(
      archiveOf(pythonPackage("monty", "0.1.0")),
      quick,
    );
    // The same files in a folder: the same content hash, so the same version is accepted.
    const same = await buildPackageEnvironment(folderOf(pythonPackage("monty", "0.1.0")), quick);
    expect(same.record.contentHash).toBe(archived.record.contentHash);
    const edited = folderOf(pythonPackage("monty", "0.1.0", { "node.py": "print('edited')\n" }));
    const refused = await refusal(edited, quick);
    expect(refused.reason).toBe("content-moved");
  });
});

describe("staging: nothing live moves until the build is complete", () => {
  it("a build that fails leaves the live package and its environment untouched", async () => {
    const quick = portsWith({ build: () => Promise.resolve({}) });
    await buildPackageEnvironment(archiveOf(pythonPackage("monty", "0.1.0")), quick);
    const failing = portsWith({ build: () => Promise.reject(new Error("the disk is full")) });
    const refused = await refusal(archiveOf(pythonPackage("monty", "0.2.0")), failing);
    expect(refused.message).toBe("monty: its environment could not be built: the disk is full");
    expect(roots.installed("monty")?.version).toBe("0.1.0");
    expect(fs.existsSync(path.join(base, "previous", "monty"))).toBe(false);
    // Unrecorded: 0.2.0 was never installed, so other content under 0.2.0 is still welcome.
    const other = pythonPackage("monty", "0.2.0", { "node.py": "print('fixed')\n" });
    expect((await buildPackageEnvironment(archiveOf(other), quick)).record.version).toBe("0.2.0");
  });
});

describe("node: pre-bundled JavaScript, and nothing ever runs npm", () => {
  /** A builder whose runtimes throw: a node package must need neither uv nor Python. */
  const noRuntimes = (): PackageEnvironmentPorts =>
    portsWith(
      new PackageEnvironmentBuilder({
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
        cacheDir,
        wheels: { kind: "default" },
        timeoutMs: 1,
        platform: process.platform,
      }),
    );

  const nodePackage = (command: unknown, extra: Files = {}): Files => ({
    "inny-package.json": declaration("viewts", "0.1.0", { kind: "node", node: ">=22" }, command),
    "node.js": "process.stdout.write('')\n",
    ...extra,
  });

  it("installs a pre-bundled package without starting any process", async () => {
    const built = await buildPackageEnvironment(
      archiveOf(nodePackage(["{node}", "{package}/node.js"])),
      noRuntimes(),
    );
    expect(built.record).toMatchObject({ environment: "node" });
    expect(built.record.python).toBeUndefined();
    expect(fs.readdirSync(path.join(built.live, "environment"))).toEqual([]);
  });

  it("refuses a package that needs an install step", async () => {
    const npm = await refusal(archiveOf(nodePackage(["npm", "start"])), noRuntimes());
    expect(npm.reason).toBe("environment");
    expect(npm.message).toContain(`type watch's command runs "npm"`);
    const deps = await refusal(
      archiveOf(
        nodePackage(["{node}", "{package}/node.js"], {
          "package.json": JSON.stringify({ dependencies: { ws: "8.18.0" } }),
        }),
      ),
      noRuntimes(),
    );
    expect(deps.message).toContain("package.json declares dependencies, which npm would install");
    expect(fs.existsSync(path.join(base, "packages"))).toBe(false);
  });
});

describe("executable: a per-platform binary with its sha256 in the declaration", () => {
  const binary = "#!/bin/sh\necho ok\n";
  const target = `${process.platform}-${process.arch}`;
  const exePackage = (digest: string): Files => ({
    "inny-package.json": declaration(
      "tool",
      "1.0.0",
      { kind: "executable", binaries: { [target]: { path: "bin/tool", sha256: digest } } },
      ["{package}/bin/tool"],
    ),
    "bin/tool": binary,
  });

  it("installs the binary for this platform, executable and sealed", async () => {
    const built = await buildPackageEnvironment(archiveOf(exePackage(sha256(binary))), ports);
    const tool = path.join(built.live, "package", "bin", "tool");
    // Executable, and, like everything live, not writable (WI-0018-16).
    expect(fs.statSync(tool).mode & 0o777).toBe(0o555);
    if (process.platform !== "win32") {
      expect(execFileSync(tool, { encoding: "utf8", timeout: 10_000 })).toBe("ok\n");
    }
  });

  it("refuses a binary whose sha256 is not the declared one", async () => {
    const refused = await refusal(archiveOf(exePackage("0".repeat(64))), portsWith(unreachable));
    expect(refused.message).toBe(
      `tool: its ${target} binary bin/tool does not match the sha256 its declaration states`,
    );
  });
});

it("reports a builder that throws something that is not a refusal as one", async () => {
  const failingRoots = Object.assign(Object.create(roots) as FsPackageRoots, {
    stage: () => {
      throw new Error("no space left");
    },
  });
  const throwing = { ...portsWith(unreachable), roots: failingRoots };
  const refused = await refusal(archiveOf(pythonPackage("monty", "0.1.0")), throwing);
  expect(refused.reason).toBe("environment");
  expect(refused.message).toBe("no space left");
});

it("tells uv where wheels come from, and where a venv keeps its interpreter", () => {
  expect(wheelArguments({ kind: "default" })).toEqual([]);
  expect(wheelArguments({ kind: "index", url: "https://example.test/simple" })).toEqual([
    "--index-url",
    "https://example.test/simple",
  ]);
  expect(wheelArguments({ kind: "folder", findLinks: "/w" })).toEqual([
    "--no-index",
    "--find-links",
    "/w",
    "--offline",
  ]);
  expect(venvPython("win32")).toBe("venv/Scripts/python.exe");
  expect(venvPython("linux")).toBe("venv/bin/python");
});
