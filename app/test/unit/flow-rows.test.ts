// Configuration › Flows' rows (ui/screens/flow-rows.ts): what `flow.list` answers, worded as the
// Flows list draws each row (switch, Last run, health and its pill); the Delete flow dialog's
// title and body (ui/words.ts); and the canvas frame's editor address (ui/editor-url.ts).
import { describe, expect, it } from "vitest";

import type { ChildStatus } from "../../src/ui/contract";
import { editorUrl, flowEditorUrl } from "../../src/ui/editor-url";
import type { FlowSummary } from "../../src/ui/flow-contract";
import { BLANK_TEMPLATE, flowRow, HEALTH_LOOK } from "../../src/ui/screens/flow-rows";
import { STRINGS } from "../../src/ui/strings";
import { wordDeleteFlow } from "../../src/ui/words";

// Thursday 2026-10-08, 15:00 local.
const NOW = new Date(2026, 9, 8, 15, 0);

const summary = (more: Partial<FlowSummary>): FlowSummary => ({
  id: "tab1",
  name: "Recordings to Anytype",
  on: true,
  health: { kind: "ready" },
  lastRun: null,
  viewNodes: [],
  steps: [],
  ...more,
});

const lastRun = (startedAt: Date, state: "done" | "failed" | "running") => ({
  runId: "r1",
  title: "a recording",
  startedAt,
  endedAt: null,
  state,
});

describe("a flow's row", () => {
  it("carries the switch, Last run and the health with its pill", () => {
    expect(
      flowRow(summary({ lastRun: lastRun(new Date(2026, 9, 8, 14, 20), "done") }), NOW),
    ).toEqual({
      id: "tab1",
      name: "Recordings to Anytype",
      on: true,
      lastRun: "Last run: today, 14:20 · done",
      health: "Ready",
      healthState: "done",
    });
    expect(
      flowRow(
        summary({
          on: false,
          health: { kind: "steps-not-set-up", count: 1 },
          lastRun: lastRun(new Date(2026, 9, 7, 18, 5), "done"),
        }),
        NOW,
      ),
    ).toMatchObject({
      on: false,
      lastRun: "Last run: yesterday, 18:05 · done",
      health: "1 step not set up",
      healthState: "waiting",
    });
    // Failing since the Monday the streak began.
    expect(
      flowRow(
        summary({
          health: { kind: "failing-since", since: new Date(2026, 9, 5, 9, 12) },
          lastRun: lastRun(new Date(2026, 9, 5, 9, 12), "failed"),
        }),
        NOW,
      ),
    ).toMatchObject({
      lastRun: "Last run: Monday, 09:12 · failed",
      health: "Failing since Monday",
      healthState: "failed",
    });
    expect(flowRow(summary({ health: { kind: "no-source" } }), NOW)).toMatchObject({
      health: STRINGS["flows.health.noSource"],
      healthState: "waiting",
    });
  });

  it("has no Last run line for a flow that never ran", () => {
    expect(flowRow(summary({}), NOW).lastRun).toBe("");
  });

  it("gives every health its pill, and Blank canvas its own template", () => {
    expect(Object.keys(HEALTH_LOOK).sort()).toEqual(
      ["failing-since", "no-source", "ready", "steps-not-set-up"].sort(),
    );
    expect(BLANK_TEMPLATE).toBe("blank");
  });
});

describe("the Delete flow dialog", () => {
  it("asks about the flow by name, and says what goes with it", () => {
    expect(wordDeleteFlow("Recordings to Anytype")).toEqual({
      title: "Delete Recordings to Anytype?",
      body: "Its run history is deleted too. Runs in progress are stopped.",
    });
    // A name with a question or a replacement pattern in it stays as written.
    expect(wordDeleteFlow("Why? $& more").title).toBe("Delete Why? $& more?");
  });
});

describe("the canvas frame's editor address", () => {
  const runtime = (port: number | null): ChildStatus => ({
    child: "runtime",
    state: "running",
    generation: 1,
    pid: 1,
    port,
    error: null,
  });

  it("is Node-RED on the runtime's port, opened on the flow's tab", () => {
    expect(editorUrl(runtime(18_800))).toBe("http://127.0.0.1:18800/red/");
    expect(flowEditorUrl(runtime(18_800), "tab 1")).toBe(
      "http://127.0.0.1:18800/red/#flow/tab%201",
    );
  });

  it("is none while the runtime has no port", () => {
    expect(flowEditorUrl(runtime(null), "tab1")).toBeNull();
    expect(flowEditorUrl(undefined, "tab1")).toBeNull();
  });
});
