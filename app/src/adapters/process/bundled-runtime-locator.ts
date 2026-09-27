// The bundled runtimes (plan 0018 §1; WI-0018-23): python-build-standalone 3.13, uv and Node 24,
// fetched and pinned by version and sha256 per target by tools/runtimes/fetch.mjs, laid out
// under one directory as:
//
//   <runtimesDir>/python/bin/python3   (python/python.exe on Windows)
//   <runtimesDir>/uv/uv                (uv/uv.exe on Windows)
//   <runtimesDir>/node/bin/node        (node/node.exe on Windows)
//
// The composition roots construct this once packaged (shell/main.ts hands each child
// INNYTYPES_RUNTIMES_DIR, resolved from process.resourcesPath); SystemRuntimeLocator stands in
// everywhere else. Real node, not Electron acting as node: no ELECTRON_RUN_AS_NODE is needed,
// which is what lets the RunAsNode fuse stay off in the packaged app.

import * as path from "node:path";

import type { NodeRuntime, RuntimeLocator } from "../../ports/runtime-locator";

/**
 * The folder name a build's runtimes are fetched into (tools/runtimes/fetch.mjs) and copied
 * into a packaged app's resources under (the electron-builder afterPack hook): one target's
 * runtimes per package, so no target segment is needed once packaged.
 */
export const RUNTIMES_DIRNAME = "runtimes";

/** One tool's folder under `<runtimesDir>` and its binary's name, without an extension. */
const LAYOUT = {
  uv: { dir: ["uv"], binary: "uv" },
  python: { dir: ["python", "bin"], binary: "python3" },
  node: { dir: ["node", "bin"], binary: "node" },
} as const;

function executable(
  runtimesDir: string,
  tool: keyof typeof LAYOUT,
  platform: NodeJS.Platform,
): string {
  const { dir, binary } = LAYOUT[tool];
  const bin = platform === "win32" ? `${binary}.exe` : binary;
  return path.join(runtimesDir, ...dir, bin);
}

export class BundledRuntimeLocator implements RuntimeLocator {
  readonly #runtimesDir: string;
  readonly #platform: NodeJS.Platform;

  /** `runtimesDir` is this target's fetched runtimes folder (see the layout above). */
  constructor(runtimesDir: string, platform: NodeJS.Platform) {
    this.#runtimesDir = runtimesDir;
    this.#platform = platform;
  }

  uv(): string {
    return executable(this.#runtimesDir, "uv", this.#platform);
  }

  /** Only 3.13 is bundled; any other version is not found (spec: python-build-standalone). */
  python(version: string): string | undefined {
    return version === "3.13" ? executable(this.#runtimesDir, "python", this.#platform) : undefined;
  }

  node(): NodeRuntime {
    return { command: executable(this.#runtimesDir, "node", this.#platform), env: {} };
  }
}
