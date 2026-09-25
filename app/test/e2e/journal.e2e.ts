// node:sqlite inside the runtime utilityProcess of the dev build (WI-0018-07, first item).
// Electron 44 bundles Node 24, whose `node:sqlite` needs no native module; this proves the
// runtime opens its journal with it, in WAL mode, where `init` says the user's data lives.
// The same proof against the PACKAGED app is owed to WI-0018-23 (packaging).
import fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

test("the runtime opens its journal with node:sqlite, in WAL mode, under the user's data", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const log = path.join(scratch, "journal.log");
    const { app, window } = await launchApp({ ...env, INNYTYPES_LOG_FILE: log });
    const runtime = await waitForRunning(window, "runtime");
    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);

    const file = path.join(userData, "journal.sqlite");
    const text = fs.readFileSync(log, "utf8");
    const line = text
      .split("\n")
      .find(
        (l) =>
          l.includes(" innytypes.runtime: journal: ") && l.includes(` ${String(runtime.pid)} `),
      );
    expect(line).toMatch(/journal: node:sqlite \(SQLite 3\.\d+\.\d+\), WAL, 0 entries in /);
    expect(line).toContain(file);
    expect(text).not.toContain("the journal could not be opened");
    expect(fs.existsSync(file)).toBe(true);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
