// Where the old installation's plugin environments live (addons/discovery.py's addons root:
// platformdirs' user_data_path("innytypes", appauthor=False) / "addons"), and listing or
// deleting them (WI-0018-25).

import fs from "node:fs";
import * as path from "node:path";
import type { LegacyPackageEnvironments } from "../../ports/legacy-packages";

export interface LegacyPackagesLocation {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function pathsFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * platformdirs' `user_data_path("innytypes", appauthor=False)`: `~/Library/Application
 * Support/innytypes` on macOS (the same directory as the config path: platformdirs does not
 * distinguish them there), `$XDG_DATA_HOME/innytypes` (or `~/.local/share/innytypes`) on Linux,
 * `%LOCALAPPDATA%\innytypes` on Windows.
 */
export function legacyDataDirectory(location: LegacyPackagesLocation): string {
  const { platform, home, env } = location;
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", "innytypes");
  }
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? path.win32.join(home, "AppData", "Local");
    return path.win32.join(local, "innytypes");
  }
  const dataHome = env["XDG_DATA_HOME"]?.trim();
  const base =
    dataHome !== undefined && dataHome !== "" ? dataHome : path.posix.join(home, ".local", "share");
  return path.posix.join(base, "innytypes");
}

export function legacyAddonsRoot(location: LegacyPackagesLocation): string {
  return pathsFor(location.platform).join(legacyDataDirectory(location), "addons");
}

export class FsLegacyPackageEnvironments implements LegacyPackageEnvironments {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  list(): readonly string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.#root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  deleteAll(): void {
    fs.rmSync(this.#root, { recursive: true, force: true });
  }
}
