// The one log file (adapters/fs/log-writer.ts): the old path, the 2 MiB × 3 rotation, the
// variables, and a destination that cannot be opened. Every file here is under a temp dir.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_COUNT,
  defaultLogPath,
  LOG_FILENAME,
  LOG_PATH_VARIABLE,
  logPath,
  MAX_LOG_BYTES,
  RotatingLogFile,
} from "../../src/adapters/fs/log-writer";
import { syncWriter } from "../../src/adapters/system/sync-writer";
import { REAL_HOMES, SANDBOX_HOME } from "../home-guard";

const scratch: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inny-log-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("where the log is", () => {
  it("is platformdirs' user_log_path on each OS, the old app's path", () => {
    expect(defaultLogPath({ platform: "darwin", home: "/Users/p", env: {} })).toBe(
      "/Users/p/Library/Logs/innytypes/innytypes.log",
    );
    expect(defaultLogPath({ platform: "linux", home: "/home/p", env: {} })).toBe(
      "/home/p/.local/state/innytypes/log/innytypes.log",
    );
    expect(
      defaultLogPath({ platform: "linux", home: "/home/p", env: { XDG_STATE_HOME: "/s" } }),
    ).toBe("/s/innytypes/log/innytypes.log");
    expect(
      defaultLogPath({ platform: "linux", home: "/home/p", env: { XDG_STATE_HOME: " " } }),
    ).toBe("/home/p/.local/state/innytypes/log/innytypes.log");
    expect(
      defaultLogPath({
        platform: "win32",
        home: "C:\\Users\\p",
        env: { LOCALAPPDATA: "C:\\Users\\p\\AppData\\Local" },
      }),
    ).toBe("C:\\Users\\p\\AppData\\Local\\innytypes\\Logs\\innytypes.log");
    expect(defaultLogPath({ platform: "win32", home: "C:\\Users\\p", env: {} })).toBe(
      "C:\\Users\\p\\AppData\\Local\\innytypes\\Logs\\innytypes.log",
    );
  });

  it("is the file INNYTYPES_LOG_FILE names when it names one", () => {
    const location = { platform: "darwin" as const, home: "/Users/p" };
    expect(logPath({ ...location, env: { [LOG_PATH_VARIABLE]: "/tmp/x.log" } })).toBe("/tmp/x.log");
    expect(logPath({ ...location, env: { [LOG_PATH_VARIABLE]: "" } })).toBe(
      "/Users/p/Library/Logs/innytypes/innytypes.log",
    );
  });

  it("is never this machine's real log in the gate", () => {
    const real = defaultLogPath({ platform: process.platform, home: REAL_HOMES[0] ?? "", env: {} });
    const gate = defaultLogPath({ platform: process.platform, home: os.homedir(), env: {} });
    expect(path.basename(real)).toBe(LOG_FILENAME);
    expect(os.homedir()).toBe(SANDBOX_HOME);
    expect(gate).not.toBe(real);
  });
});

describe("the file", () => {
  it("creates its directory and appends each line, synchronously", () => {
    const file = path.join(tempDir(), "deep", "innytypes.log");
    const log = RotatingLogFile.open(file);
    expect(log?.path).toBe(file);
    log?.append("one\n");
    // On disk the moment append returns, before anything is closed or flushed.
    expect(fs.readFileSync(file, "utf8")).toBe("one\n");
    log?.append("two\n");
    log?.close();
    log?.close();
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });

  it("does not stop the application when the destination cannot be opened", () => {
    const dir = path.join(tempDir(), "innytypes.log");
    fs.mkdirSync(dir);
    expect(RotatingLogFile.open(dir)).toBeNull();
  });

  it("keeps quiet when a line cannot be written", () => {
    const file = path.join(tempDir(), "innytypes.log");
    const log = RotatingLogFile.open(file);
    log?.close();
    expect(() => log?.append("after close\n")).not.toThrow();
  });

  it("rotates at 2 MiB and keeps 3 backups by default", () => {
    expect(MAX_LOG_BYTES).toBe(2 * 1024 * 1024);
    expect(BACKUP_COUNT).toBe(3);
    const file = path.join(tempDir(), "innytypes.log");
    const log = RotatingLogFile.open(file);
    const line = `${"x".repeat(1023)}\n`;
    for (let index = 0; index < 2048 * 4 + 10; index++) {
      log?.append(line);
    }
    log?.close();
    const kept = fs.readdirSync(path.dirname(file)).sort();
    expect(kept).toEqual([
      "innytypes.log",
      "innytypes.log.1",
      "innytypes.log.2",
      "innytypes.log.3",
    ]);
    for (const name of kept) {
      expect(fs.statSync(path.join(path.dirname(file), name)).size).toBeLessThan(MAX_LOG_BYTES);
    }
  });

  it("does not grow without limit: the oldest backup goes, and the newest line is kept", () => {
    const file = path.join(tempDir(), "innytypes.log");
    const log = RotatingLogFile.open(file, { maxBytes: 4096, backupCount: 2 });
    for (let index = 0; index < 600; index++) {
      log?.append(`a line of the sort a busy machine writes all day, number ${String(index)}\n`);
    }
    log?.close();
    const kept = fs.readdirSync(path.dirname(file)).sort();
    expect(kept).toEqual(["innytypes.log", "innytypes.log.1", "innytypes.log.2"]);
    for (const name of kept) {
      expect(fs.statSync(path.join(path.dirname(file), name)).size).toBeLessThan(4096);
    }
    expect(fs.readFileSync(file, "utf8")).toContain("number 599");
    // .1 holds what came just before the live file.
    const live = Number(/number (\d+)/.exec(fs.readFileSync(file, "utf8"))?.[1]);
    expect(fs.readFileSync(`${file}.1`, "utf8")).toContain(`number ${String(live - 1)}\n`);
  });

  it("with no backups, starts the file again", () => {
    const file = path.join(tempDir(), "innytypes.log");
    const log = RotatingLogFile.open(file, { maxBytes: 100, backupCount: 0 });
    for (let index = 0; index < 10; index++) {
      log?.append(`${"y".repeat(30)}${String(index)}\n`);
    }
    log?.close();
    expect(fs.readdirSync(path.dirname(file))).toEqual(["innytypes.log"]);
    expect(fs.readFileSync(file, "utf8")).toContain("9\n");
  });

  it("keeps writing after a rollover whose rename fails", () => {
    const dir = tempDir();
    const file = path.join(dir, "innytypes.log");
    const log = RotatingLogFile.open(file, { maxBytes: 200, backupCount: 1 });
    // A directory where the backup should go: the rename of the live file onto it fails.
    fs.mkdirSync(`${file}.1`);
    fs.writeFileSync(path.join(`${file}.1`, "blocker"), "");
    for (let index = 0; index < 20; index++) {
      log?.append(`a line long enough to push this file over its bound ${String(index)}\n`);
    }
    log?.close();
    expect(fs.readFileSync(file, "utf8")).toContain("bound 19\n");
  });
});

describe("the child's synchronous writer", () => {
  it("writes the whole text to a descriptor before it returns", () => {
    const file = path.join(tempDir(), "out");
    const fd = fs.openSync(file, "w");
    syncWriter(fd)("héllo\n".repeat(1000));
    expect(fs.readFileSync(file, "utf8")).toBe("héllo\n".repeat(1000));
    fs.closeSync(fd);
  });

  it("raises an error that is not a full pipe", () => {
    const file = path.join(tempDir(), "out");
    const fd = fs.openSync(file, "w");
    fs.closeSync(fd);
    expect(() => {
      syncWriter(fd)("x");
    }).toThrow();
  });
});
