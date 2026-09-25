// The one log file (plan 0018 §3, the row for logs.py): the old app's path, its 2 MiB × 3
// rotation, and appends that are on disk when they return.
//
// Only the shell writes it, so the old handler's defences against a sibling process rolling
// the file under it (logs.py:255-321) have nothing to defend against here. Every append is
// synchronous: a line the shell wrote an instant before it was killed is in the file.

import fs from "node:fs";
import * as path from "node:path";
import type { LogFile } from "../../ports/logger";

/** The application, as the per-user directories spell it (logs.py:149). */
export const APPLICATION_NAME = "innytypes";
export const LOG_FILENAME = "innytypes.log";

/** Where a person names another file for one run (logs.py:161). */
export const LOG_PATH_VARIABLE = "INNYTYPES_LOG_FILE";
/** How a person sets the verbosity for one run (logs.py:166). */
export const LOG_LEVEL_VARIABLE = "INNYTYPES_LOG_LEVEL";

/** The bound (logs.py:195-196): a machine left running for a month must not fill a disk. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const BACKUP_COUNT = 3;

export interface LogLocation {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** Only the variables the location depends on are read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * platformdirs' `user_log_path("innytypes", appauthor=False) / "innytypes.log"`, which is
 * where the old app writes (logs.py:204-219): `~/Library/Logs/innytypes` on macOS,
 * `$XDG_STATE_HOME/innytypes/log` on Linux, `%LOCALAPPDATA%\innytypes\Logs` on Windows.
 */
export function defaultLogPath(location: LogLocation): string {
  const { platform, home, env } = location;
  if (platform === "darwin") {
    return path.join(home, "Library", "Logs", APPLICATION_NAME, LOG_FILENAME);
  }
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? path.win32.join(home, "AppData", "Local");
    return path.win32.join(local, APPLICATION_NAME, "Logs", LOG_FILENAME);
  }
  const state = env["XDG_STATE_HOME"]?.trim();
  const base = state !== undefined && state !== "" ? state : path.join(home, ".local", "state");
  return path.join(base, APPLICATION_NAME, "log", LOG_FILENAME);
}

/** The file for this run: INNYTYPES_LOG_FILE when it names one, the old path otherwise. */
export function logPath(location: LogLocation): string {
  const named = location.env[LOG_PATH_VARIABLE];
  return named !== undefined && named !== "" ? named : defaultLogPath(location);
}

export interface RotationBound {
  readonly maxBytes: number;
  readonly backupCount: number;
}

/**
 * A size-bounded file, rolled over the way RotatingFileHandler rolls it: when the next line
 * would take it to `maxBytes`, `.2` becomes `.3`, `.1` becomes `.2`, the file becomes `.1`, and
 * a new file is started. The oldest backup is dropped.
 */
export class RotatingLogFile implements LogFile {
  readonly #path: string;
  readonly #bound: RotationBound;
  #fd: number;

  private constructor(file: string, fd: number, bound: RotationBound) {
    this.#path = file;
    this.#fd = fd;
    this.#bound = bound;
  }

  /**
   * The file, created with its directory, or null when it cannot be opened: a read-only home,
   * a full disk, a path that is a directory. None of those stops the application (logs.py:456).
   */
  static open(
    file: string,
    bound: RotationBound = { maxBytes: MAX_LOG_BYTES, backupCount: BACKUP_COUNT },
  ): RotatingLogFile | null {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return new RotatingLogFile(file, fs.openSync(file, "a"), bound);
    } catch {
      return null;
    }
  }

  get path(): string {
    return this.#path;
  }

  append(line: string): void {
    const bytes = Buffer.from(line, "utf8");
    try {
      if (this.#shouldRollOver(bytes.length)) {
        try {
          this.#rollOver();
        } catch {
          // The file could not be rolled; the line is still written, into the file as it is
          // (logs.py:295-302). Losing lines is worse than one file running over its bound.
        }
      }
      fs.writeSync(this.#fd, bytes);
    } catch {
      // A disk that filled up after the file was opened. A log that cannot be written must
      // not take the shell down with it; the next line tries again.
    }
  }

  close(): void {
    try {
      fs.closeSync(this.#fd);
    } catch {
      // Already closed.
    }
  }

  #shouldRollOver(incoming: number): boolean {
    const { maxBytes } = this.#bound;
    return maxBytes > 0 && fs.fstatSync(this.#fd).size + incoming >= maxBytes;
  }

  #rollOver(): void {
    fs.closeSync(this.#fd);
    const { backupCount } = this.#bound;
    try {
      if (backupCount > 0) {
        for (let index = backupCount - 1; index >= 1; index--) {
          this.#move(`${this.#path}.${String(index)}`, `${this.#path}.${String(index + 1)}`);
        }
        this.#move(this.#path, `${this.#path}.1`);
      } else {
        fs.truncateSync(this.#path, 0);
      }
    } finally {
      // A rename that failed leaves the file where it was; either way there must be an open
      // file afterwards, or every later line would be lost (logs.py:295-302).
      this.#fd = fs.openSync(this.#path, "a");
    }
  }

  #move(from: string, to: string): void {
    if (fs.existsSync(from)) {
      fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
    }
  }
}
