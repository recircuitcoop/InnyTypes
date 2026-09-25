// domain/packages/archive.ts: files.json, the per-file hashes, and the content hash that
// answers plan 0013 (a version whose content moved while its number did not).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PackageRefusal,
  contentHash,
  judgeContent,
  manifestOf,
  parseFileManifest,
  pathProblem,
  verifyFiles,
} from "../../src/domain/packages/archive";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const FILES = new Map([
  ["inny-package.json", text("{}")],
  ["node.py", text("print('hi')\n")],
  ["lib/util.py", text("X = 1\n")],
]);

function listing(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  return text(JSON.stringify({ files: Object.fromEntries([...manifestOf(files, sha256)]) }));
}

function refusedWith(run: () => unknown): PackageRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PackageRefusal);
    return error as PackageRefusal;
  }
  throw new Error("it was accepted");
}

describe("pathProblem", () => {
  it.each(["a.py", "lib/a.py", ".hidden/x"])("accepts %j", (file) => {
    expect(pathProblem(file)).toBeNull();
  });

  it.each(["", "/etc/passwd", "C:/x", "../x", "a/../../x", "a//b", "./a", "a\\b", "a\0b"])(
    "refuses %j",
    (file) => {
      expect(pathProblem(file)).not.toBeNull();
    },
  );
});

describe("parseFileManifest", () => {
  it("reads every file and its hash", () => {
    const manifest = parseFileManifest(listing(FILES));
    expect([...manifest.keys()].sort()).toEqual(["inny-package.json", "lib/util.py", "node.py"]);
  });

  it.each([
    ["not JSON", "{", "is not JSON"],
    ["no files object", "[]", '"files" must be an object'],
    ["a bad path", JSON.stringify({ files: { "../x": "a".repeat(64) } }), "leaves the package"],
    [
      "itself listed",
      JSON.stringify({ files: { "files.json": "a".repeat(64) } }),
      "cannot list itself",
    ],
    ["a bad hash", JSON.stringify({ files: { "inny-package.json": "abc" } }), "64 lowercase hex"],
    ["no declaration", JSON.stringify({ files: { "a.py": "a".repeat(64) } }), "does not list inny"],
  ])("refuses %s", (_what, document, reason) => {
    const refusal = refusedWith(() => parseFileManifest(text(document)));
    expect(refusal.reason).toBe("files");
    expect(refusal.message).toContain(reason);
  });
});

describe("verifyFiles", () => {
  const manifest = parseFileManifest(listing(FILES));

  it("accepts the files the listing names, with the two describing files beside them", () => {
    const archive = new Map([
      ...FILES,
      ["files.json", text("x")],
      ["files.json.minisig", text("y")],
    ]);
    expect(() => {
      verifyFiles(archive, manifest, sha256);
    }).not.toThrow();
  });

  it("refuses a changed file, a missing file and an unlisted file, naming each", () => {
    const archive = new Map(FILES);
    archive.set("node.py", text("print('changed')\n"));
    archive.delete("lib/util.py");
    archive.set("extra.py", text("import os\n"));
    const refusal = refusedWith(() => {
      verifyFiles(archive, manifest, sha256);
    });
    expect(refusal.reason).toBe("files");
    expect(refusal.message).toBe(
      "extra.py is in the package but not listed, so nothing signed it; " +
        "lib/util.py is listed but not in the package; " +
        "node.py does not match its sha256 in files.json",
    );
  });
});

describe("contentHash", () => {
  it("is the sha256 of the sorted sha256sum lines of the files", () => {
    const manifest = manifestOf(FILES, sha256);
    const lines = ["inny-package.json", "lib/util.py", "node.py"]
      .map((file) => `${manifest.get(file) ?? ""}  ${file}\n`)
      .join("");
    expect(contentHash(manifest, sha256)).toBe(sha256(text(lines)));
  });

  it("is the same for the same files whatever their order, and the describing files", () => {
    const reordered = new Map([...FILES].reverse());
    reordered.set("files.json", text("anything"));
    expect(contentHash(manifestOf(reordered, sha256), sha256)).toBe(
      contentHash(manifestOf(FILES, sha256), sha256),
    );
  });

  it("moves when one byte of one file moves", () => {
    const changed = new Map(FILES);
    changed.set("lib/util.py", text("X = 2\n"));
    expect(contentHash(manifestOf(changed, sha256), sha256)).not.toBe(
      contentHash(manifestOf(FILES, sha256), sha256),
    );
  });
});

describe("judgeContent (plan 0013)", () => {
  it("accepts a version seen for the first time, and the same content again", () => {
    expect(() => {
      judgeContent("monty", "0.1.0", "a".repeat(64), undefined);
      judgeContent("monty", "0.1.0", "a".repeat(64), "a".repeat(64));
    }).not.toThrow();
  });

  it("refuses the same version with another content hash, naming both", () => {
    const refusal = refusedWith(() => {
      judgeContent("monty", "0.1.0", "b".repeat(64), "a".repeat(64));
    });
    expect(refusal.reason).toBe("content-moved");
    expect(refusal.message).toContain(`its content hash is ${"b".repeat(64)}`);
    expect(refusal.message).toContain(`${"a".repeat(64)} was recorded for that version`);
  });
});
