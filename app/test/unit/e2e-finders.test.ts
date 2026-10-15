// Every e2e spec finds the app's elements by data-testid and nothing else (plan 0022 §R: "elements
// by data-testid only"): a finder by role, text, label, placeholder, title or CSS reads the words
// and the markup the design may change, and a test that broke on a reworded button would be
// testing the wording. Words are asserted on an element once it is found by its test id.
//
// The one exception is Node-RED's own editor inside the canvas's frame: its palette, its header,
// its edit tray and its form inputs are Node-RED's markup (`.red-ui-*` classes, `#red-ui-*`,
// `#node-input-*` and `#node-dialog-*` ids), which InnyTypes does not draw and cannot give test ids.
// Reading what a found element holds (its text, its attributes, its children in an evaluate) is
// not finding, and is not what this checks.
import fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";

const E2E = path.resolve(import.meta.dirname, "..", "e2e");

/** Every .ts file under test/e2e, by its path from there. */
function specs(dir = E2E): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return specs(full);
    }
    return entry.name.endsWith(".ts") ? [path.relative(E2E, full)] : [];
  });
}

/** A finder that is not by test id, with what follows its parenthesis. */
const FINDER =
  /\.(getByRole|getByText|getByLabel|getByPlaceholder|getByTitle|getByAltText|locator|frameLocator|waitForSelector|\$\$eval|\$eval|\$\$|\$)\(\s*(\S{0,30})/g;

/** Node-RED's own markup in its editor frame: `.red-ui-…` classes, `#red-ui-…`, `#node-input-…` ids. */
const NODE_RED = /^["'`](\.red-ui-|#red-ui-|#node-(input|dialog)-)/;

/** Every finder, with its line, that finds an element other than by test id. */
export function offenders(file: string, text: string): string[] {
  // Comments are words about the code, not finders: a line comment, or a line of a block comment.
  const code = text.replace(/^\s*(\/\/|\/\*|\*).*$/gm, (comment) => " ".repeat(comment.length));
  const lines = text.split("\n");
  return [...code.matchAll(FINDER)].flatMap((match) => {
    const [, finder, argument = ""] = match;
    if (finder === "locator" && NODE_RED.test(argument)) {
      return [];
    }
    const line = code.slice(0, match.index).split("\n").length;
    return [`${file}:${String(line)}: ${(lines[line - 1] ?? "").trim()}`];
  });
}

it("every e2e finder is by data-testid, but Node-RED's own markup in its editor", () => {
  const files = specs();
  expect(files.length).toBeGreaterThan(20);
  const found = files.flatMap((file) =>
    offenders(file, fs.readFileSync(path.join(E2E, file), "utf8")),
  );
  expect(found).toEqual([]);
});

it("the check finds what it is for, and lets Node-RED's markup and test ids through", () => {
  expect(offenders("x.ts", 'await page.getByRole("button", { name: "Go" }).click();')).toHaveLength(
    1,
  );
  expect(offenders("x.ts", 'row.locator("em");')).toHaveLength(1);
  expect(offenders("x.ts", "page.getByText(label);")).toHaveLength(1);
  expect(offenders("x.ts", 'page.frameLocator("iframe");')).toHaveLength(1);
  expect(offenders("x.ts", 'await page.waitForSelector("[data-x]");')).toHaveLength(1);
  expect(offenders("x.ts", 'await page.$$eval("li", (all) => all.length);')).toHaveLength(1);
  expect(offenders("x.ts", 'editor.locator(".red-ui-palette-node");')).toEqual([]);
  expect(offenders("x.ts", 'frame.locator("#red-ui-header-button-deploy").click();')).toEqual([]);
  expect(offenders("x.ts", 'frame.locator("#node-input-token").fill(x);')).toEqual([]);
  expect(offenders("x.ts", 'page.getByTestId("canvas-editor").contentFrame();')).toEqual([]);
  expect(offenders("x.ts", 'page.getByTestId("frame");')).toEqual([]);
  expect(offenders("x.ts", '// page.getByRole("button") in a comment')).toEqual([]);
});
