// domain/journal: the entry, every retry rule of spec 7.3 and 7.4, and the queue bound (7.6).
import { describe, expect, it } from "vitest";

import {
  eventOf,
  isJournalEntry,
  journaledMessage,
  MAX_ATTEMPTS,
  newEntry,
  onClose,
  onReplay,
  presented,
  submitted,
  type JournalEntry,
} from "../../src/domain/journal/entry";
import { admit, DEFAULT_QUEUE, queueSettings } from "../../src/domain/journal/queue";

const MESSAGE = {
  payload: { a: 1 },
  topic: "pkg.thing.v1",
  inny: { run: "run-1", cause: "in-0" },
  _msgid: "m1",
};

function entry(changes: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ...newEntry({
      inputId: "in-1",
      instanceId: "n1",
      type: "inny-pkg-t",
      message: MESSAGE,
      now: 10,
    }),
    ...changes,
  };
}

/** The entry a replay re-sends, or a failure when it gives up. */
function replayed(from: JournalEntry): JournalEntry {
  const decision = onReplay(from, 99);
  if (decision.kind !== "resend") {
    throw new Error(`expected a re-send, got: ${decision.message}`);
  }
  return decision.entry;
}

describe("a journal entry (spec 7.1)", () => {
  it("records the input id, instance, type, message, event, first attempt, state sent and the time", () => {
    expect(entry()).toEqual({
      inputId: "in-1",
      instanceId: "n1",
      type: "inny-pkg-t",
      message: MESSAGE,
      event: { type: "pkg.thing.v1", data: { a: 1 }, run: "run-1" },
      attempts: 1,
      state: "sent",
      planned: false,
      plannedBy: null,
      content: null,
      createdAt: 10,
      updatedAt: 10,
    });
  });

  it("keeps payload, topic, inny and _msgid of the message, and nothing else", () => {
    const noisy = { ...MESSAGE, _innyReplay: "x", req: {}, extra: 1 };
    expect(Object.keys(journaledMessage(noisy)).sort()).toEqual(
      ["_msgid", "inny", "payload", "topic"].sort(),
    );
    expect(journaledMessage({ payload: 3 })).toEqual({ payload: 3 });
  });

  it("builds the input's event from the topic, the payload and the run", () => {
    expect(eventOf({ payload: 1 })).toEqual({ type: "", data: 1 });
    expect(eventOf({ payload: 1, topic: 5, inny: "x" })).toEqual({ type: "", data: 1 });
    expect(eventOf({ payload: 1, topic: "t", inny: { run: 7 } })).toEqual({ type: "t", data: 1 });
    expect(eventOf({ payload: 1, topic: "t", inny: { run: "r" } })).toEqual({
      type: "t",
      data: 1,
      run: "r",
    });
  });

  it("is awaiting with its content once presented, and sent again once submitted", () => {
    const waiting = presented(entry(), { title: "Choose" }, 20);
    expect(waiting).toMatchObject({
      state: "awaiting",
      content: { title: "Choose" },
      updatedAt: 20,
    });
    expect(submitted(waiting, 30)).toMatchObject({ state: "sent", updatedAt: 30 });
  });

  it("is recognised when read back, and anything else is not", () => {
    expect(isJournalEntry(JSON.parse(JSON.stringify(entry())))).toBe(true);
    expect(isJournalEntry(presented(entry(), { t: 1 }, 1))).toBe(true);
    expect(isJournalEntry(entry({ planned: true, plannedBy: "types" }))).toBe(true);
    expect(isJournalEntry(null)).toBe(false);
    expect(isJournalEntry([])).toBe(false);
    expect(isJournalEntry({ ...entry(), state: "done" })).toBe(false);
    expect(isJournalEntry({ ...entry(), plannedBy: "quit" })).toBe(false);
    expect(isJournalEntry({ ...entry(), event: { data: 1 } })).toBe(false);
    expect(isJournalEntry({ ...entry(), content: 3 })).toBe(false);
  });
});

describe("the retry rules (spec 7.3, 7.4)", () => {
  it("the maximum is 2: the first send plus one retry", () => {
    expect(MAX_ATTEMPTS).toBe(2);
  });

  it("planned by a node-type change: marked with plannedBy, re-sent WITHOUT counting, flag cleared", () => {
    const closed = onClose(entry(), "types", 50);
    expect(closed).toEqual({
      kind: "keep",
      entry: { ...entry(), planned: true, plannedBy: "types", updatedAt: 50 },
    });
    const decision = onReplay(closed.kind === "keep" ? closed.entry : entry(), 60);
    expect(decision).toMatchObject({ kind: "resend", counted: false });
    expect(decision.kind === "resend" && decision.entry).toMatchObject({
      attempts: 1,
      planned: false,
      plannedBy: null,
    });
    expect(decision.kind === "resend" && decision.why).toMatch(/planned restart \(types\)/);
  });

  it("planned by a redeploy: the same, with plannedBy redeploy", () => {
    const closed = onClose(entry(), "redeploy", 50);
    expect(closed.kind === "keep" && closed.entry.plannedBy).toBe("redeploy");
    expect(replayed(closed.kind === "keep" ? closed.entry : entry()).attempts).toBe(1);
  });

  it("planned restarts never use up the retry, however many there are", () => {
    let current = entry();
    for (let restart = 0; restart < 5; restart += 1) {
      const closed = onClose(current, "redeploy", restart);
      current = replayed(closed.kind === "keep" ? closed.entry : current);
    }
    expect(current.attempts).toBe(1);
  });

  it("a crash (no close ran) is counted", () => {
    const decision = onReplay(entry(), 60);
    expect(decision).toMatchObject({ kind: "resend", counted: true });
    expect(decision.kind === "resend" && decision.entry.attempts).toBe(2);
  });

  it("a quit is counted: the close leaves the entry as it was", () => {
    expect(onClose(entry(), "quit", 50)).toEqual({ kind: "keep", entry: entry() });
    expect(replayed(entry()).attempts).toBe(2);
  });

  it("a step counted twice fails with 'not done after 2 attempts'", () => {
    const twice = replayed(entry());
    expect(onReplay(twice, 70)).toEqual({ kind: "fail", message: "not done after 2 attempts" });
    expect(onReplay(entry({ attempts: 5 }), 70).kind).toBe("fail");
  });

  it("a planned restart after a crash still does not count: the step fails only on a second counted one", () => {
    const afterCrash = replayed(entry());
    const closed = onClose(afterCrash, "types", 80);
    const afterPlanned = replayed(closed.kind === "keep" ? closed.entry : afterCrash);
    expect(afterPlanned.attempts).toBe(2);
    expect(onReplay(afterPlanned, 90).kind).toBe("fail");
  });

  it("an awaiting view is never counted: re-sent on every start, any number of times", () => {
    let current = presented(entry({ attempts: 2 }), { title: "wait" }, 20);
    for (let start = 0; start < 10; start += 1) {
      const decision = onReplay(current, start);
      expect(decision).toMatchObject({ kind: "resend", counted: false });
      current = decision.kind === "resend" ? decision.entry : current;
    }
    expect(current).toMatchObject({ attempts: 2, state: "awaiting", content: { title: "wait" } });
  });

  it("an awaiting view is not marked planned by a planned close", () => {
    const waiting = presented(entry(), { title: "wait" }, 20);
    expect(onClose(waiting, "types", 30)).toEqual({ kind: "keep", entry: waiting });
  });

  it("a removal drops the entry, sent or awaiting", () => {
    expect(onClose(entry(), "removed", 1)).toEqual({ kind: "drop" });
    expect(onClose(presented(entry(), {}, 1), "removed", 1)).toEqual({ kind: "drop" });
  });

  it("an input journaled while held (attempts 0) gets its first attempt on replay", () => {
    const held = newEntry({
      inputId: "h",
      instanceId: "n1",
      type: "t",
      message: MESSAGE,
      now: 1,
      attempts: 0,
    });
    expect(held.attempts).toBe(0);
    expect(replayed(held).attempts).toBe(1);
  });
});

describe("the queue bound (spec 7.6)", () => {
  it("defaults to 64, holding", () => {
    expect(DEFAULT_QUEUE).toEqual({ bound: 64, policy: "hold" });
  });

  it("sends under the bound and applies the policy at it", () => {
    const hold = queueSettings(2, "hold");
    expect(admit(0, hold)).toBe("send");
    expect(admit(1, hold)).toBe("send");
    expect(admit(2, hold)).toBe("hold");
    expect(admit(3, queueSettings(2, "fail"))).toBe("fail");
  });

  it("refuses a bound that is not a whole number of at least 1", () => {
    for (const bound of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => queueSettings(bound, "hold")).toThrow(/whole number of at least 1/);
    }
    expect(queueSettings(1, "fail")).toEqual({ bound: 1, policy: "fail" });
  });
});
