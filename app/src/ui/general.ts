// Configuration › General's words and choices, without a DOM (plan 0022 §M, ux-writing
// "Configuration › General"): each section's one-line state from the calls that answer it, the
// address AI apps are told, the setup an AI app is given, and a refused move in words.
//
// The screen (screens/GeneralScreen.tsx) only draws what these answer, so every sentence it shows
// is held here by a unit test.
import type { RowAction } from "../domain/packages/states";
import type { AppApiV2 } from "./app-api-v2";
import type { AnytypeStatus, McpEndpointStatus } from "./contract";
import type { Answer } from "./answer";
import type { FlowSummary, NodeOptions } from "./flow-contract";
import { RETENTION_CHOICES, type PackagesView } from "./general-contract";
import { plural, t, type PlainKey } from "./strings";

/** The Anytype section's state line, and whether its button is Pair or Pair again. */
export interface AnytypeLine {
  readonly line: string;
  readonly paired: boolean;
}

/**
 * "Connected · 8 spaces" / "Not paired yet." (ux-writing), never a path. `spaces` is the answer
 * of anytypeSpaces, read only once Anytype is ready; null while it has not been read.
 */
export function anytypeLine(
  status: AnytypeStatus,
  spaces: Answer<NodeOptions> | null,
): AnytypeLine {
  switch (status.state) {
    case "no-key":
      return { line: t("general.anytype.notPaired"), paired: false };
    case "unreachable":
      return { line: t("error.anytypeUnreachable"), paired: true };
    case "starting":
      return { line: t("general.anytype.starting"), paired: true };
    case "ready":
      if (spaces === null) {
        return { line: t("general.anytype.starting"), paired: true };
      }
      if (spaces.ok) {
        return {
          line: plural(spaces.value.options.length, "general.anytype.connected"),
          paired: true,
        };
      }
      // The key was refused, or Anytype went away between the two reads: the refusal says which.
      return {
        line:
          spaces.refused.reason === "not-paired"
            ? t("error.keyRefused")
            : spaces.refused.reason === "unreachable"
              ? t("error.anytypeUnreachable")
              : t("general.anytype.connected"),
        paired: true,
      };
    default:
      // tool-surface-mismatch, down, down-for-good, stopped: Advanced carries the details.
      return { line: t("general.anytype.unavailable"), paired: true };
  }
}

/** "127.0.0.1:31010" from the URL served; null when nothing is served or it cannot be read. */
export function servedAddress(status: McpEndpointStatus): string | null {
  if (status.served === null) {
    return null;
  }
  try {
    return new URL(status.served).host;
  } catch {
    return null;
  }
}

/** The port served now, to pre-fill Change port; null when nothing is served. */
export function servedPort(status: McpEndpointStatus): number | null {
  const address = servedAddress(status);
  if (address === null) {
    return null;
  }
  const port = Number(address.slice(address.lastIndexOf(":") + 1));
  return Number.isInteger(port) ? port : null;
}

/** The AI apps section's state line. */
export function aiAppsLine(status: McpEndpointStatus): string {
  const address = servedAddress(status);
  return address === null ? t("general.aiApps.notServed") : t("general.aiApps.line", { address });
}

/**
 * A refused Change port in words. The services process refuses a port another program holds by
 * naming the address it could not bind (`127.0.0.1:<port>`): that is "Port … is used by another
 * app"; anything else (the setting could not be saved) is the generic line.
 */
export function moveRefusal(reason: string, port: number): string {
  return reason.includes(`:${String(port)}`) ? t("error.portTaken", { port }) : t("refused.failed");
}

/**
 * "Copy setup for …": the command that registers the endpoint served now with the AI app, its
 * URL filled into strings.ts's template. The token is read from a variable at call time, so the
 * token itself is never copied.
 */
export const clientSetup = (url: string) => t("general.aiApps.setup", { url });

/** The Reports section's state line (ux-writing): sending, or not; unanswered is not sending. */
export const reportsLine = (answer: "on" | "off" | "unset") =>
  t(answer === "on" ? "general.reports.on" : "general.reports.off");

/** One part of the privacy notice: its heading, its lines, and the lines drawn as a list. */
export interface NoticePart {
  readonly heading: PlainKey;
  readonly lines: readonly PlainKey[];
  readonly listed?: readonly PlainKey[];
  readonly after?: readonly PlainKey[];
}

/**
 * The privacy notice beside the reports question (D25): what is sent, what never is, how long it
 * is kept, the GDPR rights; first the line saying it is optional. Every line a strings.ts key.
 */
export const PRIVACY_NOTICE_OPENING: PlainKey = "privacy.optional";
export const PRIVACY_NOTICE: readonly NoticePart[] = [
  {
    heading: "privacy.sent",
    lines: ["privacy.sent.where"],
    listed: [
      "privacy.sent.machineId",
      "privacy.sent.versions",
      "privacy.sent.packages",
      "privacy.sent.stamp",
    ],
    after: ["privacy.sent.address", "privacy.sent.wrapped", "privacy.sent.crashes"],
  },
  { heading: "privacy.never", lines: ["privacy.never.line"] },
  { heading: "privacy.kept", lines: ["privacy.kept.line"] },
  {
    heading: "privacy.rights",
    lines: [
      "privacy.rights.pseudonymous",
      "privacy.rights.contact",
      "privacy.rights.line",
      "privacy.rights.see",
      "privacy.rights.change",
    ],
  },
];

/** General › Reports shows the notice beside its switch while the question is unanswered. */
export const showsPrivacyNotice = (answer: "on" | "off" | "unset") => answer === "unset";

/** The retention Select's options, 7, 30, 90, 365 days and Forever (D8), in that order. */
export const RETENTION_OPTIONS: readonly { readonly value: string; readonly label: string }[] =
  RETENTION_CHOICES.map((days) => ({
    value: retentionValue(days),
    label:
      days === null ? t("general.retention.forever") : t("general.retention.days", { n: days }),
  }));

/** A retention choice as the Select's value: the days, or "forever". */
export function retentionValue(days: number | null): string {
  return days === null ? "forever" : String(days);
}

/** The Select's value back as days; undefined for a value that is not one of the choices. */
export function retentionDays(value: string): number | null | undefined {
  return RETENTION_CHOICES.find((days) => retentionValue(days) === value);
}

/** The Run history section's state line. */
export const retentionLine = (days: number | null) =>
  days === null ? t("general.runs.forever") : t("general.runs.days", { n: days });

// ── Recorders and folders ────────────────────────────────────────────────────────────────────

/** The shipped folder source's Node-RED type (packages/folder, D18): data, never shown. */
export const FOLDER_SOURCE_TYPE = "inny-folder-watch";

/** A folder source step of a flow: where to read its folder, and whether its flow is on. */
export interface FolderStep {
  readonly flowId: string;
  readonly nodeId: string;
  readonly on: boolean;
}

/** Every folder source step that is set up, flow by flow in the list's order. */
export function folderSteps(flows: readonly FlowSummary[]): FolderStep[] {
  return flows.flatMap((flow) =>
    flow.sources
      .filter((step) => step.type === FOLDER_SOURCE_TYPE && step.setUp)
      .map((step) => ({ flowId: flow.id, nodeId: step.id, on: flow.on })),
  );
}

/** A folder by its own name, never its path ("BOYA" for /Volumes/BOYA). */
export function folderName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter((part) => part !== "");
  return parts.at(-1) ?? folder;
}

/** "BOYA · watching" (ux-writing), or not watching while its flow is off. */
export const recorderLine = (folder: string, on: boolean) =>
  on
    ? t("general.recorder.watching", { name: folderName(folder) })
    : t("general.recorder.off", { name: folderName(folder) });

/** A line in parts, a part between backticks marked as code (the AI apps line's address). */
export function codeParts(text: string): { readonly code: boolean; readonly text: string }[] {
  return text
    .split("`")
    .map((part, index) => ({ code: index % 2 === 1, text: part }))
    .filter((part) => part.text !== "");
}

// ── Packages (plan 0022 §F) ──────────────────────────────────────────────────────────────────

/** A line in parts, a name between asterisks marked as one (ux-writing draws it in italics). */
export function nameParts(text: string): { readonly name: boolean; readonly text: string }[] {
  return text
    .split("*")
    .map((part, index) => ({ name: index % 2 === 1, text: part }))
    .filter((part) => part.text !== "");
}

/** A line with its names' asterisks dropped, for a place that draws no italics (a dialog's title). */
export const withoutMarks = (text: string) => text.replaceAll("*", "");

/** "4 installed · 1 update" (ux-writing): every package listed, and those with an update waiting. */
export function packagesLine(view: PackagesView): string {
  const updates = view.packages.filter((row) => row.package.update?.state === "available").length;
  const installed = t("packages.installedCount", { n: view.packages.length });
  return updates === 0
    ? installed
    : t("packages.line", { installed, updates: plural(updates, "packages.updateCount") });
}

/** What pressing a row's action does: a call, or Go back's confirmation first. */
export type PackageActionCall =
  | { readonly kind: "call"; readonly call: () => Promise<Answer<unknown>> }
  | { readonly kind: "confirm-go-back" };

/**
 * Every action a Package row can draw (domain/packages/states.ts `rowActions`), and its call:
 * typed over every RowAction, so no button is drawn without one. Install, on a row, is "Install
 * again" for a package that failed its check (rows are installed packages).
 */
export const PACKAGE_ACTIONS: Readonly<
  Record<RowAction, (api: AppApiV2, name: string) => PackageActionCall>
> = {
  register: (api, name) => ({ kind: "call", call: () => api.registerPackage(name) }),
  unregister: (api, name) => ({ kind: "call", call: () => api.unregisterPackage(name) }),
  install: (api, name) => ({ kind: "call", call: () => api.reinstallPackage(name) }),
  remove: (api, name) => ({ kind: "call", call: () => api.uninstallPackage(name) }),
  update: (api, name) => ({ kind: "call", call: () => api.updatePackage(name) }),
  "check-for-changes": (api, name) => ({ kind: "call", call: () => api.checkFolder(name) }),
  "go-back": () => ({ kind: "confirm-go-back" }),
};
