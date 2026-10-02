// The status pill, the runtime banner and the Live badge (plan 0022 §I, ux-writing "Navigation
// and page titles": Running, Restarting…, Stopped, Needs attention).
import { describe, expect, it } from "vitest";
import type { AnytypeState, AnytypeStatus } from "../../../src/domain/anytype/status";
import { fold, type Run, type RunEvent } from "../../../src/domain/runs/run";
import {
  liveBadgeCount,
  runtimeBanner,
  statusPill,
  STATUS_PILLS,
  type StatusInputs,
} from "../../../src/domain/status/status";
import type { ChildState, ChildStatus } from "../../../src/domain/supervision/child-state";

function child(name: ChildStatus["child"], state: ChildState): ChildStatus {
  return { child: name, state, generation: 1, pid: null, port: null, error: null };
}

function anytype(state: AnytypeState): AnytypeStatus {
  return { state, detail: null, childPid: null, beats: 0, pairing: false };
}

function inputs(
  runtime: ChildState | null,
  services: ChildState | null,
  anytypeState: AnytypeState | null = "ready",
): StatusInputs {
  const children: ChildStatus[] = [];
  if (runtime !== null) children.push(child("runtime", runtime));
  if (services !== null) children.push(child("services", services));
  return { children, anytype: anytypeState === null ? null : anytype(anytypeState) };
}

describe("the status pill", () => {
  it("is one of four values", () => {
    expect(STATUS_PILLS).toEqual(["running", "restarting", "stopped", "needsAttention"]);
  });

  it("is running when both children run and Anytype is ready or not reported", () => {
    expect(statusPill(inputs("running", "running"))).toBe("running");
    expect(statusPill(inputs("running", "running", null))).toBe("running");
    expect(statusPill(inputs("running", "running", "starting"))).toBe("running");
    expect(statusPill(inputs("running", null))).toBe("running");
  });

  it("is stopped with no runtime, or a runtime down for good or stopped", () => {
    expect(statusPill(inputs(null, "running"))).toBe("stopped");
    expect(statusPill(inputs("down-for-good", "restarting"))).toBe("stopped");
    expect(statusPill(inputs("stopped", "stopped"))).toBe("stopped");
  });

  it("is restarting while any child is on its way back", () => {
    for (const state of [
      "starting",
      "restarting-planned",
      "restarting",
      "recovering",
      "down",
    ] as const) {
      expect(statusPill(inputs(state, "running")), state).toBe("restarting");
      expect(statusPill(inputs("running", state, "no-key")), state).toBe("restarting");
    }
  });

  it("needs attention when Anytype or the services process needs the person", () => {
    for (const state of [
      "no-key",
      "unreachable",
      "tool-surface-mismatch",
      "down",
      "down-for-good",
    ] as const) {
      expect(statusPill(inputs("running", "running", state)), state).toBe("needsAttention");
    }
    expect(statusPill(inputs("running", "down-for-good", null))).toBe("needsAttention");
    expect(statusPill(inputs("running", "running", "stopped"))).toBe("running");
  });
});

describe("the runtime banner", () => {
  it("shows Restarting after a crash, Down for good, and nothing otherwise", () => {
    const banner = (state: ChildState) =>
      runtimeBanner([child("services", "down-for-good"), child("runtime", state)]);
    expect(banner("recovering")).toBe("restarting");
    expect(banner("down")).toBe("restarting");
    expect(banner("down-for-good")).toBe("down");
    expect(banner("running")).toBeNull();
    // A planned restart is not news.
    expect(banner("restarting-planned")).toBeNull();
    expect(runtimeBanner([])).toBeNull();
  });
});

describe("the Live badge", () => {
  const event = (runId: string, list: Record<string, unknown>[]): Run =>
    fold(
      [{ kind: "started", title: runId }, ...list].map(
        (item, index) =>
          ({
            flowId: "f",
            runId,
            at: new Date(2026, 9, 2, 9, index),
            ...item,
          }) as unknown as RunEvent,
      ),
    );
  const ask = (id: string) => [
    { kind: "stepStarted", instanceId: id, name: "Ask" },
    { kind: "presented", instanceId: id, question: "who spoke?" },
  ];

  it("counts every waiting question, two in one run included, and nothing else", () => {
    const runs = [
      event("1", ask("q1")),
      event("2", [...ask("q1"), ...ask("q2")]),
      event("3", [{ kind: "finished" }]),
      event("4", []),
    ];
    expect(liveBadgeCount(runs)).toBe(3);
  });

  it("never counts a cleared run", () => {
    const waiting = event("1", ask("q1"));
    expect(liveBadgeCount([{ ...waiting, cleared: true }])).toBe(0);
  });
});
