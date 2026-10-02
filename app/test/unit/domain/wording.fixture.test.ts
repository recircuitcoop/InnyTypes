// The domain's values in words (plan 0022 §O): ui/words.ts's rendering of every fixture row is
// ux-writing's sentence, verbatim, or the one WI-0022-10 decided where ux-writing gives none.
import { describe, expect, it } from "vitest";
import { UPDATE_STATE_KINDS } from "../../../src/domain/updates/machine";
import { FIXTURE_TABLES, NOW, UPDATE_SENTENCES, wordUpdateState } from "./wording.fixture";

describe("ui/words.ts against the wording fixture (ux-writing, verbatim)", () => {
  for (const [name, fixture] of Object.entries(FIXTURE_TABLES)) {
    it.each(fixture.rows.map((row, index) => [index, row] as const))(
      `${name} row %i reads as the fixture says`,
      (_index, row) => {
        expect(row.rendered).toEqual(row.expected);
      },
    );
  }

  it("every update state has its sample, and each sentence that ux-writing gives", () => {
    for (const kind of UPDATE_STATE_KINDS) {
      const [state, sentence] = UPDATE_SENTENCES[kind];
      expect(state.kind).toBe(kind);
      if (sentence !== null) {
        expect(wordUpdateState(state, NOW)).toBe(sentence);
      } else {
        // Decided by WI-0022-10: the row is in UPDATE_STATES_WI10.
        expect(
          FIXTURE_TABLES.updateStatesWi10.rows.some(
            (row) => row.rendered === wordUpdateState(state, NOW),
          ),
        ).toBe(true);
      }
    }
    expect(Object.keys(UPDATE_SENTENCES).sort()).toEqual([...UPDATE_STATE_KINDS].sort());
  });
});
