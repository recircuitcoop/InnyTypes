// The decisions WI-0022-10 made where docs/ux/ux-writing.md gives no sentence, and the run card's
// split of its step line into a bold lead and the rest (ui/words.ts). Every other row of the
// wording fixture is held to ux-writing's own sentence by domain/wording.fixture.test.ts.
import { describe, expect, it } from "vitest";
import { STRINGS } from "../../src/ui/strings";
import { resultParts, stepLineParts } from "../../src/ui/words";
import {
  FIXTURE_TABLES,
  IN_USE,
  STEP_LINES,
  STEP_LINES_WI10,
  UPDATE_STATES_WI10,
} from "./domain/wording.fixture";

describe("the wording WI-0022-10 decided", () => {
  it("names a new board's first tab Overview, and Add tab's tab New tab", () => {
    expect(STRINGS["board.firstTab"]).toBe("Overview");
    expect(STRINGS["board.newTab"]).toBe("New tab");
  });

  it("says Running… between steps and Copying… for a source that says nothing", () => {
    expect(STEP_LINES_WI10.map(([, sentence]) => sentence)).toEqual([
      "Copying…",
      "Running…",
      "Done.",
      "Reading…",
    ]);
  });

  it("words the unchecked, going-back and unreadable update states", () => {
    expect(UPDATE_STATES_WI10.map(([, sentence]) => sentence)).toEqual([
      "Not checked yet · 0.2.1",
      "Going back to 0.2.1…",
      "Couldn't check for updates: the answer was unreadable.",
    ]);
  });

  it("joins three or more uses with commas and a last and, and words the shipped refusal", () => {
    const rendered = FIXTURE_TABLES.inUse.rows.map((row) => row.rendered);
    expect(rendered).toHaveLength(IN_USE.length);
    expect(rendered[3]).toBe(
      "Can't unregister *innyrize*: *Recordings to Anytype* uses its *Transcribe* step, " +
        "*Invoices from the mailbox* uses its *Read PDF* step and *Photos from the camera card* " +
        "uses its *Describe* step. Remove those steps first.",
    );
    expect(rendered[4]).toBe(
      "*anytype* comes with InnyTypes and can't be removed. Unregister it instead.",
    );
  });
});

describe("the run card's step line", () => {
  it("splits so the step's name, or the state's word, is the bold part", () => {
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
