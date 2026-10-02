// The domain's structured values in words (plan 0022 §O): the run card's lines, a flow's health
// and last run, Setup's progress, the status pill, InnyTypes' own update line, a package row's
// state words and its refusals. Every sentence is a ui/strings.ts line; nothing here spells one.
//
// The UI imports the domain's types only (app/.dependency-cruiser.cjs), so a value made by the
// domain is accepted exactly as it is. A time the domain hands over as a Date (an update checked,
// a package updated) is placed on the person's calendar here, as the RelativeDay the domain's own
// phrases carry: telling "today" from "Tuesday" is wording.
import type { BoardErrorReason } from "../domain/board/layout";
import type { RelativeDay } from "../domain/flows/days";
import type { HealthPhrase, LastRunLine } from "../domain/flows/health";
import type {
  Installation,
  Package,
  PackageUpdate,
  Refusal as PackageRefusal,
  Registration,
  StepUse,
} from "../domain/packages/states";
import type { CardTitle, DonePill, FailureLine, StepLine } from "../domain/runs/card";
import type { StatusPill } from "../domain/status/status";
import type { RollbackOffer, UpdateState } from "../domain/updates/machine";
import type { Refusal } from "./answer";
import { plural, sentence, t, type PlainKey } from "./strings";

export type { CardTitle, CardVariant, DonePill, StepLine } from "../domain/runs/card";
export type { ResultLine, ResultSink, StepProgress } from "../domain/runs/run";

/** A note or a warning as the card lists it: the step that wrote it, and its words. */
export interface NoteLine {
  readonly step: string;
  readonly text: string;
}

/** Ends a sentence with a full stop unless it already ends as one, or trails off with "…". */
const close = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);
const two = (value: number) => String(value).padStart(2, "0");

/** "14:20". */
export const clockTime = (date: Date) => `${two(date.getHours())}:${two(date.getMinutes())}`;

const WEEKDAYS: readonly PlainKey[] = [
  "time.sunday",
  "time.monday",
  "time.tuesday",
  "time.wednesday",
  "time.thursday",
  "time.friday",
  "time.saturday",
];

/** "today", "yesterday", "Tuesday", or the date for anything a week or more away. */
export function wordDay(day: RelativeDay): string {
  switch (day.kind) {
    case "today":
      return t("time.today");
    case "yesterday":
      return t("time.yesterday");
    case "weekday":
      return t(WEEKDAYS[day.weekday] ?? "time.sunday");
    case "date":
      return isoDate(day.date);
  }
}

/** "2026-09-23": the absolute date a relative day shows on hover. */
export const isoDate = (date: Date) =>
  `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/**
 * The day of `then` as seen at `now`, in the person's local calendar: today, yesterday, a weekday
 * within the last seven days, else the date (a week or more ago, or in the future). Calendar days,
 * rounded, so a day across a daylight-saving change still counts as one.
 */
export function dayAt(then: Date, now: Date): RelativeDay {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(then).getTime()) / 86_400_000);
  if (days === 0) return { kind: "today" };
  if (days === 1) return { kind: "yesterday" };
  if (days > 1 && days < 7) return { kind: "weekday", weekday: then.getDay() };
  return { kind: "date", date: startOfDay(then) };
}

/** The day of `then` as seen at `now`, in words. */
export const dayOf = (then: Date, now: Date) => wordDay(dayAt(then, now));

// ── The run card ─────────────────────────────────────────────────────────────────────────────

export function wordTitle(title: CardTitle): string {
  return title.minutes === null
    ? title.name
    : t("card.title.minutes", { name: title.name, minutes: title.minutes });
}

/**
 * The step line in two parts: `lead`, drawn in bold (the step's name, or the state's word), and
 * `rest`. Together they are the whole sentence.
 */
export interface StepLineParts {
  readonly lead: string;
  readonly rest: string;
}

export function stepLineParts(line: StepLine): StepLineParts {
  switch (line.kind) {
    case "copying":
      return { lead: t("card.step.copying"), rest: ` ${line.text}` };
    case "copying-no-text":
      return { lead: t("card.step.copyingNoText"), rest: "" };
    case "safe-to-unplug":
      return { lead: t("card.step.safeToUnplug"), rest: "" };
    case "between-steps":
      return { lead: t("card.step.betweenSteps"), rest: "" };
    case "running":
      return runningParts(line);
    case "waiting":
      return { lead: t("card.step.waiting"), rest: ` ${line.question}` };
    case "failed":
      return {
        lead: t("card.step.failed"),
        rest: ` ${t("card.step.failedAt", { step: line.step, reason: close(line.reason) })}`,
      };
    case "resumed":
      return { lead: t("card.step.resumed"), rest: ` ${t("card.step.resumedRest")}` };
    case "done":
      return { lead: t("card.step.done"), rest: "" };
  }
}

function runningParts(line: Extract<StepLine, { kind: "running" }>): StepLineParts {
  let rest = "";
  if (line.text !== null) rest += ` ${line.text}`;
  if (line.progress !== null) {
    rest += ` ${t("card.step.progress", { done: line.progress.done, total: line.progress.total })}`;
  }
  if (line.timeLeftMinutes !== null) {
    rest += `, ${plural(line.timeLeftMinutes, "card.step.timeLeft")}`;
  }
  return rest === "" ? { lead: line.step, rest: "…" } : { lead: line.step, rest: close(rest) };
}

/** The whole step line as one sentence. */
export function wordStepLine(line: StepLine): string {
  const { lead, rest } = stepLineParts(line);
  return `${lead}${rest}`;
}

/** "Done." and the result lines in one sentence, as a notification or a summary says it. */
export function wordDoneLine(line: StepLine): string {
  if (line.kind !== "done" || line.results.length === 0) {
    return wordStepLine(line);
  }
  return `${t("card.step.done")} ${close(line.results.map((item) => item.text).join(", "))}`;
}

export function wordPill(pill: DonePill): string {
  switch (pill.kind) {
    case "done":
      return t("card.pill.done");
    case "notes":
      return plural(pill.count, "card.pill.notes");
    case "warnings":
      return plural(pill.count, "card.pill.warnings");
  }
}

/** Run history's sentence under a failed row. */
export const wordFailure = (failure: FailureLine) =>
  t("history.failedLine", { step: failure.step, reason: close(failure.reason) });

/**
 * A result line's text split for the Result line molecule: `what` before the *place*, the place
 * itself as `where`. The molecule draws the Anytype arrow itself, so a trailing "→" is dropped.
 */
export function resultParts(text: string): { what: string; where?: string } {
  const match = /^(.*?)\s*\*([^*]+)\*\s*$/.exec(text);
  if (match === null) {
    return { what: text };
  }
  const what = (match[1] ?? "").replace(/\s*→$/, "");
  return { what, where: match[2] ?? "" };
}

// ── Flows, Setup, status, board ──────────────────────────────────────────────────────────────

export function wordHealth(phrase: HealthPhrase): string {
  switch (phrase.kind) {
    case "ready":
      return t("flows.health.ready");
    case "steps-not-set-up":
      return plural(phrase.count, "flows.health.notSetUp");
    case "no-source":
      return t("flows.health.noSource");
    case "failing-since":
      return t("flows.health.failingSince", { day: wordDay(phrase.day) });
  }
}

const RUN_STATE: Record<LastRunLine["state"], PlainKey> = {
  copying: "runState.copying",
  running: "runState.running",
  waiting: "runState.waiting",
  failed: "runState.failed",
  done: "runState.done",
};

export function wordLastRun(line: LastRunLine): string {
  return t("flows.lastRun", {
    day: wordDay(line.day),
    time: clockTime(line.startedAt),
    state: t(RUN_STATE[line.state]),
  });
}

export const wordFormProgress = (progress: { readonly step: number; readonly of: number }) =>
  t("setup.form.progress", { step: progress.step, of: progress.of });

const STATUS: Record<StatusPill, PlainKey> = {
  running: "status.running",
  restarting: "status.restarting",
  stopped: "status.stopped",
  needsAttention: "status.needsAttention",
};

export const wordStatus = (pill: StatusPill) => t(STATUS[pill]);

/** A board change refused; only the last tab has a sentence a person can be shown. */
export const wordBoardError = (reason: BoardErrorReason): string | undefined =>
  reason === "last-tab" ? t("board.lastTab") : undefined;

// ── InnyTypes' own update ────────────────────────────────────────────────────────────────────

export function wordUpdateState(state: UpdateState, now: Date): string {
  switch (state.kind) {
    case "unchecked":
      return t("update.unchecked", { version: state.version });
    case "up-to-date":
      return t("update.upToDate", {
        version: state.version,
        day: dayOf(state.checkedAt, now),
        time: clockTime(state.checkedAt),
      });
    case "checking":
      return t("update.checking");
    case "downloading":
      return t("update.downloading", { version: state.version, percent: state.percent });
    case "ready":
      return t("update.ready", { version: state.version });
    case "check-failed": {
      const why =
        state.reason === "no-connection"
          ? t("update.checkFailed.noConnection")
          : t("update.checkFailed.unreadable");
      return state.lastCheckedAt === null
        ? why
        : `${why} ${t("update.lastChecked", { day: dayOf(state.lastCheckedAt, now) })}`;
    }
    case "install-failed":
      return t("update.installFailed", { version: state.version });
    case "updated":
      return t("update.updated", { version: state.version, day: dayOf(state.at, now) });
    case "rolling-back":
      return t("update.rollingBack", { version: state.to });
  }
}

export const wordUpdateGoBack = (offer: RollbackOffer) => ({
  button: t("general.goBack", { version: offer.to }),
  confirm: t("general.goBack.confirm", { version: offer.to }),
});

// ── A package's row ──────────────────────────────────────────────────────────────────────────

export const wordRegistration = (registration: Registration) =>
  t(registration.state === "registered" ? "packages.registered" : "packages.notRegistered");

export function wordInstallation(installation: Installation): string {
  switch (installation.state) {
    case "installed":
      return t("packages.installed");
    case "not-installed":
      return t("packages.notInstalled");
    case "installing":
      return t("packages.installing", { percent: installation.progress });
    case "verifying":
      return t("packages.verifying");
    case "failed-check":
      return t("packages.failedCheck");
  }
}

export function wordPackageUpdate(update: PackageUpdate, now: Date): string {
  switch (update.state) {
    case "up-to-date":
      return t("packages.upToDate");
    case "available":
      return t("packages.available", { version: update.version });
    case "updating":
      return t("packages.updating");
    case "updated":
      return t("packages.updated", { version: update.version, day: dayOf(update.at, now) });
  }
}

/** The captions under a row's name: where it came from, and whether anyone vouches for it. */
export function wordCaptions(pkg: Package): string[] {
  const captions: string[] = [];
  if (pkg.source.kind === "folder") {
    captions.push(t("packages.fromFolder.caption", { path: pkg.source.path }));
  }
  if (!pkg.signed) captions.push(t("packages.unsigned"));
  return captions;
}

/** "A uses its X step", joined: two with "and", three or more with commas and a last "and". */
function joinUses(uses: readonly StepUse[]): string {
  const parts = uses.map((use) => t("packages.inUse.use", { flow: use.flow, step: use.step }));
  const last = parts.pop() ?? "";
  if (parts.length === 0) {
    return last;
  }
  const list = parts.reduce((joined, next) => t("packages.inUse.comma", { list: joined, next }));
  return t("packages.inUse.and", { list, last });
}

/** A package refusal's sentence; null for a refusal no screen shows (the row's state says it). */
export function wordPackageRefusal(name: string, refusal: PackageRefusal): string | null {
  switch (refusal.reason) {
    case "in-use": {
      const action = t(
        refusal.action === "unregister" ? "packages.action.unregister" : "packages.action.remove",
      );
      const only = refusal.uses.length === 1 ? refusal.uses[0] : undefined;
      return only === undefined
        ? t("packages.inUse.many", { action, name, uses: joinUses(refusal.uses) })
        : t("packages.inUse.one", { action, name, flow: only.flow, step: only.step });
    }
    case "shipped":
      return t("packages.shipped", { name });
    default:
      return null;
  }
}

export const wordPackageGoBack = (
  name: string,
  update: Extract<PackageUpdate, { state: "updated" }>,
) => ({
  button: t("packages.goBack", { version: update.previous }),
  confirm: t("packages.goBack.confirm", { name, version: update.previous }),
});

/** An AppApi refusal in words: its line, with its slots filled; D6's in-use names every use. */
export function wordRefusal(refusal: Refusal): string {
  if (refusal.inUse !== undefined) {
    const { name, action, uses } = refusal.inUse;
    return wordPackageRefusal(name, { reason: "in-use", action, uses }) ?? "";
  }
  return refusal.params === undefined
    ? sentence({ key: refusal.sentence })
    : sentence({ key: refusal.sentence, params: refusal.params });
}
