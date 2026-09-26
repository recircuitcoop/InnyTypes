// The one log (WI-0018-04) through the real app: the shell writes it at the old path, the
// runtime and the services process reach it through their stdout pipes, the variables are
// honoured, a canary every process prints never reaches the file, and a child's lines from
// just before its kill -9 are there afterwards.
import fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { defaultLogPath } from "../../src/adapters/fs/log-writer";
import {
  launchApp,
  quit,
  processesNaming,
  scratchDirectories,
  shellOf,
  waitForRunning,
} from "./app-harness";

const CANARY = "fake-log-canary-that-must-never-be-written-97531";

/** Where the app writes its log for a scratch HOME, when no variable names another file. */
function oldPathUnder(env: Record<string, string>): string {
  return defaultLogPath({ platform: process.platform, home: env["HOME"] ?? "", env });
}

/** The lines of `text` written under logger `name` by process `pid`. */
function linesOf(text: string, name: string, pid?: number): string[] {
  return text
    .split("\n")
    .filter((line) => line.includes(` ${name}: `))
    .filter((line) => pid === undefined || line.split(/\s+/)[3] === String(pid));
}

test("the shell, the runtime and the services write one file at the old path, and no canary reaches it", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const { app, window, output } = await launchApp({ ...env, INNYTYPES_LOG_CANARY: CANARY });
    const runtime = await waitForRunning(window, "runtime");
    const services = await waitForRunning(window, "services");
    const shellPid = shellOf(app).pid;
    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);

    const file = oldPathUnder(env);
    expect(file.startsWith(scratch)).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain(`innytypes shell (process ${String(shellPid)}) is logging to ${file}`);
    // Each process in its own lines, with its own pid.
    expect(linesOf(text, "innytypes.shell", shellPid)).not.toEqual([]);
    expect(linesOf(text, "innytypes.runtime", runtime.pid).join("\n")).toContain(
      `runtime generation 1 started as pid ${String(runtime.pid)}`,
    );
    expect(linesOf(text, "innytypes.services", services.pid).join("\n")).toContain(
      "services stopping (quit)",
    );
    // A record reaches the file as a line, never as the JSON it travelled in.
    expect(text).not.toContain('{"t":');

    // Every process printed the canary; the file and the terminal hold only the marker.
    for (const name of ["innytypes.shell", "innytypes.runtime", "innytypes.services"]) {
      expect(linesOf(text, name).join("\n")).toContain("log canary: [redacted]");
    }
    expect(text).not.toContain(CANARY);
    expect(output.join("")).not.toContain(CANARY);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["innytypes.log"]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("INNYTYPES_LOG_FILE and INNYTYPES_LOG_LEVEL are honoured", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const named = path.join(scratch, "elsewhere", "named.log");
    const { app, window } = await launchApp({
      ...env,
      INNYTYPES_LOG_FILE: named,
      INNYTYPES_LOG_LEVEL: "error",
    });
    const runtime = await waitForRunning(window, "runtime");
    process.kill(runtime.pid, "SIGKILL");
    await waitForRunning(window, "runtime", runtime.generation + 1);
    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);

    expect(fs.existsSync(oldPathUnder(env))).toBe(false);
    const text = fs.readFileSync(named, "utf8");
    expect(text).toMatch(/ ERROR +\d+ innytypes\.shell: the runtime exited unexpectedly/);
    // At ERROR, nothing routine is written, from the shell or from a child.
    for (const level of ["DEBUG", "INFO", "WARNING"]) {
      expect(text).not.toContain(` ${level} `);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a misspelled INNYTYPES_LOG_LEVEL is said in the log, which is written at DEBUG", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const named = path.join(scratch, "chatty.log");
    const { app, window } = await launchApp({
      ...env,
      INNYTYPES_LOG_FILE: named,
      INNYTYPES_LOG_LEVEL: "chatty",
    });
    await waitForRunning(window, "runtime");
    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);

    const text = fs.readFileSync(named, "utf8");
    expect(text).toContain(
      "'chatty' is not a logging level; expected one of debug, info, warning, error, " +
        "critical; logging at DEBUG instead",
    );
    expect(text).toMatch(/ INFO +\d+ innytypes\.runtime: runtime generation 1 started/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("lines a child wrote just before its kill -9 are in the file", async () => {
  const { scratch, userData, env } = scratchDirectories();
  try {
    const named = path.join(scratch, "killed.log");
    const { app, window } = await launchApp({ ...env, INNYTYPES_LOG_FILE: named });
    // The runtime writes its "started" line and at once posts ready; it is killed the moment
    // the page shows it running.
    const first = await waitForRunning(window, "runtime");
    process.kill(first.pid, "SIGKILL");
    const second = await waitForRunning(window, "runtime", first.generation + 1);
    await quit(app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);

    const text = fs.readFileSync(named, "utf8");
    expect(linesOf(text, "innytypes.runtime", first.pid).join("\n")).toContain(
      `runtime generation 1 started as pid ${String(first.pid)}`,
    );
    expect(linesOf(text, "innytypes.runtime", second.pid).join("\n")).toContain(
      `runtime generation 2 started as pid ${String(second.pid)}`,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
