// adapters/fs/package-roots.ts: build in staging, then swap (the old
// tests/test_plugin_environments.py swap and rollback behaviours, ported). Staging and
// previous sit beside the live root; a swap keeps what it replaced; a half-built folder is
// never swapped in; a swap or rollback that cannot complete leaves the live package where it was.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsContentHashes } from "../../src/adapters/fs/content-hashes";
import { FsPackageRoots, unsealTree, SwapError } from "../../src/adapters/fs/package-roots";
import type { InstalledRecord } from "../../src/ports/package-roots";

let base: string;
let roots: FsPackageRoots;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-roots-")));
  roots = new FsPackageRoots(base);
});

afterEach(() => {
  unsealTree(base);
  fs.rmSync(base, { recursive: true, force: true });
});

const record = (version: string): InstalledRecord => ({
  package: "monty",
  version,
  contentHash: version.repeat(8),
  environment: "node",
  signed: true,
});

/** Stage `monty` at a version, complete: files, then the record. */
function stageComplete(version: string, name = "monty"): void {
  const folder = roots.stage(name);
  roots.writeFiles(
    folder.packageDir,
    new Map([["version.txt", new TextEncoder().encode(version)]]),
  );
  roots.writeRecord(folder, { ...record(version), package: name });
}

const liveVersion = (name = "monty"): string =>
  fs.readFileSync(path.join(base, "packages", name, "package", "version.txt"), "utf8");

describe("FsPackageRoots", () => {
  it("stages beside the live root, never inside it", () => {
    const folder = roots.stage("monty");
    expect(path.dirname(folder.root)).toBe(path.join(base, "staging"));
    expect(path.dirname(roots.live)).toBe(path.dirname(roots.staging));
    expect(path.dirname(roots.previous)).toBe(base);
    expect(fs.readdirSync(folder.root).sort()).toEqual(["environment", "package"]);
  });

  it("staging over an abandoned build replaces it", () => {
    const first = roots.stage("monty");
    fs.writeFileSync(path.join(first.environmentDir, "scrap"), "x");
    const second = roots.stage("monty");
    expect(fs.readdirSync(second.environmentDir)).toEqual([]);
  });

  it("writes files in their folders, and never outside the package", () => {
    const folder = roots.stage("monty");
    roots.writeFiles(folder.packageDir, new Map([["lib/a.py", new Uint8Array([65])]]));
    expect(fs.readFileSync(path.join(folder.packageDir, "lib", "a.py"), "utf8")).toBe("A");
    expect(() => {
      roots.writeFiles(folder.packageDir, new Map([["../escape", new Uint8Array()]]));
    }).toThrow("would be written outside the package");
  });

  it("swaps the staged package in, and keeps the one it replaced", () => {
    stageComplete("1");
    expect(roots.swapIn("monty")).toEqual({
      live: path.join(base, "packages", "monty"),
      previous: null,
    });
    stageComplete("2");
    const swapped = roots.swapIn("monty");
    expect(swapped.previous).toBe(path.join(base, "previous", "monty"));
    expect(liveVersion()).toBe("2");
    expect(roots.installed("monty")?.version).toBe("2");
    expect(fs.existsSync(path.join(base, "staging", "monty"))).toBe(false);
  });

  it("a second swap keeps the package it replaced, not the one before it", () => {
    for (const version of ["1", "2", "3"]) {
      stageComplete(version);
      roots.swapIn("monty");
    }
    expect(
      fs.readFileSync(path.join(base, "previous", "monty", "package", "version.txt"), "utf8"),
    ).toBe("2");
  });

  it("only the swapped package moves", () => {
    stageComplete("1", "other");
    roots.swapIn("other");
    stageComplete("1");
    roots.swapIn("monty");
    stageComplete("2");
    roots.swapIn("monty");
    expect(liveVersion("other")).toBe("1");
    expect(fs.existsSync(path.join(base, "previous", "other"))).toBe(false);
  });

  it("refuses to swap in a half-built package, and the live one survives", () => {
    stageComplete("1");
    roots.swapIn("monty");
    const half = roots.stage("monty");
    roots.writeFiles(half.packageDir, new Map([["version.txt", new TextEncoder().encode("2")]]));
    expect(() => roots.swapIn("monty")).toThrow(SwapError);
    expect(() => roots.swapIn("monty")).toThrow(/installed\.json is half-built/);
    expect(liveVersion()).toBe("1");
  });

  it("refuses to swap in a package nothing was staged for", () => {
    expect(() => roots.swapIn("monty")).toThrow(/nothing complete is staged for monty/);
    expect(roots.installed("monty")).toBeUndefined();
  });

  it("rolls back to the package the swap replaced", () => {
    stageComplete("1");
    roots.swapIn("monty");
    stageComplete("2");
    roots.swapIn("monty");
    expect(roots.rollBack("monty")).toBe(path.join(base, "packages", "monty"));
    expect(liveVersion()).toBe("1");
    expect(fs.readdirSync(path.join(base, "previous"))).toEqual([]);
  });

  it("a swap that replaced nothing keeps nothing and cannot be rolled back", () => {
    stageComplete("1");
    roots.swapIn("monty");
    expect(() => roots.rollBack("monty")).toThrow(/cannot be rolled back: nothing is kept/);
    expect(liveVersion()).toBe("1");
  });

  it("refuses a name that is not a package name, so no path leaves a root", () => {
    expect(() => roots.stage("../x")).toThrow("is not a package name");
  });

  it("a swap that cannot complete puts the live package back", () => {
    stageComplete("1");
    roots.swapIn("monty");
    stageComplete("2");
    failRenames(2, () => {
      expect(() => roots.swapIn("monty")).toThrow(/could not be moved/);
    });
    expect(liveVersion()).toBe("1");
  });

  it("a rollback that cannot complete leaves the live package where it was", () => {
    stageComplete("1");
    roots.swapIn("monty");
    stageComplete("2");
    roots.swapIn("monty");
    failRenames(2, () => {
      expect(() => roots.rollBack("monty")).toThrow(/could not be moved/);
    });
    expect(liveVersion()).toBe("2");
  });
});

/** What another process meets when it tries to write `target` (a node process would). */
function writeFromAnotherProcess(target: string): string {
  const script =
    "try { require('fs').writeFileSync(process.argv[1], 'x'); console.log('written') }" +
    " catch (error) { console.log(error.code) }";
  return execFileSync(process.execPath, ["-e", script, target], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

describe("FsPackageRoots: the live root is sealed (WI-0018-16, spec 11.4)", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "no other process can write into the live root, a package's folder, or its files",
    () => {
      stageComplete("1");
      roots.swapIn("monty");
      const live = path.join(base, "packages");
      expect(writeFromAnotherProcess(path.join(live, "dropped", "x"))).toBe("ENOENT");
      expect(writeFromAnotherProcess(path.join(live, "dropped.json"))).toBe("EACCES");
      expect(writeFromAnotherProcess(path.join(live, "monty", "package", "new.py"))).toBe("EACCES");
      expect(writeFromAnotherProcess(path.join(live, "monty", "package", "version.txt"))).toBe(
        "EACCES",
      );
      expect(writeFromAnotherProcess(path.join(live, "monty", "installed.json"))).toBe("EACCES");
      expect(writeFromAnotherProcess(path.join(live, "monty", "environment", "x"))).toBe("EACCES");
      // Sealed, and still swapped over and rolled back by the installer itself.
      stageComplete("2");
      roots.swapIn("monty");
      expect(liveVersion()).toBe("2");
      expect(roots.rollBack("monty")).toBe(path.join(live, "monty"));
      expect(liveVersion()).toBe("1");
      expect(writeFromAnotherProcess(path.join(live, "dropped.json"))).toBe("EACCES");
    },
  );

  it("lists every live package with a record, and nothing else in the live root", () => {
    expect(roots.list()).toEqual([]);
    stageComplete("1", "other");
    roots.swapIn("other");
    stageComplete("2");
    roots.swapIn("monty");
    unsealTree(roots.live);
    fs.mkdirSync(path.join(roots.live, "norecord", "package"), { recursive: true });
    fs.mkdirSync(path.join(roots.live, "Not-A-Name"));
    expect(roots.list().map(({ record }) => `${record.package} ${record.version}`)).toEqual([
      "monty 2",
      "other 1",
    ]);
    expect(roots.list()[0]?.folder).toEqual({
      root: path.join(roots.live, "monty"),
      packageDir: path.join(roots.live, "monty", "package"),
      environmentDir: path.join(roots.live, "monty", "environment"),
    });
  });

  it("removes a package whole, what the last swap kept of it too, and only it", () => {
    stageComplete("1", "other");
    roots.swapIn("other");
    stageComplete("1");
    roots.swapIn("monty");
    stageComplete("2");
    roots.swapIn("monty");
    roots.remove("monty");
    expect(roots.installed("monty")).toBeUndefined();
    expect(fs.existsSync(path.join(roots.live, "monty"))).toBe(false);
    expect(fs.existsSync(path.join(roots.previous, "monty"))).toBe(false);
    expect(liveVersion("other")).toBe("1");
    // Removing what is not there does nothing.
    roots.remove("monty");
    roots.remove("never");
    expect(roots.list().map(({ record }) => record.package)).toEqual(["other"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(roots.live).mode & 0o777).toBe(0o555);
    }
  });

  it("takes the record first, so a removal cut short leaves a folder nothing lists", () => {
    stageComplete("1");
    roots.swapIn("monty");
    const original = fs.rmSync;
    fs.rmSync = (target: fs.PathLike, options?: fs.RmOptions): void => {
      if (String(target) === path.join(roots.live, "monty")) {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      original(target, options);
    };
    syncBuiltinESMExports();
    try {
      expect(() => {
        roots.remove("monty");
      }).toThrow("EBUSY");
    } finally {
      fs.rmSync = original;
      syncBuiltinESMExports();
    }
    expect(roots.installed("monty")).toBeUndefined();
    expect(roots.list()).toEqual([]);
    roots.remove("monty");
    expect(fs.existsSync(path.join(roots.live, "monty"))).toBe(false);
  });
});

/** Make the `nth` rename (and only it) fail, as a cross-filesystem rename would. */
function failRenames(nth: number, run: () => void): void {
  const original = fs.renameSync;
  let count = 0;
  fs.renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
    count += 1;
    if (count === nth) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    original(from, to);
  };
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
  }
}

describe("FsContentHashes", () => {
  it("records a hash per version, never replaces one, and survives a new reader", () => {
    const file = path.join(base, "state", "content-hashes.json");
    const hashes = new FsContentHashes(file);
    expect(hashes.recorded("monty", "0.1.0")).toBeUndefined();
    hashes.record("monty", "0.1.0", "a".repeat(64));
    hashes.record("monty", "0.1.0", "a".repeat(64));
    hashes.record("monty", "0.2.0", "b".repeat(64));
    expect(() => {
      hashes.record("monty", "0.1.0", "c".repeat(64));
    }).toThrow("is never replaced");
    const again = new FsContentHashes(file);
    expect(again.recorded("monty", "0.1.0")).toBe("a".repeat(64));
    expect(again.recorded("monty", "0.2.0")).toBe("b".repeat(64));
    expect(again.recorded("other", "0.1.0")).toBeUndefined();
  });
});
