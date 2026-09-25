// No credential may ever be committed to this repository: the port of tests/test_no_secrets.py
// (WI-0018-06), which goes away with the old suite at the cutover.
//
// The application holds an Anytype key, a proxy token and Node-RED's credential secret. They
// belong in the user's own files and keychain, and a test is the only thing that keeps that
// true after the tenth hurried commit. It scans what git actually tracks, so an ignored scratch
// file is out of scope by construction and a staged one is not.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(import.meta.url);
const REPOSITORY = path.resolve(path.dirname(HERE), "..", "..", "..");

// Lines about content hashes are not credentials. Lockfiles are full of them, and a
// 64-character hex digest is indistinguishable from a token without this context.
const BENIGN_HASH_MARKERS = ["sha256", "sha512", "sha1", "integrity", "resolved", "revision"];

const CREDENTIAL_PATTERNS = [
  // A bearer token with something real after it.
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  // An api key assigned a long literal value.
  /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/gi,
  // A bare long hex string, once hash lines are excluded above.
  /\b[A-Fa-f0-9]{40,}\b/g,
];

// Documentation and configuration must be able to *show* the shape of a key.
const PLACEHOLDER_MARKERS = [
  "<your",
  "your_api_key",
  "<yo",
  "xxxx",
  "example",
  "placeholder",
  "test-key",
  "fake",
];

function trackedFiles(): string[] {
  return execFileSync("git", ["-C", REPOSITORY, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => path.join(REPOSITORY, line));
}

/** The lines of `file` that hold a credential-shaped string, cut to 120 characters. */
function offendingLines(file: string): string[] {
  let text: string;
  try {
    const bytes = fs.readFileSync(file);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Binary, unreadable, or deleted in the working tree: nothing to scan, and never a
    // reason to fail the gate.
    return [];
  }
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const lowered = line.toLowerCase();
    if (BENIGN_HASH_MARKERS.some((marker) => lowered.includes(marker))) {
      continue;
    }
    const offends = CREDENTIAL_PATTERNS.some((pattern) =>
      [...line.matchAll(pattern)].some(
        // The placeholder marker must be inside the credential-shaped text itself. Judging
        // the whole line let a real key ride along with the words "for example" somewhere
        // else on it, which is a scanner that can be talked out of looking.
        (match) => !PLACEHOLDER_MARKERS.some((marker) => match[0].toLowerCase().includes(marker)),
      ),
    );
    if (offends) {
      found.push(line.trim().slice(0, 120));
    }
  }
  return found;
}

/** A scratch file holding `text`, removed after `check` has looked at it. */
function planted(text: string, check: (file: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inny-no-secrets-"));
  try {
    const file = path.join(directory, "doc.md");
    fs.writeFileSync(file, text);
    check(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("no credential in the repository", () => {
  it("no credential-shaped string is committed", () => {
    const offenders: Record<string, string[]> = {};
    for (const file of trackedFiles()) {
      // This file and the old one define the patterns; matching themselves proves nothing.
      if (file === HERE || file === path.join(REPOSITORY, "tests", "test_no_secrets.py")) {
        continue;
      }
      const lines = offendingLines(file);
      if (lines.length > 0) {
        offenders[path.relative(REPOSITORY, file)] = lines;
      }
    }
    expect(offenders).toEqual({});
  });

  it("the scanner actually catches a key", () => {
    // Built by concatenation so the literal never exists in this file's own source.
    planted("Authorization: " + "Bearer " + "a1b2c3d4e5f6a7b8c9d0e1f2", (file) => {
      expect(offendingLines(file)).not.toEqual([]);
    });
  });

  it("dotenv is ignored", () => {
    expect(fs.readFileSync(path.join(REPOSITORY, ".gitignore"), "utf8")).toContain(".env");
  });

  it("a real key is caught even on a line that says example", () => {
    planted(
      "Set it like this, for example: api_" + 'key = "sk-ant-9f3b2c7d4e5a6b1c8d0e2f4a"\n',
      (file) => {
        expect(offendingLines(file)).not.toEqual([]);
      },
    );
  });

  it("a placeholder inside the match is still excused", () => {
    planted('api_key = "<your-api-key-goes-here>"\n', (file) => {
      expect(offendingLines(file)).toEqual([]);
    });
  });
});
