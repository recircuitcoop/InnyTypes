// Configuration › General's words and choices, without a DOM (plan 0022 §M, ux-writing
// "Configuration › General"): each section's one-line state from the calls that answer it, the
// address AI apps are told, the setup an AI app is given, and a refused move in words.
//
// The screen (screens/GeneralScreen.tsx) only draws what these answer, so every sentence it shows
// is held here by a unit test.
import type { AnytypeStatus, McpEndpointStatus } from "./contract";
import type { Answer } from "./answer";
import type { NodeOptions } from "./flow-contract";
import { RETENTION_CHOICES } from "./general-contract";
import { plural, t } from "./strings";

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

/** The environment variable an AI app reads the endpoint's token from (docs/INSTALL.md §7). */
export const TOKEN_VARIABLE = "INNYTYPES_MCP_TOKEN";

/** The AI apps General offers a setup for, by the name the button says. */
export const AI_APPS = ["Codex", "Claude Code"] as const;
export type AiApp = (typeof AI_APPS)[number];

/**
 * "Copy setup for Codex" etc.: the one command that registers the endpoint served now with that
 * app, its token read from TOKEN_VARIABLE at call time, so the token itself is never copied.
 */
export function clientSetup(app: AiApp, url: string): string {
  switch (app) {
    case "Codex":
      return `codex mcp add innytypes --url ${url} --bearer-token-env-var ${TOKEN_VARIABLE}`;
    case "Claude Code":
      return (
        `claude mcp add --transport http innytypes ${url} ` +
        `--header "Authorization: Bearer \${${TOKEN_VARIABLE}}"`
      );
  }
}

/** The Reports section's state line (ux-writing): sending, or not; unanswered is not sending. */
export const reportsLine = (answer: "on" | "off" | "unset") =>
  t(answer === "on" ? "general.reports.on" : "general.reports.off");

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
