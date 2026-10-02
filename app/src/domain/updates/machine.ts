// InnyTypes' own update, as one state machine (plan 0022 §A "domain/updates/", §G; ux-writing
// "Configuration › General", Updates; design-system "Configuration › General section"). Values
// only: every state's sentence ("Up to date · 0.2.1 · checked today 09:14", "Checking…", …) is
// ui/strings.ts's (WI-0022-10), listed state by state in
// app/test/unit/domain/wording.fixture.test.ts, which fails when a state has no sentence.
//
// States and transitions (events in brackets):
//
//   unchecked, up-to-date, check-failed, install-failed, updated ─[check]─► checking
//   checking ─[found null]─► up-to-date          checking ─[found v]─► downloading
//   downloading ─[progress]─► downloading         downloading ─[downloaded]─► ready
//   ready ─[quitAndInstall]─► ready (the shell quits and installs; the next start reports it)
//   checking, downloading ─[failed no-connection | unreadable]─► check-failed
//   downloading, ready, rolling-back ─[failed safety-check]─► install-failed
//   any ─[installed]─► updated (reported at the first start on a new version)
//   any but downloading, rolling-back ─[goBack, while offered]─► rolling-back
//   any ─[crashLoopDetected, within 10 minutes of the first start]─► same state, offer raised
//
// Owner decision D4: Go back installs the previous signed release and is offered for seven days
// after an update. The runtime's crash-loop limit within ten minutes of the first start on a new
// version OFFERS it (the banner and one notice); nothing here ever applies it. Go back is always
// an event the person caused.
//
// The Go back offer is not a state: it lives in `previous` beside the state, so checking again
// after an update ("Checking…", "Up to date") keeps the offer for its seven days.
//
// `unchecked` is the state before the first check ever made (the "Check automatically" switch is
// off by default, domain/update/policy.ts); ux-writing has no sentence for it, WI-0022-10 decides.

/** How long Go back is offered after an update (D4). */
export const ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How soon after the first start on a new version a crash loop offers Go back (D4). */
export const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;

/** Why a check or a download could not finish; "no connection" is ux-writing's one sentence. */
export type CheckFailure = "no-connection" | "unreadable";

export type UpdateState =
  | { readonly kind: "unchecked"; readonly version: string }
  | { readonly kind: "up-to-date"; readonly version: string; readonly checkedAt: Date }
  | { readonly kind: "checking" }
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  /** Downloaded and verified: it installs when you quit. */
  | { readonly kind: "ready"; readonly version: string }
  | {
      readonly kind: "check-failed";
      readonly reason: CheckFailure;
      readonly lastCheckedAt: Date | null;
    }
  | { readonly kind: "install-failed"; readonly version: string; readonly reason: "safety-check" }
  /**
   * The first start on `version`, made at `at` from `previous`. `rollbackUntil` is null after a
   * Go back: the version it left is offered again as an update, never as a Go back.
   */
  | {
      readonly kind: "updated";
      readonly version: string;
      readonly at: Date;
      readonly previous: string;
      readonly rollbackUntil: Date | null;
    }
  | { readonly kind: "rolling-back"; readonly to: string };

export type UpdateStateKind = UpdateState["kind"];

export const UPDATE_STATE_KINDS: readonly UpdateStateKind[] = [
  "unchecked",
  "up-to-date",
  "checking",
  "downloading",
  "ready",
  "check-failed",
  "install-failed",
  "updated",
  "rolling-back",
];

/** The release Go back returns to, recorded at the first start on the new version. */
export interface PreviousRelease {
  readonly version: string;
  /** The first start on the version that replaced it: the crash-loop window starts here. */
  readonly firstStartedAt: Date;
  readonly rollbackUntil: Date;
}

export interface UpdateMachine {
  /** The version running now. */
  readonly current: string;
  readonly state: UpdateState;
  /** The last check that finished, for "Last checked Monday." */
  readonly lastCheckedAt: Date | null;
  /** Null when there is nothing to go back to. */
  readonly previous: PreviousRelease | null;
  /** When the runtime's crash-loop limit was reached within the window, if it was. */
  readonly crashLoopAt: Date | null;
}

export type UpdateEvent =
  | { readonly kind: "check" }
  /** The check finished: a newer version, or null for none. */
  | { readonly kind: "found"; readonly version: string | null; readonly at: Date }
  | { readonly kind: "progress"; readonly percent: number }
  | { readonly kind: "downloaded" }
  | { readonly kind: "quitAndInstall" }
  | { readonly kind: "failed"; readonly reason: CheckFailure | "safety-check" }
  /**
   * Reported at the first start on a new version. `wentBack` is true when that version is the
   * one Go back returned to.
   */
  | {
      readonly kind: "installed";
      readonly version: string;
      readonly previous: string;
      readonly at: Date;
      readonly wentBack: boolean;
    }
  | { readonly kind: "crashLoopDetected"; readonly at: Date }
  | { readonly kind: "goBack"; readonly at: Date };

export type UpdateEventKind = UpdateEvent["kind"];

/** Whether the machine took the event; an event it did not take leaves it as it was. */
export interface StepResult {
  readonly accepted: boolean;
  readonly machine: UpdateMachine;
}

/** The machine at start: what is running, what was last checked, what Go back returns to. */
export function startMachine(options: {
  readonly current: string;
  readonly lastCheckedAt: Date | null;
  readonly previous: PreviousRelease | null;
}): UpdateMachine {
  const state: UpdateState =
    options.lastCheckedAt === null
      ? { kind: "unchecked", version: options.current }
      : { kind: "up-to-date", version: options.current, checkedAt: options.lastCheckedAt };
  return {
    current: options.current,
    state,
    lastCheckedAt: options.lastCheckedAt,
    previous: options.previous,
    crashLoopAt: null,
  };
}

/** The states a check may start from: none with work under way. */
const AT_REST: ReadonlySet<UpdateStateKind> = new Set<UpdateStateKind>([
  "unchecked",
  "up-to-date",
  "check-failed",
  "install-failed",
  "updated",
]);

/** A whole percentage between 0 and 100. */
function wholePercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

const accept = (machine: UpdateMachine): StepResult => ({ accepted: true, machine });
const ignore = (machine: UpdateMachine): StepResult => ({ accepted: false, machine });
const moveTo = (machine: UpdateMachine, state: UpdateState): StepResult =>
  accept({ ...machine, state });

function onFailed(machine: UpdateMachine, reason: CheckFailure | "safety-check"): StepResult {
  const state = machine.state;
  if (reason === "safety-check") {
    if (state.kind === "downloading" || state.kind === "ready") {
      return moveTo(machine, { kind: "install-failed", version: state.version, reason });
    }
    if (state.kind === "rolling-back") {
      return moveTo(machine, { kind: "install-failed", version: state.to, reason });
    }
    return ignore(machine);
  }
  if (state.kind === "checking" || state.kind === "downloading") {
    return moveTo(machine, {
      kind: "check-failed",
      reason,
      lastCheckedAt: machine.lastCheckedAt,
    });
  }
  return ignore(machine);
}

function onInstalled(
  machine: UpdateMachine,
  event: Extract<UpdateEvent, { kind: "installed" }>,
): StepResult {
  const rollbackUntil = event.wentBack ? null : new Date(event.at.getTime() + ROLLBACK_WINDOW_MS);
  return accept({
    current: event.version,
    state: {
      kind: "updated",
      version: event.version,
      at: event.at,
      previous: event.previous,
      rollbackUntil,
    },
    lastCheckedAt: machine.lastCheckedAt,
    // After a Go back there is nothing to go back to: the version it left is an update again.
    previous:
      rollbackUntil === null
        ? null
        : { version: event.previous, firstStartedAt: event.at, rollbackUntil },
    crashLoopAt: null,
  });
}

/** Applies one event. An event the state does not take is not accepted and changes nothing. */
export function step(machine: UpdateMachine, event: UpdateEvent): StepResult {
  const state = machine.state;
  switch (event.kind) {
    case "check":
      return AT_REST.has(state.kind) ? moveTo(machine, { kind: "checking" }) : ignore(machine);
    case "found":
      if (state.kind !== "checking") {
        return ignore(machine);
      }
      return accept({
        ...machine,
        lastCheckedAt: event.at,
        state:
          event.version === null
            ? { kind: "up-to-date", version: machine.current, checkedAt: event.at }
            : { kind: "downloading", version: event.version, percent: 0 },
      });
    case "progress":
      if (state.kind !== "downloading") {
        return ignore(machine);
      }
      return moveTo(machine, { ...state, percent: wholePercent(event.percent) });
    case "downloaded":
      if (state.kind !== "downloading") {
        return ignore(machine);
      }
      return moveTo(machine, { kind: "ready", version: state.version });
    case "quitAndInstall":
      // The shell quits and installs; the state stays until the next start reports `installed`.
      return state.kind === "ready" ? accept(machine) : ignore(machine);
    case "failed":
      return onFailed(machine, event.reason);
    case "installed":
      return onInstalled(machine, event);
    case "crashLoopDetected":
      if (!crashLoopCounts(machine.previous, event.at)) {
        return ignore(machine);
      }
      // Offered, never applied: the state does not move.
      return accept({ ...machine, crashLoopAt: event.at });
    case "goBack": {
      const offer = rollbackOffer(machine, event.at);
      if (offer === null || state.kind === "downloading" || state.kind === "rolling-back") {
        return ignore(machine);
      }
      return moveTo(machine, { kind: "rolling-back", to: offer.to });
    }
  }
}

/** A crash loop offers Go back only within ten minutes of the first start on a new version. */
function crashLoopCounts(previous: PreviousRelease | null, at: Date): boolean {
  if (previous === null) {
    return false;
  }
  const since = at.getTime() - previous.firstStartedAt.getTime();
  return since >= 0 && since <= CRASH_LOOP_WINDOW_MS;
}

/**
 * Go back, when it is offered: for seven days after an update, whether or not a crash loop within
 * ten minutes of the first start raised it. `because` says which, so the banner and the notice can
 * offer it after a crash loop while Configuration › General offers it all week.
 */
export interface RollbackOffer {
  readonly to: string;
  readonly because: "recent-update" | "crash-loop";
  /** The end of the seven days, for either reason: after it, Go back is no longer offered. */
  readonly until: Date;
}

export function rollbackOffer(machine: UpdateMachine, now: Date): RollbackOffer | null {
  const previous = machine.previous;
  if (previous === null) {
    return null;
  }
  // D4: offered for seven days, whatever raised it; a crash loop only changes why.
  if (now.getTime() >= previous.rollbackUntil.getTime()) {
    return null;
  }
  const because = machine.crashLoopAt === null ? "recent-update" : "crash-loop";
  return { to: previous.version, because, until: previous.rollbackUntil };
}
