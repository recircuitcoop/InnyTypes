// The log record, its levels, the line format and the child → shell wire (domain/logging).
import { describe, expect, it } from "vitest";
import { forEachLine, LineSplitter, type TextSource } from "../../src/domain/logging/lines";
import {
  DEFAULT_LEVEL,
  encodeProtect,
  encodeRecord,
  formatLine,
  levelLabel,
  LEVELS,
  MAX_OUTPUT_LINE,
  parseWireLine,
  resolveLevel,
  TRUNCATED,
  truncateLine,
  type LogRecord,
} from "../../src/domain/logging/record";

describe("levels", () => {
  it("resolves a name in any case and a number to the same verbosity", () => {
    expect(resolveLevel("Info")).toBe(20);
    expect(resolveLevel(" WARNING ")).toBe(30);
    expect(resolveLevel(20)).toBe(20);
    expect(resolveLevel(undefined)).toBe(DEFAULT_LEVEL);
  });

  it("refuses a level nobody has, by name, listing the ones there are", () => {
    expect(() => resolveLevel("chatty")).toThrow(
      "'chatty' is not a logging level; expected one of debug, info, warning, error, critical",
    );
  });

  it("defaults to DEBUG, the test-mode choice", () => {
    expect(DEFAULT_LEVEL).toBe(LEVELS.DEBUG);
    expect(levelLabel(DEFAULT_LEVEL)).toBe("DEBUG");
    expect(levelLabel(35)).toBe("Level 35");
  });

  it("orders the routine below the wrong, and ranks what a process printed as a warning", () => {
    expect(LEVELS.DEBUG).toBeLessThan(LEVELS.INFO);
    expect(LEVELS.INFO).toBeLessThan(LEVELS.WARNING);
    expect(LEVELS.WARNING).toBeLessThan(LEVELS.ERROR);
    expect(LEVELS.STDERR).toBe(LEVELS.WARNING);
    expect(LEVELS.stdout).toBe(LEVELS.WARNING);
  });
});

describe("the line format", () => {
  it("is logs.py's LOG_FORMAT: local asctime, level padded to 8, pid to 6, name, message", () => {
    const time = new Date(2026, 8, 25, 7, 4, 3, 9).getTime();
    const record: LogRecord = { time, level: "STDERR", pid: 42, name: "innytypes.x", msg: "hi" };
    expect(formatLine(record)).toBe("2026-09-25 07:04:03,009 STDERR       42 innytypes.x: hi\n");
  });

  it("cuts a long printed line and says so", () => {
    expect(truncateLine("short")).toBe("short");
    const long = truncateLine("x".repeat(MAX_OUTPUT_LINE + 5));
    expect(long).toBe(`${"x".repeat(MAX_OUTPUT_LINE)}${TRUNCATED}`);
  });
});

describe("the wire", () => {
  const record: LogRecord = {
    time: 1,
    level: "INFO",
    pid: 7,
    name: "innytypes.runtime",
    msg: "a\nb",
  };

  it("carries a record as one JSON line and reads it back whole", () => {
    const line = encodeRecord(record);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseWireLine(line.slice(0, -1))).toEqual({ kind: "log", record });
  });

  it("carries a protect line", () => {
    expect(parseWireLine(encodeProtect("s3cret").trimEnd())).toEqual({
      kind: "protect",
      secret: "s3cret",
    });
  });

  it("reads anything else as text the process printed", () => {
    for (const line of [
      "plain words",
      "[1,2]",
      "null",
      '{"t":"log","time":1,"level":"LOUD","pid":7,"name":"n","msg":"m"}',
      '{"t":"log","time":"1","level":"INFO","pid":7,"name":"n","msg":"m"}',
      '{"t":"protect","secret":5}',
    ]) {
      expect(parseWireLine(line)).toEqual({ kind: "text", text: line });
    }
  });
});

describe("lines out of chunks", () => {
  it("joins a line split across chunks and drops the line end, CRLF included", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("one\r\ntw")).toEqual([{ text: "one", cut: false }]);
    expect(splitter.push("o\n\nthree")).toEqual([
      { text: "two", cut: false },
      { text: "", cut: false },
    ]);
    expect(splitter.end()).toEqual({ text: "three", cut: false });
    expect(splitter.end()).toBeNull();
  });

  it("holds no more than its bound of a line with no end, and marks it cut", () => {
    const splitter = new LineSplitter(10);
    expect(splitter.push("x".repeat(8))).toEqual([]);
    expect(splitter.push("y".repeat(1000))).toEqual([]);
    expect(splitter.push("zz\nnext\n")).toEqual([
      { text: "xxxxxxxxyy", cut: true },
      { text: "next", cut: false },
    ]);
    splitter.push("w".repeat(20));
    expect(splitter.end()).toEqual({ text: "w".repeat(10), cut: true });
  });

  it("follows a stream to its end, the last line included", () => {
    const listeners: Record<string, (chunk?: string) => void> = {};
    const source: TextSource = {
      on: (event: string, listener: (chunk?: string) => void) => (listeners[event] = listener),
    } as TextSource;
    const seen: string[] = [];
    forEachLine(source, (line) => seen.push(line.text));
    listeners["data"]?.("a\nb");
    listeners["end"]?.();
    expect(seen).toEqual(["a", "b"]);
  });

  it("says nothing at the end of a stream that ended on a newline", () => {
    const listeners: Record<string, (chunk?: string) => void> = {};
    const source = {
      on: (event: string, listener: (chunk?: string) => void) => (listeners[event] = listener),
    } as TextSource;
    const seen: string[] = [];
    forEachLine(source, (line) => seen.push(line.text));
    listeners["data"]?.("a\n");
    listeners["end"]?.();
    expect(seen).toEqual(["a"]);
  });
});
