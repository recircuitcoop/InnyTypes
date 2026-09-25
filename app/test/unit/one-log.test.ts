// The one log's two ends without a process: a child's source log writing wire lines, and the
// shell's OneLog parsing, redacting, filtering and appending them.
import { describe, expect, it } from "vitest";
import { nodeRedLogging } from "../../src/adapters/nodered/logging";
import { OneLog, type ChildStream } from "../../src/application/one-log";
import { nodeLoggerName, printCanary, sourceLog } from "../../src/application/source-log";
import { encodeRecord, LEVELS, MAX_OUTPUT_LINE, TRUNCATED } from "../../src/domain/logging/record";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";
import type { LeveledLogger } from "../../src/ports/logger";

const KEY = "fake-anytype-key-that-must-not-be-written-13579";
const NOW = new Date(2026, 8, 25, 12, 0, 0, 0).getTime();

/** A OneLog over an in-memory file. */
function shell(options: { level?: number; registry?: SecretRegistry } = {}) {
  const file: string[] = [];
  const echoed: string[] = [];
  const log = new OneLog({
    registry: options.registry ?? new SecretRegistry(),
    level: options.level ?? LEVELS.DEBUG,
    file: { append: (line) => file.push(line) },
    echo: (line) => echoed.push(line),
    now: () => NOW,
  });
  const feed = (child: string, stream: ChildStream, text: string, cut = false) => {
    log.ingest(child, 99, stream, { text, cut });
  };
  return { log, file, echoed, feed, text: () => file.join("") };
}

/** A child's source log whose stdout is a list of lines. */
function child(name = "innytypes.runtime", registry?: SecretRegistry) {
  const written: string[] = [];
  const log = sourceLog({
    name,
    pid: 7,
    write: (text) => written.push(text),
    now: () => NOW,
    ...(registry === undefined ? {} : { registry }),
  });
  return { log, written };
}

describe("OneLog, the shell's writer", () => {
  it("writes its own records in the old format, and echoes each line", () => {
    const { log, file, echoed } = shell();
    const logger = log.logger("innytypes.shell", 42);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(file.map((line) => line.slice(24))).toEqual([
      "DEBUG        42 innytypes.shell: d\n",
      "INFO         42 innytypes.shell: i\n",
      "WARNING      42 innytypes.shell: w\n",
      "ERROR        42 innytypes.shell: e\n",
    ]);
    expect(echoed).toEqual(file);
  });

  it("drops records below its level and keeps the rest", () => {
    const { log, text, feed } = shell({ level: LEVELS.WARNING });
    const logger = log.logger("innytypes.shell", 1);
    logger.debug("debug-line");
    logger.info("info-line");
    logger.warn("warn-line");
    feed(
      "runtime",
      "stdout",
      encodeRecord({ time: NOW, level: "INFO", pid: 7, name: "n", msg: "child-info" }).trimEnd(),
    );
    feed("runtime", "stderr", "child-stderr");
    expect(text()).not.toContain("debug-line");
    expect(text()).not.toContain("info-line");
    expect(text()).not.toContain("child-info");
    expect(text()).toContain("warn-line");
    expect(text()).toContain("child-stderr");
  });

  it("redacts a registered secret in its own records and in the name", () => {
    const { log, text } = shell();
    const logger = log.logger(`innytypes.${KEY}`, 1);
    logger.protect(KEY);
    logger.error(`failed with ${KEY}`);
    expect(text()).not.toContain(KEY);
    expect(text()).toContain(`innytypes.${REDACTED}: failed with ${REDACTED}`);
  });

  it("appends a child's record with the child's own pid, level and name", () => {
    const { feed, file } = shell();
    const record = {
      time: NOW,
      level: "WARNING" as const,
      pid: 4242,
      name: "innytypes.services",
      msg: "m",
    };
    feed("services", "stdout", encodeRecord(record).trimEnd());
    expect(file).toHaveLength(1);
    expect(file[0]?.slice(24)).toBe("WARNING    4242 innytypes.services: m\n");
  });

  it("redacts a child's record again in the shell, whatever the child did", () => {
    const { log, feed, text } = shell();
    log.protect(KEY);
    feed(
      "runtime",
      "stdout",
      encodeRecord({ time: NOW, level: "INFO", pid: 7, name: "n", msg: `k=${KEY}` }).trimEnd(),
    );
    feed("runtime", "stderr", `k=${KEY}`);
    feed("runtime", "stdout", `printed k=${KEY}`);
    expect(text()).not.toContain(KEY);
    expect(text().split(REDACTED)).toHaveLength(4);
  });

  it("learns a child's credential from its protect line, and never writes that line", () => {
    const { feed, text, file } = shell();
    const source = child();
    source.log.protect(KEY);
    source.log.info("before the shell could know");
    for (const line of source.written) {
      feed("runtime", "stdout", line.trimEnd());
    }
    // A line the child printed outside its log, which the child could not redact.
    feed("runtime", "stdout", `console.log(${KEY})`);
    expect(file).toHaveLength(2);
    expect(text()).not.toContain(KEY);
    expect(text()).toContain(`console.log(${REDACTED})`);
  });

  it("writes stderr at STDERR and a non-record stdout line at stdout, named after the child", () => {
    const { feed, file } = shell();
    feed("runtime", "stderr", "cannot read /Volumes/x");
    feed("runtime", "stdout", "watching /Volumes");
    feed("runtime", "stdout", "");
    expect(file.map((line) => line.slice(24))).toEqual([
      "STDERR       99 innytypes.runtime: cannot read /Volumes/x\n",
      "stdout       99 innytypes.runtime: watching /Volumes\n",
    ]);
  });

  it("cuts an enormous printed line, and reads a cut record as printed text", () => {
    const { feed, file } = shell();
    feed("runtime", "stderr", "x".repeat(MAX_OUTPUT_LINE * 10));
    feed(
      "runtime",
      "stdout",
      encodeRecord({ time: NOW, level: "INFO", pid: 7, name: "n", msg: "m" }).slice(0, 20),
      true,
    );
    expect(file[0]?.endsWith(`${"x".repeat(10)}${TRUNCATED}\n`)).toBe(true);
    expect(file[0]?.length).toBeLessThan(MAX_OUTPUT_LINE + 100);
    expect(file[1]).toContain(" stdout ");
    expect(file[1]).toContain('{"t":"log"');
  });

  it("redacts before it cuts, so no half of a credential is left at the cut", () => {
    const { log, feed, text } = shell();
    log.protect(KEY);
    feed("runtime", "stderr", `${"x".repeat(MAX_OUTPUT_LINE - 10)}${KEY}`);
    expect(text()).not.toContain(KEY.slice(0, 10));
  });

  it("opens with which process, which file and which level, and says a bad level first", () => {
    const { log, file } = shell({ level: LEVELS.DEBUG });
    log.announce({
      role: "shell",
      pid: 5,
      destination: "/l/innytypes.log",
      levelProblem: "'chatty' is not a logging level",
    });
    expect(file.map((line) => line.slice(24))).toEqual([
      "WARNING       5 innytypes.logs: 'chatty' is not a logging level; logging at DEBUG instead\n",
      "INFO          5 innytypes.logs: innytypes shell (process 5) is logging to /l/innytypes.log at DEBUG\n",
    ]);
  });

  it("with no file, still runs and still echoes", () => {
    const echoed: string[] = [];
    const log = new OneLog({
      registry: new SecretRegistry(),
      level: LEVELS.DEBUG,
      file: null,
      echo: (line) => echoed.push(line),
      now: () => NOW,
    });
    log.announce({ role: "shell", pid: 5, destination: null, levelProblem: null });
    expect(echoed[0]).toContain("is logging to nowhere at DEBUG");
  });
});

describe("the source log, a child's side", () => {
  it("writes each record as one wire line with its name and pid", () => {
    const { log, written } = child();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(written.map((line) => JSON.parse(line) as unknown)).toEqual(
      (["DEBUG", "INFO", "WARNING", "ERROR"] as const).map((level, index) => ({
        t: "log",
        time: NOW,
        level,
        pid: 7,
        name: "innytypes.runtime",
        msg: "diwe"[index],
      })),
    );
  });

  it("redacts at the source, before the line leaves the process", () => {
    const { log, written } = child();
    log.protect(KEY);
    log.info(`key ${KEY}`);
    log.nodeLine({ type: "diarize", instance: "n1" }, "STDERR", `key ${KEY}`);
    const records = written.slice(1).join("");
    expect(records).not.toContain(KEY);
    expect(records).toContain(`key ${REDACTED}`);
  });

  it("tells the shell a credential once, on the same pipe, ahead of the lines", () => {
    const { log, written } = child();
    log.protect(KEY);
    log.protect(KEY);
    log.protect("");
    expect(written).toEqual([`${JSON.stringify({ t: "protect", secret: KEY })}\n`]);
  });

  it("tags a node's lines with its type and instance, at the spec's levels", () => {
    const { log, written } = child();
    const source = { type: "diarize", instance: "a1b2" };
    log.nodeLine(source, "STDERR", "stderr line");
    log.nodeLine(source, "stdout", "not a frame");
    log.nodeLine(source, "debug", "d");
    log.nodeLine(source, "info", "i");
    log.nodeLine(source, "warn", "w");
    log.nodeLine(source, "error", "e");
    const records = written.map((line) => JSON.parse(line) as { level: string; name: string });
    expect(records.map((record) => record.level)).toEqual([
      "STDERR",
      "stdout",
      "DEBUG",
      "INFO",
      "WARNING",
      "ERROR",
    ]);
    expect(new Set(records.map((record) => record.name))).toEqual(
      new Set([nodeLoggerName(source)]),
    );
    expect(nodeLoggerName(source)).toBe("innytypes.node.diarize.a1b2");
  });

  it("cuts an enormous node stderr line at the source", () => {
    const { log, written } = child();
    log.nodeLine({ type: "t", instance: "i" }, "STDERR", "y".repeat(MAX_OUTPUT_LINE * 5));
    const msg = (JSON.parse(written[0] ?? "") as { msg: string }).msg;
    expect(msg).toBe(`${"y".repeat(MAX_OUTPUT_LINE)}${TRUNCATED}`);
  });

  it("keeps running when the pipe to the shell is gone", () => {
    const log = sourceLog({
      name: "innytypes.runtime",
      pid: 1,
      write: () => {
        throw new Error("EPIPE");
      },
      now: () => NOW,
    });
    expect(() => {
      log.info("nobody hears this");
      log.protect(KEY);
    }).not.toThrow();
  });

  it("prints the canary registered, and prints nothing when there is none", () => {
    const { log, written } = child();
    printCanary(log, undefined);
    printCanary(log, "");
    expect(written).toEqual([]);
    printCanary(log, KEY);
    expect(written).toHaveLength(2);
    expect(written.join("")).toContain(`log canary: ${REDACTED}`);
    expect(written[1]).not.toContain(KEY);
  });
});

describe("Node-RED's log", () => {
  function routed() {
    const lines: string[] = [];
    const logger: LeveledLogger = {
      debug: (m) => lines.push(`DEBUG ${m}`),
      info: (m) => lines.push(`INFO ${m}`),
      warn: (m) => lines.push(`WARN ${m}`),
      error: (m) => lines.push(`ERROR ${m}`),
    };
    return { lines, settings: nodeRedLogging(logger) };
  }

  it("is one custom handler and no console logger", () => {
    const { settings } = routed();
    expect(Object.keys(settings)).toEqual(["innytypes"]);
    expect(settings.innytypes).toMatchObject({ level: "debug", metrics: false, audit: false });
  });

  it("routes each Node-RED level to the one log's, tagging a node's lines", () => {
    const { lines, settings } = routed();
    const write = settings.innytypes.handler();
    write({ level: 10, msg: "gone" });
    write({ level: 20, msg: new Error("boom") });
    write({ level: 30, msg: "careful", type: "inject", id: "n1" });
    write({ level: 40, msg: "Started flows", type: "debug", name: "tap" });
    write({ level: 50, msg: { a: 1 } });
    write({ level: 60, msg: "trace" });
    write({ level: 40, msg: "no id", type: "t" });
    expect(lines[0]).toBe("ERROR fatal: gone");
    expect(lines[1]).toMatch(/^ERROR Error: boom/);
    expect(lines.slice(2)).toEqual([
      "WARN [inject:n1] careful",
      "INFO [debug:tap] Started flows",
      'DEBUG {"a":1}',
      "DEBUG trace",
      "INFO [t:] no id",
    ]);
  });

  it("uses the message of an error with no stack", () => {
    const { lines, settings } = routed();
    const error = new Error("plain");
    error.stack = undefined as unknown as string;
    delete error.stack;
    settings.innytypes.handler()({ level: 20, msg: error });
    expect(lines).toEqual(["ERROR plain"]);
  });
});
