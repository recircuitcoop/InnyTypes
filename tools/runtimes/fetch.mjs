// Fetches and verifies the bundled runtimes (plan 0018 §1; WI-0018-23): python-build-standalone
// 3.13, uv and Node 24, each pinned by version and sha256 in manifest.json. A hash mismatch
// throws, which fails this script and, run from electron-builder's package script, the build.
//
// Lays each target's runtimes out exactly as adapters/process/bundled-runtime-locator.ts (the
// LAYOUT it reads at runtime) and app/packaging/electron-builder.yml (extraResources, which
// copies this same folder into the packaged app's Resources/runtimes) expect:
//
//   app/build/runtimes/<target>/python/bin/python3
//   app/build/runtimes/<target>/uv/uv
//   app/build/runtimes/<target>/node/bin/node
//
// Downloaded once and cached here: re-running with the same manifest does nothing (idempotent),
// so the packaging scripts can call this on every build with no network cost after the first.
//
// Plain Node (no dependencies), run directly: `node tools/runtimes/fetch.mjs [target ...]`.
// With no target named, every target in the manifest is fetched.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const MANIFEST_PATH = path.join(HERE, "manifest.json");
const DEST_ROOT = path.join(REPO, "app", "build", "runtimes");

/** Every target's tool sits at a different depth inside its own tarball (verified by hand
 * against a real download of each: python-build-standalone's install_only archive already
 * has `python/` as its own top entry; uv's and Node's archives wrap everything in one
 * target-named directory). */
const LAYOUTS = {
  python: { extractInto: (dest) => dest, stripComponents: 0 },
  uv: { extractInto: (dest) => path.join(dest, "uv"), stripComponents: 1 },
  node: { extractInto: (dest) => path.join(dest, "node"), stripComponents: 1 },
};

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function download(url, into) {
  // curl is present on every macOS and Ubuntu machine this runs on (dev, CI, the Multipass
  // VM); no npm dependency is spent on what the OS already provides.
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", into, url], { stdio: "inherit" });
}

/** One tool, for one target: download to a scratch file, verify, extract, then discard it. */
function fetchOne(tool, target, entry, targetDir) {
  const layout = LAYOUTS[tool];
  const destDir = layout.extractInto(targetDir);
  const marker = path.join(destDir, ".fetched-sha256");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === entry.sha256) {
    console.log(`runtimes: ${tool} ${target} already fetched (sha256 matches)`);
    return;
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const archive = `${destDir}.tar.gz`;
  console.log(`runtimes: fetching ${tool} ${target} from ${entry.url}`);
  download(entry.url, archive);
  const actual = sha256File(archive);
  if (actual !== entry.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(
      `runtimes: ${tool} ${target} sha256 mismatch: pinned ${entry.sha256}, downloaded ${actual} ` +
        `(${entry.url}) — refusing to use it`,
    );
  }
  execFileSync("tar", [
    "-xzf",
    archive,
    "-C",
    destDir,
    "--strip-components",
    String(layout.stripComponents),
  ]);
  fs.rmSync(archive, { force: true });
  if (tool === "node") {
    stripNpm(destDir);
  }
  fs.writeFileSync(marker, `${entry.sha256}\n`);
  console.log(`runtimes: ${tool} ${target} verified and extracted to ${destDir}`);
}

/**
 * npm is not in the bundle (WI-0018-23): every Node.js distribution carries its own npm and
 * corepack under lib/node_modules, with bin/ symlinks to them. Both are removed from the
 * bundled Node the moment it is fetched, so there is never a build in which they exist to be
 * excluded later — the after-pack npm check (packaging/after-pack.cjs) has nothing to find.
 */
function stripNpm(nodeDir) {
  for (const name of ["npm", "npx", "corepack"]) {
    fs.rmSync(path.join(nodeDir, "bin", name), { force: true });
    fs.rmSync(path.join(nodeDir, "bin", `${name}.cmd`), { force: true });
  }
  for (const name of ["npm", "corepack"]) {
    fs.rmSync(path.join(nodeDir, "lib", "node_modules", name), { recursive: true, force: true });
  }
}

function main(argv) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const tools = Object.keys(LAYOUTS);
  const allTargets = new Set(tools.flatMap((tool) => Object.keys(manifest[tool].targets)));
  const wanted = argv.length > 0 ? argv : [...allTargets];
  for (const target of wanted) {
    if (!allTargets.has(target)) {
      throw new Error(`runtimes: unknown target ${target}; known: ${[...allTargets].join(", ")}`);
    }
    const targetDir = path.join(DEST_ROOT, target);
    fs.mkdirSync(targetDir, { recursive: true });
    for (const tool of tools) {
      const entry = manifest[tool].targets[target];
      if (entry === undefined) {
        throw new Error(`runtimes: ${tool} names no entry for target ${target}`);
      }
      fetchOne(tool, target, entry, targetDir);
    }
  }
}

main(process.argv.slice(2));
