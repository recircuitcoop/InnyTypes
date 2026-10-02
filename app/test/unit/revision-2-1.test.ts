// Revision 2.1's frame fields (spec 4.2.1, 4.2.2): bounded, never a refusal of the frame, and
// a 2.0 frame left exactly as it was.
import { describe, expect, it } from "vitest";

import { decodeFrame, outcomeOf, stepStatusOf } from "../../src/adapters/process/codec";
import {
  boundDone,
  boundStatus,
  MAX_REPORT_ENTRIES,
  MAX_REPORT_TEXT,
} from "../../src/adapters/process/revision-2-1";

const bytes = (frame: object): Buffer => Buffer.from(JSON.stringify(frame), "utf8");

describe("a done's notes and results", () => {
  it("leaves a 2.0 done the very same object", () => {
    const frame = { t: "done", in: "a" };
    expect(boundDone(frame)).toEqual({ frame, dropped: [] });
    expect(boundDone(frame).frame).toBe(frame);
  });

  it("keeps the first 20 of each and cuts a text to 200 characters, saying so", () => {
    const notes = Array.from({ length: MAX_REPORT_ENTRIES + 5 }, (_, n) => ({
      level: n % 2 === 0 ? "note" : "warning",
      text: n === 0 ? "x".repeat(MAX_REPORT_TEXT + 50) : `note ${String(n)}`,
    }));
    const results = Array.from({ length: MAX_REPORT_ENTRIES + 1 }, (_, n) => ({
      kind: "plain",
      text: `result ${String(n)}`,
    }));
    const { frame, dropped } = boundDone({ t: "done", in: "a", notes, results });
    const kept = frame["notes"] as { text: string }[];
    expect(kept).toHaveLength(MAX_REPORT_ENTRIES);
    expect(kept[0]?.text).toBe("x".repeat(MAX_REPORT_TEXT));
    expect(frame["results"]).toHaveLength(MAX_REPORT_ENTRIES);
    expect(dropped).toEqual([
      `notes[0] text cut from ${String(MAX_REPORT_TEXT + 50)} to ${String(MAX_REPORT_TEXT)}`,
      "notes: 5 over the limit of 20 dropped",
      "results: 1 over the limit of 20 dropped",
    ]);
  });

  it("drops malformed entries and fields, keeping the rest", () => {
    const { frame, dropped } = boundDone({
      t: "done",
      in: "a",
      notes: [
        { level: "fatal", text: "?" },
        { level: "note" },
        "text",
        { level: "note", text: "ok" },
      ],
      results: [
        { kind: "email", text: "?" },
        { kind: "plain" },
        { kind: "anytype", text: "obj", anytype: { spaceId: "s" }, folder: 3, due: "", extra: 1 },
        { kind: "scheduled", text: "later", due: "2026-10-03" },
      ],
    });
    expect(frame["notes"]).toEqual([{ level: "note", text: "ok" }]);
    expect(frame["results"]).toEqual([
      { kind: "anytype", text: "obj" },
      { kind: "scheduled", text: "later", due: "2026-10-03" },
    ]);
    expect(dropped).toEqual([
      'notes[0] dropped: no level "note" or "warning"',
      "notes[1] dropped: no text",
      'notes[2] dropped: no level "note" or "warning"',
      'results[0] dropped: no kind "anytype", "file", "scheduled" or "plain"',
      "results[1] dropped: no text",
      "results[2].anytype dropped: it needs a spaceId and an objectId",
      "results[2].folder dropped: not a text",
      "results[2].due dropped: not a text",
    ]);
  });

  it("drops a list that is not one, and still completes the input", () => {
    const decoded = decodeFrame(bytes({ t: "done", in: "a", notes: "hello", results: {} }));
    expect(decoded).toEqual({
      kind: "frame",
      frame: { t: "done", in: "a" },
      dropped: ["notes dropped: not a list", "results dropped: not a list"],
    });
  });

  it("decodes a bounded done whose report reaches the outcome", () => {
    const decoded = decodeFrame(
      bytes({
        t: "done",
        in: "a",
        notes: [{ level: "warning", text: "w" }],
        results: [{ kind: "file", text: "moved", folder: "/tmp/x" }],
      }),
    );
    expect(decoded.kind).toBe("frame");
    if (decoded.kind !== "frame" || decoded.frame.t !== "done") {
      return;
    }
    expect(decoded.dropped).toBeUndefined();
    expect(outcomeOf(decoded.frame)).toEqual({
      notes: [{ level: "warning", text: "w" }],
      results: [{ kind: "file", text: "moved", folder: "/tmp/x" }],
    });
    expect(outcomeOf({ t: "done", in: "a" })).toBeUndefined();
    expect(outcomeOf({ t: "done", in: "a", results: [] })).toEqual({ notes: [], results: [] });
  });
});

describe("a status's in, progress, time left and phase", () => {
  it("leaves a 2.0 status the very same object", () => {
    const frame = { t: "status", text: "busy" };
    expect(boundStatus(frame).frame).toBe(frame);
  });

  it("keeps well-formed fields and maps them to a step status", () => {
    const decoded = decodeFrame(
      bytes({
        t: "status",
        text: "in Renaissance",
        in: "a",
        progress: { done: 2, total: 3, extra: true },
        eta_s: 90.5,
        phase: "copying",
      }),
    );
    expect(decoded).toEqual({
      kind: "frame",
      frame: {
        t: "status",
        text: "in Renaissance",
        in: "a",
        progress: { done: 2, total: 3 },
        eta_s: 90.5,
        phase: "copying",
      },
    });
    if (decoded.kind !== "frame" || decoded.frame.t !== "status") {
      return;
    }
    expect(stepStatusOf(decoded.frame)).toEqual({
      text: "in Renaissance",
      progress: { done: 2, total: 3 },
      etaSeconds: 90.5,
      phase: "copying",
    });
    expect(stepStatusOf({ t: "status", text: "x", in: "a" })).toEqual({ text: "x" });
  });

  it("drops what is malformed, says so, and drops an unknown phase quietly", () => {
    const cases: [object, string[]][] = [
      [{ in: 5 }, ["in dropped: not an input id"]],
      [{ in: "x".repeat(129) }, ["in dropped: not an input id"]],
      [
        { progress: { done: 4, total: 3 } },
        ["progress dropped: it needs whole numbers done <= total"],
      ],
      [
        { progress: { done: 1.5, total: 3 } },
        ["progress dropped: it needs whole numbers done <= total"],
      ],
      [{ progress: [1, 2] }, ["progress dropped: it needs whole numbers done <= total"]],
      [{ eta_s: -1 }, ["eta_s dropped: not a number of seconds"]],
      [{ eta_s: "soon" }, ["eta_s dropped: not a number of seconds"]],
      [
        { progress: { done: 1, total: Number.MAX_VALUE * 10 } },
        ["progress dropped: it needs whole numbers done <= total"],
      ],
      [{ phase: "uploading" }, []],
    ];
    for (const [fields, dropped] of cases) {
      const decoded = decodeFrame(bytes({ t: "status", text: "t", ...fields }));
      expect(decoded).toEqual({
        kind: "frame",
        frame: { t: "status", text: "t" },
        ...(dropped.length === 0 ? {} : { dropped }),
      });
    }
  });

  it("drops an eta_s of 1e999, valid JSON that parses to Infinity, and keeps the status", () => {
    const line = Buffer.from('{"t":"status","text":"t","in":"a","eta_s":1e999}', "utf8");
    expect(decodeFrame(line)).toEqual({
      kind: "frame",
      frame: { t: "status", text: "t", in: "a" },
      dropped: ["eta_s dropped: not a number of seconds"],
    });
    const progress = Buffer.from('{"t":"status","text":"t","progress":{"done":1,"total":1e999}}');
    expect(decodeFrame(progress)).toMatchObject({
      kind: "frame",
      frame: { t: "status", text: "t" },
    });
  });
});
