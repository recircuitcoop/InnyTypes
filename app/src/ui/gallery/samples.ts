// The gallery's sample content, from the Penpot file and ux-writing.md. Three unrelated flows
// appear across the samples, so no component reads as if one story were the product
// (design-system.md, "Sample data proves the genericity").
import type { SelectOption } from "../components/atoms/Select";
import type { RunCardDone } from "../components/organisms/RunCard";
import type {
  CardTitle,
  CardVariant,
  DonePill,
  NoteLine,
  ResultSink,
  ResultLine as RunResultLine,
  StepLine,
} from "../words";

export const FLOWS = {
  recordings: "Recordings to Anytype",
  invoices: "Invoices from the mailbox",
  photos: "Photos from the camera card",
} as const;

export const TYPES: readonly SelectOption[] = [
  { value: "meeting-notes", label: "Meeting notes" },
  { value: "customer-brief", label: "Customer brief" },
  { value: "invoice", label: "Invoice" },
];

export const SPACES: readonly SelectOption[] = [
  { value: "renaissance", label: "Renaissance" },
  { value: "renewal-notes", label: "Renewal notes" },
  { value: "rent", label: "Rent" },
  { value: "accounting", label: "Accounting" },
];

// ── Organisms: run cards, as the domain's structured values (domain/runs/card.ts) ─────────────
// The card's variants rotate through the three flows. Step names are each flow's own node names
// and differ between them; "Transcribing" belongs to the Recordings flow only.

export const FLOW_STEPS = {
  recordings: ["Transcribe", "Name the speakers", "Summarise", "File", "Send"],
  invoices: ["Read the PDF", "Match the supplier", "File"],
  photos: ["Copy off the card", "Sort by day", "Move to Archive"],
} as const;

/** A result line as the domain carries it; only `sink` and `text` show. */
function result(step: string, sink: ResultSink, text: string): RunResultLine {
  return {
    step,
    sink,
    text,
    anytype: sink === "anytype" ? { spaceId: "sample-space", objectId: "sample-object" } : null,
    folder: sink === "file" ? "/sample/folder" : null,
    due: sink === "scheduled" ? "Thursday" : null,
  };
}

/** Recordings to Anytype, done: ux-writing's three result lines. */
export const RECORDING_RESULTS: readonly RunResultLine[] = [
  result("File", "anytype", "Meeting notes → *Renaissance*"),
  result("Send", "anytype", "Customer brief → *Fritte Reinvention*"),
  result("Schedule", "scheduled", "Follow up on pricing · due Thursday"),
];

export const INVOICE_RESULTS: readonly RunResultLine[] = [
  result("File", "file", "Filed in *Accounting*"),
];

export const PHOTO_RESULTS: readonly RunResultLine[] = [
  result("Move to Archive", "file", "Moved 42 files to *Archive*"),
];

/** ux-writing's notes and warning, each with the step that wrote it. */
export const RECORDING_NOTES: readonly NoteLine[] = [
  { step: "Summarise", text: "Summary shortened to fit the type's limit" },
  { step: "Name the speakers", text: "Speaker 3 was not named" },
];

export const RECORDING_WARNINGS: readonly NoteLine[] = [
  { step: "Send", text: "Sent to Fritte Reinvention without approval: the approval step is off" },
];

export interface RunCardSample {
  readonly state: CardVariant;
  readonly title: CardTitle;
  readonly line: StepLine;
  readonly pills: readonly DonePill[];
  readonly notes: readonly NoteLine[];
  readonly warnings: readonly NoteLine[];
  /** The card's button labels, Primary first. */
  readonly actions: readonly string[];
  /** Penpot's Done sub-axis, named explicitly on the done cards that carry one. */
  readonly done?: RunCardDone;
}

const card = (sample: Partial<RunCardSample> & Pick<RunCardSample, "state" | "title" | "line">) =>
  ({ pills: [], notes: [], warnings: [], actions: [], ...sample }) satisfies RunCardSample;

const CLIENT_CALL: CardTitle = { name: "2026-09-27 client call", minutes: 48 };
const COACHING: CardTitle = { name: "2026-09-29 coaching", minutes: 32 };
/** The camera card's event: its name and its file count, as the source names it. */
export const CAMERA_CARD: CardTitle = {
  name: "2026-09-26 camera card · 142 photos",
  minutes: null,
};

/** Penpot's nine run-card variants, rotating through the three flows. */
export const RUN_CARDS: readonly RunCardSample[] = [
  card({
    state: "copying",
    title: CAMERA_CARD,
    line: { kind: "copying", text: "from the camera card…" },
  }),
  card({
    state: "running",
    title: CLIENT_CALL,
    line: {
      kind: "running",
      step: "Transcribing",
      text: null,
      progress: null,
      timeLeftMinutes: 12,
    },
  }),
  card({
    state: "waiting",
    title: { name: "Fritte invoice 0413", minutes: null },
    line: { kind: "waiting", question: "which supplier is this?" },
    actions: ["Answer"],
  }),
  card({
    state: "failed",
    title: { name: "2026-09-28 standup", minutes: 14 },
    line: {
      kind: "failed",
      step: "Transcribe",
      reason: "Mistral refused the key. Check the key in the Transcribe step.",
    },
    actions: ["Retry"],
  }),
  card({
    state: "done",
    title: { name: "Fritte invoice 0412", minutes: null },
    line: { kind: "done", results: INVOICE_RESULTS },
    pills: [{ kind: "done" }],
  }),
  card({
    state: "done",
    title: COACHING,
    line: { kind: "done", results: RECORDING_RESULTS },
    done: "notes",
    pills: [{ kind: "done" }, { kind: "notes", count: 2 }],
    notes: RECORDING_NOTES,
  }),
  card({
    state: "done",
    title: { name: "2026-09-28 intro call", minutes: 22 },
    line: { kind: "done", results: RECORDING_RESULTS.slice(0, 1) },
    done: "warnings",
    pills: [{ kind: "done" }, { kind: "warnings", count: 1 }],
    warnings: [{ step: "Transcribe", text: "Transcription used the fallback model" }],
  }),
  card({
    state: "done",
    title: COACHING,
    line: { kind: "done", results: RECORDING_RESULTS },
    done: "both",
    pills: [{ kind: "done" }, { kind: "notes", count: 2 }, { kind: "warnings", count: 1 }],
    notes: RECORDING_NOTES,
    warnings: RECORDING_WARNINGS,
  }),
  card({
    state: "resumed",
    title: CAMERA_CARD,
    line: { kind: "resumed" },
  }),
];

/** One board, ONE flow: three recordings of Recordings to Anytype, one card per recording. */
export const BOARD_CARDS: readonly RunCardSample[] = [
  card({
    state: "running",
    title: { name: "2026-09-30 design review", minutes: 41 },
    line: {
      kind: "running",
      step: "Summarising",
      text: null,
      progress: { done: 2, total: 3 },
      timeLeftMinutes: null,
    },
  }),
  card({
    state: "waiting",
    title: CLIENT_CALL,
    line: { kind: "waiting", question: "who spoke?" },
    actions: ["Answer"],
  }),
  card({
    state: "done",
    title: COACHING,
    line: { kind: "done", results: RECORDING_RESULTS },
    done: "both",
    pills: [{ kind: "done" }, { kind: "notes", count: 2 }, { kind: "warnings", count: 1 }],
    notes: RECORDING_NOTES,
    warnings: RECORDING_WARNINGS,
  }),
];

/** A running card from each flow, for the Card places at S, M and L. */
const running = (step: string, minutes: number) =>
  ({ kind: "running", step, text: null, progress: null, timeLeftMinutes: minutes }) as const;

export const SLOT_CARDS = {
  S: card({ state: "running", title: CLIENT_CALL, line: running("Transcribing", 12) }),
  M: card({
    state: "running",
    title: { name: "Fritte invoice 0412", minutes: null },
    line: running("Matching the supplier", 1),
  }),
  L: card({ state: "running", title: CAMERA_CARD, line: running("Sorting by day", 2) }),
} as const;
