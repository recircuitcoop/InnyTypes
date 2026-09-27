// Where the old config.toml lives (helper/config.py's default_config_path: platformdirs'
// user_config_path("innytypes", appauthor=False) / "config.toml"), and reading it as text
// (WI-0018-25). The same directory owner-only-files.ts's legacyConfigDirectory already computes
// for the Anytype key's read-only legacy fallback (plan 0018 §4.1); this file exists so
// migration code does not have to import the secrets adapter for an unrelated file.

import fs from "node:fs";
import * as path from "node:path";

export interface LegacyConfigLocation {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** `~/Library/Application Support/innytypes` (macOS), `$XDG_CONFIG_HOME/innytypes` (Linux),
 * `%LOCALAPPDATA%\innytypes` (Windows): where config.toml lived (config.py:114-124). */
export function legacyConfigDirectory(location: LegacyConfigLocation): string {
  const { platform, home, env } = location;
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", "innytypes");
  }
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? path.win32.join(home, "AppData", "Local");
    return path.win32.join(local, "innytypes");
  }
  const config = env["XDG_CONFIG_HOME"]?.trim();
  const base = config !== undefined && config !== "" ? config : path.posix.join(home, ".config");
  return path.posix.join(base, "innytypes");
}

export function legacyConfigPath(location: LegacyConfigLocation): string {
  const paths = location.platform === "win32" ? path.win32 : path.posix;
  return paths.join(legacyConfigDirectory(location), "config.toml");
}

/** The file's text, or null when it does not exist. Any other read failure is thrown. */
export function readTextFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
