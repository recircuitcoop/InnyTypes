// The app window's hash routes (plan 0022 §M; ui/routes.ts): every route of the table resolves and
// writes back the same address, the window opens on Setup until it is completed and on Live after
// that, and the Setup sidebar marks the step shown.
import { describe, expect, it } from "vitest";
import type { SetupState } from "../../src/domain/setup/setup";
import {
  LIVE,
  parseRoute,
  routeHash,
  settleRoute,
  SETUP_NAV,
  setupNavIndex,
  surfaceOf,
  type Route,
} from "../../src/ui/routes";

const SECTION_M: readonly (readonly [string, Route])[] = [
  ["#/setup/connect-anytype", { screen: "setup", step: "connect-anytype" }],
  ["#/live", { screen: "live", flowId: null, tabId: null }],
  ["#/live/flow-1", { screen: "live", flowId: "flow-1", tabId: null }],
  ["#/live/flow-1?tab=tab-2", { screen: "live", flowId: "flow-1", tabId: "tab-2" }],
  ["#/configuration/flows", { screen: "flows" }],
  ["#/configuration/flows/flow-1/canvas", { screen: "canvas", flowId: "flow-1" }],
  ["#/configuration/flows/flow-1/history", { screen: "history", flowId: "flow-1" }],
  ["#/configuration/general", { screen: "general" }],
  ["#/gallery", { screen: "gallery" }],
];

const setupAt = (step: SetupState["step"], completed = false): SetupState => ({
  step,
  formIndex: 0,
  formCount: 0,
  starterFlowId: null,
  completed,
});

describe("the section M routes", () => {
  it.each(SECTION_M)("%s resolves, and writes back as the same address", (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
    expect(routeHash(route)).toBe(hash);
  });

  it("an id is encoded in the address and decoded from it", () => {
    const route: Route = { screen: "live", flowId: "a/b c", tabId: "t&1" };
    expect(routeHash(route)).toBe("#/live/a%2Fb%20c?tab=t%261");
    expect(parseRoute(routeHash(route))).toEqual(route);
    expect(parseRoute("#/configuration/flows/a%2Fb/canvas")).toEqual({
      screen: "canvas",
      flowId: "a/b",
    });
  });

  it("the gallery keeps whatever follows it, for the gallery to read", () => {
    expect(parseRoute("#/gallery?theme=dark")).toEqual({ screen: "gallery" });
    expect(parseRoute("#/gallery/modal-dialog")).toEqual({ screen: "gallery" });
  });

  it.each([
    "",
    "#",
    "#/",
    "live",
    "#/editor",
    "#/setup",
    "#/setup/",
    "#/setup/a/b",
    "#/live/",
    "#/live/a/b",
    "#/live/%E0%A4%A",
    "#/configuration",
    "#/configuration/general/x",
    "#/configuration/flows/",
    "#/configuration/flows/id",
    "#/configuration/flows/id/other",
    "#/configuration/flows//canvas",
  ])("%j names no screen", (hash) => {
    expect(parseRoute(hash)).toBeNull();
  });

  it("an empty tab is no tab", () => {
    expect(parseRoute("#/live/f?tab=")).toEqual({ screen: "live", flowId: "f", tabId: null });
  });

  it("Live is the live surface; Flows, the canvas, Run history and General are Configuration", () => {
    expect(surfaceOf("live")).toBe("live");
    for (const screen of ["flows", "canvas", "history", "general"] as const) {
      expect(surfaceOf(screen)).toBe("configuration");
    }
    expect(surfaceOf("setup")).toBeNull();
    expect(surfaceOf("gallery")).toBeNull();
  });
});

describe("the window opens on Setup until completed, then Live", () => {
  it("a first launch (no address) opens Setup at its stored step", () => {
    expect(settleRoute(null, setupAt("welcome"))).toEqual({ screen: "setup", step: "welcome" });
    expect(settleRoute(null, setupAt("source-folder"))).toEqual({
      screen: "setup",
      step: "source-folder",
    });
  });

  it("while Setup is not completed, every other address lands on its step, and the address's own step is not trusted", () => {
    for (const [hash] of SECTION_M.filter(([, route]) => route.screen !== "gallery")) {
      expect(settleRoute(parseRoute(hash), setupAt("reports"))).toEqual({
        screen: "setup",
        step: "reports",
      });
    }
  });

  it("once completed: no address, or a Setup address, opens Live; every other screen is shown as asked", () => {
    const done = setupAt("ready", true);
    expect(settleRoute(null, done)).toEqual(LIVE);
    expect(settleRoute(parseRoute("#/setup/ready"), done)).toEqual(LIVE);
    for (const [hash, route] of SECTION_M.filter(([, r]) => r.screen !== "setup")) {
      expect(settleRoute(parseRoute(hash), done), hash).toEqual(route);
    }
  });

  it("the gallery, a development page, ignores Setup", () => {
    expect(settleRoute({ screen: "gallery" }, setupAt("welcome"))).toEqual({ screen: "gallery" });
  });
});

describe("the Setup sidebar", () => {
  it("lists Welcome, Reports, Anytype, Source folder, Steps and Ready, and marks the step shown", () => {
    expect(SETUP_NAV).toEqual(["welcome", "reports", "anytype", "folder", "steps", "ready"]);
    expect(
      (
        ["welcome", "reports", "connect-anytype", "source-folder", "node-forms", "ready"] as const
      ).map(setupNavIndex),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
