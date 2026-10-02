// Flow health and the last run (plan 0022 §A, ux-writing "Configuration › Flows"), as values;
// their sentences are in wording.fixture.test.ts.
import { describe, expect, it } from "vitest";
import { daysBetween, relativeDay } from "../../../src/domain/flows/days";
import {
  health,
  healthPhrase,
  lastRun,
  lastRunLine,
  type StepSetup,
} from "../../../src/domain/flows/health";
import { fold, type Run, type RunEvent } from "../../../src/domain/runs/run";

const FLOW = { id: "flow-recordings" };
// Friday 2 October 2026, 16:00 local time.
const NOW = new Date(2026, 9, 2, 16, 0);

/** A run of FLOW started at `startedAt` that ends `done`, `failed`, or stays in progress. */
function run(runId: string, startedAt: Date, end: "done" | "failed" | "running" | "waiting"): Run {
  const key = { flowId: FLOW.id, runId, at: startedAt };
  const list: Record<string, unknown>[] = [
    { kind: "started", title: runId },
    { kind: "stepStarted", instanceId: "n", name: "Transcribe" },
  ];
  if (end === "done") {
    list.push({ kind: "stepDone", instanceId: "n" }, { kind: "finished" });
  } else if (end === "failed") {
    list.push({ kind: "stepFailed", instanceId: "n", text: "Mistral refused the key." });
  } else if (end === "waiting") {
    list.push({ kind: "presented", instanceId: "n", question: "who spoke?" });
  }
  return fold(list.map((event) => ({ ...key, ...event }) as unknown as RunEvent));
}

const day = (date: number, hour = 9, minute = 0) => new Date(2026, 9, date, hour, minute);
const SET_UP: StepSetup[] = [
  { instanceId: "a", setUp: true },
  { instanceId: "b", setUp: true },
];

describe("health", () => {
  it("is Ready with no runs, or when the latest finished run is done", () => {
    expect(healthPhrase(health(FLOW, [], SET_UP), NOW)).toEqual({ kind: "ready" });
    const runs = [run("1", day(1), "failed"), run("2", day(2), "done")];
    expect(health(FLOW, runs, SET_UP)).toEqual({ kind: "ready" });
  });

  it("counts the steps not set up, before anything the runs did", () => {
    const one = health(
      FLOW,
      [run("1", day(2), "failed")],
      [
        { instanceId: "a", setUp: false },
        { instanceId: "b", setUp: true },
      ],
    );
    expect(one).toEqual({ kind: "steps-not-set-up", count: 1 });
    expect(healthPhrase(one, NOW)).toEqual({ kind: "steps-not-set-up", count: 1 });
  });

  it("is failing since the first of the latest consecutive failures", () => {
    const runs = [
      run("1", new Date(2026, 8, 25, 9), "done"), // an old success, before the streak
      run("2", new Date(2026, 8, 28, 9), "failed"), // Monday 28 September: the streak begins
      run("3", new Date(2026, 8, 30, 9), "failed"),
      run("4", day(2, 10), "failed"),
      // In progress: it neither breaks nor starts a streak.
      run("5", day(2, 15), "running"),
      run("6", day(2, 15, 30), "waiting"),
    ];
    const value = health(FLOW, runs, SET_UP);
    expect(value).toEqual({ kind: "failing-since", since: new Date(2026, 8, 28, 9) });
    expect(healthPhrase(value, NOW)).toEqual({
      kind: "failing-since",
      day: { kind: "weekday", weekday: 1 },
    });
    // Seen more than a week later, the day is a date.
    expect(healthPhrase(value, new Date(2026, 9, 6, 12))).toEqual({
      kind: "failing-since",
      day: { kind: "date", date: new Date(2026, 8, 28) },
    });
  });

  it("ignores other flows' runs", () => {
    const other = { ...run("1", day(2), "failed"), flowId: "flow-invoices" };
    expect(health(FLOW, [other], SET_UP)).toEqual({ kind: "ready" });
  });
});

describe("last run", () => {
  it("is the latest run by start, with its day, start and state", () => {
    const runs = [run("2", day(2, 14, 20), "done"), run("1", day(1, 8), "failed")];
    const latest = lastRun(FLOW, runs);
    expect(latest?.runId).toBe("2");
    expect(lastRunLine(latest as Run, NOW)).toEqual({
      day: { kind: "today" },
      startedAt: day(2, 14, 20),
      state: "done",
    });
    expect(lastRunLine(run("1", day(1, 8), "failed"), NOW).day).toEqual({ kind: "yesterday" });
    expect(lastRun(FLOW, [])).toBeNull();
  });
});

describe("relative days", () => {
  it("is today, yesterday, a weekday within seven days, else the date", () => {
    expect(relativeDay(new Date(2026, 9, 2, 0, 1), NOW)).toEqual({ kind: "today" });
    expect(relativeDay(new Date(2026, 9, 1, 23, 59), NOW)).toEqual({ kind: "yesterday" });
    expect(relativeDay(new Date(2026, 8, 30, 8), NOW)).toEqual({ kind: "weekday", weekday: 3 });
    expect(relativeDay(new Date(2026, 8, 26), NOW)).toEqual({ kind: "weekday", weekday: 6 });
    expect(relativeDay(new Date(2026, 8, 25, 13), NOW)).toEqual({
      kind: "date",
      date: new Date(2026, 8, 25),
    });
    expect(relativeDay(new Date(2026, 9, 3), NOW)).toEqual({
      kind: "date",
      date: new Date(2026, 9, 3),
    });
    expect(daysBetween(new Date(2026, 9, 3), NOW)).toBe(-1);
  });
});
