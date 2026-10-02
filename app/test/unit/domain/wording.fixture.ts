// The wording fixture (plan 0022 §O): ux-writing's sentences next to the domain value each one is
// made from, table by table, and ui/words.ts's rendering of every row. WI-0022-02, -05 and -07
// handed these rows over; WI-0022-10 wrote ui/strings.ts and ui/words.ts against them, and decided
// the rows ux-writing gives no sentence for (marked "decided").
//
// wording.fixture.test.ts holds every rendered row to its sentence, and ../ui-wording.test.ts
// holds the decided rows and the card's split into bold lead and rest.
//
// Every other expected sentence is copied verbatim from docs/ux/ux-writing.md.
import type { BoardErrorReason } from "../../../src/domain/board/layout";
import type { RelativeDay } from "../../../src/domain/flows/days";
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
import {
  wordBoardError,
  wordCaptions,
  wordDay,
  wordDoneLine,
  wordFailure,
  wordFormProgress,
  wordHealth,
  wordInstallation,
  wordLastRun,
  wordPackageGoBack,
  wordPackageRefusal,
  wordPackageUpdate,
  wordPill,
  wordRegistration,
  wordStatus,
  wordStepLine,
  wordTitle,
  wordUpdateGoBack,
  wordUpdateState,
} from "../../../src/ui/words";

export { wordUpdateState };

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

/** Step lines ux-writing has no sentence for: decided by WI-0022-10. */
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

/** The Done line with its result lines, as ux-writing's two examples join them. */
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
  [{ kind: "no-source" }, "This flow has no source yet."],
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

// The board's names: Add tab passes ux-writing's "New tab" to addTab; a new board's first tab is
// "Overview" (decided; strings.ts board.firstTab).
export const BOARD_ERRORS: readonly Row<BoardErrorReason>[] = [
  ["last-tab", "A board needs at least one tab."],
];

/** One sample per state, with ux-writing's sentence; `null` marks a row WI-0022-10 decided. */
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

/** The update states ux-writing has no sentence for: decided by WI-0022-10. */
export const UPDATE_STATES_WI10: readonly Row<UpdateState>[] = [
  [{ kind: "unchecked", version: "0.2.1" }, "Not checked yet · 0.2.1"],
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
  // Decided by WI-0022-10: three or more uses join with commas and a last "and".
  [
    [
      "innyrize",
      {
        reason: "in-use",
        action: "unregister",
        uses: [
          { flow: "Recordings to Anytype", step: "Transcribe" },
          { flow: "Invoices from the mailbox", step: "Read PDF" },
          { flow: "Photos from the camera card", step: "Describe" },
        ],
      },
    ],
    "Can't unregister *innyrize*: *Recordings to Anytype* uses its *Transcribe* step, *Invoices from the mailbox* uses its *Read PDF* step and *Photos from the camera card* uses its *Describe* step. Remove those steps first.",
  ],
  // Decided by WI-0022-10: a shipped package is never removed (plan 0022 §F).
  [
    ["anytype", { reason: "shipped" }],
    "*anytype* comes with InnyTypes and can't be removed. Unregister it instead.",
  ],
];

/** A table with its rendering, its rows checked one by one. */
export interface FixtureTable {
  readonly rows: readonly { readonly expected: unknown; readonly rendered: unknown }[];
}

function table<V, S>(render: (value: V) => unknown, rows: readonly Row<V, S>[]): FixtureTable {
  return { rows: rows.map(([value, expected]) => ({ expected, rendered: render(value) })) };
}

/**
 * Every table, by name, with ui/words.ts's rendering applied.
 */
export const FIXTURE_TABLES = {
  stepLines: table(wordStepLine, STEP_LINES),
  stepLinesWi10: table(wordStepLine, STEP_LINES_WI10),
  cardTitles: table(wordTitle, CARD_TITLES),
  donePills: table(wordPill, DONE_PILLS),
  doneLines: table(wordDoneLine, DONE_LINES),
  failureLines: table(wordFailure, FAILURE_LINES),
  health: table(wordHealth, HEALTH),
  lastRun: table(wordLastRun, LAST_RUN),
  daysWi10: table(wordDay, DAYS_WI10),
  formProgress: table(wordFormProgress, FORM_PROGRESS),
  statusPills: table((pill: StatusPill) => wordStatus(pill), STATUS_PILLS),
  boardErrors: table((reason: BoardErrorReason) => wordBoardError(reason), BOARD_ERRORS),
  updateStates: table((state: UpdateState) => wordUpdateState(state, NOW), UPDATE_STATES),
  updateStatesWi10: table((state: UpdateState) => wordUpdateState(state, NOW), UPDATE_STATES_WI10),
  updateGoBack: table((offer: RollbackOffer) => wordUpdateGoBack(offer), UPDATE_GO_BACK),
  registrations: table(wordRegistration, REGISTRATIONS),
  installations: table(wordInstallation, INSTALLATIONS),
  packageUpdates: table((update: PackageUpdate) => wordPackageUpdate(update, NOW), PACKAGE_UPDATES),
  packageGoBack: table(([name, update]) => wordPackageGoBack(name, update), PACKAGE_GO_BACK),
  packageCaptions: table(wordCaptions, PACKAGE_CAPTIONS),
  inUse: table(([name, refusal]) => wordPackageRefusal(name, refusal), IN_USE),
} as const satisfies Record<string, FixtureTable>;

export type FixtureTableName = keyof typeof FIXTURE_TABLES;
