// adapters/sqlite/snapshots.ts: snapshots kept across a reopen (a restart), a missing one is
// null, and a row that is not a snapshot fails loudly rather than being skipped.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { openSqliteSnapshots } from "../../src/adapters/sqlite/snapshots";
import type { SnapshotRecord } from "../../src/domain/views/views";

let scratch: string;
let file: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inny-snapshots-"));
  file = path.join(scratch, "snapshots.sqlite");
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const record: SnapshotRecord = {
  id: "s1",
  instanceId: "rec",
  type: "inny-viewpy-record",
  label: "Record",
  time: 5,
  content: { title: "t" },
  state: { n: 1 },
  window: "inline",
  actions: [{ id: "again", label: "Run again", event: "viewpy.again.v1" }],
};

it("keeps a snapshot across a reopen, and answers null for one it never had", () => {
  const store = openSqliteSnapshots(file);
  store.put(record);
  store.close();
  store.close(); // a second close is harmless
  const reopened = openSqliteSnapshots(file);
  expect(reopened.get("s1")).toEqual(record);
  expect(reopened.get("s2")).toBeNull();
  reopened.close();
});

it("fails loudly on a row that is not a snapshot", () => {
  openSqliteSnapshots(file).close();
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO snapshots (id, instance_id, body) VALUES (?, ?, ?)").run(
    "bad",
    "rec",
    JSON.stringify({ id: "bad" }),
  );
  db.close();
  const store = openSqliteSnapshots(file);
  expect(() => store.get("bad")).toThrow("the snapshot store holds a row that is not a snapshot");
  store.close();
});

it("lists the newest records first, as many as asked for (the Snapshots page)", () => {
  const store = openSqliteSnapshots(file);
  for (const id of ["s1", "s2", "s3"]) {
    store.put({ ...record, id });
  }
  expect(store.list(2).map((kept) => kept.id)).toEqual(["s3", "s2"]);
  expect(store.list(10)).toHaveLength(3);
  store.close();
});
