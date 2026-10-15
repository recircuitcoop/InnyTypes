// What a telemetry report is and what it may carry (plan 0018 §3 telemetry.py: Port; the
// consent-first design of plan 0003 F2, kept whole). What the person is told before any is sent
// is the privacy notice, worded in ui/strings.ts and laid out by ui/general.ts.
//
// The reports are assembled from named fields, never from whatever a caller hands over: a usage
// report says which version runs where and which packages are installed; a crash report says
// which process crashed and how often each has. Adding a field here is the moment somebody has to
// ask whether it may be sent.

import type { JsonObject } from "./redact";

/** The two kinds of report, which go to two different servers (D21, D22). */
export type ReportKind = "usage" | "error";

export const REPORT_KINDS: readonly ReportKind[] = ["usage", "error"];

export function isReportKind(value: unknown): value is ReportKind {
  return value === "usage" || value === "error";
}

/**
 * The switch. `on` is the only answer that queues or sends; `off` and `unset` both stop everything,
 * and `unset` is the question not answered yet (F2: nothing at all before the person was asked).
 */
export type TelemetryAnswer = "on" | "off" | "unset";

/** Telemetry cannot be set up, naming what is missing. Never raised to a caller that reported. */
export class TelemetryError extends Error {
  override name = "TelemetryError";
}

/** One report waiting in the queue, already redacted. */
export interface QueuedReport {
  readonly sequence: number;
  readonly kind: ReportKind;
  readonly payload: JsonObject;
}

// ── the machine id's input ───────────────────────────────────────────────────────────────

/**
 * An identifier shorter than this is not the OS's machine identifier: a stub, a fake or a
 * truncated read. Registering it with the redactor would blank fragments of unrelated text.
 */
export const MINIMUM_IDENTIFIER_LENGTH = 8;

/** The raw identifier, checked: refused when empty or too short to be the OS's own. */
export function checkIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new TelemetryError(
      "the machine identifier source returned nothing; telemetry needs the operating system's " +
        "own machine identifier to derive a machine id",
    );
  }
  if (trimmed.length < MINIMUM_IDENTIFIER_LENGTH) {
    throw new TelemetryError(
      `the machine identifier source returned ${String(trimmed.length)} characters, which is ` +
        `not an operating system machine identifier (at least ` +
        `${String(MINIMUM_IDENTIFIER_LENGTH)} are expected)`,
    );
  }
  return trimmed;
}

// ── what is sent ─────────────────────────────────────────────────────────────────────────

/** Which version runs, on what. Every report carries it. */
export interface Versions {
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly arch: string;
}

/** One installed package as usage reports it: which package, which version. */
export interface ReportedPackage {
  readonly id: string;
  readonly version: string;
}

function versionFields(versions: Versions): Record<string, string> {
  return {
    app_version: versions.appVersion,
    os: versions.os,
    os_version: versions.osVersion,
    arch: versions.arch,
  };
}

/** One usage report's body, before redaction: the version set and the packages installed. */
export function usagePayload(
  versions: Versions,
  packages: readonly ReportedPackage[],
): Record<string, unknown> {
  return {
    ...versionFields(versions),
    packages: packages.map((entry) => ({ id: entry.id, version: entry.version })),
  };
}

/** The processes whose crashes are counted: the two supervised children and a node's process. */
export type CrashedProcess = "runtime" | "services" | "node";

/** How often each has crashed since the app started. */
export interface CrashCounts {
  readonly runtime: number;
  readonly services: number;
  readonly node: number;
  /** Node instances the crash-loop limit stopped. */
  readonly nodeStopped: number;
}

/** The exception type a crash is grouped under on the error server. */
export const CRASH_TYPES: Readonly<Record<CrashedProcess, string>> = {
  runtime: "RuntimeCrashed",
  services: "ServicesCrashed",
  node: "NodeProcessCrashed",
};

/**
 * One crash report's body, before redaction: which process crashed, whether the crash-loop limit
 * stopped it, and the counts. Never what the process was working on: no node's name, no input, no
 * message, no log line (plan 0003: an error report never carries the exception's message).
 */
export function crashPayload(
  crashed: CrashedProcess,
  stoppedForGood: boolean,
  counts: CrashCounts,
  versions: Versions,
): Record<string, unknown> {
  return {
    ...versionFields(versions),
    exception_type: CRASH_TYPES[crashed],
    crashed,
    stopped_for_good: stoppedForGood,
    crashes: {
      runtime: counts.runtime,
      services: counts.services,
      node: counts.node,
      node_stopped: counts.nodeStopped,
    },
  };
}

// ── retention ────────────────────────────────────────────────────────────────────────────

/** D25's retention periods, named so the notice and any server configuration read the same. */
export const ERROR_RETENTION_DAYS = 90;
export const USAGE_RETENTION_MONTHS = 13;
