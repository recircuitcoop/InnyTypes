// The system's uv and Python, standing in for the bundled ones (ports/runtime-locator.ts).
//
// Owed to WI-0018-23: plan 0018 §1 bundles python-build-standalone 3.13 and uv, each pinned by
// version and sha256, and the packaged app must use those. This locator is for development and
// the tests: uv from PATH, and the Python uv finds among the system's interpreters, checked to
// be the version asked for.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { RuntimeLocator } from "../../ports/runtime-locator";
import { minimalEnvironment } from "./command";

const TIMEOUT_MS = 30_000;

/** The first executable named `name` on a PATH, or undefined. */
export function onPath(
  name: string,
  searchPath: string,
  platform: NodeJS.Platform,
): string | undefined {
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of searchPath.split(path.delimiter).filter((entry) => entry !== "")) {
    for (const candidate of names.map((file) => path.join(dir, file))) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

export class SystemRuntimeLocator implements RuntimeLocator {
  readonly #parent: Readonly<Record<string, string | undefined>>;
  readonly #platform: NodeJS.Platform;
  readonly #cacheDir: string;

  /** `cacheDir` is uv's cache (it caches what it learns of each interpreter), the app's own. */
  constructor(
    parent: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform,
    cacheDir: string,
  ) {
    this.#parent = parent;
    this.#platform = platform;
    this.#cacheDir = cacheDir;
  }

  uv(): string {
    const found = onPath("uv", this.#parent["PATH"] ?? "", this.#platform);
    if (found === undefined) {
      throw new Error("uv is not on PATH (the bundled uv is WI-0018-23's)");
    }
    return found;
  }

  python(version: string): string | undefined {
    const env = minimalEnvironment(this.#parent, {
      UV_CACHE_DIR: this.#cacheDir,
      UV_PYTHON_DOWNLOADS: "never",
    });
    try {
      const found = execFileSync(
        this.uv(),
        ["python", "find", "--no-project", "--no-config", "--system", version],
        { env, timeout: TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      const actual = execFileSync(
        found,
        ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
        { env, timeout: TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return actual === version ? found : undefined;
    } catch {
      return undefined;
    }
  }
}
