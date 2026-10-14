// Run history's rows (ui/screens/history-rows.ts): what `run.list` answers, worded as the table
// draws each row (When, Event, Took, the state pill, the notes pills, a failed row's sentence, a
// re-run's caption); the filter row as `run.list` asks it; the empty sentences; and Delete run's
// confirmation for one run and for several (ui/words.ts).
import { describe, expect, it } from "vitest";

import type { RunRecord } from "../../src/ui/run-contract";
import { MAX_MANY } from "../../src/application/run-actions";
import {
  ANY_TIME,
  anytypeLink,
  HISTORY_FILTERS,
  HISTORY_PAGE,
  HISTORY_RANGES,
  historyEmpty,
  historyQuery,
  historyRow,
} from "../../src/ui/screens/history-rows";
import { STRINGS } from "../../src/ui/strings";
import { wordDeleteRuns } from "../../src/ui/words";

// Thursday 2026-10-08, 15:00 local.
const NOW = new Date(2026, 9, 8, 15, 0);

const record = (more: Partial<RunRecord>): RunRecord => ({
  flowId: "tab1",
  runId: "r1",
  title: "2026-09-29 coaching",
  durationSeconds: null,
  startedAt: new Date(2026, 9, 6, 14, 20),
  endedAt: new Date(2026, 9, 6, 14, 52),
  state: "done",
  resumed: false,
  copyText: null,
  copied: false,
  steps: [],
  notes: [],
  warnings: [],
  results: [],
  failure: null,
  rerunOf: null,
  rerunFrom: null,
  rerunOfStartedAt: null,
  cleared: false,
  ...more,
});

describe("a run's row", () => {
  it("says when, what, how long, its state and its notes", () => {
    const line = { step: "Transcribe", text: "x" };
    expect(historyRow(record({ notes: [line, line], warnings: [line] }), NOW, true)).toEqual({
      id: "r1",
      when: "Tuesday 14:20",
      event: "2026-09-29 coaching",
      took: "32 min",
      state: "done",
      stateLabel: "Done",
      selected: true,
      inAnytype: false,
      notes: [
        { state: "off", label: "2 notes" },
        { state: "waiting", label: "1 warning" },
      ],
    });
  });

  it("carries a failed run's sentence, a running run no time, and a re-run's caption", () => {
    const failed = record({
      state: "failed",
      failure: { step: "Transcribe", text: "Mistral refused the key", instanceId: "n" },
    });
    expect(historyRow(failed, NOW, false)).toMatchObject({
      state: "failed",
      stateLabel: "Failed",
      failure: "Failed at Transcribe: Mistral refused the key.",
    });
    // The caption is the re-run's own record: the run it re-runs need not be among the rows.
    const rerun = record({
      runId: "r2",
      state: "copying",
      endedAt: null,
      startedAt: new Date(2026, 9, 8, 9, 5),
      rerunOf: "r1",
      rerunOfStartedAt: new Date(2026, 9, 6, 14, 30),
    });
    const row = historyRow(rerun, NOW, false);
    expect(row).toMatchObject({
      when: "today 09:05",
      took: "",
      state: "running",
      stateLabel: "Copying",
      caption: "Re-run Tuesday 14:30",
    });
    expect(row).not.toHaveProperty("notes");
    expect(historyRow(record({}), NOW, false)).not.toHaveProperty("caption");
    // A run shorter than a minute still took one.
    const quick = record({ endedAt: new Date(2026, 9, 6, 14, 20, 10) });
    expect(historyRow(quick, NOW, false).took).toBe("1 min");
  });

  it("offers Open in Anytype with the deep link of the run's first Anytype result", () => {
    const result = { step: "File", text: "Notes", folder: null, due: null };
    const run = record({
      results: [
        { ...result, sink: "file", anytype: null },
        { ...result, sink: "anytype", anytype: { spaceId: "space-1", objectId: "obj-1" } },
      ],
    });
    expect(historyRow(run, NOW, false).inAnytype).toBe(true);
    expect(anytypeLink(run)).toBe("anytype://object?objectId=obj-1&spaceId=space-1");
    expect(anytypeLink(record({}))).toBeNull();
  });
});

describe("the filter row", () => {
  it("lists no more runs than one Re-run or Delete of the Selected bar takes", () => {
    expect(HISTORY_PAGE).toBe(MAX_MANY);
  });

  it("offers All, Waiting, Failed and Done, and Last 7, 30 and 90 days or Any time", () => {
    expect(HISTORY_FILTERS.map((each) => each.label)).toEqual(["All", "Waiting", "Failed", "Done"]);
    expect(HISTORY_RANGES.map((each) => each.label)).toEqual([
      "Last 7 days",
      "Last 30 days",
      "Last 90 days",
      "Any time",
    ]);
  });

  it("asks run.list for the state, the start and the words", () => {
    expect(historyQuery("tab1", "all", ANY_TIME, "  ", NOW)).toEqual({
      flowId: "tab1",
      limit: HISTORY_PAGE,
    });
    expect(historyQuery("tab1", "failed", "7", " coaching ", NOW)).toEqual({
      flowId: "tab1",
      limit: HISTORY_PAGE,
      state: "failed",
      since: NOW.getTime() - 7 * 86_400_000,
      search: "coaching",
    });
  });

  it("says no runs yet, or none matching, over the range or what Run history keeps", () => {
    expect(historyEmpty("all", "7", "", 90)).toBe(STRINGS["history.empty"]);
    expect(historyEmpty("failed", "7", "", 90)).toBe("No failed runs in the last 7 days.");
    expect(historyEmpty("all", "30", "standup", 90)).toBe("No runs in the last 30 days.");
    expect(historyEmpty("done", ANY_TIME, "", 90)).toBe("No done runs in the last 90 days.");
    expect(historyEmpty("done", ANY_TIME, "", null)).toBe(STRINGS["history.empty"]);
  });
});

describe("Delete run's confirmation", () => {
  it("asks for one run, or for several by their count", () => {
    expect(wordDeleteRuns(1)).toEqual({
      title: "Delete this run?",
      body: "Its results in Anytype are kept; only InnyTypes' record of it goes.",
    });
    expect(wordDeleteRuns(3)).toEqual({
      title: "Delete 3 runs?",
      body: "Their results in Anytype are kept; only InnyTypes' record of them goes.",
    });
  });
});
