// A stand-in for the Anytype desktop app (WI-0018-21), so no test ever starts, adopts or quits
// this user's own. A bash script that execs node under its own path (`exec -a "$0"`), so the
// process table shows the script's path at the start of its command line, exactly as it shows
// the real app's. It writes its pid beside itself, then runs until it is signalled.

import fs from "node:fs";
import * as path from "node:path";

/** Write the fake app into `dir`; its path is what the app is told Anytype is. */
export function fakeAnytypeApp(dir: string, node: string = process.execPath): string {
  const file = path.join(dir, "fake-anytype");
  const code =
    "require('fs').writeFileSync(process.argv[1], String(process.pid)); " +
    "setInterval(() => undefined, 1000);";
  fs.writeFileSync(
    file,
    `#!/bin/bash\nexec -a "$0" ${JSON.stringify(node)} -e ${JSON.stringify(code)} "$0.pid"\n`,
    { mode: 0o755 },
  );
  return file;
}

/** The pid the fake app wrote once it was running; null until then. */
export function fakeAnytypePid(file: string): number | null {
  try {
    return Number(fs.readFileSync(`${file}.pid`, "utf8"));
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
