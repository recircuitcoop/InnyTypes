// What Live's places hold (plan 0022 §M; ux-writing "Live: the board", "Questions"): the run
// cards and the questions inline, from the flow's run records, kept current by the runs push.
//
// * The run cards' place: one card per source event (design-system "Run card": newest first),
//   never merged; a cleared run leaves the board, never the history. "Clear done" at the top of
//   the list, undoable for a minute (D8): Undo shows for that minute.
// * A waiting card says its question, "Waiting since Tuesday" once it is older than today, and
//   Answer, which opens the question in its pop-out (pop-up only, plan 0021 §8).
// * A question's place lists the questions of its view node that wait, each with Answer and Skip
//   this step, which confirms once; Later is the pop-out's, where it closes the window.
// * The values a card shows are the domain's, derived by the shell (RunRecord.card); the words
//   are ui/words.ts's.
import { useEffect, useState } from "react";
import type { AppApi } from "../contract";
import type { RunRecord } from "../run-contract";
import { Button } from "../components/atoms/Button";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { Dialog } from "../components/organisms/Dialog";
import { EmptyState } from "../components/organisms/EmptyState";
import { RunCard } from "../components/organisms/RunCard";
import { useLastGood } from "../last-good";
import { useRuns } from "../store";
import { t } from "../strings";
import { wordRefusal, wordSkip, wordWaitingSince } from "../words";

/** How long "Clear done" can be undone (decision D8; application/runs UNDO_CLEAR_MS). */
const UNDO_MS = 60_000;

/** The flow's runs still on the board: not cleared, each with its card, newest first. */
function onBoard(runs: readonly RunRecord[]): RunRecord[] {
  return runs.filter((run) => !run.cleared && run.card !== undefined);
}

export function RunsPlace({ api, flowId }: { readonly api: AppApi; readonly flowId: string }) {
  const runs = useLastGood(useRuns(flowId));
  /** Until when "Clear done" can be undone; null when there is nothing to undo. */
  const [undoUntil, setUndoUntil] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (undoUntil === null) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        setUndoUntil(null);
      },
      Math.max(0, undoUntil - Date.now()),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [undoUntil]);
  if (runs.value === null) {
    return runs.refused === null ? null : (
      <InlineMessage kind="warning">{wordRefusal(runs.refused)}</InlineMessage>
    );
  }
  const shown = onBoard(runs.value.runs);
  const anyDone = shown.some((run) => run.state === "done");
  const clear = async () => {
    const answer = await api.clearDone(flowId);
    if (!answer.ok) {
      setProblem(wordRefusal(answer.refused));
      return;
    }
    setProblem(null);
    setUndoUntil(Date.now() + UNDO_MS);
  };
  const undo = async () => {
    setUndoUntil(null);
    const answer = await api.undoClear(flowId);
    setProblem(answer.ok ? null : wordRefusal(answer.refused));
  };
  const now = new Date();
  return (
    <div data-testid="run-cards" className="flex flex-col gap-3">
      {anyDone || undoUntil !== null ? (
        <div className="flex items-center justify-end gap-2">
          {undoUntil === null ? null : (
            <Button kind="secondary" data-testid="runs-undo" onClick={() => void undo()}>
              {t("card.undo")}
            </Button>
          )}
          {anyDone ? (
            <Button kind="quiet" data-testid="runs-clear-done" onClick={() => void clear()}>
              {t("card.clearDone")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {problem === null ? null : <InlineMessage kind="warning">{problem}</InlineMessage>}
      {shown.length === 0 ? (
        <EmptyState area="live-idle" message={t("live.idle")} />
      ) : (
        shown.map((run) => <Card key={run.runId} api={api} run={run} now={now} />)
      )}
    </div>
  );
}

function Card({
  api,
  run,
  now,
}: {
  readonly api: AppApi;
  readonly run: RunRecord;
  readonly now: Date;
}) {
  const card = run.card;
  if (card === undefined) {
    return null;
  }
  const since = card.waiting === null ? null : wordWaitingSince(card.waiting.since, now);
  const viewId = card.waiting?.viewId;
  return (
    <div data-testid="run-card" data-run={run.runId} data-state={card.variant}>
      <RunCard
        state={card.variant}
        title={card.title}
        line={card.line}
        pills={card.pills}
        notes={run.notes}
        warnings={run.warnings}
        {...(viewId === undefined
          ? {}
          : {
              actions: (
                <>
                  <Button
                    kind="primary"
                    data-testid="run-card-answer"
                    onClick={() => void api.openView(viewId)}
                  >
                    {t("card.answer")}
                  </Button>
                  {since === null ? null : (
                    <span className="text-caption text-secondary">{since}</span>
                  )}
                </>
              ),
            })}
      />
    </div>
  );
}

/** A question's place: the questions of its view node that wait for the person, inline. */
export function QuestionPlace({
  api,
  flowId,
  viewNodeId,
  name,
}: {
  readonly api: AppApi;
  readonly flowId: string;
  readonly viewNodeId: string;
  readonly name: string;
}) {
  const runs = useLastGood(useRuns(flowId));
  const [skipping, setSkipping] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = onBoard(runs.value?.runs ?? []).filter(
    (run) => run.card?.waiting?.instanceId === viewNodeId,
  );
  if (waiting.length === 0) {
    return <p className="text-body font-medium text-primary">{name}</p>;
  }
  const skip = async (viewId: string) => {
    setSkipping(null);
    const answer = await api.submitView(viewId, { __dismiss__: true });
    setProblem(answer.ok ? null : answer.error);
  };
  const confirm = wordSkip(name);
  return (
    <div data-testid="question-place" className="flex flex-col gap-3">
      {problem === null ? null : <InlineMessage kind="warning">{problem}</InlineMessage>}
      {waiting.map((run) => {
        const asked = run.card?.waiting;
        const line = run.card?.line;
        if (asked === undefined || asked === null || line?.kind !== "waiting") {
          return null;
        }
        return (
          <section
            key={run.runId}
            data-testid="question-inline"
            data-run={run.runId}
            aria-label={line.question}
            className="flex flex-col gap-2"
          >
            <p className="text-body text-primary">
              <strong className="font-semibold">{t("card.step.waiting")}</strong> {line.question}
            </p>
            <p className="text-caption text-secondary">{run.title}</p>
            <div className="flex items-center gap-2">
              <Button
                kind="primary"
                data-testid="question-answer"
                onClick={() => void api.openView(asked.viewId)}
              >
                {t("card.answer")}
              </Button>
              <Button
                kind="quiet"
                data-testid="question-skip"
                className="ml-auto"
                onClick={() => {
                  setSkipping(asked.viewId);
                }}
              >
                {t("question.skip")}
              </Button>
            </div>
          </section>
        );
      })}
      <Dialog
        kind="warning"
        testId="question-skip-dialog"
        open={skipping !== null}
        title={confirm.title}
        body={confirm.body}
        onClose={() => {
          setSkipping(null);
        }}
        buttons={
          <DialogButtons
            kind="neutral"
            testId="question-skip"
            primaryLabel={t("question.keepWaiting")}
            cancelLabel={t("question.skip.yes")}
            onPrimary={() => {
              setSkipping(null);
            }}
            onCancel={() => {
              if (skipping !== null) {
                void skip(skipping);
              }
            }}
          />
        }
      />
    </div>
  );
}
