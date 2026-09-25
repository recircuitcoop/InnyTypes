// adapters/sqlite/journal.ts on a real file: WAL, the store's contract, and a reopen.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openSqliteJournal, type SqliteJournal } from "../../src/adapters/sqlite/journal";
import { newEntry, presented, type JournalEntry } from "../../src/domain/journal/entry";

const opened: SqliteJournal[] = [];
const dirs: string[] = [];

function scratchFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inny-journal-"));
  dirs.push(dir);
  return path.join(dir, "journal.sqlite");
}

function open(file: string): SqliteJournal {
  const journal = openSqliteJournal(file);
  opened.push(journal);
  return journal;
}

function entry(inputId: string, instanceId = "n1"): JournalEntry {
  return newEntry({
    inputId,
    instanceId,
    type: "inny-pkg-t",
    message: { payload: { id: inputId }, topic: "pkg.t.v1", _msgid: `m-${inputId}` },
    now: 1,
  });
}

afterEach(() => {
  for (const journal of opened.splice(0)) {
    journal.close();
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the SQLite journal", () => {
  it("is in WAL mode, and says which SQLite it is", () => {
    const file = scratchFile();
    const journal = open(file);
    journal.put(entry("a"));
    expect(journal.file).toBe(file);
    expect(journal.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
    expect(fs.existsSync(`${file}-wal`)).toBe(true);
    const other = new DatabaseSync(file);
    expect(other.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    other.close();
  });

  it("puts, gets, replaces in place, clears, and lists oldest first by instance", () => {
    const journal = open(scratchFile());
    journal.put(entry("a"));
    journal.put(entry("b", "n2"));
    journal.put(entry("c"));
    journal.put(presented(entry("a"), { title: "wait" }, 5)); // replaced, keeps its place
    expect(journal.get("a")).toMatchObject({ state: "awaiting", content: { title: "wait" } });
    expect(journal.get("nope")).toBeNull();
    expect(journal.all().map((e) => e.inputId)).toEqual(["a", "b", "c"]);
    expect(journal.forInstance("n1").map((e) => e.inputId)).toEqual(["a", "c"]);
    journal.clear("a");
    journal.clear("a"); // a missing entry is not an error
    expect(journal.all().map((e) => e.inputId)).toEqual(["b", "c"]);
  });

  it("keeps every entry across a close and a reopen", () => {
    const file = scratchFile();
    const first = open(file);
    first.put(entry("a"));
    first.put(entry("b"));
    first.clear("a");
    first.close();
    first.close(); // twice is harmless
    expect(open(file).all()).toEqual([entry("b")]);
  });

  it("fails loudly on a row that is not an entry, never skipping it", () => {
    const file = scratchFile();
    open(file).put(entry("a"));
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE journal SET body = ? WHERE input_id = 'a'").run('{"inputId":"a"}');
    raw.close();
    const journal = open(file);
    expect(() => journal.all()).toThrow(/a row that is not an entry/);
    expect(() => journal.get("a")).toThrow(/a row that is not an entry/);
  });

  it("refuses a database that cannot use WAL", () => {
    expect(() => openSqliteJournal(":memory:")).toThrow(/could not use WAL mode/);
  });
});
