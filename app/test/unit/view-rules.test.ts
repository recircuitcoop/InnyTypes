// The pure rules of views (WI-0018-10): first presentation versus re-presentation, the
// journaled deadline, the action judgement of spec 8.4, an instance's window and timeout, a
// snapshot record read back, and the channel's `present` and `pending` messages.

import { describe, expect, it } from "vitest";

import { parseChildMessage } from "../../src/domain/channel/messages";
import {
  isFirstPresentation,
  isJournalEntry,
  newEntry,
  onReplay,
  presented,
  submitted,
} from "../../src/domain/journal/entry";
import {
  GONE_FROM_FLOW,
  isSnapshotRecord,
  judgeActions,
  NOT_RUNNING,
  refusalOf,
  timeoutOf,
  titleOf,
  unwired,
  windowOf,
  type SnapshotRecord,
} from "../../src/domain/views/views";

const entry = newEntry({
  inputId: "i",
  instanceId: "n",
  type: "t",
  message: { payload: 1 },
  now: 0,
});

describe("presentation", () => {
  it("is first only while the entry has no stored content; a re-presentation keeps the deadline", () => {
    expect(isFirstPresentation(entry)).toBe(true);
    const shown = presented(entry, { title: "a" }, 1_000, 5_000);
    expect(shown).toMatchObject({ state: "awaiting", content: { title: "a" }, deadline: 6_000 });
    expect(isFirstPresentation(shown)).toBe(false);
    // After a restart, at 4 s: the same deadline, not 4 s + 5 s.
    expect(presented(shown, { title: "a" }, 4_000, 5_000).deadline).toBe(6_000);
    // Submitted and re-sent (a crash before done): still a re-presentation.
    expect(isFirstPresentation(submitted(shown, 5_000))).toBe(false);
  });

  it("with no timeout there is no deadline, first or again; an old entry without one reads as none", () => {
    const shown = presented(entry, {}, 1_000);
    expect(shown.deadline).toBeNull();
    // An entry journaled before deadlines existed has no such field at all.
    const old = { ...shown };
    delete old.deadline;
    expect(presented(old, {}, 2_000, 5_000).deadline).toBeNull();
    expect(isJournalEntry(old)).toBe(true);
    expect(isJournalEntry({ ...shown, deadline: 5 })).toBe(true);
    expect(isJournalEntry({ ...shown, deadline: "soon" })).toBe(false);
  });

  it("an awaiting entry is re-sent on every start and never counts an attempt", () => {
    let shown = presented(entry, {}, 0);
    for (let start = 0; start < 5; start += 1) {
      const decision = onReplay(shown, start);
      expect(decision).toMatchObject({ kind: "resend", counted: false });
      if (decision.kind === "resend") {
        shown = decision.entry;
      }
    }
    expect(shown.attempts).toBe(1);
  });
});

const record: SnapshotRecord = {
  id: "s",
  instanceId: "rec",
  type: "inny-viewpy-record",
  label: "Record",
  time: 1,
  content: {},
  state: null,
  window: "inline",
  actions: [
    { id: "again", label: "Run again", event: "viewpy.again.v1" },
    { id: "spare", label: "Spare", event: "viewpy.spare.v1" },
  ],
};

describe("the judgement of an action (spec 8.4)", () => {
  const deployed = { ports: ["passed", "again", "spare"], wires: [[], ["x"], []], running: true };

  it("enabled when the view is in the flow, the port wired, and its process running", () => {
    expect(judgeActions(record, deployed)).toEqual([
      { ...record.actions[0], enabled: true, reason: null },
      { ...record.actions[1], enabled: false, reason: unwired("Spare") },
    ]);
  });

  it("disabled with the proven wording otherwise", () => {
    const again = record.actions[0] as SnapshotRecord["actions"][number];
    expect(refusalOf(again, null)).toBe(GONE_FROM_FLOW);
    expect(GONE_FROM_FLOW).toBe("The view that took this snapshot is no longer in the flow.");
    expect(unwired("Spare")).toBe('Nothing is wired to the "Spare" output.');
    expect(refusalOf(again, { ...deployed, ports: ["passed"] })).toBe(unwired("Run again"));
    expect(refusalOf(again, { ...deployed, wires: [] })).toBe(unwired("Run again"));
    expect(refusalOf(again, { ...deployed, running: false })).toBe(NOT_RUNNING);
  });
});

describe("an instance's view settings", () => {
  it("window is popout only when it says so", () => {
    expect(windowOf({ window: "popout" })).toBe("popout");
    expect(windowOf({ window: "other" })).toBe("inline");
    expect(windowOf({})).toBe("inline");
  });

  it("a timeout needs a timeout port and a positive timeout_seconds", () => {
    const ports = ["answer", "timeout"];
    expect(timeoutOf({ timeout_seconds: 2.5 }, ports)).toBe(2_500);
    expect(timeoutOf({ timeout_seconds: 2 }, ["answer"])).toBeNull();
    expect(timeoutOf({ timeout_seconds: 0 }, ports)).toBeNull();
    expect(timeoutOf({ timeout_seconds: "2" }, ports)).toBeNull();
    expect(timeoutOf({}, ports)).toBeNull();
  });

  it("the title is the content's, else empty", () => {
    expect(titleOf({ title: "Name them" })).toBe("Name them");
    expect(titleOf({ title: 3 })).toBe("");
  });
});

describe("a snapshot record read back", () => {
  it("is one only with every field of its shape", () => {
    expect(isSnapshotRecord(record)).toBe(true);
    expect(isSnapshotRecord(null)).toBe(false);
    expect(isSnapshotRecord({ ...record, window: "tab" })).toBe(false);
    expect(isSnapshotRecord({ ...record, content: [] })).toBe(false);
    expect(isSnapshotRecord({ ...record, actions: [{ id: "a", label: "A" }] })).toBe(false);
    expect(isSnapshotRecord({ ...record, time: "now" })).toBe(false);
  });
});

describe("the channel's view messages (spec 10.2)", () => {
  it("present and pending parse, and a malformed one is refused", () => {
    const present = { v: 1, t: "present", id: "i", window: "popout", first: false, title: "T" };
    expect(parseChildMessage(present)).toEqual(present);
    expect(parseChildMessage({ ...present, window: "tab" })).toBeNull();
    expect(parseChildMessage({ ...present, first: "no" })).toBeNull();
    expect(parseChildMessage({ v: 1, t: "pending", count: 2 })).toEqual({
      v: 1,
      t: "pending",
      count: 2,
    });
    expect(parseChildMessage({ v: 1, t: "pending", count: -1 })).toBeNull();
    expect(parseChildMessage({ v: 1, t: "pending", count: 1.5 })).toBeNull();
    expect(parseChildMessage({ v: 1, t: "jobs" })).toEqual({ v: 1, t: "jobs" });
  });

  it("a reply may carry status 409, and no other status", () => {
    const reply = (result: object) => parseChildMessage({ v: 1, t: "reply", rid: "r", result });
    expect(reply({ ok: false, error: "why", status: 409 })).toMatchObject({
      result: { status: 409 },
    });
    expect(reply({ ok: false, error: "why", status: 500 })).toBeNull();
  });
});
