// The package store until verified installs exist: the packages declared in fixed folders.
// Several behaviours of the old addon discovery (tests/test_addon_discovery.py) carry over:
// a broken package is reported with its reason and hides none of the others, an absent root
// is nothing and is not created, a stray file is not a package, and reading writes nothing.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeclaredPackageStore } from "../../src/adapters/fs/declared-package-store";
import { RecordingLogger } from "../fakes/children";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-store-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function declare(folder: string, content: string | Buffer): void {
  fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, folder, "inny-package.json"), content);
}

/** Every file and folder under root, to show that reading wrote nothing. */
function tree(): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[]).sort();
}

describe("DeclaredPackageStore", () => {
  it("lists the package each folder declares, by its declared name", () => {
    declare("raw-node", JSON.stringify({ protocol: 2, package: "rawnode" }));
    declare("monty", JSON.stringify({ protocol: 2, package: "monty" }));
    const logger = new RecordingLogger();
    expect(new DeclaredPackageStore([root], logger).packages()).toEqual(["monty", "rawnode"]);
    expect(logger.lines).toEqual([]);
  });

  it("the repository's test fixtures declare the rawnode package", () => {
    const fixtures = path.resolve(import.meta.dirname, "..", "fixtures");
    expect(new DeclaredPackageStore([fixtures], new RecordingLogger()).packages()).toEqual([
      "rawnode",
    ]);
  });

  it("reports each broken package with its own reason, and every other still returns", () => {
    declare("good", JSON.stringify({ package: "good" }));
    fs.mkdirSync(path.join(root, "missing"));
    declare("not-json", "{ not json");
    declare("not-utf8", Buffer.from([0xff, 0xfe, 0x7b]));
    declare("no-name", JSON.stringify({ protocol: 2 }));
    declare("bad-name", JSON.stringify({ package: "Bad-Name" }));
    declare("not-object", "[1]");
    const logger = new RecordingLogger();
    expect(new DeclaredPackageStore([root], logger).packages()).toEqual(["good"]);
    const reason = (folder: string) => logger.lines.find((l) => l.includes(`${folder} `)) ?? "";
    expect(reason("missing")).toContain("has no inny-package.json; it is left out");
    expect(reason("not-json")).toContain("is not JSON");
    expect(reason("not-utf8")).toContain("is not UTF-8 text");
    expect(reason("no-name")).toContain("names no valid package");
    expect(reason("bad-name")).toContain("names no valid package");
    expect(reason("not-object")).toContain("names no valid package");
    expect(logger.lines).toHaveLength(6);
  });

  it("reports an unreadable declaration with its reason", () => {
    fs.mkdirSync(path.join(root, "dir-not-file", "inny-package.json"), { recursive: true });
    const logger = new RecordingLogger();
    expect(new DeclaredPackageStore([root], logger).packages()).toEqual([]);
    expect(logger.lines).toEqual([expect.stringContaining("inny-package.json: Error: EISDIR")]);
  });

  it("keeps the first of two folders declaring one name, and says so (spec 2.1)", () => {
    declare("a", JSON.stringify({ package: "same" }));
    declare("b", JSON.stringify({ package: "same" }));
    const logger = new RecordingLogger();
    expect(new DeclaredPackageStore([root], logger).packages()).toEqual(["same"]);
    expect(logger.lines).toEqual([
      `WARN node package ${path.join(root, "b")} declares same, already declared by ` +
        `${path.join(root, "a")}; it is left out`,
    ]);
  });

  it("says each problem once, however often it is read", () => {
    fs.mkdirSync(path.join(root, "missing"));
    const logger = new RecordingLogger();
    const store = new DeclaredPackageStore([root], logger);
    store.packages();
    store.packages();
    expect(logger.lines).toHaveLength(1);
  });

  it("an absent root holds nothing and is not created and a stray file is not a package", () => {
    const absent = path.join(root, "absent");
    fs.writeFileSync(path.join(root, "stray.txt"), "not a package");
    const logger = new RecordingLogger();
    expect(new DeclaredPackageStore([absent, root], logger).packages()).toEqual([]);
    expect(fs.existsSync(absent)).toBe(false);
    expect(logger.lines).toEqual([]);
  });

  it("reports a root that exists but cannot be listed", () => {
    const file = path.join(root, "a-file");
    fs.writeFileSync(file, "");
    const logger = new RecordingLogger();
    expect(new DeclaredPackageStore([file], logger).packages()).toEqual([]);
    expect(logger.lines).toEqual([expect.stringContaining("could not be listed")]);
  });

  it("writes nothing", () => {
    declare("good", JSON.stringify({ package: "good" }));
    declare("broken", "{");
    const before = tree();
    new DeclaredPackageStore([root], new RecordingLogger()).packages();
    expect(tree()).toEqual(before);
  });
});
