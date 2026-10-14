// Run history's delete against the real pieces (plan 0022 §E): the raw fixture node behind the
// node-process adapter at a queue bound of 1 (policy hold), the SQLite journal, the journal replay
// and application/run-actions.ts. One run waits on the person, the others are held at the bound.
// Whatever order a batch names them in, a deleted run's held input is never journaled, so never
// sent nor presented, and the queue is free afterwards: the next run goes straight through.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openSqliteJournal, type SqliteJournal } from "../../src/adapters/sqlite/journal";
import { JournalReplay } from "../../src/application/journal-replay";
import { RunActions } from "../../src/application/run-actions";
import type { JournalEntry } from "../../src/domain/journal/entry";
import type { RunChange } from "../../src/ports/journal-store";
import {
  RecordingDelivery,
  RecordingLogger,
  startRaw,
  waitFor,
  type RawNode,
} from "../fixtures/raw-node/fixture";

const FLOW = "flow-1";
const open: { node: RawNode; journal: SqliteJournal; dir: string }[] = [];

afterEach(async () => {
  for (const { node, journal, dir } of open.splice(0)) {
    await node.node.close("quit");
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The node at bound 1, its journal (the run of every input journaled, recorded), its replay and actions. */
async function setUp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inny-run-delete-"));
  const journal = openSqliteJournal(path.join(dir, "journal.sqlite"));
  const journaled: string[] = [];
  const put = journal.put.bind(journal);
  journal.put = (entry: JournalEntry, change?: RunChange) => {
    if (change?.kind === "journaled") {
      journaled.push(entry.event.run ?? entry.inputId);
    }
    put(entry, change);
  };
  const node = startRaw({
    journal,
    id: "ask-1",
    settings: { queue: { bound: 1, policy: "hold" } },
  });
  open.push({ node, journal, dir });
  const logger = new RecordingLogger();
  const replay = new JournalReplay({ store: journal, logger, events: { on: () => undefined } });
  replay.attach("ask-1", node.node, () => undefined);
  const actions = new RunActions({
    store: journal,
    engine: { getFlow: () => Promise.resolve(null) },
    replay,
    deleteSnapshots: () => 0,
    clock: { now: () => Date.now(), after: () => () => undefined },
    newId: () => "unused",
    logger,
  });
  await waitFor("ready", () => node.logger.has(/\] ready$/));
  return { journal, journaled, node, actions };
}

/** A question of run `run` reaches the node; its run is recorded as a source would start it. */
function ask(node: RawNode, journal: SqliteJournal, run: string): RecordingDelivery {
  journal.started({ flowId: FLOW, runId: run, title: run, at: Date.now() });
  const delivery = new RecordingDelivery();
  node.node.input(
    { payload: { do: "present", content: { title: run } }, topic: "t", inny: { run } },
    delivery,
  );
  return delivery;
}

const titles = (node: RawNode) => node.host.presented.map((view) => view.content["title"]);

describe("deleting runs waiting at a bound of 1", () => {
  for (const [name, runs, order] of [
    ["the waiting one first", ["r1", "r2"], ["r1", "r2"]],
    ["the held one first", ["r1", "r2"], ["r2", "r1"]],
    ["five, oldest first", ["r1", "r2", "r3", "r4", "r5"], ["r1", "r2", "r3", "r4", "r5"]],
  ] as const) {
    it(`${name}: a held run is never journaled, sent nor presented, and the queue is free`, async () => {
      const { journal, journaled, node, actions } = await setUp();
      const deliveries = runs.map((run) => ask(node, journal, run));
      await waitFor("r1 presents", () => node.host.presented.length === 1);
      expect(node.node.queue()).toMatchObject({ outstanding: 1, held: runs.length - 1 });

      const answer = await actions.call("run.deleteMany", { flowId: FLOW, runIds: [...order] });
      expect(answer).toEqual({ ok: true, value: { deleted: runs.length } });
      await waitFor("every run ended", () => deliveries.every((delivery) => delivery.finished));

      // Only r1 was ever journaled: none of the held ones got a place, whatever freed one.
      expect(journaled).toEqual(["r1"]);
      expect(titles(node)).toEqual(["r1"]);
      expect(journal.all()).toEqual([]);
      expect(runs.map((run) => journal.run(run))).toEqual(runs.map(() => null));
      expect(node.node.queue()).toMatchObject({ outstanding: 0, held: 0 });

      // The queue is free: the next run goes straight to the person.
      ask(node, journal, "fresh");
      await waitFor("fresh presents", () => node.host.presented.length === 2);
      expect(titles(node)).toEqual(["r1", "fresh"]);
    });
  }

  it("a run held behind deleted ones gets the place they leave", async () => {
    const { journal, journaled, node, actions } = await setUp();
    const deliveries = ["r1", "r2", "kept"].map((run) => ask(node, journal, run));
    await waitFor("r1 presents", () => node.host.presented.length === 1);
    await actions.call("run.deleteMany", { flowId: FLOW, runIds: ["r1", "r2"] });
    await waitFor("kept presents", () => node.host.presented.length === 2);
    expect(titles(node)).toEqual(["r1", "kept"]);
    expect(journaled).toEqual(["r1", "kept"]);
    expect(deliveries[2]?.finished).toBe(false);
    expect(node.node.queue()).toMatchObject({ outstanding: 1, held: 0 });
  });
});
