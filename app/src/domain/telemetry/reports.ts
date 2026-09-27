// What a telemetry report is, what it may carry, and what the person is told before any is sent
// (plan 0018 §3 telemetry.py: Port; the consent-first design of plan 0003 F2, kept whole).
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

// ── the first-launch question ────────────────────────────────────────────────────────────

/** D25's retention periods, named so the notice and any server configuration read the same. */
export const ERROR_RETENTION_DAYS = 90;
export const USAGE_RETENTION_MONTHS = 13;

export const FIRST_LAUNCH_QUESTION =
  "Send anonymous usage and crash reports to the InnyTypes servers?";

export const PRIVACY_NOTICE = `InnyTypes can send usage and crash reports to its own servers. It is entirely optional, and answering "no" changes nothing else: InnyTypes keeps restarting its processes and updating its packages either way.

If you say yes, a report contains:
• a machine id: an HMAC-SHA256 hash of your operating system's machine identifier. The identifier itself never leaves this machine, and the hash cannot be matched to the same machine in any other software.
• the InnyTypes version, your operating system, its version and the processor type.
• which packages are installed, at which versions.
• for a crash: which process crashed (the runtime, the services process or a node's process), whether InnyTypes stopped restarting it, and how often each has crashed. Never what it was working on.

A report never contains: anything from your Anytype content, the names of your objects, spaces, flows or nodes, your Anytype API key, the proxy token or any other credential, anything you configured a node with, the contents of any file, audio or transcripts, the values of environment variables, full paths inside your home directory, your user name, your machine's host name, or your machine's raw identifier.

Reports are kept for ${String(ERROR_RETENTION_DAYS)} days (crashes) and ${String(USAGE_RETENTION_MONTHS)} months (usage). Under the GDPR the machine id is still pseudonymous personal data, even though it carries no name, which is why those limits exist.

You can change your answer at any time on the Settings page. Turning reports off deletes anything still waiting to be sent.`;
