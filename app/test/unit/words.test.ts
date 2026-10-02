// ui/words.ts beyond the wording fixture's rows: an AppApi refusal in words, the days of the week,
// and the values no screen words (a board error with no sentence, a package refusal the row's
// state already says).
import { describe, expect, it } from "vitest";
import { relativeDay } from "../../src/domain/flows/days";
import {
  dayAt,
  dayOf,
  isoDate,
  wordBoardError,
  wordPackageRefusal,
  wordRefusal,
} from "../../src/ui/words";

describe("words for an AppApi refusal", () => {
  it("fills its line's slots, or words it plain", () => {
    expect(wordRefusal({ reason: "dirty", sentence: "flows.refused.dirty" })).toBe(
      "Save or discard your changes on the canvas first.",
    );
    expect(
      wordRefusal({
        reason: "invalid",
        sentence: "error.formIncomplete",
        params: { step: "Summarise", what: "choose an object type" },
      }),
    ).toBe("*Summarise* isn't set up yet: choose an object type.");
  });

  it("names every flow and step of an in-use refusal (D6)", () => {
    expect(
      wordRefusal({
        reason: "in-use",
        sentence: "packages.inUse.many",
        inUse: {
          name: "innyrize",
          action: "unregister",
          uses: [
            { flow: "A", step: "X" },
            { flow: "B", step: "Y" },
          ],
        },
      }),
    ).toBe(
      "Can't unregister *innyrize*: *A* uses its *X* step and *B* uses its *Y* step. Remove those steps first.",
    );
  });
});

describe("words for the rest", () => {
  it("says every day of the week, and the date for anything further", () => {
    const saturday = new Date(2026, 9, 10, 12, 0);
    const monday = new Date(2026, 9, 12, 12, 0);
    const at = (day: number) => new Date(2026, 9, day, 9, 0);
    expect([3, 4, 5, 6, 7, 8, 9].map((day) => dayOf(at(day), saturday))).toEqual([
      "2026-10-03",
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "yesterday",
    ]);
    expect([9, 10].map((day) => dayOf(at(day), monday))).toEqual(["Friday", "Saturday"]);
    expect(isoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("has no sentence for a board error a person never causes, or a refusal the row already says", () => {
    expect(wordBoardError("unknown-tab")).toBeUndefined();
    expect(wordPackageRefusal("monty", { reason: "busy" })).toBeNull();
  });
});

describe("the person's calendar", () => {
  it("places a day exactly as the domain's own relativeDay does", () => {
    const now = new Date(2026, 2, 30, 0, 30); // the night after a daylight-saving change
    for (let back = -3; back <= 10; back += 1) {
      const then = new Date(2026, 2, 30 - back, 23, 0);
      expect(dayAt(then, now)).toEqual(relativeDay(then, now));
    }
  });
});
