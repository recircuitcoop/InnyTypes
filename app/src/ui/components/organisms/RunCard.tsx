// Run card (Penpot 04 Organisms › run-card). State: Copying, Running, Waiting, Failed, Done,
// Resumed; Done also Notes, Warnings, Both. Panel fill, radius m, raised shadow, 16 padding, 12
// between rows: the title (body-large semibold), on a Done card the badge row (the Done pill, then
// "2 notes" in the Off colour and "1 warning" in the Waiting colour, only when present), the step
// line (body 14, its first words in bold), a progress bar while running, the result lines when
// done, and the card's buttons. Pressing "2 notes" opens the notes under the results, "1 warning"
// the warnings, each line with its step's name.
//
// It takes the domain's structured card values (wording.ts restates their shapes) and words them
// itself, through wording.ts until ui/strings.ts replaces it (WI-0022-10). One card per source
// event, per flow: the board lists them, this draws one.
import { useId, useState, type ReactNode } from "react";
import { Progress } from "../atoms/Progress";
import { StatusPill } from "../atoms/StatusPill";
import { ResultLine } from "../molecules/ResultLine";
import { cx, variantAttributes } from "../variant";
import {
  NOTES_HEADING,
  resultParts,
  stepLineParts,
  WARNINGS_HEADING,
  wordPill,
  wordStepLine,
  wordTitle,
  type CardTitle,
  type CardVariant,
  type DonePill,
  type NoteLine,
  type RunResultLine,
  type StepLine,
} from "../wording";

/** Penpot's Done sub-axis: which of the two extra pills a done card carries. */
export type RunCardDone = "notes" | "warnings" | "both";

export interface RunCardProps {
  /** The card's variant (domain cardVariant). */
  readonly state: CardVariant;
  readonly title: CardTitle;
  readonly line: StepLine;
  /** The Done badge row (domain donePills); empty unless done. */
  readonly pills?: readonly DonePill[];
  /** The lines behind the "2 notes" and "1 warning" pills. */
  readonly notes?: readonly NoteLine[];
  readonly warnings?: readonly NoteLine[];
  /**
   * Penpot's Done sub-axis (plan 0022 §L: `<RunCard state="done" done="both">`). When absent it
   * is derived from the pills' counts; it is ignored unless the state is Done.
   */
  readonly done?: RunCardDone;
  /** The lists open from the start (the gallery); otherwise each pill opens its own. */
  readonly expanded?: boolean;
  /** The card's buttons (Answer, Retry, Send · Not now), from ux-writing. */
  readonly actions?: ReactNode;
  /** Opens what a result line points at: the Anytype object, the folder, the task. */
  readonly onOpenResult?: (result: RunResultLine) => void;
  readonly className?: string;
}

/** Notes, Warnings or Both, from the pills; undefined for a plain Done or any other state. */
export function doneAxis(pills: readonly DonePill[]): RunCardDone | undefined {
  const notes = pills.some((pill) => pill.kind === "notes");
  const warnings = pills.some((pill) => pill.kind === "warnings");
  if (notes && warnings) return "both";
  if (notes) return "notes";
  if (warnings) return "warnings";
  return undefined;
}

const PILL_STATE = { done: "done", notes: "off", warnings: "waiting" } as const;

export function RunCard({
  state,
  title,
  line,
  pills = [],
  notes = [],
  warnings = [],
  done,
  expanded = false,
  actions,
  onOpenResult,
  className,
}: RunCardProps) {
  // Each pill opens its own list: "2 notes" the notes, "1 warning" the warnings.
  const [open, setOpen] = useState({ notes: expanded, warnings: expanded });
  const listId = { notes: useId(), warnings: useId() };
  const doneVariant = state === "done" ? (done ?? doneAxis(pills)) : undefined;
  const { lead, rest } = stepLineParts(line);
  return (
    <article
      {...variantAttributes(
        "run-card",
        doneVariant === undefined ? { state } : { state, done: doneVariant },
      )}
      className={cx(
        "flex w-full flex-col gap-3 rounded-m bg-surface-panel p-4 shadow-raised",
        className,
      )}
    >
      <h3 className="text-body-large leading-tight font-semibold text-primary">
        {wordTitle(title)}
      </h3>
      {state === "done" && pills.length > 0 ? (
        <div className="flex items-center gap-2">
          {pills.map((pill) =>
            pill.kind === "done" ? (
              <StatusPill key={pill.kind} state="done">
                {wordPill(pill)}
              </StatusPill>
            ) : (
              <button
                key={pill.kind}
                type="button"
                aria-expanded={open[pill.kind]}
                aria-controls={open[pill.kind] ? listId[pill.kind] : undefined}
                onClick={() => {
                  setOpen({ ...open, [pill.kind]: !open[pill.kind] });
                }}
                className="rounded-pill focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <StatusPill state={PILL_STATE[pill.kind]}>{wordPill(pill)}</StatusPill>
              </button>
            ),
          )}
        </div>
      ) : null}
      <p className="text-body text-primary">
        <strong className="font-semibold">{lead}</strong>
        {rest}
      </p>
      {line.kind === "running" ? (
        <Progress
          mode={line.progress === null ? "indeterminate" : "determinate"}
          value={line.progress === null ? 0 : (100 * line.progress.done) / line.progress.total}
          label={wordStepLine(line)}
        />
      ) : null}
      {line.kind === "done" && line.results.length > 0 ? (
        <div className="flex flex-col gap-3">
          {line.results.map((result, index) => {
            const parts = resultParts(result.text);
            return (
              <ResultLine
                key={index}
                sink={result.sink}
                what={parts.what}
                {...(parts.where === undefined ? {} : { where: parts.where, href: "#" })}
                onOpen={(event) => {
                  event.preventDefault();
                  onOpenResult?.(result);
                }}
              />
            );
          })}
        </div>
      ) : null}
      {(open.notes && notes.length > 0) || (open.warnings && warnings.length > 0) ? (
        <div className="flex flex-col gap-2">
          {open.notes ? <NoteList id={listId.notes} heading={NOTES_HEADING} lines={notes} /> : null}
          {open.warnings ? (
            <NoteList id={listId.warnings} heading={WARNINGS_HEADING} lines={warnings} warning />
          ) : null}
        </div>
      ) : null}
      {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
    </article>
  );
}

function NoteList({
  id,
  heading,
  lines,
  warning = false,
}: {
  readonly id: string;
  readonly heading: string;
  readonly lines: readonly NoteLine[];
  readonly warning?: boolean;
}) {
  if (lines.length === 0) {
    return null;
  }
  return (
    <>
      <h4 className="text-caption font-medium text-secondary">{heading}</h4>
      <ul id={id} className="flex flex-col gap-2">
        {lines.map((note, index) => (
          <li key={index} className={cx("text-body", warning ? "text-waiting" : "text-primary")}>
            <strong className="font-semibold">{note.step}:</strong> {note.text}
          </li>
        ))}
      </ul>
    </>
  );
}
