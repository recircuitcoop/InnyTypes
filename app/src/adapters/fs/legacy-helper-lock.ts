// Where the old helper's single-instance lock lives (helper/launcher.py default_lock_path:
// platformdirs' user_runtime_path("innytypes", appauthor=False) / "helper.lock"), and reading
// the pid it names (WI-0018-25). The lock file holds a whole ChildRecord (children.py); only
// the pid is read here, because the new app cannot re-run the old app's own three-fact identity
// check (pid, start time, executable) without linking in more of it than this one check is
// worth — a false positive here costs a person one extra "quit the old helper" message, not a
// wrong signal sent to an unrelated process (nothing here ever signals a pid, only asks the OS
// whether one is alive).

import fs from "node:fs";
import * as path from "node:path";

export interface LegacyLockLocation {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** platformdirs' `user_runtime_path("innytypes", appauthor=False)`. */
export function legacyRuntimeDirectory(location: LegacyLockLocation, tmpdir: string): string {
  const { platform, home, env } = location;
  const runtimeDir = env["XDG_RUNTIME_DIR"]?.trim();
  if (runtimeDir !== undefined && runtimeDir !== "") {
    return path.posix.join(runtimeDir, "innytypes");
  }
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Caches", "TemporaryItems", "innytypes");
  }
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? path.win32.join(home, "AppData", "Local");
    return path.win32.join(local, "innytypes");
  }
  return path.posix.join(tmpdir, "innytypes");
}

export function legacyLockPath(location: LegacyLockLocation, tmpdir: string): string {
  const paths = location.platform === "win32" ? path.win32 : path.posix;
  return paths.join(legacyRuntimeDirectory(location, tmpdir), "helper.lock");
}

/** The pid the lock file names, or null when there is none to read (missing, unreadable, or
 * malformed: a lock this reads nothing sensible from protects nobody, so it is not a block). */
export function readLegacyLockPid(file: string): number | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null) {
    return null;
  }
  const pid = (document as Record<string, unknown>)["pid"];
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}
