// adapters/process/input-journal.ts: every write that moves a step says so to the store, so
// the run records are written in the journal's own transaction (plan 0022 §C, D15), and every
// entry it journals carries the instance's flow.
import { describe, expect, it } from "vitest";

import { InputJournal } from "../../src/adapters/process/input-journal";
import { DEFAULT_QUEUE } from "../../src/domain/journal/queue";
import type { InputDelivery } from "../../src/ports/node-process";
import { FakeClock } from "../fakes/clock";
import { MemoryJournal } from "../fakes/journal";

function journalOf(store = new MemoryJournal()) {
  let n = 0;
  const logs: string[] = [];
  const journal = new InputJournal({
    store,
    clock: new FakeClock(),
    queue: { ...DEFAULT_QUEUE, bound: 1 },
    instanceId: "n1",
    flowId: "tab1",
    type: "inny-pkg-t",
    label: "Transcribe",
    newId: () => `in-${String((n += 1))}`,
    log: (level, message) => logs.push(`${level} ${message}`),
  });
  return { journal, store, logs };
}

const delivery = (): InputDelivery & { ends: (Error | undefined)[] } => {
  const ends: (Error | undefined)[] = [];
  return { ends, send: () => undefined, done: (error) => ends.push(error) };
};

const message = { payload: 1, topic: "t.v1", inny: { run: "run-1" } };

describe("the input journal's run changes", () => {
  it("journals, presents, submits and ends a step, each with its change, and stamps the flow", () => {
    const { journal, store } = journalOf();
    const admitted = journal.admit(message, delivery(), 0);
    expect(admitted?.id).toBe("in-1");
    expect(store.get("in-1")?.flowId).toBe("tab1");
    journal.presented("in-1", { title: "Who spoke?" }, null);
    journal.submitted("in-1");
    journal.finished("in-1", undefined, {
      notes: [{ level: "note", text: "ok" }],
      results: [],
    });
    expect(store.changes).toEqual([
      "in-1 journaled Transcribe",
      "in-1 presented Who spoke?",
      "in-1 submitted",
      "in-1 done 1",
    ]);
  });

  it("ends a failed step with the error's sentence, and a plain done with no outcome", () => {
    const { journal, store } = journalOf();
    journal.admit(message, delivery(), 0);
    journal.finished("in-1", new Error("cancelled"));
    journal.admit(message, delivery(), 0);
    journal.finished("in-2");
    expect(store.changes.slice(1)).toEqual([
      "in-1 failed cancelled",
      "in-2 journaled Transcribe",
      "in-2 done -",
    ]);
  });

  it("re-sends as resent, gives up as failed, and a submit of a gone entry changes nothing", () => {
    const { journal, store } = journalOf();
    journal.admit(message, delivery(), 0);
    journal.close("quit", ["in-1"]);
    expect(journal.readmit("in-1", delivery(), false)?.id).toBe("in-1");
    // A quit again, and the second counted attempt is the last: given up.
    journal.close("quit", ["in-1"]);
    const gaveUp = delivery();
    expect(journal.readmit("in-1", gaveUp, false)).toBeNull();
    journal.submitted("in-1");
    expect(store.changes).toEqual([
      "in-1 journaled Transcribe",
      "in-1 resent Transcribe",
      "in-1 failed Transcribe: not done after 2 attempts",
    ]);
  });

  it("journals held inputs at close as new steps, and a removal fails every step it drops", () => {
    const { journal, store } = journalOf();
    journal.admit(message, delivery(), 0);
    journal.admit(message, delivery(), 1); // at the bound: held
    journal.close("redeploy", ["in-1"]);
    expect(store.all().map((entry) => [entry.inputId, entry.flowId, entry.attempts])).toEqual([
      ["in-1", "tab1", 1],
      ["in-2", "tab1", 0],
    ]);
    journal.close("removed", []);
    expect(store.changes).toEqual([
      "in-1 journaled Transcribe",
      "in-2 journaled Transcribe",
      "in-1 failed removed from the flow",
      "in-2 failed removed from the flow",
    ]);
  });

  it("logs a submit the store refuses", () => {
    const { journal, store, logs } = journalOf();
    journal.admit(message, delivery(), 0);
    store.failWrites = true;
    journal.submitted("in-1");
    expect(logs).toEqual([
      "error the journal entry of in-1 could not be updated: Error: disk full",
    ]);
  });
});
