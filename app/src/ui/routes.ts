// The app window's hash routes (plan 0022 §M): which screen the frame shows, read from and written
// to `location.hash`, so a reload keeps the screen and a notification can open one by address.
//
// | Route                                  | Screen                                           |
// |----------------------------------------|--------------------------------------------------|
// | #/setup/<step>                         | Setup walkthrough, no navigation                 |
// | #/live/<flowId>?tab=<tabId>            | Live: the flow's board (#/live alone: the empty) |
// | #/configuration/flows                  | the Flows list                                   |
// | #/configuration/flows/<id>/canvas      | the canvas frame                                 |
// | #/configuration/flows/<id>/history     | Run history                                      |
// | #/configuration/general                | General                                          |
// | #/gallery                              | the component gallery, development builds only   |
//
// The window opens on Setup until Setup is completed, then on Live (`settleRoute`). While Setup
// is not completed it is the only screen: it has no navigation, and an address of any other
// screen lands on Setup's current step. The step in a Setup address is never trusted either:
// the stored state says where Setup is.
import type { SetupStep } from "../domain/setup/setup";
import type { SetupState } from "./general-contract";

export type Route =
  | { readonly screen: "setup"; readonly step: string }
  | { readonly screen: "live"; readonly flowId: string | null; readonly tabId: string | null }
  | { readonly screen: "flows" }
  | { readonly screen: "canvas"; readonly flowId: string }
  | { readonly screen: "history"; readonly flowId: string }
  | { readonly screen: "general" }
  | { readonly screen: "gallery" };

export type Screen = Route["screen"];

/** The surface a screen belongs to, for the Sidebar's active Nav item; Setup and the gallery have none. */
export function surfaceOf(screen: Screen): "live" | "configuration" | null {
  switch (screen) {
    case "live":
      return "live";
    case "flows":
    case "canvas":
    case "history":
    case "general":
      return "configuration";
    default:
      return null;
  }
}

/** One path segment, decoded; null when it is empty or not decodable. */
function segment(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The screen a hash names, or null when it names none (an old address, a typo, nothing). */
export function parseRoute(hash: string): Route | null {
  const address = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryAt = address.indexOf("?");
  const pathPart = queryAt === -1 ? address : address.slice(0, queryAt);
  const query = new URLSearchParams(queryAt === -1 ? "" : address.slice(queryAt + 1));
  if (!pathPart.startsWith("/")) {
    return null;
  }
  const parts = pathPart.slice(1).split("/");
  const [first, second, third, fourth] = parts;
  switch (first) {
    case "setup": {
      const step = segment(second);
      return parts.length === 2 && step !== null ? { screen: "setup", step } : null;
    }
    case "live": {
      if (parts.length === 1) {
        return { screen: "live", flowId: null, tabId: null };
      }
      const flowId = segment(second);
      if (parts.length !== 2 || flowId === null) {
        return null;
      }
      const tab = query.get("tab");
      return { screen: "live", flowId, tabId: tab === null || tab === "" ? null : tab };
    }
    case "configuration":
      return configurationRoute(second, third, fourth, parts.length);
    case "gallery":
      return parts.length === 1 ? { screen: "gallery" } : null;
    default:
      return null;
  }
}

function configurationRoute(
  area: string | undefined,
  id: string | undefined,
  view: string | undefined,
  length: number,
): Route | null {
  if (area === "general" && length === 2) {
    return { screen: "general" };
  }
  if (area !== "flows") {
    return null;
  }
  if (length === 2) {
    return { screen: "flows" };
  }
  const flowId = segment(id);
  if (length !== 4 || flowId === null) {
    return null;
  }
  if (view === "canvas") {
    return { screen: "canvas", flowId };
  }
  if (view === "history") {
    return { screen: "history", flowId };
  }
  return null;
}

/** The hash of a route, so `parseRoute(routeHash(route))` gives the route back. */
export function routeHash(route: Route): string {
  const id = (value: string) => encodeURIComponent(value);
  switch (route.screen) {
    case "setup":
      return `#/setup/${id(route.step)}`;
    case "live": {
      if (route.flowId === null) {
        return "#/live";
      }
      const tab = route.tabId === null ? "" : `?tab=${id(route.tabId)}`;
      return `#/live/${id(route.flowId)}${tab}`;
    }
    case "flows":
      return "#/configuration/flows";
    case "canvas":
      return `#/configuration/flows/${id(route.flowId)}/canvas`;
    case "history":
      return `#/configuration/flows/${id(route.flowId)}/history`;
    case "general":
      return "#/configuration/general";
    case "gallery":
      return "#/gallery";
  }
}

/** Live's empty state: where the window opens once Setup is completed. */
export const LIVE: Route = { screen: "live", flowId: null, tabId: null };

/**
 * The screen to show for an address, given where Setup is. Setup until it is completed, at its
 * stored step; after that, never Setup again: a Setup address, or one that names no screen, opens
 * Live. The gallery is a development page and ignores Setup (a production build refuses it in
 * the screen, not here).
 */
export function settleRoute(route: Route | null, setup: SetupState): Route {
  if (route?.screen === "gallery") {
    return route;
  }
  if (!setup.completed) {
    return { screen: "setup", step: setup.step };
  }
  if (route === null || route.screen === "setup") {
    return LIVE;
  }
  return route;
}

/** The Setup sidebar's six entries, in order (design-system "Sidebar", owner 2026-10-02). */
export const SETUP_NAV = ["welcome", "reports", "anytype", "folder", "steps", "ready"] as const;
export type SetupNavEntry = (typeof SETUP_NAV)[number];

/** Which Setup sidebar entry a step is; the starter's step forms share "Steps". */
const SETUP_NAV_OF: Readonly<Record<SetupStep, SetupNavEntry>> = {
  welcome: "welcome",
  reports: "reports",
  "connect-anytype": "anytype",
  "source-folder": "folder",
  "node-forms": "steps",
  ready: "ready",
};

/** The Setup sidebar's current entry for a step, from 0. */
export function setupNavIndex(step: SetupStep): number {
  return SETUP_NAV.indexOf(SETUP_NAV_OF[step]);
}
