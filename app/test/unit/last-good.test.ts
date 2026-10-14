// What Live draws when a read is refused for a moment (ui/last-good.ts): the last good value,
// with the refusal beside it, so Edit layout is never thrown away by a passing refusal.
import { describe, expect, it } from "vitest";
import type { Refusal } from "../../src/ui/answer";
import { lastGood } from "../../src/ui/last-good";

const RESTARTING: Refusal = { reason: "restarting", sentence: "refused.restarting" };

describe("lastGood", () => {
  it("shows nothing while the first read is under way, and its refusal alone if it fails", () => {
    expect(lastGood<string>(null, { status: "loading" })).toEqual({
      value: null,
      refused: null,
      loading: true,
    });
    expect(lastGood<string>(null, { status: "refused", refused: RESTARTING })).toEqual({
      value: null,
      refused: RESTARTING,
      loading: false,
    });
  });

  it("keeps the last good value through a refused read, then takes the next good one", () => {
    let shown = lastGood<string>(null, { status: "ready", value: "board 1" });
    expect(shown).toEqual({ value: "board 1", refused: null, loading: false });
    shown = lastGood(shown.value, { status: "refused", refused: RESTARTING });
    expect(shown).toEqual({ value: "board 1", refused: RESTARTING, loading: false });
    shown = lastGood(shown.value, { status: "loading" });
    expect(shown).toEqual({ value: "board 1", refused: null, loading: false });
    shown = lastGood(shown.value, { status: "ready", value: "board 2" });
    expect(shown).toEqual({ value: "board 2", refused: null, loading: false });
  });
});
