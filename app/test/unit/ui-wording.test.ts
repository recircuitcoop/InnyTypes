// The run card's temporary wording (app/src/ui/components/wording.ts, until WI-0022-10's
// ui/strings.ts) against the hand-over fixture (domain/wording.fixture.ts), whose sentences are
// ux-writing's verbatim:
// * every row of every table the UI renders reads, through the UI's own functions, as the
//   fixture says;
// * every other table is named as not rendered by WI-05 and owned by WI-10, and a table added to
//   the fixture fails this test until it is classified one way or the other;
// * the card's value types, restated in the UI because it may not import the domain, are
//   exactly the domain's: same keys, same optionality, same readonly, same nested shapes. The
//   check is in the types, so tsc (the gate's types stage) fails the day either side drifts.
import { describe, expect, it } from "vitest";
import type * as domainCard from "../../src/domain/runs/card";
import type * as domainRun from "../../src/domain/runs/run";
import {
  resultParts,
  stepLineParts,
  wordPill,
  wordStepLine,
  wordTitle,
  type CardTitle,
  type CardVariant,
  type DonePill,
  type RunResultLine,
  type StepLine,
  type StepProgress,
} from "../../src/ui/components/wording";
import {
  CARD_TITLES,
  DONE_PILLS,
  FIXTURE_TABLES,
  STEP_LINES,
  STEP_LINES_WI10,
  type FixtureTableName,
  type Row,
} from "./domain/wording.fixture";

/** The fixture's tables wording.ts renders, each with its rows and the UI's own rendering. */
const RENDERED = {
  stepLines: [STEP_LINES, wordStepLine],
  stepLinesWi10: [STEP_LINES_WI10, wordStepLine],
  cardTitles: [CARD_TITLES, wordTitle],
  donePills: [DONE_PILLS, wordPill],
} as const satisfies Partial<Record<FixtureTableName, readonly [readonly Row<unknown>[], unknown]>>;

/** Not rendered by WI-05; owned by WI-10 (ui/strings.ts). Each needs a screen this WI does not build. */
const NOT_RENDERED_BY_WI05_OWNED_BY_WI10: readonly FixtureTableName[] = [
  "doneLines", // the Done line's one-sentence summary; the card shows "Done." and the result lines
  "failureLines", // Run history's failed-row sentence; the table takes it worded
  "health",
  "lastRun",
  "daysWi10",
  "formProgress",
  "statusPills",
  "boardErrors",
  "updateStates",
  "updateStatesWi10",
  "updateGoBack",
  "registrations",
  "installations",
  "packageUpdates",
  "packageGoBack",
  "packageCaptions",
  "inUse",
];

describe("the run card's wording (wording.ts) against the hand-over fixture", () => {
  it("every fixture table is either rendered by the UI or owned by WI-10, never both", () => {
    const rendered = Object.keys(RENDERED);
    expect([...rendered, ...NOT_RENDERED_BY_WI05_OWNED_BY_WI10].sort()).toEqual(
      Object.keys(FIXTURE_TABLES).sort(),
    );
    expect(
      rendered.filter((name) =>
        NOT_RENDERED_BY_WI05_OWNED_BY_WI10.includes(name as FixtureTableName),
      ),
    ).toEqual([]);
  });

  it.each(STEP_LINES.map((row, index) => [index, ...row] as const))(
    "step line row %i reads as the fixture says",
    (_index, line, sentence) => {
      expect(wordStepLine(line)).toBe(sentence);
    },
  );

  it.each(STEP_LINES_WI10.map((row, index) => [index, ...row] as const))(
    "WI-10-decides step line row %i reads as the fixture says",
    (_index, line, sentence) => {
      expect(wordStepLine(line)).toBe(sentence);
    },
  );

  it.each(CARD_TITLES.map((row, index) => [index, ...row] as const))(
    "card title row %i reads as the fixture says",
    (_index, title, sentence) => {
      expect(wordTitle(title)).toBe(sentence);
    },
  );

  it.each(DONE_PILLS.map((row, index) => [index, ...row] as const))(
    "Done pill row %i reads as the fixture says",
    (_index, pill, sentence) => {
      expect(wordPill(pill)).toBe(sentence);
    },
  );

  it("splits the step line so the step's name, or the state's word, is the bold part", () => {
    for (const [line, sentence] of [...STEP_LINES, ...STEP_LINES_WI10]) {
      const { lead, rest } = stepLineParts(line);
      expect(`${lead}${rest}`).toBe(sentence);
      expect(sentence.startsWith(lead)).toBe(true);
    }
    expect(stepLineParts({ kind: "waiting", question: "who spoke?" }).lead).toBe(
      "Waiting for you:",
    );
    expect(stepLineParts({ kind: "failed", step: "Transcribe", reason: "x" }).lead).toBe("Failed");
  });

  it("splits a result line at its *place* for the Result line molecule", () => {
    expect(resultParts("Meeting notes → *Renaissance*")).toEqual({
      what: "Meeting notes",
      where: "Renaissance",
    });
    expect(resultParts("Moved 42 files to *Archive*")).toEqual({
      what: "Moved 42 files to",
      where: "Archive",
    });
    expect(resultParts("Follow up on pricing · due Thursday")).toEqual({
      what: "Follow up on pricing · due Thursday",
    });
  });
});

/**
 * True only when A and B are the same type: TypeScript's identity relation, which tells apart a
 * missing key, an optional one (`x?: T` against `x: T | undefined`), a readonly one, and any of
 * those inside a nested object or a union member. Probed when written: adding an optional field,
 * or dropping a readonly, to one side turned the assertion below into a tsc error.
 */
type Exact<A, B> =
  (<T>(probe: T) => T extends A ? 1 : 2) extends <T>(probe: T) => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when every entry is true. */
const assertExact = <T extends readonly true[]>(checks: T) => checks;

const RESTATED_EXACTLY = assertExact([
  true satisfies Exact<CardVariant, domainCard.CardVariant>,
  true satisfies Exact<CardTitle, domainCard.CardTitle>,
  true satisfies Exact<StepLine, domainCard.StepLine>,
  true satisfies Exact<DonePill, domainCard.DonePill>,
  true satisfies Exact<StepProgress, domainRun.StepProgress>,
  true satisfies Exact<RunResultLine, domainRun.ResultLine>,
] as const);

it("restates the domain's card values exactly (checked by tsc)", () => {
  expect(RESTATED_EXACTLY).toHaveLength(6);
});
