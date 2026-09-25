// The journal survives kill -9 at any point (spec 7.1, WI-0018-07): a property test.
//
// A worker writes to the SQLite journal as the runtime does (put, present, clear) and is
// killed with SIGKILL after a random delay, again and again on the same file. After every
// kill the file is reopened and checked against what the worker said had RETURNED: nothing
// that returned is lost or undone, nothing is duplicated, nothing appears that was never
// written, and the one operation in flight at the kill is either wholly there or wholly not.
//
// What this does not prove: power loss. A killed process loses nothing the kernel already
// has; surviving a power cut is what `synchronous = FULL` and `fullfsync` are for, and no
// test here pulls the plug.
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSqliteJournal } from "../../src/adapters/sqlite/journal";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUNDS = 25;

let scratch = "";
let worker = "";

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-journal-kill-"));
  worker = path.join(scratch, "worker.cjs");
  buildSync({
    entryPoints: [path.join(HERE, "..", "fixtures", "journal-worker", "worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: worker,
    logLevel: "warning",
  });
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A small seeded generator, so a failing run can be repeated from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Expected = "sent" | "awaiting";

/** Run the worker until killed after `delayMs` (counted from its "open"); return its lines. */
async function runAndKill(file: string, prefix: string, delayMs: number): Promise<string[]> {
  const child = spawn(process.execPath, [worker, file, prefix, "0"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      resolve();
    }),
  );
  child.stdout.on("data", (chunk: string) => {
    const opened = !out.includes("open\n") && (out + chunk).includes("open\n");
    out += chunk;
    if (opened) {
      setTimeout(() => child.kill("SIGKILL"), delayMs);
    }
  });
  await exited;
  return out.split("\n").filter((line) => line !== "");
}

describe("the SQLite journal under kill -9", () => {
  it(
    `loses, duplicates and invents nothing across ${String(ROUNDS)} kills at random points`,
    { timeout: 120_000 },
    async () => {
      const seed = Date.now() % 1_000_000;
      const next = random(seed);
      const file = path.join(scratch, "journal.sqlite");
      // What must be in the file: every returned operation, applied in order.
      const expected = new Map<string, Expected>();
      let operations = 0;

      for (let round = 0; round < ROUNDS; round += 1) {
        const delayMs = Math.floor(next() * 120);
        const lines = await runAndKill(file, `r${String(round)}`, delayMs);
        // The operation begun but not returned: in flight at the kill.
        let inFlight: { op: string; id: string } | null = null;
        for (const line of lines.slice(1)) {
          const [phase, op, id] = line.split(" ") as [string, string, string];
          if (phase === "begin") {
            inFlight = { op, id };
            continue;
          }
          inFlight = null;
          operations += 1;
          if (op === "clear") {
            expected.delete(id);
          } else {
            expected.set(id, op === "present" ? "awaiting" : "sent");
          }
        }

        const journal = openSqliteJournal(file);
        const entries = journal.all();
        journal.close();
        const context = `seed ${String(seed)}, round ${String(round)}, killed after ${String(delayMs)} ms`;

        const ids = entries.map((entry) => entry.inputId);
        expect(new Set(ids).size, `duplicates (${context})`).toBe(ids.length);
        const found = new Map(entries.map((entry) => [entry.inputId, entry.state]));
        for (const [id, state] of expected) {
          const inFlightOnIt = inFlight?.id === id;
          if (inFlightOnIt && inFlight?.op === "clear") {
            // Cleared or not: both are whole outcomes. Anything present must be intact.
            expect([undefined, state], `${id} (${context})`).toContain(found.get(id));
          } else if (inFlightOnIt && inFlight?.op === "present") {
            expect(["sent", "awaiting"], `${id} (${context})`).toContain(found.get(id));
          } else {
            expect(found.get(id), `${id} lost or changed (${context})`).toBe(state);
          }
        }
        for (const id of found.keys()) {
          const known = expected.has(id) || (inFlight?.op === "put" && inFlight.id === id);
          expect(known, `${id} was never written (${context})`).toBe(true);
        }
        // Carry the file's truth forward for the in-flight operation, now that it is known.
        if (inFlight !== null) {
          const state = found.get(inFlight.id);
          if (state === undefined) {
            expected.delete(inFlight.id);
          } else {
            expected.set(inFlight.id, state);
          }
        }
        expect(found.size, `entries (${context})`).toBe(expected.size);
      }
      // The property means something only if the worker got real work done between kills.
      expect(operations).toBeGreaterThan(ROUNDS * 3);
    },
  );
});
