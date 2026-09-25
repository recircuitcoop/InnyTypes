// adapters/fs/package-roots.ts: build in staging, then swap (the old
// tests/test_plugin_environments.py swap and rollback behaviours, ported). Staging and
// previous sit beside the live root; a swap keeps what it replaced; a half-built folder is
// never swapped in; a swap or rollback that cannot complete leaves the live package where it was.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsContentHashes } from "../../src/adapters/fs/content-hashes";
import { FsPackageRoots, SwapError } from "../../src/adapters/fs/package-roots";
import type { InstalledRecord } from "../../src/ports/package-roots";

let base: string;
let roots: FsPackageRoots;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-roots-")));
  roots = new FsPackageRoots(base);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const record = (version: string): InstalledRecord => ({
  package: "monty",
  version,
  contentHash: version.repeat(8),
  environment: "node",
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
