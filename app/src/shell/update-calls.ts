// InnyTypes' own update, as General shows it (plan 0022 §G): domain/updates' state machine, fed by
// every check UpdateCheck makes (Check now and the scheduled ones alike), and pushed to the page
// at each step.
//
// * Check now checks even with "Check automatically" off: the person asked (plan 0003).
// * Quit and update quits when an update is ready; the quit installs it (QuitFlow's exit calls
//   UpdateCheck.installAtQuit).
// * Go back (D4): offered for seven days after the first start on a new version, which this file
//   records (domain/updates/history.ts). It verifies the older release exactly as an update is
//   verified (UpdateCheck.goBack); only a verified one is staged, and InnyTypes then quits to
//   install it. A release that does not verify is refused and nothing is installed.
// * The crash-loop offer: the runtime reaching its crash-loop limit within ten minutes of the
//   first start on a new version raises one notice and puts Go back in the banner (the page reads
//   `goBack.because`). Never applied: Go back is always the person's own press.
import type { IpcMain } from "electron";
import type { UpdateCheck } from "../application/update-check";
import type { Supervisor } from "../application/supervisor";
import { parseUpdatePolicy } from "../domain/update/policy";
import {
  atStart,
  parseUpdateHistory,
  previousRelease,
  releaseTag,
  serialiseUpdateHistory,
  type UpdateHistory,
} from "../domain/updates/history";
import {
  rollbackOffer,
  startMachine,
  step,
  type UpdateEvent,
  type UpdateMachine,
} from "../domain/updates/machine";
import type { Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { UpdateHistoryStore, UpdateSettingsStore } from "../ports/settings-store";
import type { Answer } from "../ui/answer";
import type { UpdateView } from "../ui/general-contract";
import { guarded, notAvailable, opOf, refused, unknownOp } from "./answer";
import { IPC } from "./ipc";

const NOTICE_SUBJECT = "InnyTypes";

export interface UpdateCallsDeps {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly toPage: (channel: string, ...args: unknown[]) => void;
  /** The version running now. */
  readonly currentVersion: () => string;
  readonly clock: Pick<Clock, "now">;
  /** shell-settings.json: the install record and the "Check automatically" switch. */
  readonly settings: UpdateHistoryStore & UpdateSettingsStore;
  /** The runtime's supervisor: its crash-loop limit raises the Go back offer. */
  readonly runtime: Pick<Supervisor, "onStatus">;
  readonly notifier: Notifier;
  /** Open the release notes of the release tagged `tag` in the browser. */
  readonly openReleaseNotes: (tag: string) => void;
  /** Quit InnyTypes; the quit installs a ready update, or the verified older release. */
  readonly quit: () => void;
  readonly logger: Logger;
}

export interface UpdateCalls {
  /** UpdateCheck's `onEvent`: each step of a check moves the state, and the page is told. */
  onEvent(event: UpdateEvent): void;
  /** The check itself, once built; null on a platform that does not self-update. */
  attach(updates: Pick<UpdateCheck, "check" | "goBack"> | null): void;
}

/** Reads the install record and judges this start against it; the record is written back. */
function startOf(deps: UpdateCallsDeps): { history: UpdateHistory; machine: UpdateMachine } {
  const { settings, logger } = deps;
  const current = deps.currentVersion();
  const now = new Date(deps.clock.now());
  let stored: UpdateHistory;
  try {
    stored = parseUpdateHistory(settings.readUpdateHistory());
  } catch (error) {
    logger.warn(`update: the install record cannot be read: ${String(error)}`);
    stored = parseUpdateHistory(undefined);
  }
  const start = atStart(stored, current, now);
  const machine = startMachine({
    current,
    lastCheckedAt: start.history.lastCheckedAt,
    previous: start.installed === null ? previousRelease(start.history) : null,
  });
  if (start.installed !== null) {
    logger.info(`update: first start on ${current}, updated from ${start.installed.previous}`);
  }
  return {
    history: start.history,
    machine: start.installed === null ? machine : step(machine, start.installed).machine,
  };
}

export function wireUpdateCalls(deps: UpdateCallsDeps): UpdateCalls {
  const { ipc, toPage, clock, settings, notifier, logger } = deps;
  let { history, machine } = startOf(deps);
  let updates: Pick<UpdateCheck, "check" | "goBack"> | null = null;
  const remember = (next: UpdateHistory): void => {
    history = next;
    try {
      settings.writeUpdateHistory(serialiseUpdateHistory(next));
    } catch (error) {
      logger.warn(`update: the install record cannot be written: ${String(error)}`);
    }
  };
  remember(history);

  const autoCheck = (): boolean => {
    try {
      return parseUpdatePolicy(settings.readUpdate()).autoCheck;
    } catch {
      return false;
    }
  };
  const view = (): UpdateView => ({
    state: machine.state,
    goBack: rollbackOffer(machine, new Date(clock.now())),
    autoCheck: autoCheck(),
  });
  const onEvent = (event: UpdateEvent): void => {
    const result = step(machine, event);
    if (!result.accepted) {
      logger.info(`update: ${event.kind} does not apply in ${machine.state.kind}; ignored`);
      return;
    }
    machine = result.machine;
    if (event.kind === "found") {
      remember({ ...history, lastCheckedAt: event.at });
    }
    toPage(IPC.updateStateChanged, view());
  };

  // The crash-loop offer: once, when the runtime gives up within the window; never applied.
  deps.runtime.onStatus((status) => {
    if (status.state !== "down-for-good" || machine.crashLoopAt !== null) {
      return;
    }
    onEvent({ kind: "crashLoopDetected", at: new Date(clock.now()) });
    const offer = rollbackOffer(machine, new Date(clock.now()));
    if (machine.crashLoopAt !== null && offer !== null) {
      notifier.raise({ kind: "core-crash-loop", subject: NOTICE_SUBJECT, version: offer.to });
    }
  });

  const goBack = async (): Promise<Answer<UpdateView>> => {
    const previous = history.previous;
    const result = step(machine, { kind: "goBack", at: new Date(clock.now()) });
    if (updates === null) {
      return notAvailable(); // this platform does not self-update (WI-0025-01)
    }
    if (!result.accepted || previous === null) {
      return refused("nothing-to-do", "update.goBackGone");
    }
    machine = result.machine;
    remember({ ...history, goingBackTo: previous.version });
    toPage(IPC.updateStateChanged, view());
    notifier.clear("core-crash-loop", NOTICE_SUBJECT);
    const outcome = await updates.goBack({ version: previous.version, tag: previous.tag });
    if (!outcome.ok) {
      // Refused or unreachable: the state already says which; nothing is installed.
      remember({ ...history, goingBackTo: null });
      return { ok: true, value: view() };
    }
    logger.info(`update: going back to ${previous.version} at quit`);
    deps.quit();
    return { ok: true, value: view() };
  };

  ipc.handle(IPC.updateCall, (_event, call: unknown) => {
    const { op, args } = opOf(call);
    return guarded(op, logger, async (): Promise<Answer<UpdateView | null>> => {
      switch (op) {
        case "update.state":
          return { ok: true, value: view() };
        case "update.checkNow":
          if (updates === null) {
            return notAvailable(); // this platform does not self-update (WI-0025-01)
          }
          await updates.check({ manual: true });
          return { ok: true, value: view() };
        case "update.quit":
          if (machine.state.kind !== "ready") {
            return refused("nothing-to-do", "update.notReady");
          }
          onEvent({ kind: "quitAndInstall" });
          deps.quit();
          return { ok: true, value: null };
        case "update.goBack":
          return goBack();
        case "update.setAutoCheck": {
          const on = args["on"];
          if (typeof on !== "boolean") {
            return refused("failed", "refused.failed");
          }
          const policy = parseUpdatePolicy(settings.readUpdate());
          settings.writeUpdate({ auto_check: on, channel: policy.channel });
          const next = view();
          toPage(IPC.updateStateChanged, next);
          return { ok: true, value: next };
        }
        case "update.releaseNotes":
          deps.openReleaseNotes(releaseTag(machine.current));
          return { ok: true, value: null };
        default:
          return unknownOp(op, "update", logger);
      }
    });
  });
  return {
    onEvent,
    attach: (check) => {
      updates = check;
    },
  };
}
