// npm is not in the bundle (plan 0018 §8.3 WI-0018-23): @node-red/registry's own
// lib/externalModules.js does `require.resolve('npm/package.json')` unconditionally at module
// load time (node_modules/@node-red/registry/lib/externalModules.js:19), which crashes the
// whole runtime process the instant npm is simply absent — verified against a real packaged
// build before packaging/npm-stub was added. This proves @node-red/registry still loads with
// only that stub present, and nothing else of npm, in a fresh child process (so a module
// already resolved by this test file's own process can never hide the real answer).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const REAL_NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const NPM_STUB = path.join(REPO_ROOT, "app", "packaging", "npm-stub");

describe("@node-red/registry with only the npm stub present", () => {
  it("loads (module resolution succeeds) instead of crashing on the missing npm package", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-no-npm-"));
    const nodeModules = path.join(scratch, "node_modules");
    fs.mkdirSync(nodeModules);
    try {
      // Every real dependency @node-red/registry needs, exactly as the packaged app has them
      // (real code, real deps) — except npm, which gets the stub instead of a symlink to the
      // real one.
      for (const name of fs.readdirSync(REAL_NODE_MODULES)) {
        if (name === "npm" || name === ".bin" || name.startsWith(".")) {
          continue;
        }
        fs.symlinkSync(path.join(REAL_NODE_MODULES, name), path.join(nodeModules, name), "dir");
      }
      fs.cpSync(NPM_STUB, path.join(nodeModules, "npm"), { recursive: true });

      // A fresh child process: this test file's own process may already have @node-red/registry
      // (or a real npm) cached in its module registry, which would hide the very crash this
      // proves is fixed.
      // --no-addons is irrelevant here; the point is a completely fresh V8/module registry,
      // separate from this test file's own process.
      const output = execFileSync(
        process.execPath,
        ["-e", "require('@node-red/registry'); console.log('loaded')"],
        { cwd: scratch, encoding: "utf8" },
      );
      expect(output.trim()).toBe("loaded");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// Not asserted here: "without the stub, the same require crashes." Proven once, by hand,
// against a real packaged build (the crash this file's header describes) — but not as an
// automated negative test, because Node's module resolution falls back to *global* paths
// (module.globalPaths: derived from the running node binary's own install, e.g. nvm's
// lib/node_modules) once every node_modules up the directory tree is exhausted. A dev machine
// whose own Node ships a global npm (most do) would make that require *succeed* by finding the
// wrong npm entirely, which is a fact about the host running the test, not about this package.
