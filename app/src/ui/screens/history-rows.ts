// Configuration › Flows › Run history (plan 0022 §E; ux-writing "Configuration › Flows › Run
// history"): what `run.list` answers, as the Run history table draws it, and the filter row's
// choices as `run.list` asks them. When ("Tuesday 14:20"), the event, Took ("12 min"), the state
// pill, the notes and warnings pills, a failed row's sentence, and a re-run's caption naming
// when the run it re-runs started ("Re-run Tuesday 14:30").
import type { StatusPillState } from "../components/atoms/StatusPill";
import type { SegmentOption } from "../components/molecules/SegmentedControl";
import type { RunHistoryRow } from "../components/organisms/RunHistory";
import type { RunListQuery, RunRecord } from "../run-contract";
import { plural, t, type PlainKey } from "../strings";
import { clockTime, dayOf, wordFailure } from "../words";

/** The segmented control's filters: every run, or one state. */
export type HistoryFilter = "all" | "waiting" | "failed" | "done";

const FILTER_KEYS: Readonly<Record<HistoryFilter, PlainKey>> = {
  all: "history.filter.all",
  waiting: "history.filter.waiting",
  failed: "history.filter.failed",
  done: "history.filter.done",
};

export const HISTORY_FILTERS: readonly SegmentOption[] = (
  Object.keys(FILTER_KEYS) as HistoryFilter[]
).map((value) => ({ value, label: t(FILTER_KEYS[value]) }));

/** The date range's choices, in days, and Any time; Last 7 days is where it starts. */
const RANGE_DAYS = [7, 30, 90] as const;
export const ANY_TIME = "any";
export const FIRST_RANGE = "7";

export const HISTORY_RANGES: readonly { readonly value: string; readonly label: string }[] = [
  ...RANGE_DAYS.map((days) => ({
    value: String(days),
    label: t("history.range.days", { n: days }),
  })),
  { value: ANY_TIME, label: t("history.range.any") },
];

/** The days a range covers; null for Any time. */
export const rangeDays = (range: string): number | null =>
  range === ANY_TIME ? null : Number(range);

/** How many runs one page of Run history holds: `run.list`'s largest. */
export const HISTORY_PAGE = 200;

/** The filter row as `run.list` asks it, at `now`. */
export function historyQuery(
  flowId: string,
  filter: HistoryFilter,
  range: string,
  search: string,
  now: Date,
): RunListQuery {
  const days = rangeDays(range);
  return {
    flowId,
    limit: HISTORY_PAGE,
    ...(filter === "all" ? {} : { state: filter }),
    ...(days === null ? {} : { since: now.getTime() - days * 86_400_000 }),
    ...(search.trim() === "" ? {} : { search: search.trim() }),
  };
}

/** A run's state as its pill looks: copying runs, as running does. */
const STATE_LOOK: Readonly<Record<RunRecord["state"], StatusPillState>> = {
  copying: "running",
  running: "running",
  waiting: "waiting",
  failed: "failed",
  done: "done",
};

const STATE_KEYS: Readonly<Record<RunRecord["state"], PlainKey>> = {
  copying: "history.state.copying",
  running: "history.state.running",
  waiting: "history.state.waiting",
  failed: "history.state.failed",
  done: "history.state.done",
};

/** "Tuesday 14:20", the day placed on the person's calendar at `now`. */
const when = (date: Date, now: Date) =>
  t("history.when", { day: dayOf(date, now), time: clockTime(date) });

/**
 * One row. `original` is the run this one re-runs, when it is among the runs read: its start
 * names the caption.
 */
export function historyRow(
  run: RunRecord,
  now: Date,
  selected: boolean,
  original: RunRecord | undefined,
): RunHistoryRow {
  const notes = [
    ...(run.notes.length === 0
      ? []
      : [{ state: "off" as const, label: plural(run.notes.length, "card.pill.notes") }]),
    ...(run.warnings.length === 0
      ? []
      : [{ state: "waiting" as const, label: plural(run.warnings.length, "card.pill.warnings") }]),
  ];
  const minutes =
    run.endedAt === null
      ? null
      : Math.max(1, Math.round((run.endedAt.getTime() - run.startedAt.getTime()) / 60_000));
  return {
    id: run.runId,
    when: when(run.startedAt, now),
    event: run.title,
    took: minutes === null ? "" : t("history.took", { n: minutes }),
    state: STATE_LOOK[run.state],
    stateLabel: t(STATE_KEYS[run.state]),
    selected,
    ...(notes.length === 0 ? {} : { notes }),
    ...(run.failure === null
      ? {}
      : { failure: wordFailure({ step: run.failure.step, reason: run.failure.text }) }),
    ...(original === undefined
      ? {}
      : {
          caption: t("history.rerunOf", {
            day: dayOf(original.startedAt, now),
            time: clockTime(original.startedAt),
          }),
        }),
  };
}

/**
 * The sentence when no row is shown: "No runs yet…", or, while a filter or a search narrows them,
 * "No failed runs in the last 7 days." Over Any time the range is what Run history keeps.
 */
export function historyEmpty(
  filter: HistoryFilter,
  range: string,
  search: string,
  keptDays: number | null,
): string {
  if (filter === "all" && search.trim() === "") {
    return t("history.empty");
  }
  const days = rangeDays(range) ?? keptDays;
  if (days === null) {
    return t("history.empty");
  }
  const state = filter === "all" ? "" : t(FILTER_KEYS[filter]).toLowerCase();
  return t("history.emptyFiltered", { state, days }).replace("  ", " ");
}
