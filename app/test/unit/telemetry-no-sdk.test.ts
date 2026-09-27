// No Sentry SDK (WI-0018-22): GlitchTip is sent a hand-written envelope, because an SDK hooks the
// process and collects the environment, breadcrumbs and the host name on its own, past every rule
// the one redaction keeps. The gate refuses one in any manifest, in the lock, and in any source.
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = path.dirname(APP);
const SDK = /@sentry\/|["']sentry["']|raven-js|@sentry-internal/;

function sources(folder: string): string[] {
  return fs
    .readdirSync(folder, { withFileTypes: true, recursive: true })
    .flatMap((entry) =>
      entry.isFile() && /\.(ts|mjs|cjs|js)$/.test(entry.name)
        ? [path.join(entry.parentPath, entry.name)]
        : [],
    );
}

describe("no Sentry SDK", () => {
  it("is in no manifest and not in the lock", () => {
    for (const file of [
      path.join(REPO, "package.json"),
      path.join(APP, "package.json"),
      path.join(REPO, "package-lock.json"),
    ]) {
      expect(SDK.test(fs.readFileSync(file, "utf8")), file).toBe(false);
    }
  });

  it("is imported by no source file", () => {
    const found = sources(path.join(APP, "src")).filter((file) =>
      SDK.test(fs.readFileSync(file, "utf8")),
    );
    expect(found).toEqual([]);
  });

  it("the check can fail", () => {
    expect(SDK.test('import * as Sentry from "@sentry/electron";')).toBe(true);
    expect(SDK.test('"dependencies": { "@sentry/node": "9.0.0" }')).toBe(true);
  });
});
