// TEMPORARY: the run card's words, until WI-0022-10 writes ui/strings.ts (plan 0022 §O) and
// replaces this file. Each sentence is the one app/test/unit/domain/wording.fixture.test.ts holds
// for the same value, verbatim; that fixture copies them from docs/ux/ux-writing.md.
//
// The card takes the domain's structured values (domain/runs/card.ts), never sentences. The UI
// may not import the domain, not even its types (app/.dependency-cruiser.cjs, plan 0022 §J), so
// the shapes are restated here. They are structurally the domain's own: a value cardTitle,
// stepLine or donePills returns is accepted as it is, and a change on either side fails tsc where
// the screens pass one to the other.

/** The card's six variants (domain CardVariant). */
export type CardVariant = "copying" | "running" | "waiting" | "failed" | "done" | "resumed";

/** The event's name and its length in whole minutes, when the source knows it (domain CardTitle). */
export interface CardTitle {
  readonly name: string;
  readonly minutes: number | null;
}

export interface StepProgress {
  readonly done: number;
  readonly total: number;
}

/** Where a result line ended (domain ResultSink). */
export type ResultSink = "anytype" | "file" | "scheduled" | "plain";

/** One thing the run did (domain ResultLine); `text` marks the place with *asterisks*. */
export interface RunResultLine {
  readonly step: string;
  readonly sink: ResultSink;
  readonly text: string;
  readonly anytype: { readonly spaceId: string; readonly objectId: string } | null;
  readonly folder: string | null;
  readonly due: string | null;
}

/** What the card's step line says (domain StepLine). */
export type StepLine =
  | { readonly kind: "copying"; readonly text: string }
  | { readonly kind: "copying-no-text" }
  | { readonly kind: "safe-to-unplug" }
  | { readonly kind: "between-steps" }
  | {
      readonly kind: "running";
      readonly step: string;
      readonly text: string | null;
      readonly progress: StepProgress | null;
      readonly timeLeftMinutes: number | null;
    }
  | { readonly kind: "waiting"; readonly question: string }
  | { readonly kind: "failed"; readonly step: string; readonly reason: string }
  | { readonly kind: "resumed" }
  | { readonly kind: "done"; readonly results: readonly RunResultLine[] };

/** The Done badge row (domain DonePill). */
export type DonePill =
  | { readonly kind: "done" }
  | { readonly kind: "notes"; readonly count: number }
  | { readonly kind: "warnings"; readonly count: number };

/** A note or a warning as the card lists it: the step that wrote it, and its words. */
export interface NoteLine {
  readonly step: string;
  readonly text: string;
}

/** Ends a sentence with a full stop unless it already ends as one, or trails off with "…". */
const close = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

export function wordTitle(title: CardTitle): string {
  return title.minutes === null ? title.name : `${title.name} · ${String(title.minutes)} min`;
}

/**
 * The step line in two parts: `lead`, drawn in bold (the step's name, or the state's word), and
 * `rest`. Together they are the fixture's sentence.
 */
export interface StepLineParts {
  readonly lead: string;
  readonly rest: string;
}

export function stepLineParts(line: StepLine): StepLineParts {
  switch (line.kind) {
    case "copying":
      return { lead: "Copying", rest: ` ${line.text}` };
    case "copying-no-text":
      return { lead: "Copying…", rest: "" };
    case "safe-to-unplug":
      return { lead: "Safe to unplug.", rest: "" };
    case "between-steps":
      return { lead: "Running…", rest: "" };
    case "running":
      return runningParts(line);
    case "waiting":
      return { lead: "Waiting for you:", rest: ` ${line.question}` };
    case "failed":
      return { lead: "Failed", rest: ` at ${line.step}: ${close(line.reason)}` };
    case "resumed":
      return { lead: "Resumed", rest: " after restart." };
    case "done":
      return { lead: "Done.", rest: "" };
  }
}

function runningParts(line: Extract<StepLine, { kind: "running" }>): StepLineParts {
  let rest = "";
  if (line.text !== null) rest += ` ${line.text}`;
  if (line.progress !== null) {
    rest += ` (${String(line.progress.done)} of ${String(line.progress.total)})`;
  }
  if (line.timeLeftMinutes !== null) {
    const unit = line.timeLeftMinutes === 1 ? "minute" : "minutes";
    rest += `, about ${String(line.timeLeftMinutes)} ${unit} left`;
  }
  return rest === "" ? { lead: line.step, rest: "…" } : { lead: line.step, rest: close(rest) };
}

/** The whole step line as one sentence (the fixture's wordStepLine). */
export function wordStepLine(line: StepLine): string {
  const { lead, rest } = stepLineParts(line);
  return `${lead}${rest}`;
}

export function wordPill(pill: DonePill): string {
  switch (pill.kind) {
    case "done":
      return "Done";
    case "notes":
      return `${String(pill.count)} note${pill.count === 1 ? "" : "s"}`;
    case "warnings":
      return `${String(pill.count)} warning${pill.count === 1 ? "" : "s"}`;
  }
}

/** The headings over a done card's lists, as the Penpot card draws them. */
export const NOTES_HEADING = "Notes";
export const WARNINGS_HEADING = "Warnings";

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
