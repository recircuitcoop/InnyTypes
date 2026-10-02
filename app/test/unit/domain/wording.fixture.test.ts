// HAND-OVER LIST FOR WI-0022-10 (ui/strings.ts, plan 0022 §O). Not a domain rule.
//
// The tables and the reference rendering are in wording.fixture.ts, shared with
// ../ui-wording.test.ts. This test holds the reference rendering to every row: each sentence is
// ux-writing's, verbatim, or marked "WI-10 decides" where ux-writing gives none.
import { describe, expect, it } from "vitest";
import { UPDATE_STATE_KINDS } from "../../../src/domain/updates/machine";
import { FIXTURE_TABLES, NOW, UPDATE_SENTENCES, wordUpdateState } from "./wording.fixture";

describe("wording hand-over for WI-0022-10 (ux-writing, verbatim)", () => {
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
      }
    }
    expect(Object.keys(UPDATE_SENTENCES).sort()).toEqual([...UPDATE_STATE_KINDS].sort());
  });
});
