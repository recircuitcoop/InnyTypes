// minisign inside Electron (WI-0018-14). Electron's node:crypto is BoringSSL, which has no
// blake2b512, so a verifier that passes under the Node running vitest could still refuse every
// pre-hashed signature in the app. This runs the production verifier under the Electron binary
// itself (as node, the way the utility processes run it) over the old helper's vectors.
//
// An e2e spec rather than an integration test: in a fresh install the electron package fetches
// its binary on first use, and only this stage runs outside the unit stages' home guard.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { buildSync } from "esbuild";
import { ELECTRON_BINARY } from "./app-harness";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

test("minisign verifies both forms and refuses a tampered file in Electron's own crypto", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-minisign-"));
  try {
    const bundle = path.join(scratch, "electron-check.cjs");
    buildSync({
      entryPoints: [path.join(FIXTURES, "minisign", "electron-check.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      logLevel: "warning",
    });
    const run = spawnSync(
      ELECTRON_BINARY,
      [bundle, path.join(FIXTURES, "minisign", "python-helper-vectors.json")],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 60_000 },
    );
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout.trim()) as Record<string, string | null>;
    expect(result["electron"]).toEqual(expect.any(String));
    expect(result).toMatchObject({
      prehashed: "verified",
      legacy: "verified",
      tampered: "bad-signature",
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
