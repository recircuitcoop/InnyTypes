// Runs (plan 0022 §A, Acceptance): one card per source event, a failure is never a warning, a run
// resumed after replay, and the value behind every step line of ux-writing's "Live: the board"
// (the sentences themselves are in wording.fixture.test.ts).
import { describe, expect, it } from "vitest";
import {
  cardTitle,
  cardVariant,
  donePills,
  failureLine,
  stepLine,
  wholeMinutes,
} from "../../../src/domain/runs/card";
import {
  applyEvent,
  currentStep,
  fold,
  foldAll,
  isFinished,
  RUN_STATES,
  runKeyString,
  RunTransitionError,
  type Run,
  type RunEvent,
} from "../../../src/domain/runs/run";

const FLOW = "flow-recordings";
const at = (minute: number): Date => new Date(2026, 9, 2, 14, minute);

/** Events of one run, with its key and a clock filled in. */
function events(runId: string, ...list: Record<string, unknown>[]): RunEvent[] {
  return list.map(
    (event, index) => ({ flowId: FLOW, runId, at: at(index), ...event }) as unknown as RunEvent,
  );
}

const started = (title = "2026-09-27 client call", extra: Record<string, unknown> = {}) => ({
  kind: "started",
  title,
  ...extra,
});

/** A run that started, transcribed and finished with notes, warnings and results. */
function doneRun(): Run {
  return fold(
    events(
      "evt-1",
      started("2026-09-27 client call", { durationSeconds: 48 * 60 }),
      { kind: "stepStarted", instanceId: "n-tx", name: "Transcribe" },
      {
        kind: "stepDone",
        instanceId: "n-tx",
        notes: [
          { level: "note", text: "Speaker 3 was not named" },
          { level: "warning", text: "Transcription used the fallback model" },
        ],
      },
      { kind: "stepStarted", instanceId: "n-file", name: "File" },
      {
        kind: "stepDone",
        instanceId: "n-file",
        notes: [{ level: "note", text: "Summary shortened to fit the type's limit" }],
        results: [
          {
            kind: "anytype",
            text: "Meeting notes → Renaissance",
            anytype: { spaceId: "s", objectId: "o" },
          },
          { kind: "file", text: "Moved recording to Archive", folder: "/x/Archive" },
          { kind: "scheduled", text: "Follow up on pricing · due Thursday", due: "2026-10-08" },
          { kind: "plain", text: "Deleted the recording" },
        ],
      },
      { kind: "finished" },
    ),
  );
}

describe("one card per source event", () => {
  it("makes one run per event per flow, in arrival order, never merging them", () => {
    const stream: RunEvent[] = [
      ...events("evt-1", started("first call")),
      ...events("evt-2", started("second call")),
      // The same source event reaching another flow is that flow's own run.
      { flowId: "flow-invoices", runId: "evt-1", at: at(3), kind: "started", title: "first call" },
      ...events("evt-1", { kind: "stepStarted", instanceId: "n1", name: "Transcribe" }),
    ];
    const runs = foldAll(stream);
    expect(runs.map((run) => [run.flowId, run.runId])).toEqual([
      [FLOW, "evt-1"],
      [FLOW, "evt-2"],
      ["flow-invoices", "evt-1"],
    ]);
    expect(runs[0]?.steps).toHaveLength(1);
    expect(runs[1]?.steps).toHaveLength(0);
    expect(new Set(runs.map(runKeyString)).size).toBe(3);
  });

  it("refuses a stream that does not start with the run's started event, or mixes two runs", () => {
    expect(() => fold([])).toThrow(RunTransitionError);
    expect(() => fold(events("evt-1", { kind: "finished" }))).toThrow(/starts with "started"/);
    expect(() => fold(events("evt-1", started(), started()))).toThrow(/only once/);
    const run = fold(events("evt-1", started()));
    expect(() => applyEvent(run, events("evt-2", { kind: "finished" })[0] as RunEvent)).toThrow(
      /another run/,
    );
  });

  it("titles the card with the event's name and its length", () => {
    expect(cardTitle(doneRun())).toEqual({ name: "2026-09-27 client call", minutes: 48 });
    expect(cardTitle(fold(events("evt-1", started("invoice.pdf"))))).toEqual({
      name: "invoice.pdf",
      minutes: null,
    });
    expect(cardTitle(fold(events("e", started("short", { durationSeconds: 5 }))))).toEqual({
      name: "short",
      minutes: 1,
    });
  });

  it("records a re-run's origin", () => {
    const rerun = fold(events("evt-9", started("call", { rerunOf: "evt-1", rerunFrom: "n-tx" })));
    expect([rerun.rerunOf, rerun.rerunFrom]).toEqual(["evt-1", "n-tx"]);
    expect([doneRun().rerunOf, doneRun().rerunFrom]).toEqual([null, null]);
  });
});

describe("failure is never a warning", () => {
  it("keeps warnings on a done run, counted in the Done badge", () => {
    const run = doneRun();
    expect(run.state).toBe("done");
    expect(run.failure).toBeNull();
    expect(run.warnings).toEqual([
      { step: "Transcribe", text: "Transcription used the fallback model" },
    ]);
    expect(run.notes).toEqual([
      { step: "Transcribe", text: "Speaker 3 was not named" },
      { step: "File", text: "Summary shortened to fit the type's limit" },
    ]);
    expect(donePills(run)).toEqual([
      { kind: "done" },
      { kind: "notes", count: 2 },
      { kind: "warnings", count: 1 },
    ]);
    expect(cardVariant(run)).toBe("done");
  });

  it("shows the Done pill alone when there is nothing to say", () => {
    const run = fold(events("e", started(), { kind: "finished" }));
    expect(donePills(run)).toEqual([{ kind: "done" }]);
    const one = fold(
      events(
        "e",
        started(),
        { kind: "stepStarted", instanceId: "n", name: "Read" },
        { kind: "stepDone", instanceId: "n", notes: [{ level: "note", text: "x" }] },
        { kind: "finished" },
      ),
    );
    expect(donePills(one)).toEqual([{ kind: "done" }, { kind: "notes", count: 1 }]);
  });

  it("fails the run when a step cannot finish, and keeps that failure for good", () => {
    const run = fold(
      events(
        "evt-1",
        started(),
        { kind: "stepStarted", instanceId: "n-tx", name: "Transcribe" },
        { kind: "stepStarted", instanceId: "n-side", name: "Archive" },
        {
          kind: "stepFailed",
          instanceId: "n-tx",
          text: "Mistral refused the key. Check the key in the Transcribe step.",
        },
        // A parallel branch finishing or failing late changes nothing.
        { kind: "stepDone", instanceId: "n-side", notes: [{ level: "warning", text: "late" }] },
        { kind: "stepFailed", instanceId: "n-side", text: "Second failure." },
      ),
    );
    expect(run.state).toBe("failed");
    expect(run.failure).toEqual({
      step: "Transcribe",
      instanceId: "n-tx",
      text: "Mistral refused the key. Check the key in the Transcribe step.",
    });
    expect(run.warnings).toEqual([]);
    expect(run.endedAt).toEqual(at(3));
    expect(donePills(run)).toEqual([]);
    expect(cardVariant(run)).toBe("failed");
    expect(stepLine(run)).toEqual({
      kind: "failed",
      step: "Transcribe",
      reason: "Mistral refused the key. Check the key in the Transcribe step.",
    });
    expect(failureLine(run)).toEqual({
      step: "Transcribe",
      reason: "Mistral refused the key. Check the key in the Transcribe step.",
    });
    expect(failureLine(doneRun())).toBeNull();
  });

  it("a step that starts on a done run reopens it; after a FAILED run, activity is ignored", () => {
    const done = applyEvent(doneRun(), { ...base(doneRun()), kind: "cleared", cleared: true });
    // The flow was not finished after all (a delay node, an input held at a queue bound).
    const reopened = applyEvent(done, {
      ...base(done),
      kind: "stepStarted",
      instanceId: "n-up",
      name: "Upload",
    });
    expect(reopened).toMatchObject({ state: "running", endedAt: null, cleared: false });
    expect(reopened.steps.at(-1)).toMatchObject({ name: "Upload", state: "running" });
    // Its later failure fails it, as on any running run.
    const failed = applyEvent(reopened, {
      ...base(reopened),
      kind: "stepFailed",
      instanceId: "n-up",
      text: "upload failed: 500",
    });
    expect(failed).toMatchObject({
      state: "failed",
      failure: { step: "Upload", text: "upload failed: 500" },
    });
    // A failed run ignores a step starting late, and keeps its first failure.
    const late = applyEvent(failed, {
      ...base(failed),
      kind: "stepStarted",
      instanceId: "n-x",
      name: "Late",
    });
    expect(late).toBe(failed);
    // Other late activity on a done run changes nothing.
    expect(
      applyEvent(doneRun(), { ...base(doneRun()), kind: "status", instanceId: "n-tx", text: "x" }),
    ).toEqual(doneRun());
  });

  it("finds a step by its input when two inputs of one instance are open", () => {
    const run = fold(
      events(
        "e",
        started(),
        { kind: "stepStarted", instanceId: "n", inputId: "in-1", name: "Tx" },
        { kind: "stepStarted", instanceId: "n", inputId: "in-2", name: "Tx" },
        { kind: "status", instanceId: "n", inputId: "in-1", text: "first" },
        { kind: "stepDone", instanceId: "n", inputId: "in-1" },
      ),
    );
    expect(run.steps.map((step) => [step.inputId, step.statusText, step.state])).toEqual([
      ["in-1", "first", "done"],
      ["in-2", null, "running"],
    ]);
    expect(() =>
      applyEvent(run, { ...base(run), kind: "stepDone", instanceId: "n", inputId: "in-1" }),
    ).toThrow(/No step of "in-1" is in progress/);
  });

  it("refuses to finish, resume or clear a run whose state does not allow it", () => {
    const failed = fold(
      events(
        "e",
        started(),
        { kind: "stepStarted", instanceId: "n", name: "Read" },
        { kind: "stepFailed", instanceId: "n", text: "Unreadable" },
      ),
    );
    expect(() => applyEvent(failed, { ...base(failed), kind: "finished" })).toThrow(
      /cannot happen to a failed run/,
    );
    expect(() => applyEvent(failed, { ...base(failed), kind: "cleared", cleared: true })).toThrow(
      RunTransitionError,
    );
    expect(() => applyEvent(failed, { ...base(failed), kind: "resumed" })).toThrow(
      RunTransitionError,
    );
    expect(failureLine(failed)).toEqual({ step: "Read", reason: "Unreadable" });
  });
});

/** The key and a clock for one more event on `run`. */
function base(run: Run) {
  return { flowId: run.flowId, runId: run.runId, at: at(30) };
}

describe("resumed after replay", () => {
  it("flags a running run that was replayed, keeps its state, and clears the flag on activity", () => {
    const resumed = fold(
      events(
        "evt-1",
        started(),
        { kind: "stepStarted", instanceId: "n-tx", name: "Transcribing" },
        { kind: "resumed" },
      ),
    );
    expect(resumed.state).toBe("running");
    expect(resumed.resumed).toBe(true);
    expect(cardVariant(resumed)).toBe("resumed");
    expect(stepLine(resumed)).toEqual({ kind: "resumed" });

    const moving = applyEvent(resumed, {
      ...base(resumed),
      kind: "status",
      instanceId: "n-tx",
      etaSeconds: 720,
    });
    expect(moving.resumed).toBe(false);
    expect(cardVariant(moving)).toBe("running");
    expect(stepLine(moving)).toEqual({
      kind: "running",
      step: "Transcribing",
      text: null,
      progress: null,
      timeLeftMinutes: 12,
    });
  });

  it("goes on showing the question of a waiting run that was replayed", () => {
    const run = fold(
      events(
        "evt-1",
        started(),
        { kind: "stepStarted", instanceId: "n-q", name: "Name the speakers" },
        { kind: "presented", instanceId: "n-q", question: "who spoke?" },
        { kind: "resumed" },
      ),
    );
    expect([run.state, run.resumed]).toEqual(["waiting", true]);
    expect(cardVariant(run)).toBe("waiting");
    expect(stepLine(run)).toEqual({ kind: "waiting", question: "who spoke?" });
  });

  it("says Resumed for a copy that was replayed", () => {
    const run = fold(
      events("e", started(), { kind: "copying", text: "from BOYA…" }, { kind: "resumed" }),
    );
    expect(stepLine(run)).toEqual({ kind: "resumed" });
  });

  it("never resumes a finished run", () => {
    expect(() => applyEvent(doneRun(), { ...base(doneRun()), kind: "resumed" })).toThrow(
      RunTransitionError,
    );
  });
});

describe("the step line, as ux-writing words it", () => {
  it("copies, then says it is safe to unplug, then names the running step", () => {
    const copying = fold(events("e", started(), { kind: "copying", text: "from BOYA…" }));
    expect(copying.state).toBe("copying");
    expect(cardVariant(copying)).toBe("copying");
    expect(stepLine(copying)).toEqual({ kind: "copying", text: "from BOYA…" });

    const silent = fold(events("e", started(), { kind: "copying" }));
    expect(stepLine(silent)).toEqual({ kind: "copying-no-text" });

    const copied = applyEvent(copying, { ...base(copying), kind: "copied" });
    expect(copied.state).toBe("running");
    expect(stepLine(copied)).toEqual({ kind: "safe-to-unplug" });

    const idle = fold(events("e", started()));
    expect(stepLine(idle)).toEqual({ kind: "between-steps" });
    expect(cardVariant(idle)).toBe("running");
  });

  it("joins the step's words, its count and its time left", () => {
    const run = (status: Record<string, unknown>, name = "Transcribing") =>
      fold(
        events(
          "e",
          started(),
          { kind: "stepStarted", instanceId: "n", name },
          { kind: "status", instanceId: "n", ...status },
        ),
      );
    const line = (step: string, rest: Record<string, unknown>) => ({
      kind: "running",
      step,
      text: null,
      progress: null,
      timeLeftMinutes: null,
      ...rest,
    });
    expect(stepLine(run({ etaSeconds: 720 }))).toEqual(
      line("Transcribing", { timeLeftMinutes: 12 }),
    );
    expect(stepLine(run({ progress: { done: 2, total: 3 } }, "Summarising"))).toEqual(
      line("Summarising", { progress: { done: 2, total: 3 } }),
    );
    expect(stepLine(run({ text: "in Renaissance…" }, "Filing"))).toEqual(
      line("Filing", { text: "in Renaissance…" }),
    );
    expect(stepLine(run({}, "Reading"))).toEqual(line("Reading", {}));
    expect(stepLine(run({ text: "" }, "Reading"))).toEqual(line("Reading", {}));
    // A later status keeps what an earlier one said unless it says something new.
    const twice = applyEvent(run({ text: "the audio", etaSeconds: 60 }), {
      flowId: FLOW,
      runId: "e",
      at: at(9),
      kind: "status",
      instanceId: "n",
      progress: { done: 1, total: 2 },
    });
    expect(stepLine(twice)).toEqual(
      line("Transcribing", {
        text: "the audio",
        progress: { done: 1, total: 2 },
        timeLeftMinutes: 1,
      }),
    );
    expect(wholeMinutes(20)).toBe(1);
  });

  it("asks, answers and goes on", () => {
    const waiting = fold(
      events(
        "e",
        started(),
        { kind: "stepStarted", instanceId: "n-q", name: "Approve sending" },
        { kind: "presented", instanceId: "n-q", question: "send to Fritte Reinvention?" },
      ),
    );
    expect(waiting.state).toBe("waiting");
    expect(stepLine(waiting)).toEqual({ kind: "waiting", question: "send to Fritte Reinvention?" });
    expect(currentStep(waiting)?.name).toBe("Approve sending");

    const answered = applyEvent(waiting, {
      ...base(waiting),
      kind: "submitted",
      instanceId: "n-q",
    });
    expect(answered.state).toBe("running");
    expect(() =>
      applyEvent(answered, { ...base(answered), kind: "submitted", instanceId: "n-q" }),
    ).toThrow(RunTransitionError);
  });

  it("keeps waiting while a second question is open", () => {
    const run = fold(
      events(
        "e",
        started(),
        { kind: "stepStarted", instanceId: "q1", name: "Speakers" },
        { kind: "stepStarted", instanceId: "q2", name: "Customer" },
        { kind: "presented", instanceId: "q1", question: "who spoke?" },
        { kind: "presented", instanceId: "q2", question: "which customer?" },
        { kind: "submitted", instanceId: "q1" },
      ),
    );
    expect(run.state).toBe("waiting");
    expect(stepLine(run)).toEqual({ kind: "waiting", question: "which customer?" });
    // A step of the same run finishing meanwhile does not end the wait.
    const other = fold(
      events(
        "e",
        started(),
        { kind: "stepStarted", instanceId: "q1", name: "Speakers" },
        { kind: "stepStarted", instanceId: "n", name: "Summarise" },
        { kind: "presented", instanceId: "q1", question: "who spoke?" },
        { kind: "stepDone", instanceId: "n" },
      ),
    );
    expect(other.state).toBe("waiting");
    expect(() => applyEvent(other, { ...base(other), kind: "finished" })).toThrow(
      RunTransitionError,
    );
  });

  it("refuses activity for a step that is not in progress", () => {
    const run = fold(events("e", started()));
    expect(() =>
      applyEvent(run, { ...base(run), kind: "status", instanceId: "ghost", text: "x" }),
    ).toThrow(/No step of "ghost"/);
  });

  it("says what a done run did: its result lines", () => {
    const run = doneRun();
    expect(stepLine(run)).toEqual({ kind: "done", results: run.results });
    expect(stepLine(fold(events("e", started(), { kind: "finished" })))).toEqual({
      kind: "done",
      results: [],
    });
    expect(isFinished(run.state)).toBe(true);
    expect(RUN_STATES.filter(isFinished)).toEqual(["failed", "done"]);
  });

  it("keeps each result line with its step and only the link its sink has", () => {
    expect(doneRun().results).toEqual([
      {
        step: "File",
        sink: "anytype",
        text: "Meeting notes → Renaissance",
        anytype: { spaceId: "s", objectId: "o" },
        folder: null,
        due: null,
      },
      {
        step: "File",
        sink: "file",
        text: "Moved recording to Archive",
        anytype: null,
        folder: "/x/Archive",
        due: null,
      },
      {
        step: "File",
        sink: "scheduled",
        text: "Follow up on pricing · due Thursday",
        anytype: null,
        folder: null,
        due: "2026-10-08",
      },
      {
        step: "File",
        sink: "plain",
        text: "Deleted the recording",
        anytype: null,
        folder: null,
        due: null,
      },
    ]);
  });
});

describe("clear done", () => {
  it("flags a done run and undoes it, never deleting it", () => {
    const run = doneRun();
    const cleared = applyEvent(run, { ...base(run), kind: "cleared", cleared: true });
    expect(cleared.cleared).toBe(true);
    expect(cleared.results).toEqual(run.results);
    const back = applyEvent(cleared, { ...base(run), kind: "cleared", cleared: false });
    expect(back.cleared).toBe(false);
  });

  it("never clears a run in progress", () => {
    const run = fold(events("e", started()));
    expect(() => applyEvent(run, { ...base(run), kind: "cleared", cleared: true })).toThrow(
      /cannot happen to a running run/,
    );
  });
});
