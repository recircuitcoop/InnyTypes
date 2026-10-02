// What a step tells about its run (protocol 2.1, spec 4.2.1, 4.2.2) becomes the run events the
// fold takes: notes and warnings split, results kept with their step, progress on that step.
import { describe, expect, it } from "vitest";

import { fold, type RunEvent } from "../../../src/domain/runs/run";
import { stepDoneEvent, stepStatusEvent } from "../../../src/domain/runs/step-report";

const KEY = { flowId: "flow-recordings", runId: "event-1" };
const at = (minute: number): Date => new Date(2026, 9, 2, 14, minute);

const started: RunEvent = { ...KEY, at: at(0), kind: "started", title: "client call" };
const stepStarted = (instanceId: string, name: string, minute: number): RunEvent => ({
  ...KEY,
  at: at(minute),
  kind: "stepStarted",
  instanceId,
  name,
});

describe("stepDoneEvent", () => {
  it("carries notes and results into the run, warnings apart from notes", () => {
    const run = fold([
      started,
      stepStarted("n1", "Transcribe", 1),
      stepDoneEvent(KEY, "n1", at(2), {
        notes: [
          { level: "note", text: "used the large model" },
          { level: "warning", text: "2 speakers could not be named" },
        ],
        results: [
          {
            kind: "anytype",
            text: "Meeting notes → Renaissance",
            anytype: { spaceId: "s1", objectId: "o1" },
          },
          { kind: "file", text: "Moved recording", folder: "/archive" },
        ],
      }),
    ]);
    expect(run.notes).toEqual([{ step: "Transcribe", text: "used the large model" }]);
    expect(run.warnings).toEqual([{ step: "Transcribe", text: "2 speakers could not be named" }]);
    expect(run.results).toEqual([
      {
        step: "Transcribe",
        sink: "anytype",
        text: "Meeting notes → Renaissance",
        anytype: { spaceId: "s1", objectId: "o1" },
        folder: null,
        due: null,
      },
      {
        step: "Transcribe",
        sink: "file",
        text: "Moved recording",
        anytype: null,
        folder: "/archive",
        due: null,
      },
    ]);
    expect(run.state).toBe("running");
  });

  it("is a plain stepDone for a 2.0 done, with no notes or results", () => {
    const event = stepDoneEvent(KEY, "n1", at(2));
    expect(event).toEqual({ ...KEY, at: at(2), kind: "stepDone", instanceId: "n1" });
    const run = fold([started, stepStarted("n1", "Transcribe", 1), event]);
    expect(run.notes).toEqual([]);
    expect(run.results).toEqual([]);
    expect(run.steps[0]?.state).toBe("done");
  });

  it("keeps only the key's two fields, whatever was passed as the key", () => {
    const run = fold([started]);
    const event = stepDoneEvent(run, "n1", at(2));
    expect(Object.keys(event).sort()).toEqual(["at", "flowId", "instanceId", "kind", "runId"]);
  });
});

describe("stepStatusEvent", () => {
  it("puts text, progress and time left on that step only", () => {
    const run = fold([
      started,
      stepStarted("n1", "Transcribe", 1),
      stepStarted("n2", "File", 2),
      stepStatusEvent(KEY, "n2", at(3), {
        text: "in Renaissance",
        progress: { done: 2, total: 3 },
        etaSeconds: 120,
      }),
    ]);
    expect(run.steps[0]).toMatchObject({ statusText: null, progress: null, etaSeconds: null });
    expect(run.steps[1]).toMatchObject({
      statusText: "in Renaissance",
      progress: { done: 2, total: 3 },
      etaSeconds: 120,
    });
  });

  it("leaves out progress and time left the node did not send", () => {
    expect(stepStatusEvent(KEY, "n1", at(1), { text: "working" })).toEqual({
      ...KEY,
      at: at(1),
      kind: "status",
      instanceId: "n1",
      text: "working",
    });
  });

  it("makes a copy phase the run's: copying with the node's words, then copied", () => {
    const copying = stepStatusEvent(KEY, "src", at(1), { text: "from BOYA", phase: "copying" });
    const copied = stepStatusEvent(KEY, "src", at(2), { text: "copied", phase: "copied" });
    expect(copying).toEqual({ ...KEY, at: at(1), kind: "copying", text: "from BOYA" });
    expect(copied).toEqual({ ...KEY, at: at(2), kind: "copied" });
    const run = fold([started, copying, copied]);
    expect(run).toMatchObject({ state: "running", copied: true, copyText: "from BOYA" });
  });
});
