// The run records on a real journal.sqlite (plan 0022 §C, decision D15; acceptance
// "run-records.test.ts"): written in the journal's own transaction, migrated additively from a
// 0.2.1 journal with its pre-0.3.0 copy, listed newest first a page at a time, and pruned by
// retention without ever touching a run in progress.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { JsonSettingsStore } from "../../src/adapters/fs/settings-store";
import { openSqliteJournal, type SqliteJournal } from "../../src/adapters/sqlite/journal";
import { preMigrationCopy } from "../../src/adapters/sqlite/migrate";
import { MAX_KEPT_MESSAGE_BYTES } from "../../src/adapters/sqlite/run-rows";
import { InputJournal } from "../../src/adapters/process/input-journal";
import { DAY_MS, RunService, SETTLE_MS } from "../../src/application/runs";
import { DEFAULT_QUEUE } from "../../src/domain/journal/queue";
import { newEntry, presented, submitted, type JournalEntry } from "../../src/domain/journal/entry";
import type { RunKey } from "../../src/domain/runs/run";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

const opened: SqliteJournal[] = [];
const dirs: string[] = [];

function scratchFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inny-runs-"));
  dirs.push(dir);
  return path.join(dir, "journal.sqlite");
}

function open(file: string, problems: string[] = []): SqliteJournal {
  const journal = openSqliteJournal(file, { problem: (message) => problems.push(message) });
  opened.push(journal);
  return journal;
}

/** An input of run `run`, journaled for instance `instanceId` of flow `flowId` at `now`. */
function entry(
  inputId: string,
  run: string,
  options: { instanceId?: string; flowId?: string; now?: number; payload?: unknown } = {},
): JournalEntry {
  const { instanceId = "n1", flowId = "tab1", now = 1_000 } = options;
  const payload = "payload" in options ? options.payload : { id: inputId };
  return newEntry({
    inputId,
    instanceId,
    flowId,
    type: "inny-pkg-t",
    message: { payload, topic: "pkg.t.v1", inny: { run }, _msgid: `m-${inputId}` },
    now,
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

describe("a crash between journal and record is impossible", () => {
  it("a failing run statement rolls the journal row back with it, on put and on clear", () => {
    const file = scratchFile();
    const journal = open(file);
    // A second connection makes the run tables' next write fail, as a full disk would.
    const saboteur = new DatabaseSync(file);
    saboteur.exec(
      "CREATE TRIGGER no_steps BEFORE INSERT ON run_steps BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    expect(() => {
      journal.put(entry("in-1", "run-1"), { kind: "journaled", name: "Transcribe", at: 1_000 });
    }).toThrow(/disk full/);
    expect(journal.get("in-1")).toBeNull();
    expect(journal.run("run-1")).toBeNull();

    saboteur.exec("DROP TRIGGER no_steps");
    journal.put(entry("in-1", "run-1"), { kind: "journaled", name: "Transcribe", at: 1_000 });
    expect(journal.get("in-1")).not.toBeNull();
    expect(journal.run("run-1")?.steps).toHaveLength(1);

    saboteur.exec(
      "CREATE TRIGGER no_ends BEFORE UPDATE ON run_steps BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    expect(() => {
      journal.clear("in-1", { kind: "done", at: 2_000 });
    }).toThrow(/disk full/);
    // Neither moved: the entry is still in hand, and its step is still open.
    expect(journal.get("in-1")).not.toBeNull();
    expect(journal.run("run-1")?.steps[0]?.endedAt).toBeNull();
    saboteur.close();
  });

  it("every journal write path lands in the run, in the same commit, and survives a reopen", () => {
    const file = scratchFile();
    const problems: string[] = [];
    const journal = open(file, problems);
    const heard: RunKey[] = [];
    journal.onChange((key) => heard.push(key));

    journal.started({ flowId: "tab1", runId: "run-1", title: "Weekly sync", at: 500 });
    const first = entry("in-1", "run-1");
    journal.put(first, { kind: "journaled", name: "Transcribe", at: 1_000 });
    journal.stepStatuses([
      {
        inputId: "in-1",
        status: { text: "in Renaissance", progress: { done: 1, total: 3 } },
        at: 1_100,
      },
    ]);
    journal.clear("in-1", {
      kind: "done",
      outcome: {
        notes: [
          { level: "note", text: "Two speakers" },
          { level: "warning", text: "Low volume" },
        ],
        results: [
          {
            kind: "anytype",
            text: "Meeting notes → Renaissance",
            anytype: { spaceId: "s1", objectId: "o1" },
          },
          { kind: "file", text: "Moved recording", folder: "/tmp/archive" },
        ],
      },
      at: 1_500,
    });

    const ask = entry("in-2", "run-1", { instanceId: "v1", now: 1_600 });
    journal.put(ask, { kind: "journaled", name: "Who spoke?", at: 1_600 });
    const asked = presented(ask, { title: "Who spoke?" }, 1_700);
    journal.put(asked, { kind: "presented", question: "Who spoke?", at: 1_700 });
    expect(journal.run("run-1")).toMatchObject({ state: "waiting" });
    journal.put(submitted(asked, 1_800), { kind: "submitted", at: 1_800 });
    expect(journal.run("run-1")).toMatchObject({ state: "running" });
    journal.put(asked, { kind: "resent", name: "Who spoke?", at: 1_850 });
    expect(journal.run("run-1")).toMatchObject({ resumed: true });
    journal.clear("in-2", { kind: "done", at: 1_900 });
    expect(journal.settle("run-1", 2_000)).toBe(true);
    expect(journal.settle("run-1", 2_100)).toBe(false); // done: nothing more to settle

    const failing = entry("in-3", "run-2", { now: 3_000 });
    journal.put(failing, { kind: "journaled", name: "Upload", at: 3_000 });
    journal.clear("in-3", { kind: "failed", reason: "cancelled from the Jobs page", at: 3_100 });

    journal.close();
    const again = open(file);
    const run = again.run("run-1");
    expect(run).toMatchObject({
      flowId: "tab1",
      title: "Weekly sync",
      state: "done",
      startedAt: new Date(500),
      endedAt: new Date(2_000),
      notes: [{ step: "Transcribe", text: "Two speakers" }],
      warnings: [{ step: "Transcribe", text: "Low volume" }],
      results: [
        {
          step: "Transcribe",
          sink: "anytype",
          anytype: { spaceId: "s1", objectId: "o1" },
          folder: null,
        },
        { step: "Transcribe", sink: "file", folder: "/tmp/archive", anytype: null },
      ],
    });
    expect(run?.steps).toMatchObject([
      {
        name: "Transcribe",
        state: "done",
        statusText: "in Renaissance",
        progress: { done: 1, total: 3 },
      },
      { name: "Who spoke?", state: "done", question: "Who spoke?" },
    ]);
    expect(again.run("run-2")).toMatchObject({
      state: "failed",
      failure: { step: "Upload", instanceId: "n1", text: "cancelled from the Jobs page" },
    });
    expect(heard.map((key) => key.runId)).toContain("run-2");
    expect(problems).toEqual([]);
  });

  it("an event the fold refuses keeps the run as it was and never fails the journal write", () => {
    const problems: string[] = [];
    const journal = open(scratchFile(), problems);
    const step = entry("in-1", "run-1");
    journal.put(step, { kind: "journaled", name: "Transcribe", at: 1_000 });
    // Nothing waits: a submission is not a transition this run can make.
    journal.put(submitted(step, 1_100), { kind: "submitted", at: 1_100 });
    expect(journal.get("in-1")).not.toBeNull();
    expect(journal.run("run-1")?.steps[0]?.state).toBe("running");
    expect(problems.join("\n")).toMatch(/run run-1 kept as it was/);
    // A step of a run with no record cannot end it.
    journal.clear("ghost", { kind: "done", at: 1 });
    journal.put(entry("in-9", "run-9"), { kind: "done", at: 1 });
    expect(problems.join("\n")).toMatch(/run run-9 has no record/);
  });

  it("keeps a step's input message for re-runs, up to 1 MiB", () => {
    const file = scratchFile();
    const journal = open(file);
    journal.put(entry("small", "r1"), { kind: "journaled", name: "A", at: 1 });
    const huge = "x".repeat(MAX_KEPT_MESSAGE_BYTES);
    journal.put(entry("huge", "r2", { payload: huge }), { kind: "journaled", name: "A", at: 1 });
    const db = new DatabaseSync(file);
    const kept = db.prepare("SELECT input_id, message FROM run_steps ORDER BY input_id").all();
    db.close();
    expect(kept).toEqual([
      { input_id: "huge", message: null },
      {
        input_id: "small",
        message: JSON.stringify({
          payload: { id: "small" },
          topic: "pkg.t.v1",
          inny: { run: "r1" },
          _msgid: "m-small",
        }),
      },
    ]);
  });
});

describe("additive migration (0.2.1 fixture database)", () => {
  /** A journal exactly as 0.2.1 wrote it: one table, user_version 0, entries with no flow. */
  function journal021(file: string): Record<string, string> {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        input_id    TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        body        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_instance ON journal (instance_id);
    `);
    const sent = newEntry({
      inputId: "in-sent",
      instanceId: "n1",
      type: "inny-pkg-t",
      message: { payload: 1, topic: "pkg.t.v1", inny: { run: "run-a" } },
      now: 10,
    });
    const waiting = presented(
      newEntry({
        inputId: "in-wait",
        instanceId: "v1",
        type: "inny-pkg-ask",
        message: { payload: 2, topic: "pkg.t.v1", inny: { run: "run-b" } },
        now: 20,
      }),
      { title: "Which project?" },
      30,
    );
    const bodies: Record<string, string> = {};
    for (const row of [sent, waiting]) {
      bodies[row.inputId] = JSON.stringify(row);
      db.prepare("INSERT INTO journal (input_id, instance_id, body) VALUES (?, ?, ?)").run(
        row.inputId,
        row.instanceId,
        bodies[row.inputId] ?? "",
      );
    }
    db.close();
    return bodies;
  }

  const version = (file: string): number => {
    const db = new DatabaseSync(file);
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    db.close();
    return tables.length * 100 + row.user_version;
  };

  it("copies the 0.2.1 journal first, adds only, and copies its entries into runs", () => {
    const file = scratchFile();
    const bodies = journal021(file);
    const journal = open(file);

    // The copy is the 0.2.1 file as it was: one table, version 0, both rows.
    const copy = new DatabaseSync(preMigrationCopy(file));
    expect(copy.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
      { name: "journal" },
    ]);
    expect(copy.prepare("SELECT count(*) AS n FROM journal").get()).toEqual({ n: 2 });
    copy.close();

    // The journal's rows are byte-for-byte what 0.2.1 wrote; four tables now, version 1.
    const db = new DatabaseSync(file);
    const rows = db.prepare("SELECT input_id, body FROM journal ORDER BY rowid").all();
    db.close();
    expect(rows).toEqual([
      { input_id: "in-sent", body: bodies["in-sent"] },
      { input_id: "in-wait", body: bodies["in-wait"] },
    ]);
    expect(version(file)).toBe(401);
    expect(journal.all().map((e) => e.inputId)).toEqual(["in-sent", "in-wait"]);

    // The pre-0.3.0 copy into runs: running, and waiting on its view's question.
    expect(journal.run("run-a")).toMatchObject({ flowId: "", state: "running" });
    expect(journal.run("run-b")).toMatchObject({
      state: "waiting",
      steps: [{ instanceId: "v1", state: "waiting", question: "Which project?", name: "" }],
    });

    // Re-sent by an instance that knows its flow and name: the blanks are filled in.
    const old = journal.get("in-wait");
    if (old === null) {
      throw new Error("the waiting entry is gone");
    }
    journal.put({ ...old, flowId: "tab7" }, { kind: "resent", name: "Ask", at: 40 });
    expect(journal.run("run-b")).toMatchObject({
      flowId: "tab7",
      resumed: true,
      steps: [{ name: "Ask", state: "waiting" }],
    });
  });

  it("migrates once: a second open copies nothing again and duplicates nothing", () => {
    const file = scratchFile();
    journal021(file);
    open(file).close();
    const copied = fs.statSync(preMigrationCopy(file)).mtimeMs;
    const again = open(file);
    expect(fs.statSync(preMigrationCopy(file)).mtimeMs).toBe(copied);
    expect(again.list({ flowId: "", limit: 10 }).runs.map((run) => run.runId)).toEqual([
      "run-b",
      "run-a",
    ]);
    expect(again.run("run-a")?.steps).toHaveLength(1);
  });

  it("a new journal is created at version 1 with no copy", () => {
    const file = scratchFile();
    open(file);
    expect(version(file)).toBe(401);
    expect(fs.existsSync(preMigrationCopy(file))).toBe(false);
  });
});

describe("run.list: newest first, keyset pages, filters and search", () => {
  function seeded(): SqliteJournal {
    const journal = open(scratchFile());
    // Twelve runs in tab1, two of them started at the same instant; one in tab2.
    for (let n = 0; n < 12; n += 1) {
      const at = n === 11 ? 10_000 : 1_000 * (n + 1); // runs 9 and 11 tie at 10 000
      journal.started({
        flowId: "tab1",
        runId: `r${String(n).padStart(2, "0")}`,
        title: `Meeting ${String(n)}`,
        at,
      });
    }
    journal.started({ flowId: "tab2", runId: "other", title: "Meeting elsewhere", at: 5_000 });
    // r03 fails; r04 ends done with a note that mentions "budget".
    journal.put(entry("i3", "r03", { now: 4_000 }), {
      kind: "journaled",
      name: "Upload",
      at: 4_000,
    });
    journal.clear("i3", { kind: "failed", reason: "disk full", at: 4_100 });
    journal.put(entry("i4", "r04", { now: 5_000 }), {
      kind: "journaled",
      name: "Notes",
      at: 5_000,
    });
    journal.clear("i4", {
      kind: "done",
      outcome: { notes: [{ level: "note", text: "The budget_line 100%" }], results: [] },
      at: 5_100,
    });
    journal.settle("r04", 5_200);
    return journal;
  }

  it("pages through every run of a flow once, newest first, ties broken by run id", () => {
    const journal = seeded();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const answer = journal.list({
        flowId: "tab1",
        limit: 5,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...answer.runs.map((run) => run.runId));
      if (answer.next === null) {
        break;
      }
      cursor = answer.next;
    }
    // r10 is the newest; r11 and r09 started at the same instant, the greater id first.
    expect(seen).toEqual([
      "r10",
      "r11",
      "r09",
      "r08",
      "r07",
      "r06",
      "r05",
      "r04",
      "r03",
      "r02",
      "r01",
      "r00",
    ]);
    expect(seen).not.toContain("other");
  });

  it("filters by state and start, and searches titles, steps, lines and failures", () => {
    const journal = seeded();
    const ids = (query: Parameters<SqliteJournal["list"]>[0]) =>
      journal.list(query).runs.map((run) => run.runId);
    expect(ids({ flowId: "tab1", state: "failed", limit: 50 })).toEqual(["r03"]);
    expect(ids({ flowId: "tab1", state: "done", limit: 50 })).toEqual(["r04"]);
    expect(ids({ flowId: "tab1", since: 9_000, limit: 50 })).toEqual(["r10", "r11", "r09", "r08"]);
    expect(ids({ flowId: "tab1", search: "Meeting 7", limit: 50 })).toEqual(["r07"]);
    expect(ids({ flowId: "tab1", search: "BUDGET", limit: 50 })).toEqual(["r04"]);
    expect(ids({ flowId: "tab1", search: "disk full", limit: 50 })).toEqual(["r03"]);
    expect(ids({ flowId: "tab1", search: "upload", limit: 50 })).toEqual(["r03"]);
    // The pattern characters are taken literally.
    expect(ids({ flowId: "tab1", search: "100%", limit: 50 })).toEqual(["r04"]);
    expect(ids({ flowId: "tab1", search: "_line", limit: 50 })).toEqual(["r04"]);
    expect(ids({ flowId: "tab1", search: "%", limit: 50 })).toEqual(["r04"]);
    expect(ids({ flowId: "tab1", search: "   ", limit: 3 })).toEqual(["r10", "r11", "r09"]);
    expect(() => journal.list({ flowId: "tab1", cursor: "nonsense", limit: 5 })).toThrow(
      /not a run list cursor/,
    );
  });

  it("deletes every run of a deleted flow, finished or not, with its steps and lines, and no other", () => {
    const journal = seeded();
    const changed: string[] = [];
    journal.onChange((key) => changed.push(`${key.flowId} ${key.runId}`));
    expect(journal.deleteFlowRuns("tab1")).toBe(12);
    expect(journal.list({ flowId: "tab1", limit: 50 }).runs).toEqual([]);
    expect(journal.run("r03")).toBeNull();
    expect(changed).toHaveLength(12);
    expect(changed.every((line) => line.startsWith("tab1 "))).toBe(true);
    expect(journal.list({ flowId: "tab2", limit: 50 }).runs.map((run) => run.runId)).toEqual([
      "other",
    ]);
    expect(journal.deleteFlowRuns("tab1")).toBe(0);
  });

  it("clears done runs as a flag, and the undo brings back only what was cleared since", () => {
    const journal = seeded();
    expect(journal.clearDone("tab1", 20_000)).toBe(1);
    expect(journal.run("r04")).toMatchObject({ cleared: true, state: "done" });
    expect(journal.run("r03")).toMatchObject({ cleared: false }); // a failure is never cleared
    expect(journal.list({ flowId: "tab1", limit: 50 }).runs).toHaveLength(12); // never a delete
    expect(journal.clearDone("tab1", 20_500)).toBe(0);
    expect(journal.undoClear("tab1", 21_000)).toBe(0); // cleared before `since`: too late
    expect(journal.undoClear("tab1", 19_000)).toBe(1);
    expect(journal.run("r04")).toMatchObject({ cleared: false });
  });
});

describe("retention never prunes a run in progress", () => {
  function service(
    journal: SqliteJournal,
    clock: FakeClock,
    days: () => number | null | undefined,
  ) {
    const logger = new RecordingLogger();
    const signals: string[] = [];
    const runs = new RunService({
      store: journal,
      clock,
      logger,
      signal: (flowId) => signals.push(flowId),
      retentionDays: days,
    });
    return { runs, logger, signals };
  }

  it("prunes finished runs past the setting at start and daily, never one in progress", () => {
    const journal = open(scratchFile());
    const clock = new FakeClock();
    clock.advance(200 * DAY_MS);
    const day = (n: number): number => n * DAY_MS;
    // Ended 150 days ago (done), 100 days ago (failed), 10 days ago (done); started 150 days ago
    // and still waiting on a person: in progress.
    const finish = (runId: string, at: number, failed = false): void => {
      journal.started({ flowId: "tab1", runId, title: runId, at });
      journal.put(entry(`in-${runId}`, runId, { now: at }), { kind: "journaled", name: "S", at });
      journal.clear(
        `in-${runId}`,
        failed ? { kind: "failed", reason: "no", at } : { kind: "done", at },
      );
      journal.settle(runId, at);
    };
    finish("old-done", day(50));
    finish("old-failed", day(100), true);
    finish("recent", day(190));
    journal.started({ flowId: "tab1", runId: "waiting", title: "waiting", at: day(50) });
    const ask = entry("in-wait", "waiting", { now: day(50) });
    journal.put(ask, { kind: "journaled", name: "Ask", at: day(50) });
    journal.put(presented(ask, { title: "?" }, day(50)), {
      kind: "presented",
      question: "?",
      at: day(50),
    });

    let setting: number | null | undefined = undefined;
    const { runs, logger } = service(journal, clock, () => setting);
    runs.start(); // unset: 90 days
    const kept = () =>
      journal
        .list({ flowId: "tab1", limit: 50 })
        .runs.map((run) => run.runId)
        .sort();
    expect(kept()).toEqual(["recent", "waiting"]);
    expect(logger.lines).toContainEqual("INFO pruned 2 runs that ended over 90 days ago");

    setting = 7;
    clock.advance(DAY_MS); // the daily prune reads the setting again
    expect(kept()).toEqual(["waiting"]);
    clock.advance(400 * DAY_MS);
    expect(kept()).toEqual(["waiting"]); // in progress: never pruned, however old
    runs.stop();
  });

  it("keeps everything when the setting is Forever", () => {
    const journal = open(scratchFile());
    const clock = new FakeClock();
    clock.advance(1_000 * DAY_MS);
    journal.started({ flowId: "tab1", runId: "ancient", title: "a", at: 1 });
    journal.settle("ancient", 2);
    const { runs } = service(journal, clock, () => null);
    runs.start();
    expect(journal.run("ancient")).toMatchObject({ state: "done" });
    runs.stop();
  });
});

describe("the runs.retentionDays setting", () => {
  it("reads unset, days and Forever from the shell's settings, and refuses anything else", () => {
    const file = path.join(path.dirname(scratchFile()), "shell-settings.json");
    const store = new JsonSettingsStore(file);
    expect(store.readRunRetentionDays()).toBeUndefined();
    const write = (runs: unknown): void => {
      fs.writeFileSync(file, JSON.stringify({ telemetry: true, runs }));
    };
    write({});
    expect(store.readRunRetentionDays()).toBeUndefined();
    write({ retentionDays: 30 });
    expect(store.readRunRetentionDays()).toBe(30);
    write({ retentionDays: null });
    expect(store.readRunRetentionDays()).toBeNull();
    for (const wrong of [
      { retentionDays: 0 },
      { retentionDays: 1.5 },
      { retentionDays: "90" },
      90,
    ]) {
      write(wrong);
      expect(() => store.readRunRetentionDays()).toThrow(/runs\.retentionDays/);
    }
  });
  it("stores General's choice beside every other setting, and Setup's place", () => {
    const file = path.join(path.dirname(scratchFile()), "shell-settings.json");
    fs.writeFileSync(file, JSON.stringify({ telemetry: true, runs: { other: 1 } }));
    const store = new JsonSettingsStore(file);
    store.writeRunRetentionDays(30);
    expect(store.readRunRetentionDays()).toBe(30);
    store.writeRunRetentionDays(null);
    expect(store.readRunRetentionDays()).toBeNull();
    expect(store.readSetup()).toBeUndefined();
    store.writeSetup({ step: "reports", completed: false });
    expect(store.readSetup()).toEqual({ step: "reports", completed: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      telemetry: true,
      runs: { other: 1, retentionDays: null },
      setup: { step: "reports", completed: false },
    });
    // A runs setting that is not an object is replaced by the choice.
    fs.writeFileSync(file, JSON.stringify({ runs: 90 }));
    store.writeRunRetentionDays(7);
    expect(store.readRunRetentionDays()).toBe(7);
  });
});

describe("a run is done only when nothing is left for it (the verifier's refutation)", () => {
  function wired(problems: string[] = []) {
    const journal = open(scratchFile(), problems);
    const clock = new FakeClock();
    const signals: string[] = [];
    const runs = new RunService({
      store: journal,
      clock,
      logger: new RecordingLogger(),
      signal: (flowId) => signals.push(flowId),
      retentionDays: () => null,
    });
    runs.start();
    return { journal, clock, runs, signals, problems };
  }
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("a step journaled after the run settled reopens it, and its failure fails the run", async () => {
    const { journal, clock, runs, problems } = wired();
    runs.emitted({ flowId: "tab1", runId: "r1", type: "rec", data: {} });
    journal.put(entry("a", "r1", { instanceId: "A" }), {
      kind: "journaled",
      name: "Transcribe",
      at: clock.now(),
    });
    clock.advance(100);
    journal.clear("a", { kind: "done", at: clock.now() });
    await tick();
    // A Node-RED delay node holds the output longer than the quiet window.
    clock.advance(SETTLE_MS + 500);
    expect(journal.run("r1")?.state).toBe("done");
    journal.put(entry("b", "r1", { instanceId: "B" }), {
      kind: "journaled",
      name: "Upload",
      at: clock.now(),
    });
    expect(journal.run("r1")).toMatchObject({ state: "running", endedAt: null });
    clock.advance(10);
    journal.clear("b", { kind: "failed", reason: "upload failed: 500", at: clock.now() });
    const run = journal.run("r1");
    expect(run?.state).toBe("failed");
    expect(run?.steps.map((step) => `${step.name}:${step.state}`)).toEqual([
      "Transcribe:done",
      "Upload:failed",
    ]);
    expect(run?.failure).toMatchObject({ step: "Upload", text: "upload failed: 500" });
    expect(problems).toEqual(["run r1 was done; step b started, and reopened it"]);
    // Activity after the failure is said, and changes nothing.
    journal.put(entry("c", "r1", { instanceId: "C" }), { kind: "journaled", name: "Late", at: 1 });
    expect(problems.at(-1)).toBe("run r1 is failed; late stepStarted of step c ignored");
    expect(journal.run("r1")?.steps).toHaveLength(2);
    runs.stop();
  });

  it("never settles a run while an instance holds an input of it at its queue bound", async () => {
    const { journal, clock, runs } = wired();
    let n = 0;
    const node = new InputJournal({
      store: journal,
      clock,
      queue: { ...DEFAULT_QUEUE, bound: 1, policy: "hold" },
      instanceId: "B",
      flowId: "tab1",
      type: "inny-pkg-t",
      label: "Upload",
      newId: () => `b-${String((n += 1))}`,
      log: () => undefined,
      held: runs,
    });
    const delivery = { send: () => undefined, done: () => undefined };
    const message = (run: string) => ({ payload: 1, topic: "t", inny: { run } });
    runs.emitted({ flowId: "tab1", runId: "busy", type: "rec", data: {} });
    runs.emitted({ flowId: "tab1", runId: "waits", type: "rec", data: {} });
    node.admit(message("busy"), delivery, 0); // in hand
    node.admit(message("waits"), delivery, 1); // at the bound: held, nothing journaled
    await tick();
    clock.advance(10 * SETTLE_MS);
    expect(journal.run("waits")?.state).toBe("running"); // held: not done, however quiet
    // The input in hand ends; the held one goes next and is journaled as its step.
    journal.clear("b-1", { kind: "done", at: clock.now() });
    const next = node.nextHeld();
    node.admit(next?.message ?? message("x"), delivery, 0);
    await tick();
    clock.advance(10 * SETTLE_MS);
    expect(journal.run("waits")?.steps.map((step) => step.name)).toEqual(["Upload"]);
    expect(journal.run("waits")?.state).toBe("running"); // its step is open
    journal.clear("b-2", { kind: "done", at: clock.now() });
    await tick();
    clock.advance(SETTLE_MS);
    expect(journal.run("waits")?.state).toBe("done");
    runs.stop();
  });

  it("two open inputs of one instance are two steps, each status and end reaching its own", () => {
    const { journal, clock, runs } = wired();
    journal.started({ flowId: "tab1", runId: "r1", title: "T", at: 500 });
    journal.put(entry("in-1", "r1"), { kind: "journaled", name: "A", at: 1_000 });
    journal.put(entry("in-2", "r1"), { kind: "journaled", name: "A", at: 1_001 });
    journal.stepStatuses([
      { inputId: "in-1", status: { text: "first", progress: { done: 1, total: 2 } }, at: 1_100 },
    ]);
    journal.clear("in-1", { kind: "done", at: 1_200 });
    // A status written late, after its step ended, is the badge's only.
    journal.stepStatuses([{ inputId: "in-1", status: { text: "stale" }, at: 1_300 }]);
    expect(journal.run("r1")?.steps.map((s) => [s.inputId, s.statusText, s.state])).toEqual([
      ["in-1", "first", "done"],
      ["in-2", null, "running"],
    ]);
    expect(journal.get("in-2")).not.toBeNull();
    clock.advance(1);
    runs.stop();
  });

  it("tells the flow on every journal write, a run changed or not, for the Jobs page", async () => {
    const { journal, signals, runs } = wired();
    journal.put(entry("a", "r1"), { kind: "journaled", name: "A", at: 0 });
    await tick();
    signals.length = 0;
    journal.put(entry("plain", "r2")); // a write that changes no run
    journal.clear("plain"); // and a clear with no change
    journal.clear("nothing-there");
    await tick();
    expect(signals).toEqual(["tab1", ""]);
    runs.stop();
  });
});
