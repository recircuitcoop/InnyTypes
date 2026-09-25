// Playwright drives the real Electron app through its `_electron` driver (plan 0018 §1).
// The gate runs the dev build with hidden windows and a temporary userData directory;
// specs that need a real machine are tagged @machine and left to the machine proofs.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.e2e.ts",
  grepInvert: /@machine/,
  // One Electron at a time: the specs count processes, and two apps would count each other.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  forbidOnly: true,
  // The JSON report is what the parity stage checks ported ids against (plan 0018 §5.3).
  reporter: [["list"], ["json", { outputFile: "../.gate/playwright.json" }]],
  outputDir: "test-results",
});
