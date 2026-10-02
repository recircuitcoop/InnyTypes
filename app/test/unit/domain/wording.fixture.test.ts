// HAND-OVER LIST FOR WI-0022-10 (ui/strings.ts, plan 0022 §O). Not a domain rule.
//
// The domain (runs, board, flows, setup, status) returns structured values and words nothing.
// This file keeps ux-writing's sentences next to the value each one is made from, so they are not
// lost before WI-0022-10 writes ui/strings.ts. The `word*` functions below are a reference
// rendering that lives ONLY here, never in src: WI-0022-10 replaces them with ui/strings.ts and
// points this table at it (or moves the table to its strings test).
//
// Every expected sentence is copied verbatim from docs/ux/ux-writing.md. Where ux-writing gives no
// sentence for a value, the row says so and WI-0022-10 decides the words (marked "WI-10 decides").
import { describe, expect, it } from "vitest";
import type { BoardErrorReason } from "../../../src/domain/board/layout";
import type { RelativeDay } from "../../../src/domain/flows/days";
import type { HealthPhrase, LastRunLine } from "../../../src/domain/flows/health";
import type { CardTitle, DonePill, FailureLine, StepLine } from "../../../src/domain/runs/card";
import type { ResultLine } from "../../../src/domain/runs/run";
import type { StatusPill } from "../../../src/domain/status/status";

// ── Reference rendering (test-only) ──────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (value: number) => String(value).padStart(2, "0");

/** Ends a sentence with a full stop unless it already ends as one, or trails off with "…". */
const close = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

function wordDay(day: RelativeDay): string {
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

function wordTitle(title: CardTitle): string {
  return title.minutes === null ? title.name : `${title.name} · ${String(title.minutes)} min`;
}

/** The step line as plain text; on the card the step's name (first words) is bold. */
function wordStepLine(line: StepLine): string {
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

function wordPill(pill: DonePill): string {
  switch (pill.kind) {
    case "done":
      return "Done";
    case "notes":
      return `${String(pill.count)} note${pill.count === 1 ? "" : "s"}`;
    case "warnings":
      return `${String(pill.count)} warning${pill.count === 1 ? "" : "s"}`;
  }
}

const wordFailure = (failure: FailureLine) => `Failed at ${failure.step}: ${close(failure.reason)}`;

function wordHealth(phrase: HealthPhrase): string {
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

function wordLastRun(line: LastRunLine): string {
  const time = `${two(line.startedAt.getHours())}:${two(line.startedAt.getMinutes())}`;
  return `Last run: ${wordDay(line.day)}, ${time} · ${RUN_STATE_WORDS[line.state]}`;
}

const wordFormProgress = (progress: { step: number; of: number }) =>
  `Step ${String(progress.step)} of ${String(progress.of)}.`;

const STATUS_WORDS: Record<StatusPill, string> = {
  running: "Running",
  restarting: "Restarting…",
  stopped: "Stopped",
  needsAttention: "Needs attention",
};

const BOARD_ERROR_WORDS: Partial<Record<BoardErrorReason, string>> = {
  "last-tab": "A board needs at least one tab.",
};

// ── The table: value → ux-writing's sentence ─────────────────────────────────────────────────

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

const STEP_LINES: [StepLine, string][] = [
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

/** A result line as the Done fixtures need it; the step that did it does not show here. */
const result = (sink: ResultLine["sink"], text: string): ResultLine => ({
  step: "File",
  sink,
  text,
  anytype: sink === "anytype" ? { spaceId: "s", objectId: "o" } : null,
  folder: sink === "file" ? "/Archive" : null,
  due: null,
});

/** Test-only: "Done." followed by the result lines joined into one sentence. WI-10 decides. */
function wordDoneWithResults(line: StepLine): string {
  if (line.kind !== "done" || line.results.length === 0) {
    return wordStepLine(line);
  }
  return `Done. ${close(line.results.map((item) => item.text).join(", "))}`;
}

const DONE_LINES: [StepLine, string][] = [
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

describe("wording hand-over for WI-0022-10 (ux-writing, verbatim)", () => {
  it.each(STEP_LINES)("step line %j reads %s", (value, sentence) => {
    expect(wordStepLine(value)).toBe(sentence);
  });

  it("the card title", () => {
    expect(wordTitle({ name: "2026-09-27 client call", minutes: 48 })).toBe(
      "2026-09-27 client call · 48 min",
    );
  });

  it("the Done badge row", () => {
    const pills: DonePill[] = [
      { kind: "done" },
      { kind: "notes", count: 2 },
      { kind: "warnings", count: 1 },
    ];
    expect(pills.map(wordPill)).toEqual(["Done", "2 notes", "1 warning"]);
  });

  it("Run history's failed row", () => {
    expect(wordFailure({ step: "Transcribe", reason: "Mistral refused the key." })).toBe(
      "Failed at Transcribe: Mistral refused the key.",
    );
  });

  it("a flow's health", () => {
    expect(wordHealth({ kind: "ready" })).toBe("Ready");
    expect(wordHealth({ kind: "steps-not-set-up", count: 1 })).toBe("1 step not set up");
    expect(wordHealth({ kind: "failing-since", day: { kind: "weekday", weekday: 1 } })).toBe(
      "Failing since Monday",
    );
  });

  it("a flow's last run", () => {
    expect(
      wordLastRun({
        day: { kind: "today" },
        startedAt: new Date(2026, 9, 2, 14, 20),
        state: "done",
      }),
    ).toBe("Last run: today, 14:20 · done");
  });

  it("Setup's form progress", () => {
    expect(wordFormProgress({ step: 3, of: 7 })).toBe("Step 3 of 7.");
  });

  it("the status pill", () => {
    const pills: StatusPill[] = ["running", "restarting", "stopped", "needsAttention"];
    expect(pills.map((pill) => STATUS_WORDS[pill])).toEqual([
      "Running",
      "Restarting…",
      "Stopped",
      "Needs attention",
    ]);
  });

  // The board's names: Add tab passes ux-writing's "New tab" to addTab; a new board's first tab
  // name, passed to newLayout, is WI-10's to decide ("Main" is taken by the sidebar's mode).
  it("the board's refusal", () => {
    expect(BOARD_ERROR_WORDS["last-tab"]).toBe("A board needs at least one tab.");
  });

  // WI-10 decides how the Done line summarises the result lines; this test-only render joins
  // them after "Done." so ux-writing's two Done sentences are kept verbatim.
  it.each(DONE_LINES)("WI-10 decides: done line %j reads %s", (value, sentence) => {
    expect(wordDoneWithResults(value)).toBe(sentence);
  });

  it("the rows WI-10 decides, rendered here only so nothing is missing", () => {
    expect(wordStepLine({ kind: "copying-no-text" })).toBe("Copying…");
    expect(wordStepLine({ kind: "between-steps" })).toBe("Running…");
    expect(wordStepLine({ kind: "done", results: [] })).toBe("Done.");
    expect(wordStepLine(running("Reading", {}))).toBe("Reading…");
    expect(wordDay({ kind: "yesterday" })).toBe("yesterday");
    expect(wordDay({ kind: "date", date: new Date(2026, 8, 25) })).toBe("2026-09-25");
  });
});
