// Boards (plan 0022 §A, Acceptance): a new view node appends a slot, a removed node removes its
// slot, the last tab stays, and a hidden place never hides a waiting question.
import { describe, expect, it } from "vitest";
import {
  addTab,
  BoardError,
  hiddenSlots,
  hideSlot,
  moveSlot,
  newLayout,
  reconcile,
  removeTab,
  renameTab,
  resizeSlot,
  RUNS_SLOT_ID,
  showSlot,
  slotsOfTab,
  urgentHidden,
  waitingQuestions,
  type BoardLayout,
  type ViewNode,
} from "../../../src/domain/board/layout";
import { fold, type Run, type RunEvent } from "../../../src/domain/runs/run";

const FLOW = "flow-recordings";
const QUESTION: ViewNode = { id: "q-speakers", kind: "question" };
const RESULT: ViewNode = { id: "r-notes", kind: "result", suggestedSize: "L" };
const APPROVE: ViewNode = { id: "q-approve", kind: "question", suggestedSize: "S" };

/** The board of a flow with a question and a result. */
function board(): BoardLayout {
  return reconcile(newLayout(FLOW, "Board"), [QUESTION, RESULT]).layout;
}

/** Where each slot is, as [id, tab, order]. */
function places(layout: BoardLayout): [string, string, number][] {
  return layout.slots
    .map((slot): [string, string, number] => [slot.viewNodeId, slot.tabId, slot.order])
    .sort((a, b) => a[1].localeCompare(b[1]) || a[2] - b[2]);
}

/** A run of FLOW folded from events with its key and clock filled in. */
function run(runId: string, ...list: Record<string, unknown>[]): Run {
  return fold(
    [{ kind: "started", title: runId }, ...list].map(
      (event, index) =>
        ({
          flowId: FLOW,
          runId,
          at: new Date(2026, 9, 2, 9, index),
          ...event,
        }) as unknown as RunEvent,
    ),
  );
}

const waitingOn = (runId: string, instanceId: string) =>
  run(
    runId,
    { kind: "stepStarted", instanceId, name: "Name the speakers" },
    { kind: "presented", instanceId, question: "who spoke?" },
  );

describe("a new view node appends a slot", () => {
  it("adds it at the end of the last tab at its suggested size, M when it suggests none", () => {
    const first = board();
    expect(places(first)).toEqual([
      [RUNS_SLOT_ID, "tab-1", 0],
      ["q-speakers", "tab-1", 1],
      ["r-notes", "tab-1", 2],
    ]);
    expect(first.slots.find((slot) => slot.viewNodeId === "q-speakers")?.size).toBe("M");
    expect(first.slots.find((slot) => slot.viewNodeId === "r-notes")?.size).toBe("L");

    const { layout: twoTabs, tabId } = addTab(first, "Tab");
    const result = reconcile(twoTabs, [QUESTION, RESULT, APPROVE]);
    expect(result.added).toEqual(["q-approve"]);
    expect(result.removed).toEqual([]);
    expect(result.layout.slots.find((slot) => slot.viewNodeId === "q-approve")).toEqual({
      viewNodeId: "q-approve",
      kind: "question",
      size: "S",
      hidden: false,
      tabId,
      order: 0,
    });
  });

  it("keeps everything the person arranged when the flow is redeployed unchanged", () => {
    let layout = board();
    layout = resizeSlot(layout, "q-speakers", "S");
    layout = hideSlot(layout, "r-notes");
    layout = moveSlot(layout, "r-notes", "tab-1", 0);
    const again = reconcile(layout, [QUESTION, RESULT]);
    expect(again.added).toEqual([]);
    expect(again.layout).toEqual(layout);
  });

  it("puts the run cards' slot back in the first tab when a stored layout lost it", () => {
    const stored: BoardLayout = {
      flowId: FLOW,
      tabs: [{ id: "a", name: "A", order: 0 }],
      slots: [],
    };
    const { layout } = reconcile(stored, [{ id: RUNS_SLOT_ID, kind: "card" }]);
    expect(places(layout)).toEqual([[RUNS_SLOT_ID, "a", 0]]);
  });
});

describe("a removed node removes its slot", () => {
  it("drops the slot of a view node the flow lost and closes the gap, keeping the rest", () => {
    const layout = resizeSlot(board(), "r-notes", "S");
    const result = reconcile(layout, [RESULT]);
    expect(result.removed).toEqual(["q-speakers"]);
    expect(places(result.layout)).toEqual([
      [RUNS_SLOT_ID, "tab-1", 0],
      ["r-notes", "tab-1", 1],
    ]);
    expect(result.layout.slots.find((slot) => slot.viewNodeId === "r-notes")?.size).toBe("S");
  });

  it("never removes the run cards' slot", () => {
    const { layout } = reconcile(board(), []);
    expect(places(layout)).toEqual([[RUNS_SLOT_ID, "tab-1", 0]]);
  });
});

describe("the last tab stays", () => {
  it("refuses to remove the only tab, with the reason the view words", () => {
    expect(() => removeTab(board(), "tab-1")).toThrow(BoardError);
    try {
      removeTab(board(), "tab-1");
    } catch (error) {
      expect((error as BoardError).reason).toBe("last-tab");
    }
    expect(() => hideSlot(board(), "nope")).toThrow(
      expect.objectContaining({ reason: "unknown-slot" }),
    );
    expect(() => renameTab(board(), "nope", "x")).toThrow(
      expect.objectContaining({ reason: "unknown-tab" }),
    );
  });

  it("moves a removed tab's places to the end of the first tab; nothing is deleted", () => {
    const { layout: withTab, tabId } = addTab(board(), "Customers");
    const moved = moveSlot(moveSlot(withTab, "q-speakers", tabId, 0), "r-notes", tabId, 5);
    expect(slotsOfTab(moved, tabId).map((slot) => slot.viewNodeId)).toEqual([
      "q-speakers",
      "r-notes",
    ]);
    const removed = removeTab(moved, tabId);
    expect(removed.tabs).toEqual([{ id: "tab-1", name: "Board", order: 0 }]);
    expect(places(removed)).toEqual([
      [RUNS_SLOT_ID, "tab-1", 0],
      ["q-speakers", "tab-1", 1],
      ["r-notes", "tab-1", 2],
    ]);
  });

  it("removing the first tab moves its places to the tab that becomes first", () => {
    const { layout: withTab, tabId } = addTab(board(), "Tab");
    const removed = removeTab(withTab, "tab-1");
    expect(removed.tabs).toEqual([{ id: tabId, name: "Tab", order: 0 }]);
    expect(places(removed).map((place) => place[1])).toEqual([tabId, tabId, tabId]);
  });

  it("names tabs, gives each a fresh id, and refuses unknown tabs and places", () => {
    const one = addTab(board(), "Tab");
    const two = addTab(removeTab(addTab(one.layout, "Tab").layout, one.tabId), "Tab");
    expect(new Set(two.layout.tabs.map((tab) => tab.id)).size).toBe(two.layout.tabs.length);
    const renamed = renameTab(one.layout, one.tabId, "Customers");
    expect(renamed.tabs.find((tab) => tab.id === one.tabId)?.name).toBe("Customers");
    expect(() => renameTab(board(), "nope", "x")).toThrow(BoardError);
    expect(() => removeTab(board(), "nope")).toThrow(BoardError);
    expect(() => moveSlot(board(), "nope", "tab-1", 0)).toThrow(BoardError);
    expect(() => moveSlot(board(), "r-notes", "nope", 0)).toThrow(BoardError);
    expect(() => hideSlot(board(), "nope")).toThrow(/no slot for "nope"/);
    expect(() => reconcile({ flowId: FLOW, tabs: [], slots: [] }, [])).toThrow(BoardError);
  });

  it("moves within a tab by shifting the others", () => {
    const moved = moveSlot(board(), "r-notes", "tab-1", -3);
    expect(slotsOfTab(moved, "tab-1").map((slot) => slot.viewNodeId)).toEqual([
      "r-notes",
      RUNS_SLOT_ID,
      "q-speakers",
    ]);
  });
});

describe("hidden never hides a waiting question", () => {
  it("lists a hidden place's waiting question exactly as a shown one, and marks it hidden", () => {
    const layout = hideSlot(board(), "q-speakers");
    const runs = [waitingOn("evt-1", "q-speakers"), run("evt-2"), waitingOn("evt-3", "q-other")];
    expect(waitingQuestions(layout, runs)).toEqual([
      {
        flowId: FLOW,
        runId: "evt-1",
        viewNodeId: "q-speakers",
        question: "who spoke?",
        hidden: true,
      },
      {
        flowId: FLOW,
        runId: "evt-3",
        viewNodeId: "q-other",
        question: "who spoke?",
        hidden: false,
      },
    ]);
    // Hiding or showing changes nothing about which questions wait.
    const shown = showSlot(layout, "q-speakers");
    expect(waitingQuestions(shown, runs).map((q) => q.runId)).toEqual(["evt-1", "evt-3"]);
    expect(hiddenSlots(shown)).toEqual([]);
    expect(hiddenSlots(layout).map((slot) => slot.viewNodeId)).toEqual(["q-speakers"]);
  });

  it("names the hidden places that still hold a question or a failure", () => {
    const failed = run(
      "evt-4",
      { kind: "stepStarted", instanceId: "r-notes", name: "Notes" },
      { kind: "stepFailed", instanceId: "r-notes", text: "Couldn't reach Anytype." },
    );
    const runs = [waitingOn("evt-1", "q-speakers"), failed];
    expect(urgentHidden(board(), runs)).toEqual([]);
    const hidden = hideSlot(hideSlot(board(), "q-speakers"), "r-notes");
    expect(urgentHidden(hidden, runs)).toEqual([
      { viewNodeId: "q-speakers", runId: "evt-1", reason: "waiting" },
      { viewNodeId: "r-notes", runId: "evt-4", reason: "failed" },
    ]);
    // Hiding the run cards still tells about both.
    const cardsHidden = hideSlot(board(), RUNS_SLOT_ID);
    expect(urgentHidden(cardsHidden, runs)).toEqual([
      { viewNodeId: RUNS_SLOT_ID, runId: "evt-1", reason: "waiting" },
      { viewNodeId: RUNS_SLOT_ID, runId: "evt-4", reason: "failed" },
    ]);
    expect(waitingQuestions(cardsHidden, runs)[0]?.hidden).toBe(true);
  });

  it("ignores other flows' runs", () => {
    const other = { ...waitingOn("evt-1", "q-speakers"), flowId: "flow-invoices" };
    const otherFailed = { ...run("evt-2"), flowId: "flow-invoices", state: "failed" as const };
    expect(waitingQuestions(board(), [other])).toEqual([]);
    expect(urgentHidden(hideSlot(board(), RUNS_SLOT_ID), [other, otherFailed])).toEqual([]);
  });
});
