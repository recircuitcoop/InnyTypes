// Configuration › Flows (plan 0022 §D, ux-writing "Configuration › Flows"): what `flow.list`
// answers, as the Flows list draws it. The flow's name, its switch, "Last run: today, 14:20 ·
// done" and its health in one phrase with the pill's look; a flow that never ran has no Last run
// line (ux-writing gives none).
import type { StatusPillState } from "../components/atoms/StatusPill";
import type { FlowsListRow } from "../components/organisms/FlowsList";
import type { FlowSummary } from "../flow-contract";
import { dayAt, wordHealth, wordLastRun } from "../words";

/**
 * The health pill's look: Ready is calm (done), a flow that cannot run as drawn waits for the
 * person (waiting), a failing one is red. The word always says which.
 */
export const HEALTH_LOOK: Readonly<Record<FlowSummary["health"]["kind"], StatusPillState>> = {
  ready: "done",
  "steps-not-set-up": "waiting",
  "no-source": "waiting",
  "failing-since": "failed",
};

/** The health phrase, its day placed on the person's calendar at `now`. */
function healthWords(health: FlowSummary["health"], now: Date): string {
  return health.kind === "failing-since"
    ? wordHealth({ kind: "failing-since", day: dayAt(health.since, now) })
    : wordHealth(health);
}

export function flowRow(flow: FlowSummary, now: Date): FlowsListRow {
  const last = flow.lastRun;
  return {
    id: flow.id,
    name: flow.name,
    on: flow.on,
    lastRun:
      last === null
        ? ""
        : wordLastRun({
            day: dayAt(last.startedAt, now),
            startedAt: last.startedAt,
            state: last.state,
          }),
    health: healthWords(flow.health, now),
    healthState: HEALTH_LOOK[flow.health.kind],
  };
}

/** The template Blank canvas makes; it is not offered again as a card under From a template. */
export const BLANK_TEMPLATE = "blank";
