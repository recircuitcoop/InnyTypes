// HAND-OVER LIST FOR WI-0022-10 (ui/strings.ts, plan 0022 §O). Not a domain rule.
//
// The domain (runs, board, flows, setup, status, packages, updates) returns structured values and
// words nothing. This file keeps ux-writing's sentences next to the value each one is made from,
// so they are not lost before WI-0022-10 writes ui/strings.ts. The `word*` functions are a
// reference rendering that lives ONLY in tests, never in src.
//
// Two tests read it: wording.fixture.test.ts holds the reference rendering to every row, and
// ../ui-wording.test.ts holds the UI's own rendering (app/src/ui/components/wording.ts) to the
// rows it draws, and makes every other table say who owns it. A table added here must be
// classified there, or that test fails.
//
// Every expected sentence is copied verbatim from docs/ux/ux-writing.md. Where ux-writing gives no
// sentence for a value, the row says so and WI-0022-10 decides the words ("WI-10 decides").
import type { BoardErrorReason } from "../../../src/domain/board/layout";
import { relativeDay, type RelativeDay } from "../../../src/domain/flows/days";
import type { HealthPhrase, LastRunLine } from "../../../src/domain/flows/health";
import type {
  Installation,
  Package,
  PackageUpdate,
  Refusal,
  Registration,
} from "../../../src/domain/packages/states";
import type { CardTitle, DonePill, FailureLine, StepLine } from "../../../src/domain/runs/card";
import type { ResultLine } from "../../../src/domain/runs/run";
import type { StatusPill } from "../../../src/domain/status/status";
import type {
  RollbackOffer,
  UpdateState,
  UpdateStateKind,
} from "../../../src/domain/updates/machine";

// ── Reference rendering (test-only) ──────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (value: number) => String(value).padStart(2, "0");

/** Ends a sentence with a full stop unless it already ends as one, or trails off with "…". */
const close = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

export function wordDay(day: RelativeDay): string {
  switch (day.kind) {
    case "today":
      return "today";
    case "yesterday":
      return "yesterday";
    case "weekday":
      return WEEKDAYS[day.weekday] ?? "";
    case "date":
      return `${String(day.date.getFullYear())}-${two(day.date.getMonth() + 1)}-${two(day.date.getDate())}`;
  }
}

export function wordTitle(title: CardTitle): string {
  return title.minutes === null ? title.name : `${title.name} · ${String(title.minutes)} min`;
}

/** The step line as plain text; on the card the step's name (first words) is bold. */
export function wordStepLine(line: StepLine): string {
  switch (line.kind) {
    case "copying":
      return `Copying ${line.text}`;
    case "copying-no-text":
      return "Copying…"; // WI-10 decides: ux-writing always shows the source's words
    case "safe-to-unplug":
      return "Safe to unplug.";
    case "between-steps":
      return "Running…"; // WI-10 decides: ux-writing has no line between steps
    case "running": {
      let rest = "";
      if (line.text !== null) rest += ` ${line.text}`;
      if (line.progress !== null) {
        rest += ` (${String(line.progress.done)} of ${String(line.progress.total)})`;
      }
      if (line.timeLeftMinutes !== null) {
        const unit = line.timeLeftMinutes === 1 ? "minute" : "minutes";
        rest += `, about ${String(line.timeLeftMinutes)} ${unit} left`;
      }
      return rest === "" ? `${line.step}…` : `${line.step}${close(rest)}`;
    }
    case "waiting":
      return `Waiting for you: ${line.question}`;
    case "failed":
      return `Failed at ${line.step}: ${close(line.reason)}`;
    case "resumed":
      return "Resumed after restart.";
    case "done":
      // ux-writing's "Done." line is followed by the result lines; WI-10 decides any summary.
      return "Done.";
  }
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

export const wordFailure = (failure: FailureLine) =>
  `Failed at ${failure.step}: ${close(failure.reason)}`;

export function wordHealth(phrase: HealthPhrase): string {
  switch (phrase.kind) {
    case "ready":
      return "Ready";
    case "steps-not-set-up":
      return `${String(phrase.count)} step${phrase.count === 1 ? "" : "s"} not set up`;
    case "failing-since":
      return `Failing since ${wordDay(phrase.day)}`;
  }
}

const RUN_STATE_WORDS = {
  copying: "copying",
  running: "running",
  waiting: "waiting for you",
  failed: "failed",
  done: "done",
} as const;

export function wordLastRun(line: LastRunLine): string {
  const time = `${two(line.startedAt.getHours())}:${two(line.startedAt.getMinutes())}`;
  return `Last run: ${wordDay(line.day)}, ${time} · ${RUN_STATE_WORDS[line.state]}`;
}

export const wordFormProgress = (progress: { step: number; of: number }) =>
  `Step ${String(progress.step)} of ${String(progress.of)}.`;

export const STATUS_WORDS: Record<StatusPill, string> = {
  running: "Running",
  restarting: "Restarting…",
  stopped: "Stopped",
  needsAttention: "Needs attention",
};

export const BOARD_ERROR_WORDS: Partial<Record<BoardErrorReason, string>> = {
  "last-tab": "A board needs at least one tab.",
};

/** Test-only: "Done." followed by the result lines joined into one sentence. WI-10 decides. */
export function wordDoneWithResults(line: StepLine): string {
  if (line.kind !== "done" || line.results.length === 0) {
    return wordStepLine(line);
  }
  return `Done. ${close(line.results.map((item) => item.text).join(", "))}`;
}

/** "Tuesday", "today", …: the day of `then` as seen at `now`, by the reference rendering above. */
const dayOf = (then: Date, now: Date) => wordDay(relativeDay(then, now));
const clock = (date: Date) => `${two(date.getHours())}:${two(date.getMinutes())}`;

export function wordRegistration(registration: Registration): string {
  return registration.state === "registered" ? "Registered" : "Not registered";
}

export function wordInstallation(installation: Installation): string {
  switch (installation.state) {
    case "installed":
      return "Installed";
    case "not-installed":
      return "Not installed";
    case "installing":
      return `Installing · ${String(installation.progress)}%`;
    case "verifying":
      return "Verifying…";
    case "failed-check":
      return "Failed its check";
  }
}

export function wordPackageUpdate(update: PackageUpdate, now: Date): string {
  switch (update.state) {
    case "up-to-date":
      return "Up to date";
    case "available":
      return `Update to ${update.version} available`;
    case "updating":
      return "Updating…";
    case "updated":
      return `Updated to ${update.version} on ${dayOf(update.at, now)}`;
  }
}

/** The caption under a row's name: where it came from, and whether anyone vouches for it. */
export function wordCaptions(pkg: Package): string[] {
  const captions: string[] = [];
  if (pkg.source.kind === "folder") captions.push(`From a folder: *${pkg.source.path}*`);
  if (!pkg.signed) captions.push("Unsigned");
  return captions;
}

/** The in-use refusal (D6): one use keeps ux-writing's sentence; several read as plan §F. */
export function wordInUse(name: string, refusal: Refusal): string {
  if (refusal.reason !== "in-use") return "WI-10 decides";
  const uses = refusal.uses;
  if (uses.length === 1) {
    const only = uses[0];
    return (
      `Can't ${refusal.action} *${name}*: the flow *${only?.flow ?? ""}* uses its ` +
      `*${only?.step ?? ""}* step. Remove that step first.`
    );
  }
  // WI-10 decides how three or more join; plan §F gives two, joined by "and".
  const parts = uses.map((use) => `*${use.flow}* uses its *${use.step}* step`);
  return `Can't ${refusal.action} *${name}*: ${parts.join(" and ")}. Remove those steps first.`;
}

export const wordPackageGoBack = (
  name: string,
  update: Extract<PackageUpdate, { state: "updated" }>,
) => ({
  button: `Go back to ${update.previous}`,
  confirm: `Go back to *${name}* ${update.previous}? The flows that use it keep running.`,
});

/** InnyTypes' own update line, state by state (ux-writing, Updates). */
export function wordUpdateState(state: UpdateState, now: Date): string {
  switch (state.kind) {
    case "unchecked":
      return `${state.version} · not checked yet`; // WI-10 decides
    case "up-to-date":
      return `Up to date · ${state.version} · checked ${dayOf(state.checkedAt, now)} ${clock(state.checkedAt)}`;
    case "checking":
      return "Checking…";
    case "downloading":
      return `Downloading ${state.version} · ${String(state.percent)}%`;
    case "ready":
      return `${state.version} is ready. It installs when you quit.`;
    case "check-failed": {
      // ux-writing words "no connection"; another reason is WI-10's to decide.
      const why = state.reason === "no-connection" ? "no connection" : "the answer was unreadable";
      const last =
        state.lastCheckedAt === null ? "" : ` Last checked ${dayOf(state.lastCheckedAt, now)}.`;
      return `Couldn't check for updates: ${why}.${last}`;
    }
    case "install-failed":
      return `Update to ${state.version} didn't pass its safety check and wasn't installed.`;
    case "updated":
      return `Updated to ${state.version} on ${dayOf(state.at, now)}.`;
    case "rolling-back":
      return `Going back to ${state.to}…`; // WI-10 decides
  }
}

export const wordUpdateGoBack = (offer: RollbackOffer) => ({
  button: `Go back to ${offer.to}`,
  confirm: `Go back to ${offer.to}? Your flows and settings are kept.`,
});

// ── The tables: value → ux-writing's sentence ────────────────────────────────────────────────

/** One fixture row: a value and what it must read as. */
export type Row<V, S = string> = readonly [V, S];

export const NOW = new Date(2026, 9, 2, 9, 30); // a Friday
const MONDAY = new Date(2026, 8, 28, 18, 0);
const TUESDAY = new Date(2026, 8, 29, 8, 0);

const running = (
  step: string,
  rest: Partial<Extract<StepLine, { kind: "running" }>>,
): StepLine => ({
  kind: "running",
  step,
  text: null,
  progress: null,
  timeLeftMinutes: null,
  ...rest,
});

export const STEP_LINES: readonly Row<StepLine>[] = [
  [{ kind: "copying", text: "from BOYA…" }, "Copying from BOYA…"],
  [{ kind: "safe-to-unplug" }, "Safe to unplug."],
  [running("Transcribing", { timeLeftMinutes: 12 }), "Transcribing, about 12 minutes left."],
  [running("Summarising", { progress: { done: 2, total: 3 } }), "Summarising (2 of 3)."],
  [running("Filing", { text: "in Renaissance…" }), "Filing in Renaissance…"],
  [{ kind: "waiting", question: "who spoke?" }, "Waiting for you: who spoke?"],
  [
    { kind: "waiting", question: "send to Fritte Reinvention?" },
    "Waiting for you: send to Fritte Reinvention?",
  ],
  [
    {
      kind: "failed",
      step: "Transcribe",
      reason: "Mistral refused the key. Check the key in the Transcribe step.",
    },
    "Failed at Transcribe: Mistral refused the key. Check the key in the Transcribe step.",
  ],
  [{ kind: "resumed" }, "Resumed after restart."],
];

/** Step lines ux-writing has no sentence for, rendered here only so nothing is missing. */
export const STEP_LINES_WI10: readonly Row<StepLine>[] = [
  [{ kind: "copying-no-text" }, "Copying…"],
  [{ kind: "between-steps" }, "Running…"],
  [{ kind: "done", results: [] }, "Done."],
  [running("Reading", {}), "Reading…"],
];

export const CARD_TITLES: readonly Row<CardTitle>[] = [
  [{ name: "2026-09-27 client call", minutes: 48 }, "2026-09-27 client call · 48 min"],
];

export const DONE_PILLS: readonly Row<DonePill>[] = [
  [{ kind: "done" }, "Done"],
  [{ kind: "notes", count: 2 }, "2 notes"],
  [{ kind: "warnings", count: 1 }, "1 warning"],
];

/** A result line as the Done fixtures need it; the step that did it does not show here. */
const result = (sink: ResultLine["sink"], text: string): ResultLine => ({
  step: "File",
  sink,
  text,
  anytype: sink === "anytype" ? { spaceId: "s", objectId: "o" } : null,
  folder: sink === "file" ? "/Archive" : null,
  due: null,
});

/** WI-10 decides how the Done line summarises the result lines (wordDoneWithResults). */
export const DONE_LINES: readonly Row<StepLine>[] = [
  [
    {
      kind: "done",
      results: [
        result("anytype", "3 summaries in *Renaissance*"),
        result("scheduled", "2 next steps scheduled"),
      ],
    },
    "Done. 3 summaries in *Renaissance*, 2 next steps scheduled.",
  ],
  [
    { kind: "done", results: [result("file", "Recording moved to *Archive*")] },
    "Done. Recording moved to *Archive*.",
  ],
];

export const FAILURE_LINES: readonly Row<FailureLine>[] = [
  [
    { step: "Transcribe", reason: "Mistral refused the key." },
    "Failed at Transcribe: Mistral refused the key.",
  ],
];

export const HEALTH: readonly Row<HealthPhrase>[] = [
  [{ kind: "ready" }, "Ready"],
  [{ kind: "steps-not-set-up", count: 1 }, "1 step not set up"],
  [{ kind: "failing-since", day: { kind: "weekday", weekday: 1 } }, "Failing since Monday"],
];

export const LAST_RUN: readonly Row<LastRunLine>[] = [
  [
    { day: { kind: "today" }, startedAt: new Date(2026, 9, 2, 14, 20), state: "done" },
    "Last run: today, 14:20 · done",
  ],
];

export const DAYS_WI10: readonly Row<RelativeDay>[] = [
  [{ kind: "yesterday" }, "yesterday"],
  [{ kind: "date", date: new Date(2026, 8, 25) }, "2026-09-25"],
];

export const FORM_PROGRESS: readonly Row<{ step: number; of: number }>[] = [
  [{ step: 3, of: 7 }, "Step 3 of 7."],
];

export const STATUS_PILLS: readonly Row<StatusPill>[] = [
  ["running", "Running"],
  ["restarting", "Restarting…"],
  ["stopped", "Stopped"],
  ["needsAttention", "Needs attention"],
];

// The board's names: Add tab passes ux-writing's "New tab" to addTab; a new board's first tab
// name, passed to newLayout, is WI-10's to decide ("Main" is taken by the sidebar's mode).
export const BOARD_ERRORS: readonly Row<BoardErrorReason>[] = [
  ["last-tab", "A board needs at least one tab."],
];

/** One sample per state, with ux-writing's sentence; `null` marks a row WI-10 decides. */
export const UPDATE_SENTENCES: Record<UpdateStateKind, readonly [UpdateState, string | null]> = {
  unchecked: [{ kind: "unchecked", version: "0.2.1" }, null],
  "up-to-date": [
    { kind: "up-to-date", version: "0.2.1", checkedAt: new Date(2026, 9, 2, 9, 14) },
    "Up to date · 0.2.1 · checked today 09:14",
  ],
  checking: [{ kind: "checking" }, "Checking…"],
  ready: [{ kind: "ready", version: "0.3.0" }, "0.3.0 is ready. It installs when you quit."],
  downloading: [{ kind: "downloading", version: "0.3.0", percent: 42 }, "Downloading 0.3.0 · 42%"],
  "check-failed": [
    { kind: "check-failed", reason: "no-connection", lastCheckedAt: MONDAY },
    "Couldn't check for updates: no connection. Last checked Monday.",
  ],
  "install-failed": [
    { kind: "install-failed", version: "0.3.0", reason: "safety-check" },
    "Update to 0.3.0 didn't pass its safety check and wasn't installed.",
  ],
  updated: [
    { kind: "updated", version: "0.3.0", at: TUESDAY, previous: "0.2.1", rollbackUntil: NOW },
    "Updated to 0.3.0 on Tuesday.",
  ],
  "rolling-back": [{ kind: "rolling-back", to: "0.2.1" }, null],
};

export const UPDATE_STATES: readonly Row<UpdateState>[] = Object.values(UPDATE_SENTENCES).flatMap(
  ([state, sentence]) => (sentence === null ? [] : [[state, sentence] as const]),
);

export const UPDATE_STATES_WI10: readonly Row<UpdateState>[] = [
  [{ kind: "unchecked", version: "0.2.1" }, "0.2.1 · not checked yet"],
  [{ kind: "rolling-back", to: "0.2.1" }, "Going back to 0.2.1…"],
  [
    { kind: "check-failed", reason: "unreadable", lastCheckedAt: null },
    "Couldn't check for updates: the answer was unreadable.",
  ],
];

export const UPDATE_GO_BACK: readonly Row<RollbackOffer, { button: string; confirm: string }>[] = [
  [
    { to: "0.2.1", because: "recent-update", until: NOW },
    {
      button: "Go back to 0.2.1",
      confirm: "Go back to 0.2.1? Your flows and settings are kept.",
    },
  ],
];

export const REGISTRATIONS: readonly Row<Registration>[] = [
  [{ state: "registered", verifiedAt: NOW }, "Registered"],
  [{ state: "not-registered", verifiedAt: NOW }, "Not registered"],
];

export const INSTALLATIONS: readonly Row<Installation>[] = [
  [{ state: "installed", verifiedAt: NOW }, "Installed"],
  [{ state: "not-installed", verifiedAt: NOW }, "Not installed"],
  [{ state: "installing", progress: 60, verifiedAt: NOW }, "Installing · 60%"],
  [{ state: "verifying", verifiedAt: NOW }, "Verifying…"],
  [{ state: "failed-check", reason: "files", verifiedAt: NOW }, "Failed its check"],
];

const UPDATED_PACKAGE = {
  state: "updated",
  version: "0.4",
  previous: "0.3",
  at: TUESDAY,
  rollbackUntil: NOW,
  verifiedAt: NOW,
} as const;

export const PACKAGE_UPDATES: readonly Row<PackageUpdate>[] = [
  [{ state: "up-to-date", verifiedAt: NOW }, "Up to date"],
  [{ state: "available", version: "0.4", verifiedAt: NOW }, "Update to 0.4 available"],
  [{ state: "updating", version: "0.4", verifiedAt: NOW }, "Updating…"],
  [UPDATED_PACKAGE, "Updated to 0.4 on Tuesday"],
];

export const PACKAGE_GO_BACK: readonly Row<
  readonly [string, typeof UPDATED_PACKAGE],
  { button: string; confirm: string }
>[] = [
  [
    ["innyrize", UPDATED_PACKAGE],
    {
      button: "Go back to 0.3",
      confirm: "Go back to *innyrize* 0.3? The flows that use it keep running.",
    },
  ],
];

const FOLDER_PACKAGE: Package = {
  name: "innyrize",
  version: "0.3",
  source: { kind: "folder", path: "~/packages/innyrize" },
  signed: false,
  shipped: false,
  registration: null,
  installation: null,
  update: null,
};

export const PACKAGE_CAPTIONS: readonly Row<Package, readonly string[]>[] = [
  [FOLDER_PACKAGE, ["From a folder: *~/packages/innyrize*", "Unsigned"]],
  [{ ...FOLDER_PACKAGE, source: { kind: "catalogue" }, signed: true }, []],
];

export const IN_USE: readonly Row<readonly [string, Refusal]>[] = [
  [
    [
      "innyrize",
      {
        reason: "in-use",
        action: "unregister",
        uses: [{ flow: "Recordings to Anytype", step: "Transcribe" }],
      },
    ],
    "Can't unregister *innyrize*: the flow *Recordings to Anytype* uses its *Transcribe* step. Remove that step first.",
  ],
  [
    [
      "innyrize",
      {
        reason: "in-use",
        action: "unregister",
        uses: [
          { flow: "Recordings to Anytype", step: "Transcribe" },
          { flow: "Invoices from the mailbox", step: "Read PDF" },
        ],
      },
    ],
    "Can't unregister *innyrize*: *Recordings to Anytype* uses its *Transcribe* step and *Invoices from the mailbox* uses its *Read PDF* step. Remove those steps first.",
  ],
  // ux-writing: removing a package in use is the same sentence, with "remove".
  [
    [
      "innyrize",
      {
        reason: "in-use",
        action: "remove",
        uses: [{ flow: "Recordings to Anytype", step: "Transcribe" }],
      },
    ],
    "Can't remove *innyrize*: the flow *Recordings to Anytype* uses its *Transcribe* step. Remove that step first.",
  ],
  [["innyrize", { reason: "shipped" }], "WI-10 decides"],
];

/** A table with its reference rendering, its rows checked one by one. */
export interface FixtureTable {
  readonly rows: readonly { readonly expected: unknown; readonly rendered: unknown }[];
}

function table<V, S>(render: (value: V) => unknown, rows: readonly Row<V, S>[]): FixtureTable {
  return { rows: rows.map(([value, expected]) => ({ expected, rendered: render(value) })) };
}

/**
 * Every table, by name, with the reference rendering applied. ui-wording.test.ts classifies each
 * name as rendered by the UI or owned by WI-10; a new table fails it until it is classified.
 */
export const FIXTURE_TABLES = {
  stepLines: table(wordStepLine, STEP_LINES),
  stepLinesWi10: table(wordStepLine, STEP_LINES_WI10),
  cardTitles: table(wordTitle, CARD_TITLES),
  donePills: table(wordPill, DONE_PILLS),
  doneLines: table(wordDoneWithResults, DONE_LINES),
  failureLines: table(wordFailure, FAILURE_LINES),
  health: table(wordHealth, HEALTH),
  lastRun: table(wordLastRun, LAST_RUN),
  daysWi10: table(wordDay, DAYS_WI10),
  formProgress: table(wordFormProgress, FORM_PROGRESS),
  statusPills: table((pill: StatusPill) => STATUS_WORDS[pill], STATUS_PILLS),
  boardErrors: table((reason: BoardErrorReason) => BOARD_ERROR_WORDS[reason], BOARD_ERRORS),
  updateStates: table((state: UpdateState) => wordUpdateState(state, NOW), UPDATE_STATES),
  updateStatesWi10: table((state: UpdateState) => wordUpdateState(state, NOW), UPDATE_STATES_WI10),
  updateGoBack: table(wordUpdateGoBack, UPDATE_GO_BACK),
  registrations: table(wordRegistration, REGISTRATIONS),
  installations: table(wordInstallation, INSTALLATIONS),
  packageUpdates: table((update: PackageUpdate) => wordPackageUpdate(update, NOW), PACKAGE_UPDATES),
  packageGoBack: table(([name, update]) => wordPackageGoBack(name, update), PACKAGE_GO_BACK),
  packageCaptions: table(wordCaptions, PACKAGE_CAPTIONS),
  inUse: table(([name, refusal]) => wordInUse(name, refusal), IN_USE),
} as const satisfies Record<string, FixtureTable>;

export type FixtureTableName = keyof typeof FIXTURE_TABLES;
