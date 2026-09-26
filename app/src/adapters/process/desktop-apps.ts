// Another desktop application, started, found and quit from the process table (plan 0018 §4.1
// point 6; launcher.py:572 `default_anytype_executable`, `RunningApplications`).
//
// * Found by its executable's absolute path at the start of a command line in the process
//   table: the path is what the table reports, and a bare name would match any process called
//   that. A process that merely names the path as an argument (`grep …/Anytype`) is not it.
// * Started detached, in a process group of its own, with no pipes: it is a desktop app, not a
//   child, and must never be taken down by a signal meant for InnyTypes' own group.
// * Quit through the handle the start returned: SIGTERM, then SIGKILL after the grace period.
//   There is no quit by pid: an app this application did not start has no handle to quit.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import type { DesktopApps, FoundApp, StartedApp } from "../../ports/desktop-apps";

/** How long a quit waits for the app to go after SIGTERM before SIGKILL. */
export const QUIT_GRACE_MS = 5_000;
/** How long the process table may take to answer. */
const LIST_TIMEOUT_MS = 10_000;

/**
 * Where the Anytype desktop app is installed on this machine, or null. The first of the usual
 * places that exists; never a search of PATH, which is whatever a shell profile made it.
 */
export function anytypeExecutable(
  platform: NodeJS.Platform,
  home: string,
  localAppData: string | undefined,
  exists: (file: string) => boolean = fs.existsSync,
): string | null {
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Anytype.app/Contents/MacOS/Anytype",
          path.join(home, "Applications", "Anytype.app", "Contents", "MacOS", "Anytype"),
        ]
      : platform === "win32"
        ? localAppData === undefined
          ? []
          : [path.win32.join(localAppData, "Programs", "anytype", "Anytype.exe")]
        : ["/usr/bin/anytype", "/opt/Anytype/anytype"];
  return candidates.find((file) => exists(file)) ?? null;
}

/** The pid whose command line is `executable`, from `ps -o pid=,args=` lines; null if none. */
export function findInProcessTable(listing: string, executable: string): number | null {
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const [, pid = "", args = ""] = match;
    if (args === executable || args.startsWith(`${executable} `)) {
      return Number(pid);
    }
  }
  return null;
}

export class ProcessTableApps implements DesktopApps {
  readonly #platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform) {
    this.#platform = platform;
  }

  find(executable: string): Promise<FoundApp | null> {
    return new Promise((resolve, reject) => {
      const [command, args] =
        this.#platform === "win32"
          ? [
              "powershell.exe",
              [
                "-NoProfile",
                "-Command",
                // One `<pid> <path>` line per process, as ps would print it.
                'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }',
              ],
            ]
          : ["/bin/ps", ["-A", "-o", "pid=,args="]];
      execFile(
        command,
        args,
        { timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            reject(new Error(`the process table could not be read: ${error.message}`));
            return;
          }
          const pid = findInProcessTable(stdout, executable);
          resolve(pid === null ? null : { pid });
        },
      );
    });
  }

  launch(executable: string): StartedApp {
    const child = spawn(executable, [], { detached: true, stdio: "ignore" });
    // A spawn that fails says so as an event; unheard, it would take the shell down with it.
    child.on("error", () => undefined);
    // A desktop app is not held open by InnyTypes' event loop.
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`${executable} could not be started`);
    }
    return startedApp(child, child.pid);
  }
}

function startedApp(child: ChildProcess, pid: number): StartedApp {
  let exited = child.exitCode !== null || child.signalCode !== null;
  const gone = new Promise<void>((resolve) => {
    if (exited) {
      resolve();
      return;
    }
    const done = (): void => {
      exited = true;
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
  return {
    pid,
    quit: async () => {
      if (exited) {
        return;
      }
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (!exited) {
          child.kill("SIGKILL");
        }
      }, QUIT_GRACE_MS);
      await gone;
      clearTimeout(timer);
    },
  };
}
