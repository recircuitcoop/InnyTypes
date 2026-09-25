// No tray, menu-bar or notification-area icon on any OS (plan 0018 §3 window.py, F4): the rule
// checked against the source, as the old app's test_no_system_tray_api_appears_anywhere_in_the_tree
// did, since Electron offers no way to list the trays a running app has made.
import fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : /\.(ts|html)$/.test(entry.name) ? [full] : [];
  });
}

it("no tray, menu-bar or notification-area icon: nothing in app/src makes one", () => {
  const files = sources(SRC);
  expect(files.length).toBeGreaterThan(50);
  const offenders = files.filter((file) => {
    const text = fs.readFileSync(file, "utf8");
    // Electron's Tray, imported or reached through the module, and a status item by any name.
    return /\bTray\b/.test(text) || /setStatusItem|NSStatusItem|appIndicator/i.test(text);
  });
  expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
});
