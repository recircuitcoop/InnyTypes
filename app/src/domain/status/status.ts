// The status pill, the runtime banner and the Live badge (plan 0022 §I). Values only: the pill's
// word (ux-writing "Navigation and page titles": Running, Restarting…, Stopped, Needs attention)
// is ui/strings.ts's (WI-0022-10), listed in app/test/unit/domain/wording.fixture.test.ts.
//
// Derived from what is already supervised; nothing new is watched. The pill's rules, in the order
// they are checked (the first that holds wins, so the worse news is never hidden by milder news):
// 1. Stopped: no runtime is reported, or the runtime is down for good or stopped. No flow runs.
// 2. Restarting…: a child is starting, restarting or recovering, or waiting out its backoff.
// 3. Needs attention: the runtime runs but something it relies on does not — the services process
//    is down for good, or Anytype has no key, cannot be reached, lists other tools than expected,
//    or its MCP child is down.
// 4. Running.
//
// The Live badge counts the questions waiting for the person across all flows, hidden places
// included (a hidden place never hides a question), and never a cleared run.

import type { AnytypeState, AnytypeStatus } from "../anytype/status";
import type { Run } from "../runs/run";
import type { ChildState, ChildStatus } from "../supervision/child-state";

export type StatusPill = "running" | "restarting" | "stopped" | "needsAttention";

export const STATUS_PILLS: readonly StatusPill[] = [
  "running",
  "restarting",
  "stopped",
  "needsAttention",
];

/** What the pill is derived from. `anytype` is null until the services process reports it. */
export interface StatusInputs {
  readonly children: readonly ChildStatus[];
  readonly anytype: AnytypeStatus | null;
}

/** A child on its way back: the pill says Restarting… while any child is in one of these. */
const COMING_BACK: ReadonlySet<ChildState> = new Set<ChildState>([
  "starting",
  "restarting-planned",
  "restarting",
  "recovering",
  "down",
]);

/** The Anytype states a person has to do something about (or wait out) while the runtime runs. */
const ANYTYPE_NEEDS_ATTENTION: ReadonlySet<AnytypeState> = new Set<AnytypeState>([
  "no-key",
  "unreachable",
  "tool-surface-mismatch",
  "down",
  "down-for-good",
]);

function child(inputs: StatusInputs, name: ChildStatus["child"]): ChildStatus | null {
  return inputs.children.find((status) => status.child === name) ?? null;
}

export function statusPill(inputs: StatusInputs): StatusPill {
  const runtime = child(inputs, "runtime");
  if (runtime === null || runtime.state === "down-for-good" || runtime.state === "stopped") {
    return "stopped";
  }
  if (inputs.children.some((status) => COMING_BACK.has(status.state))) {
    return "restarting";
  }
  const services = child(inputs, "services");
  if (services !== null && services.state === "down-for-good") {
    return "needsAttention";
  }
  if (inputs.anytype !== null && ANYTYPE_NEEDS_ATTENTION.has(inputs.anytype.state)) {
    return "needsAttention";
  }
  return "running";
}

/**
 * The runtime banner (design-system "Runtime banner"): Restarting after a crash, Down once the
 * crash-loop limit stopped the restarts, or none. A planned restart (after a package change) is
 * not news, so it shows no banner; the pill says Restarting… meanwhile.
 */
export type RuntimeBanner = "restarting" | "down";

export function runtimeBanner(children: readonly ChildStatus[]): RuntimeBanner | null {
  const runtime = children.find((status) => status.child === "runtime");
  if (runtime === undefined) {
    return null;
  }
  if (runtime.state === "down-for-good") {
    return "down";
  }
  if (runtime.state === "recovering" || runtime.state === "down") {
    return "restarting";
  }
  return null;
}

/** The Live badge: every question waiting for the person, in every flow, hidden or not. */
export function liveBadgeCount(runs: readonly Run[]): number {
  let count = 0;
  for (const run of runs) {
    if (run.state !== "waiting" || run.cleared) {
      continue;
    }
    // A run may ask two questions at once; each is one thing waiting for the person.
    count += run.steps.filter((step) => step.state === "waiting").length;
  }
  return count;
}
