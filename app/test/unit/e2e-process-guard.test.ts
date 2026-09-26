// The e2e specs ask about an app's Electron process only through the harness (app-harness.ts),
// which takes it once, at launch. Playwright hands it out only while its driver holds the app:
// asked after a quit, `app.process()` can throw ("reading '_object'"), and whether it does is a
// race with the driver's own teardown. That race failed cleanups in several specs.
import fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";

const E2E = path.resolve(import.meta.dirname, "..", "e2e");
const HARNESS = "app-harness.ts";

const specs = (): string[] => fs.readdirSync(E2E).filter((name) => name.endsWith(".ts"));

it("no e2e file but the harness calls .process() or launches Electron itself", () => {
  const files = specs();
  expect(files).toContain(HARNESS);
  expect(files.length).toBeGreaterThan(10);
  const offenders = files
    .filter((name) => name !== HARNESS)
    .filter((name) => {
      const text = fs.readFileSync(path.join(E2E, name), "utf8");
      return /\.process\(\)/.test(text) || /_electron\b|electron\.launch\(/.test(text);
    });
  expect(offenders).toEqual([]);
});

it("the harness takes the process once, where it launches, and nowhere else", () => {
  const harness = fs.readFileSync(path.join(E2E, HARNESS), "utf8");
  const code = harness
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  expect(code.match(/\.process\(\)/g)).toHaveLength(1);
  expect(code).toMatch(
    /const app = await electron\.launch\(options\);\s*shells\.set\(app, app\.process\(\)\);/,
  );
});
