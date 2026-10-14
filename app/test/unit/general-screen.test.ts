// ui/general.ts (plan 0022 §M, ux-writing "Configuration › General"): each section's one-line
// state, the address AI apps are told, the setup a client is given, a refused move in words, and
// retention's five choices (D8). No DOM: the screen only draws these.
import { describe, expect, it } from "vitest";
import type { AnytypeStatus, McpEndpointStatus } from "../../src/ui/contract";
import {
  aiAppsLine,
  anytypeLine,
  clientSetup,
  moveRefusal,
  reportsLine,
  RETENTION_OPTIONS,
  retentionDays,
  retentionLine,
  retentionValue,
  servedAddress,
  servedPort,
} from "../../src/ui/general";
import { STRINGS } from "../../src/ui/strings";

const anytype = (state: AnytypeStatus["state"]): AnytypeStatus => ({
  state,
  detail: "added=[API-x] differ from the committed surface",
  childPid: 4242,
  beats: 3,
  pairing: false,
});

const spaces = (n: number) => ({
  ok: true as const,
  value: { options: Array.from({ length: n }, (_, i) => ({ value: `s${String(i)}`, label: "S" })) },
});

const endpoint = (served: string | null): McpEndpointStatus => ({
  served,
  saved: served,
  stored: false,
  ignoredVariables: [],
  problem: null,
  warning: "clients must be updated",
});

describe("the Anytype section's state line", () => {
  it("says Connected · n spaces once paired and Not paired yet. before, with Pair or Pair again", () => {
    expect(anytypeLine(anytype("ready"), spaces(8))).toEqual({
      line: "Connected · 8 spaces",
      paired: true,
    });
    expect(anytypeLine(anytype("ready"), spaces(1)).line).toBe("Connected · 1 space");
    expect(anytypeLine(anytype("no-key"), null)).toEqual({
      line: STRINGS["general.anytype.notPaired"],
      paired: false,
    });
  });

  it("names an unreachable Anytype, a refused key and a start, never the detail or a path", () => {
    expect(anytypeLine(anytype("unreachable"), null).line).toBe(
      STRINGS["error.anytypeUnreachable"],
    );
    expect(anytypeLine(anytype("starting"), null).line).toBe(STRINGS["general.anytype.starting"]);
    expect(anytypeLine(anytype("ready"), null).line).toBe(STRINGS["general.anytype.starting"]);
    const refused = (reason: "not-paired" | "unreachable" | "failed") => ({
      ok: false as const,
      refused: { reason, sentence: "refused.failed" as const },
    });
    expect(anytypeLine(anytype("ready"), refused("not-paired")).line).toBe(
      STRINGS["error.keyRefused"],
    );
    expect(anytypeLine(anytype("ready"), refused("unreachable")).line).toBe(
      STRINGS["error.anytypeUnreachable"],
    );
    expect(anytypeLine(anytype("ready"), refused("failed")).line).toBe(
      STRINGS["general.anytype.connected"],
    );
    for (const state of ["tool-surface-mismatch", "down", "down-for-good", "stopped"] as const) {
      const line = anytypeLine(anytype(state), null);
      expect(line.line).toBe(STRINGS["general.anytype.unavailable"]);
      expect(line.line).not.toContain("added=");
    }
  });
});

describe("the AI apps section", () => {
  it("tells the address served as host:port, and pre-fills Change port with its port", () => {
    const status = endpoint("http://127.0.0.1:31010/mcp");
    expect(servedAddress(status)).toBe("127.0.0.1:31010");
    expect(servedPort(status)).toBe(31010);
    expect(aiAppsLine(status)).toBe(
      "Claude, Codex and other apps can use your Anytype through InnyTypes at `127.0.0.1:31010`.",
    );
  });

  it("says nothing is served when nothing is, with no port to pre-fill", () => {
    expect(servedAddress(endpoint(null))).toBeNull();
    expect(servedPort(endpoint(null))).toBeNull();
    expect(aiAppsLine(endpoint(null))).toBe(STRINGS["general.aiApps.notServed"]);
  });

  it("words a taken port with ux-writing's line and anything else with the generic one", () => {
    expect(moveRefusal("Error: could not bind 127.0.0.1:40001: EADDRINUSE", 40001)).toBe(
      "Port 40001 is used by another app. Choose another port.",
    );
    expect(moveRefusal("Error: the MCP endpoint setting could not be saved", 40001)).toBe(
      STRINGS["refused.failed"],
    );
  });
});

describe("Copy setup", () => {
  it("copies strings.ts's command with the URL served filled in, and no token", () => {
    const url = "http://127.0.0.1:31010/mcp";
    expect(clientSetup(url)).toBe(STRINGS["general.aiApps.setup"].replace("{url}", url));
    expect(clientSetup(url)).toContain(`--url ${url} `);
    expect(clientSetup(url)).not.toContain("{");
  });
});

describe("the Reports section's state line", () => {
  it("says sending only when on; unanswered is not sending", () => {
    expect(reportsLine("on")).toBe("Sending anonymous usage counts.");
    expect(reportsLine("off")).toBe("Not sending.");
    expect(reportsLine("unset")).toBe("Not sending.");
  });
});

describe("retention (D8)", () => {
  it("offers 7, 30, 90, 365 days and Forever, in that order, and reads each back", () => {
    expect(RETENTION_OPTIONS.map((option) => option.label)).toEqual([
      "7 days",
      "30 days",
      "90 days",
      "365 days",
      "Forever",
    ]);
    for (const days of [7, 30, 90, 365, null]) {
      expect(retentionDays(retentionValue(days))).toBe(days);
    }
    expect(retentionDays("14")).toBeUndefined();
  });

  it("states how long runs are kept", () => {
    expect(retentionLine(90)).toBe("Runs are kept for 90 days.");
    expect(retentionLine(null)).toBe("Runs are kept until you delete them.");
  });
});
