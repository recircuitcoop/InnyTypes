// adapters/fs/package-source.ts: a package's files, read from a `.tgz` or a folder into
// memory, refusing anything that could not be written back as the file it claims to be.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsPackageSource, readTar } from "../../src/adapters/fs/package-source";
import { paxPath, tar, tgz } from "../fakes/package-archive";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decoded = (files: ReadonlyMap<string, Uint8Array>): Record<string, string> =>
  Object.fromEntries([...files].map(([file, bytes]) => [file, new TextDecoder().decode(bytes)]));

let dir: string;
const source = new FsPackageSource();

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-source-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function archive(bytes: Uint8Array): string {
  const file = path.join(dir, "package.tgz");
  fs.writeFileSync(file, bytes);
  return file;
}

describe("readArchive", () => {
  it("reads every regular file, dropping ./ and the directories its files imply", async () => {
    const bytes = gzipSync(
      tar([
        { name: "./", type: "5" },
        { name: "./inny-package.json", data: text("{}") },
        { name: "lib/", type: "5" },
        { name: "lib/util.py", data: text("X = 1\n".repeat(200)) },
        { name: "empty", data: new Uint8Array() },
      ]),
    );
    expect(decoded(await source.readArchive(archive(bytes)))).toEqual({
      "inny-package.json": "{}",
      "lib/util.py": "X = 1\n".repeat(200),
      empty: "",
    });
  });

  it("reads an archive the system's tar wrote", async () => {
    const tree = path.join(dir, "tree");
    fs.mkdirSync(path.join(tree, "lib"), { recursive: true });
    fs.writeFileSync(path.join(tree, "inny-package.json"), "{}");
    fs.writeFileSync(path.join(tree, "lib", "util.py"), "X = 1\n");
    const file = path.join(dir, "system.tgz");
    execFileSync("tar", ["-czf", file, "-C", tree, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      timeout: 30_000,
    });
    expect(decoded(await source.readArchive(file))).toEqual({
      "inny-package.json": "{}",
      "lib/util.py": "X = 1\n",
    });
  });

  it("honours pax and GNU long names", () => {
    const long = `${"deep/".repeat(30)}file.py`;
    const files = readTar(
      tar([
        paxPath(long),
        { name: "truncated-name", data: text("a") },
        { name: "././@LongLink", type: "L", data: text("gnu/long/name.py\0") },
        { name: "short", data: text("b") },
        { name: "global", type: "g", data: text("9 a=bcd\n") },
      ]),
    );
    expect(decoded(files)).toEqual({ [long]: "a", "gnu/long/name.py": "b" });
  });

  it.each([
    ["a symlink", [{ name: "link", type: "2" }], "not a regular file (tar type 2)"],
    ["a hard link", [{ name: "hard", type: "1" }], "not a regular file (tar type 1)"],
    ["a path out of the package", [{ name: "../evil.py", data: text("x") }], "leaves the package"],
    ["an absolute path", [{ name: "/etc/evil", data: text("x") }], "not a relative path"],
    [
      "a file twice",
      [
        { name: "a.py", data: text("1") },
        { name: "./a.py", data: text("2") },
      ],
      "holds a.py twice",
    ],
  ])("refuses %s", (_what, entries, reason) => {
    expect(() => readTar(tar(entries))).toThrow(reason);
  });

  it("refuses a truncated archive, and one with no end marker", () => {
    const whole = tar([{ name: "a.py", data: text("x".repeat(2000)) }], { end: false });
    expect(() => readTar(whole.subarray(0, 1024))).toThrow("ends inside an entry");
    expect(() => readTar(whole)).toThrow("no end-of-archive marker");
  });

  it("refuses a header whose size is not octal, and a malformed pax header", () => {
    const bad = tar([{ name: "a.py", data: text("x") }]);
    bad.set(text("99999999999\0"), 124);
    expect(() => readTar(bad)).toThrow("not octal");
    expect(() => readTar(tar([{ name: "p", type: "x", data: text("zz path=x\n") }]))).toThrow(
      "pax extended header is malformed",
    );
  });

  it("refuses what is not gzip, and a file that is not there", async () => {
    await expect(source.readArchive(archive(text("plain text")))).rejects.toThrow(
      /it is not a gzip archive/,
    );
    await expect(source.readArchive(path.join(dir, "missing.tgz"))).rejects.toThrow(/ENOENT/);
  });

  it("round-trips the test writer's archives", async () => {
    const files = await source.readArchive(archive(tgz({ "inny-package.json": "{}", "x/y": "z" })));
    expect(decoded(files)).toEqual({ "inny-package.json": "{}", "x/y": "z" });
  });
});

describe("readFolder", () => {
  it("reads every file under the folder, with / separators", async () => {
    fs.mkdirSync(path.join(dir, "pkg", "lib", "deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "pkg", "inny-package.json"), "{}");
    fs.writeFileSync(path.join(dir, "pkg", "lib", "deep", "a.py"), "A");
    expect(decoded(await source.readFolder(path.join(dir, "pkg")))).toEqual({
      "inny-package.json": "{}",
      "lib/deep/a.py": "A",
    });
  });

  it("refuses a link, which is not a package file", async () => {
    fs.mkdirSync(path.join(dir, "pkg"));
    fs.writeFileSync(path.join(dir, "outside.txt"), "secret");
    fs.symlinkSync(path.join(dir, "outside.txt"), path.join(dir, "pkg", "link.txt"));
    await expect(source.readFolder(path.join(dir, "pkg"))).rejects.toThrow(
      "link.txt is not a regular file; a package holds regular files only",
    );
  });

  it("refuses a folder that is not there", async () => {
    await expect(source.readFolder(path.join(dir, "gone"))).rejects.toThrow(/ENOENT/);
  });
});
