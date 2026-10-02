// A flow's board in Live: its tabs and where each place sits (plan 0022 §A and §C, ux-writing
// "Live: the board", design-system "Board" and "Slot").
//
// The flow decides WHAT is on the board: one slot per view node, plus the one slot that holds the
// flow's run cards. The person decides WHERE each sits and how big, in Edit layout. So:
// * `reconcile` runs every time a layout is read: a view node the flow gained gets a slot at the
//   end of the last tab, at the size it suggests; a view node the flow lost loses its slot;
//   everything the person arranged stays as it was. A redeploy never resets a layout.
// * Hiding a place only changes what is drawn. A hidden place never hides a waiting question or a
//   failure: `waitingQuestions` ignores `hidden`, and `urgentHidden` names the hidden places that
//   still hold one, so the view can say so and the notifier still notifies.
// * A board always has at least one tab: removing a tab moves its places to the first tab, and
//   the last tab cannot be removed.
//
// Every operation returns a new layout; a wrong request (an unknown slot or tab, the last tab)
// throws a BoardError with a `reason` the view words. Saving and validating a layout is the
// board store's (plan 0022 §C, boards.json with ajv, WI-0022-12); the domain has only the type.

import type { Run } from "../runs/run";

/** What a slot holds: a run card, a question inline, or result lines (design-system "Slot"). */
export type SlotKind = "card" | "question" | "result";

export const SLOT_KINDS: readonly SlotKind[] = ["card", "question", "result"];

/** S spans 4 of the 12 columns, M 6, L 12. */
export type SlotSize = "S" | "M" | "L";

export const SLOT_SIZES: readonly SlotSize[] = ["S", "M", "L"];

/** The id of the slot that lists the flow's run cards; no view node may have it. */
export const RUNS_SLOT_ID = "runs";

export interface BoardTab {
  readonly id: string;
  readonly name: string;
  /** Left to right, from 0. */
  readonly order: number;
}

export interface BoardSlot {
  /** The view node it shows, or RUNS_SLOT_ID for the run cards. */
  readonly viewNodeId: string;
  readonly kind: SlotKind;
  readonly size: SlotSize;
  /** Not drawn while viewing; still notifies and still counts. */
  readonly hidden: boolean;
  readonly tabId: string;
  /** Position within its tab, from 0. */
  readonly order: number;
}

export interface BoardLayout {
  readonly flowId: string;
  readonly tabs: readonly BoardTab[];
  readonly slots: readonly BoardSlot[];
}

/** A view node of the flow, as the runtime lists it (`flow.list` viewNodes). */
export interface ViewNode {
  readonly id: string;
  readonly kind: SlotKind;
  /** The size its package suggests; M when it suggests none. */
  readonly suggestedSize?: SlotSize;
}

/** Why a layout request cannot be done; the view words it (ui/strings.ts, WI-0022-10). */
export type BoardErrorReason = "last-tab" | "unknown-slot" | "unknown-tab";

/** A layout request that cannot be done. The message is for the log; `reason` is for the view. */
export class BoardError extends Error {
  override readonly name = "BoardError";
  constructor(
    readonly reason: BoardErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A new board: one tab, holding the run cards full width. The tab's name is the view's to choose
 * (ui/strings.ts, WI-0022-10): the domain names nothing a person reads.
 */
export function newLayout(flowId: string, firstTabName: string): BoardLayout {
  const tab: BoardTab = { id: "tab-1", name: firstTabName, order: 0 };
  return { flowId, tabs: [tab], slots: [runsSlot(tab.id, 0)] };
}

function runsSlot(tabId: string, order: number): BoardSlot {
  return { viewNodeId: RUNS_SLOT_ID, kind: "card", size: "L", hidden: false, tabId, order };
}

/** The tabs left to right. */
export function orderedTabs(layout: BoardLayout): BoardTab[] {
  return [...layout.tabs].sort((a, b) => a.order - b.order);
}

/** One tab's slots, in their order. */
export function slotsOfTab(layout: BoardLayout, tabId: string): BoardSlot[] {
  return layout.slots.filter((slot) => slot.tabId === tabId).sort((a, b) => a.order - b.order);
}

function firstTab(layout: BoardLayout): BoardTab {
  const [first] = orderedTabs(layout);
  if (first === undefined) {
    throw new BoardError("last-tab", "A board keeps at least one tab.");
  }
  return first;
}

function lastTab(layout: BoardLayout): BoardTab {
  return orderedTabs(layout).at(-1) ?? firstTab(layout);
}

function nextOrder(layout: BoardLayout, tabId: string): number {
  return slotsOfTab(layout, tabId).length;
}

/** Renumbers each tab's slots 0..n-1 in their current order, so orders never collide. */
function renumber(layout: BoardLayout): BoardLayout {
  const slots: BoardSlot[] = [];
  for (const tab of orderedTabs(layout)) {
    slotsOfTab(layout, tab.id).forEach((slot, order) => slots.push({ ...slot, order }));
  }
  return { ...layout, slots };
}

/** What `reconcile` changed, so Edit layout can say "New on the board: Approve sending." */
export interface Reconciled {
  readonly layout: BoardLayout;
  /** The view nodes that got a slot now, in the flow's order. */
  readonly added: readonly string[];
  /** The view nodes whose slot went with them. */
  readonly removed: readonly string[];
}

/**
 * Brings a layout in line with the flow's view nodes, keeping everything the person arranged:
 * a new view node appends a slot to the last tab at its suggested size; a removed view node
 * removes its slot; the run cards' slot is always there (put back in the first tab if missing).
 */
export function reconcile(layout: BoardLayout, viewNodes: readonly ViewNode[]): Reconciled {
  const wanted = new Map(viewNodes.map((node) => [node.id, node]));
  const removed = layout.slots
    .filter((slot) => slot.viewNodeId !== RUNS_SLOT_ID && !wanted.has(slot.viewNodeId))
    .map((slot) => slot.viewNodeId);
  let next: BoardLayout = {
    ...layout,
    slots: layout.slots.filter(
      (slot) => slot.viewNodeId === RUNS_SLOT_ID || wanted.has(slot.viewNodeId),
    ),
  };
  if (!next.slots.some((slot) => slot.viewNodeId === RUNS_SLOT_ID)) {
    const first = firstTab(next);
    next = { ...next, slots: [...next.slots, runsSlot(first.id, nextOrder(next, first.id))] };
  }
  const present = new Set(next.slots.map((slot) => slot.viewNodeId));
  const added: string[] = [];
  const tab = lastTab(next);
  for (const node of viewNodes) {
    if (present.has(node.id) || node.id === RUNS_SLOT_ID) {
      continue;
    }
    const slot: BoardSlot = {
      viewNodeId: node.id,
      kind: node.kind,
      size: node.suggestedSize ?? "M",
      hidden: false,
      tabId: tab.id,
      order: nextOrder(next, tab.id),
    };
    next = { ...next, slots: [...next.slots, slot] };
    present.add(node.id);
    added.push(node.id);
  }
  return { layout: renumber(next), added, removed };
}

function requireSlot(layout: BoardLayout, viewNodeId: string): BoardSlot {
  const slot = layout.slots.find((candidate) => candidate.viewNodeId === viewNodeId);
  if (slot === undefined) {
    throw new BoardError("unknown-slot", `This board has no slot for "${viewNodeId}".`);
  }
  return slot;
}

function requireTab(layout: BoardLayout, tabId: string): BoardTab {
  const tab = layout.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined) {
    throw new BoardError("unknown-tab", `This board has no tab "${tabId}".`);
  }
  return tab;
}

function changeSlot(
  layout: BoardLayout,
  viewNodeId: string,
  change: Partial<BoardSlot>,
): BoardLayout {
  requireSlot(layout, viewNodeId);
  return {
    ...layout,
    slots: layout.slots.map((slot) =>
      slot.viewNodeId === viewNodeId ? { ...slot, ...change } : slot,
    ),
  };
}

/**
 * Moves a slot to `tabId` at position `order` there (clamped to the tab's end); the others in
 * that tab shift to make room.
 */
export function moveSlot(
  layout: BoardLayout,
  viewNodeId: string,
  tabId: string,
  order: number,
): BoardLayout {
  const moving = requireSlot(layout, viewNodeId);
  requireTab(layout, tabId);
  const others = slotsOfTab(layout, tabId).filter((slot) => slot.viewNodeId !== viewNodeId);
  const at = Math.max(0, Math.min(order, others.length));
  const inTab = [...others.slice(0, at), { ...moving, tabId }, ...others.slice(at)];
  const placed = new Map(inTab.map((slot, index) => [slot.viewNodeId, { ...slot, order: index }]));
  const slots = layout.slots.map((slot) => placed.get(slot.viewNodeId) ?? slot);
  return renumber({ ...layout, slots });
}

export function resizeSlot(layout: BoardLayout, viewNodeId: string, size: SlotSize): BoardLayout {
  return changeSlot(layout, viewNodeId, { size });
}

export function hideSlot(layout: BoardLayout, viewNodeId: string): BoardLayout {
  return changeSlot(layout, viewNodeId, { hidden: true });
}

export function showSlot(layout: BoardLayout, viewNodeId: string): BoardLayout {
  return changeSlot(layout, viewNodeId, { hidden: false });
}

/** The hidden places, for Edit layout's "Hidden (2)". */
export function hiddenSlots(layout: BoardLayout): BoardSlot[] {
  return layout.slots.filter((slot) => slot.hidden);
}

/** Add tab: a tab after the others, with the next free id; the view chooses its name. */
export function addTab(layout: BoardLayout, name: string): { layout: BoardLayout; tabId: string } {
  const used = new Set(layout.tabs.map((tab) => tab.id));
  let number = layout.tabs.length + 1;
  while (used.has(`tab-${String(number)}`)) {
    number += 1;
  }
  const tabId = `tab-${String(number)}`;
  const order = layout.tabs.reduce((max, tab) => Math.max(max, tab.order + 1), 0);
  return { layout: { ...layout, tabs: [...layout.tabs, { id: tabId, name, order }] }, tabId };
}

export function renameTab(layout: BoardLayout, tabId: string, name: string): BoardLayout {
  requireTab(layout, tabId);
  return { ...layout, tabs: layout.tabs.map((tab) => (tab.id === tabId ? { ...tab, name } : tab)) };
}

/**
 * Remove tab: what was on it moves to the end of the first remaining tab; nothing is deleted.
 * The last tab cannot be removed.
 */
export function removeTab(layout: BoardLayout, tabId: string): BoardLayout {
  requireTab(layout, tabId);
  if (layout.tabs.length === 1) {
    throw new BoardError("last-tab", "A board keeps at least one tab.");
  }
  const tabs = orderedTabs(layout)
    .filter((tab) => tab.id !== tabId)
    .map((tab, order) => ({ ...tab, order }));
  const kept: BoardLayout = { ...layout, tabs };
  const target = firstTab(kept);
  let order = nextOrder(layout, target.id);
  const moved = slotsOfTab(layout, tabId).map((slot) => {
    const placed = { ...slot, tabId: target.id, order };
    order += 1;
    return placed;
  });
  const stay = layout.slots.filter((slot) => slot.tabId !== tabId);
  return renumber({ ...kept, slots: [...stay, ...moved] });
}

/** A question waiting for the person on this board, and whether its place is hidden. */
export interface WaitingQuestion {
  readonly flowId: string;
  readonly runId: string;
  /** The question step's instance: its view node, when it has a slot. */
  readonly viewNodeId: string;
  readonly question: string;
  readonly hidden: boolean;
}

/**
 * Every question of this flow's runs that waits for the person, hidden places included: hiding a
 * place never changes which questions are notified or counted. A cleared run is done, so it
 * never waits.
 */
export function waitingQuestions(layout: BoardLayout, runs: readonly Run[]): WaitingQuestion[] {
  const hidden = new Set(hiddenSlots(layout).map((slot) => slot.viewNodeId));
  const runsHidden = hidden.has(RUNS_SLOT_ID);
  const found: WaitingQuestion[] = [];
  for (const run of runs) {
    if (run.flowId !== layout.flowId || run.state !== "waiting") {
      continue;
    }
    for (const step of run.steps) {
      if (step.state !== "waiting") {
        continue;
      }
      found.push({
        flowId: run.flowId,
        runId: run.runId,
        viewNodeId: step.instanceId,
        question: step.question ?? "",
        hidden: hidden.has(step.instanceId) || runsHidden,
      });
    }
  }
  return found;
}

/** A hidden place that still holds something the person must see. */
export interface UrgentHidden {
  readonly viewNodeId: string;
  readonly runId: string;
  readonly reason: "waiting" | "failed";
}

/**
 * The hidden places that hold a waiting question or a failure: a question step's own place, or
 * the run cards' place when it is the one hidden. The view keeps telling the person about these.
 */
export function urgentHidden(layout: BoardLayout, runs: readonly Run[]): UrgentHidden[] {
  const hidden = new Set(hiddenSlots(layout).map((slot) => slot.viewNodeId));
  const urgent: UrgentHidden[] = [];
  for (const question of waitingQuestions(layout, runs)) {
    if (hidden.has(question.viewNodeId)) {
      urgent.push({ viewNodeId: question.viewNodeId, runId: question.runId, reason: "waiting" });
    }
    if (hidden.has(RUNS_SLOT_ID)) {
      urgent.push({ viewNodeId: RUNS_SLOT_ID, runId: question.runId, reason: "waiting" });
    }
  }
  for (const run of runs) {
    if (run.flowId !== layout.flowId || run.state !== "failed" || run.failure === null) {
      continue;
    }
    if (hidden.has(run.failure.instanceId)) {
      urgent.push({ viewNodeId: run.failure.instanceId, runId: run.runId, reason: "failed" });
    }
    if (hidden.has(RUNS_SLOT_ID)) {
      urgent.push({ viewNodeId: RUNS_SLOT_ID, runId: run.runId, reason: "failed" });
    }
  }
  return urgent;
}
