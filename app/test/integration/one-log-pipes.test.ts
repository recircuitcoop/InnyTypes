// The one log across a real process boundary (WI-0018-04), without Electron: a child running
// the production source log (test/fixtures/log-child.ts) writes to a real pipe and is killed
// with SIGKILL; the shell's production ingestion reads the pipe to its end into a real file.
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RotatingLogFile } from "../../src/adapters/fs/log-writer";
import { OneLog } from "../../src/application/one-log";
import { forEachLine } from "../../src/domain/logging/lines";
import { LEVELS } from "../../src/domain/logging/record";
import { REDACTED, SecretRegistry } from "../../src/domain/redaction/registry";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "log-child.ts",
);
const CREDENTIAL = "fake-node-credential-canary-86420";

let scratch = "";
let bundle = "";

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-one-log-"));
  bundle = path.join(scratch, "log-child.cjs");
  buildSync({
    entryPoints: [FIXTURE],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "warning",
  });
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Run the fixture to its SIGKILL, ingesting its stdout; resolve once the pipe has ended. */
async function runChild(lines: number, file: string) {
  const log = RotatingLogFile.open(file);
  const shell = new OneLog({
    registry: new SecretRegistry(),
    level: LEVELS.DEBUG,
    file: log,
    now: () => Date.now(),
  });
  const child = spawn(process.execPath, [bundle, CREDENTIAL, String(lines)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const ended = (stream: NodeJS.ReadableStream) =>
    new Promise<void>((resolve) => stream.once("end", resolve));
  const stdoutEnded = ended(child.stdout);
  const stderrEnded = ended(child.stderr);
  forEachLine(child.stdout, (line) => {
    shell.ingest("runtime", child.pid ?? null, "stdout", line);
  });
  forEachLine(child.stderr, (line) => {
    shell.ingest("runtime", child.pid ?? null, "stderr", line);
  });
  const signal = await new Promise<NodeJS.Signals | null>((resolve) =>
    child.once("exit", (_code, killedBy) => {
      resolve(killedBy);
    }),
  );
  await Promise.all([stdoutEnded, stderrEnded]);
  log?.close();
  return { signal, text: fs.readFileSync(file, "utf8") };
}

describe("the one log across a real pipe", () => {
  it("keeps every line a child wrote just before its kill -9, the last one included", async () => {
    // Far more than a pipe holds (64 KiB on macOS and Linux): most of it is still in the pipe
    // when the child dies, and must be read after its death.
    const lines = 3000;
    const { signal, text } = await runChild(lines, path.join(scratch, "burst.log"));
    expect(signal).toBe("SIGKILL");
    const burst = text.split("\n").filter((line) => line.includes("burst line"));
    expect(burst).toHaveLength(lines);
    expect(burst.at(-1)).toContain(`burst line ${String(lines - 1)} `);
    expect(burst.at(-1)).toMatch(/ INFO +\d+ innytypes\.runtime: /);
  }, 30_000);

  it("writes a node's stderr at STDERR, tagged with its type and instance, the credential redacted twice over", async () => {
    const { text } = await runChild(1, path.join(scratch, "node.log"));
    const stderr = text.split("\n").filter((line) => line.includes("the node was started with"));
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/ STDERR +\d+ innytypes\.node\.fake-node\.n1: the node was started /);
    expect(stderr[0]?.endsWith(`the node was started with ${REDACTED}`)).toBe(true);
    expect(text).not.toContain(CREDENTIAL);
  }, 30_000);
});
