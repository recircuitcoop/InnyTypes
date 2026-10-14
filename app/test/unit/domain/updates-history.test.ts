import { describe, expect, it } from "vitest";
import {
  atStart,
  EMPTY_HISTORY,
  parseUpdateHistory,
  previousRelease,
  releaseTag,
  serialiseUpdateHistory,
  type UpdateHistory,
} from "../../../src/domain/updates/history";
import { ROLLBACK_WINDOW_MS } from "../../../src/domain/updates/machine";

const NOW = new Date(2026, 9, 14, 10, 0);
const OLD = "1.0.0";
const NEW = "1.1.0";

describe("the install record", () => {
  it("the first start ever records this version and offers nothing", () => {
    const start = atStart(EMPTY_HISTORY, NEW, NOW);
    expect(start.installed).toBeNull();
    expect(start.history).toEqual({ ...EMPTY_HISTORY, lastVersion: NEW });
    expect(previousRelease(start.history)).toBeNull();
  });

  it("a start on the same version changes nothing but keeps the offer", () => {
    const history: UpdateHistory = {
      lastVersion: NEW,
      lastCheckedAt: NOW,
      previous: { version: OLD, tag: releaseTag(OLD), updatedAt: NOW },
      goingBackTo: null,
    };
    const start = atStart(history, NEW, new Date(NOW.getTime() + 1000));
    expect(start.installed).toBeNull();
    expect(start.history).toEqual(history);
  });

  it("the first start on a new version records the previous release with its tag and time", () => {
    const start = atStart({ ...EMPTY_HISTORY, lastVersion: OLD }, NEW, NOW);
    expect(start.installed).toEqual({
      kind: "installed",
      version: NEW,
      previous: OLD,
      at: NOW,
      wentBack: false,
    });
    expect(start.history.previous).toEqual({ version: OLD, tag: `v${OLD}`, updatedAt: NOW });
    expect(start.history.lastVersion).toBe(NEW);
    expect(previousRelease(start.history)).toEqual({
      version: OLD,
      firstStartedAt: NOW,
      rollbackUntil: new Date(NOW.getTime() + ROLLBACK_WINDOW_MS),
    });
  });

  it("the start a Go back went to offers nothing, and forgets the Go back", () => {
    const start = atStart(
      {
        lastVersion: NEW,
        lastCheckedAt: null,
        previous: { version: OLD, tag: releaseTag(OLD), updatedAt: NOW },
        goingBackTo: OLD,
      },
      OLD,
      NOW,
    );
    expect(start.installed).toMatchObject({ version: OLD, previous: NEW, wentBack: true });
    expect(start.history.previous).toBeNull();
    expect(start.history.goingBackTo).toBeNull();
  });

  it("round-trips through JSON, and reads anything unreadable as unset", () => {
    const history: UpdateHistory = {
      lastVersion: NEW,
      lastCheckedAt: NOW,
      previous: { version: OLD, tag: releaseTag(OLD), updatedAt: NOW },
      goingBackTo: OLD,
    };
    const stored: unknown = JSON.parse(JSON.stringify(serialiseUpdateHistory(history)));
    expect(parseUpdateHistory(stored)).toEqual(history);
    expect(serialiseUpdateHistory(EMPTY_HISTORY)).toMatchObject({ previous: null });
    expect(parseUpdateHistory(undefined)).toEqual(EMPTY_HISTORY);
    expect(parseUpdateHistory([1])).toEqual(EMPTY_HISTORY);
    expect(
      parseUpdateHistory({
        lastVersion: 3,
        lastCheckedAt: "not a date",
        previous: { version: OLD, tag: "", updatedAt: NOW.toISOString() },
        goingBackTo: "",
      }),
    ).toEqual(EMPTY_HISTORY);
    expect(parseUpdateHistory({ lastCheckedAt: 5, previous: "x" })).toEqual(EMPTY_HISTORY);
  });
});
