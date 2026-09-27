// The bundled python-build-standalone and uv build a package environment through the
// RuntimeLocator port (plan 0018 §1; WI-0018-23): the one owed proof that is not a packaged
// Electron app at all, only BundledRuntimeLocator pointed at what tools/runtimes/fetch.mjs
// actually fetched and verified for this machine's target.
//
// Skipped, not faked, when nobody has run `npm run runtimes:fetch` (or `package:mac`) for this
// target yet: the ordinary gate never needs network access, but on a machine that has fetched
// them, this proves the bundled runtimes for real, not the system's stand-in
// (SystemRuntimeLocator, which is what test/integration/package-environments.test.ts proves).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BundledRuntimeLocator } from "../../src/adapters/process/bundled-runtime-locator";
import { PackageEnvironmentBuilder, venvPython } from "../../src/adapters/process/env-builder";

const APP_ROOT = path.resolve(__dirname, "..", "..");
/** electron-builder's own ${os} macro naming (mac, linux), which tools/runtimes/fetch.mjs and
 * app/packaging/electron-builder.yml's extraResources both key their target folders on. */
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "mac", linux: "linux" };
const TARGET = `${OS_NAMES[process.platform] ?? process.platform}-${process.arch}`;
const RUNTIMES_DIR = path.join(APP_ROOT, "build", "runtimes", TARGET);
const HAS_RUNTIMES = fs.existsSync(path.join(RUNTIMES_DIR, "python", "bin", "python3"));

describe.skipIf(!HAS_RUNTIMES)(
  `bundled runtimes (${TARGET}): the fetched python-build-standalone and uv, through the port`,
  () => {
    it("BundledRuntimeLocator resolves real, executable binaries", () => {
      const locator = new BundledRuntimeLocator(RUNTIMES_DIR, process.platform);
      for (const executable of [locator.uv(), locator.python("3.13"), locator.node().command]) {
        expect(executable).toBeDefined();
        // A directory also passes X_OK (it is traversable); this must be an actual file, or
        // spawning it reports the misleading EACCES that caught this exact bug once already.
        expect(fs.statSync(executable as string).isFile()).toBe(true);
        fs.accessSync(executable as string, fs.constants.X_OK);
      }
      // Not the system's: a machine without uv on PATH still resolves one, from the bundle.
      expect(locator.uv()).toContain(RUNTIMES_DIR);
    });

    it("builds a real uv venv on the bundled Python 3.13, with no lock (a dependency-free package)", async () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-bundled-env-"));
      try {
        const builder = new PackageEnvironmentBuilder({
          locator: new BundledRuntimeLocator(RUNTIMES_DIR, process.platform),
          parentEnvironment: process.env,
          cacheDir: path.join(scratch, "uv-cache"),
          wheels: { kind: "default" },
          timeoutMs: 120_000,
          platform: process.platform,
        });

        const built = await builder.build(
          { kind: "uv-python", python: "3.13", lock: null },
          scratch,
          scratch,
        );

        expect(built.python).toBe(venvPython(process.platform));
        const interpreter = path.join(scratch, ...venvPython(process.platform).split("/"));
        fs.accessSync(interpreter, fs.constants.X_OK);
        const version = execFileSync(
          interpreter,
          ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
          { encoding: "utf8" },
        ).trim();
        expect(version).toBe("3.13");
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });
  },
);
