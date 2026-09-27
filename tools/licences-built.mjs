// The built-artifact half of the licences stage (plan 0018 §8.3 WI-0018-23): tools/licences.mjs
// checks the *source* dependency tree, where npm is still a genuine, installed dependency of
// @node-red/registry. This script checks the opposite thing: that a packaged app.asar actually
// ships none of it. The two are complementary, not duplicates — see licences.mjs's own comment
// on EXCEPTIONS for why the source-tree exceptions do not "expire" just because this passes.
//
// Usage: node tools/licences-built.mjs <path to app.asar, or an .app/.exe/AppImage that
// contains one>. Exits 1 and prints every offending path if npm (beyond the placeholder
// package.json packaging/npm-stub provides) is found inside.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/** The stub's own files: the only thing under node_modules/npm a passing build may contain. */
function stubFiles() {
  const dir = path.join(REPO, "app", "packaging", "npm-stub");
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath ?? dir, entry.name)));
}

/** Find the first `*.asar` under `root` (an unpacked .app, or a directory of build output). */
function findAsar(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "app.asar") {
        return full;
      }
      if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return null;
}

function main(argv) {
  const target = argv[0];
  if (target === undefined) {
    console.error("usage: node tools/licences-built.mjs <app.asar, or a folder containing one>");
    return 1;
  }
  const asar = target.endsWith(".asar") ? target : findAsar(target);
  if (asar === null || !fs.existsSync(asar)) {
    console.error(`licences (built): no app.asar found under ${target}`);
    return 1;
  }

  const listing = execFileSync("npx", ["--yes", "asar", "list", asar], { encoding: "utf8" });
  const npmEntries = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/node_modules/npm/"))
    .map((line) => line.slice("/node_modules/npm/".length));

  const allowed = new Set(stubFiles());
  const offending = npmEntries.filter((entry) => !allowed.has(entry));

  console.log(`licences (built): ${asar}`);
  console.log(`licences (built): ${npmEntries.length} node_modules/npm entr(y/ies) found`);
  if (offending.length > 0) {
    console.error(
      `licences (built): ${offending.length} entr(y/ies) beyond the placeholder ` +
        `(packaging/npm-stub), meaning the real npm CLI shipped:`,
    );
    for (const entry of offending) {
      console.error(`  node_modules/npm/${entry}`);
    }
    return 1;
  }
  console.log(
    "licences (built): npm is excluded (only the placeholder package.json is present); the " +
      "source-tree exceptions in tools/licences.mjs for qrcode-terminal, spdx-exceptions and " +
      "spdx-license-ids do not apply to this artifact",
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
