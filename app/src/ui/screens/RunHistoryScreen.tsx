// Configuration › Flows › Run history (plan 0022 §E, §M; ux-writing "Configuration › Flows › Run
// history"): where a run is found again, read and re-run. The board only shows the current cards;
// this is every run the flow kept, newest first.
//
// * The filter row narrows `run.list` itself: a state, a date range, the search. The list is
//   asked again whenever a filter changes and whenever the flow's runs change (the runs store of
//   the flow, which the shell's `runs` push keeps current, is followed for that).
// * The row's ⋯ menu: Open result (the flow's board, where its result shows), Re-run, Re-run
//   from… › the flow's steps in order, Open in Anytype when the run has an Anytype result (its
//   anytype:// link, opened as a window, which the shell hands to Anytype instead), and Delete
//   run, which asks first.
// * Checked rows show the Selected bar: Re-run (each from the start), Delete (asks first), Clear
//   selection.
// * A refused call leaves its sentence above the table until the next call answers.
import { useEffect, useState } from "react";
import type { Answer } from "../answer";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { Dialog } from "../components/organisms/Dialog";
import {
  RunHistory,
  type RunHistoryAction,
  type RunHistoryWords,
} from "../components/organisms/RunHistory";
import type { AppApi } from "../contract";
import type { Retention } from "../general-contract";
import { routeHash, type Route } from "../routes";
import type { RunRecord } from "../run-contract";
import { useFlows, useRuns } from "../store";
import { plural, t } from "../strings";
import { wordDeleteRuns, wordRefusal } from "../words";
import {
  anytypeLink,
  FIRST_RANGE,
  HISTORY_FILTERS,
  HISTORY_RANGES,
  historyEmpty,
  historyQuery,
  historyRow,
  type HistoryFilter,
} from "./history-rows";

const WORDS: RunHistoryWords = {
  title: t("history.title"),
  back: `← ${t("history.back")}`,
  retention: "",
  filterLabel: t("history.filterLabel"),
  rangeLabel: t("history.column.when"),
  search: t("history.search"),
  clearSearch: t("history.clearSearch"),
  columns: {
    select: t("history.selectAll"),
    when: t("history.column.when"),
    event: t("history.column.event"),
    took: t("history.column.took"),
    state: t("history.column.state"),
    notes: t("history.column.notes"),
    more: t("a11y.more"),
  },
  selected: (count) => plural(count, "history.selected"),
  rerun: t("history.rerun"),
  delete: t("history.delete"),
  clearSelection: t("history.clearSelection"),
  openResult: t("history.openResult"),
  rerunFrom: t("history.rerunFrom"),
  openInAnytype: t("history.openInAnytype"),
  deleteRun: t("history.deleteRun"),
  selectRun: (event) => t("history.selectRun", { event }),
};

/** The caption under the title: how long runs are kept, and where that is changed. */
const retentionCaption = (retention: Retention | null) =>
  retention === null
    ? ""
    : retention.days === null
      ? t("history.retention.forever")
      : t("history.retention.days", { days: retention.days });

export interface RunHistoryScreenProps {
  readonly api: AppApi;
  readonly flowId: string;
  readonly navigate: (route: Route) => void;
}

export function RunHistoryScreen({ api, flowId, navigate }: RunHistoryScreenProps) {
  const flows = useFlows();
  // Replaced whenever a run of the flow changes: the list below is asked again then.
  const changed = useRuns(flowId);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [range, setRange] = useState(FIRST_RANGE);
  const [search, setSearch] = useState("");
  const [runs, setRuns] = useState<readonly RunRecord[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<readonly string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [retention, setRetention] = useState<Retention | null>(null);

  useEffect(() => {
    void api.retention().then((answer) => {
      if (answer.ok) setRetention(answer.value);
    });
  }, [api]);

  useEffect(() => {
    // An answer a newer query overtook is dropped.
    let current = true;
    void api.runs(historyQuery(flowId, filter, range, search, new Date())).then((answer) => {
      if (!current) return;
      if (!answer.ok) {
        setProblem(wordRefusal(answer.refused));
        return;
      }
      setRuns(answer.value.runs);
      // A run no longer listed is no longer selected.
      const listed = new Set(answer.value.runs.map((run) => run.runId));
      setSelected((now) => new Set([...now].filter((id) => listed.has(id))));
    });
    return () => {
      current = false;
    };
  }, [api, flowId, filter, range, search, changed]);

  /** The value of an answer, or null with its refusal shown. */
  const answered = <T,>(answer: Answer<T>): T | null => {
    if (!answer.ok) {
      setProblem(wordRefusal(answer.refused));
      return null;
    }
    setProblem(null);
    return answer.value;
  };

  const flow =
    flows.status === "ready" ? flows.value.find((each) => each.id === flowId) : undefined;
  const steps = flow?.steps ?? [];

  const act = async (runId: string, action: RunHistoryAction): Promise<void> => {
    switch (action.kind) {
      case "open-result":
        navigate({ screen: "live", flowId, tabId: null });
        return;
      case "open-in-anytype": {
        const run = runs?.find((each) => each.runId === runId);
        const link = run === undefined ? null : anytypeLink(run);
        if (link !== null) {
          window.open(link);
        }
        return;
      }
      case "rerun":
        answered(await api.rerun(flowId, runId));
        return;
      case "rerun-from": {
        const step = steps.find((each) => each.name === action.step);
        if (step !== undefined) {
          answered(await api.rerun(flowId, runId, step.id));
        }
        return;
      }
      case "delete":
        setDeleting([runId]);
        return;
    }
  };

  const actOnSelection = async (action: "rerun" | "delete" | "clear"): Promise<void> => {
    const ids = [...selected];
    if (action === "delete") {
      setDeleting(ids);
      return;
    }
    setSelected(new Set());
    if (action === "rerun") {
      answered(await api.rerunMany(flowId, ids));
    }
  };

  const now = new Date();
  const rows = (runs ?? []).map((run) => historyRow(run, now, selected.has(run.runId)));
  return (
    <div data-testid="history-screen" data-flow={flowId} className="flex flex-col gap-5">
      {problem === null ? null : <InlineMessage kind="failed">{problem}</InlineMessage>}
      {runs === null ? null : (
        <RunHistory
          flowName={flow?.name ?? ""}
          rows={rows}
          words={{ ...WORDS, retention: retentionCaption(retention) }}
          filters={HISTORY_FILTERS}
          filter={filter}
          ranges={HISTORY_RANGES}
          range={range}
          query={search}
          filtered={filter !== "all" || search.trim() !== ""}
          emptyMessage={historyEmpty(filter, range, search, retention?.days ?? null)}
          steps={steps.map((step) => step.name)}
          backHref={routeHash({ screen: "flows" })}
          onFilter={(value) => {
            setFilter(value as HistoryFilter);
          }}
          onRange={(value) => {
            if (value !== null) setRange(value);
          }}
          onQuery={setSearch}
          onSelect={(ids, on) => {
            setSelected((now) => {
              const next = new Set(now);
              for (const id of ids) {
                if (on) next.add(id);
                else next.delete(id);
              }
              return next;
            });
          }}
          onAction={(runId, action) => {
            void act(runId, action);
          }}
          onSelectionAction={(action) => {
            void actOnSelection(action);
          }}
        />
      )}
      <DeleteRunsDialog
        runIds={deleting}
        onClose={() => {
          setDeleting(null);
        }}
        onDelete={async (ids) => {
          setDeleting(null);
          if (answered(await api.deleteRuns(flowId, ids)) !== null) {
            setSelected((now) => new Set([...now].filter((id) => !ids.includes(id))));
          }
        }}
      />
    </div>
  );
}

/** Delete run, or several: the Destructive dialog, Delete and Cancel; Escape is Cancel. */
function DeleteRunsDialog({
  runIds,
  onClose,
  onDelete,
}: {
  readonly runIds: readonly string[] | null;
  readonly onClose: () => void;
  readonly onDelete: (runIds: readonly string[]) => Promise<void>;
}) {
  const words = wordDeleteRuns(runIds?.length ?? 1);
  return (
    <Dialog
      kind="destructive"
      testId="history-delete-dialog"
      open={runIds !== null}
      title={words.title}
      body={words.body}
      onClose={onClose}
      buttons={
        <DialogButtons
          kind="destructive"
          testId="history-delete"
          primaryLabel={t("history.delete")}
          cancelLabel={t("dialog.cancel")}
          onPrimary={() => {
            if (runIds !== null) {
              void onDelete(runIds);
            }
          }}
          onCancel={onClose}
        />
      }
    />
  );
}
