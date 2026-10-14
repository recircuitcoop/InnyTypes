// The folder source's watcher (packages/folder/src/watcher.ts, WI-0022-25) in process, time
// driven through scan(now): a file is remembered only once its emit succeeded, one file's failed
// emit does not stop the others, and a file whose emit failed is passed on after a restart.

import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FolderWatcher,
  passOn,
  QUIET_MS,
  SEEN_FILE,
  type CreatedFile,
} from "../../../packages/folder/src/watcher";

const scratches: string[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

/** A watched folder and a data folder, both empty. */
function instance(): { folder: string; dataDir: string } {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-watcher-")));
  scratches.push(scratch);
  const folder = path.join(scratch, "watched");
  const dataDir = path.join(scratch, "data");
  fs.mkdirSync(folder);
  fs.mkdirSync(dataDir);
  return { folder, dataDir };
}

/** The names `seen.json` holds. */
function recorded(dataDir: string): string[] {
  const document = JSON.parse(fs.readFileSync(path.join(dataDir, SEEN_FILE), "utf8")) as {
    files: Record<string, unknown>;
  };
  return Object.keys(document.files).sort();
}

/** Scan at `start`, then once the quiet period is over: what the second scan offers. */
function offeredAfterQuiet(watcher: FolderWatcher, start: number): CreatedFile[] {
  expect(watcher.scan(start)).toEqual([]);
  return watcher.scan(start + QUIET_MS) ?? [];
}

/** A send that throws for one name, as the SDK's emit throws for a frame too large. */
function failingFor(name: string, sent: string[]) {
  return (_port: string, data: CreatedFile): void => {
    if (data.name === name) {
      throw new Error("frame too large");
    }
    sent.push(data.name);
  };
}

describe("packages/folder watcher: remembered only once passed on", () => {
  it("a failed emit for one file leaves it unrecorded and offered again; the others are passed on and recorded", () => {
    const { folder, dataDir } = instance();
    const watcher = new FolderWatcher({ folder }, dataDir);
    expect(watcher.scan(0)).toEqual([]); // the first run's baseline: empty
    expect(watcher.persist()).toBeNull();
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      fs.writeFileSync(path.join(folder, name), name);
    }

    const sent: string[] = [];
    const offered = offeredAfterQuiet(watcher, 1_000);
    expect(offered.map((file) => file.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
    const failed = passOn(watcher, offered, failingFor("b.txt", sent));
    expect(sent).toEqual(["a.txt", "c.txt"]);
    expect(failed).toEqual([{ name: "b.txt", reason: "frame too large" }]);
    expect(watcher.persist()).toBeNull();
    expect(recorded(dataDir)).toEqual(["a.txt", "c.txt"]);

    // The next scan offers only b.txt, at once (it was quiet already); this time it goes.
    const again = watcher.scan(1_000 + QUIET_MS + 500) ?? [];
    expect(again.map((file) => file.name)).toEqual(["b.txt"]);
    expect(passOn(watcher, again, failingFor("none", sent))).toEqual([]);
    expect(watcher.persist()).toBeNull();
    expect(sent).toEqual(["a.txt", "c.txt", "b.txt"]);
    expect(recorded(dataDir)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(watcher.scan(1_000 + QUIET_MS + 1_000)).toEqual([]);
  });

  it("a file whose emit failed before a restart is passed on by the next process", () => {
    const { folder, dataDir } = instance();
    const first = new FolderWatcher({ folder }, dataDir);
    expect(first.scan(0)).toEqual([]);
    fs.writeFileSync(path.join(folder, "a.txt"), "A");
    fs.writeFileSync(path.join(folder, "b.txt"), "B");
    const sent: string[] = [];
    passOn(first, offeredAfterQuiet(first, 1_000), failingFor("b.txt", sent));
    expect(first.persist()).toBeNull();
    expect(recorded(dataDir)).toEqual(["a.txt"]);

    // A second process for the same instance: b.txt is new to it, a.txt is not.
    const second = new FolderWatcher({ folder }, dataDir);
    const offered = offeredAfterQuiet(second, 10_000);
    expect(offered.map((file) => file.name)).toEqual(["b.txt"]);
    passOn(second, offered, failingFor("none", sent));
    expect(second.persist()).toBeNull();
    expect(sent).toEqual(["a.txt", "b.txt"]);
    expect(recorded(dataDir)).toEqual(["a.txt", "b.txt"]);
  });
});
