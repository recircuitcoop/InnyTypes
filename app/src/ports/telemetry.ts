// Telemetry's edges (plan 0018 §2.3 Telemetry; WI-0018-22): where the switch is stored, where
// reports wait, how one is posted, and where the machine's identifier comes from. The pipeline
// (application/telemetry.ts) is the only thing that holds them, so nothing reaches the queue or a
// server around the switch.

import type { JsonObject } from "../domain/telemetry/redact";
import type { QueuedReport, ReportKind, TelemetryAnswer } from "../domain/telemetry/reports";
import type { Outgoing } from "../domain/telemetry/transports";

/** The telemetry switch, in a file only the shell writes. */
export interface TelemetrySetting {
  /** The answer now, read from the file every time; throws when the file cannot be read. */
  readTelemetry(): TelemetryAnswer;
  /** Store the answer, leaving every other setting as it was. */
  writeTelemetry(on: boolean): void;
}

/** Reports on disk, in order, bounded, dropping the oldest when full (telemetry.py:737). */
export interface ReportQueue {
  /** Write one (already redacted) report, then bring the queue back inside its bounds. */
  enqueue(kind: ReportKind, payload: JsonObject): QueuedReport;
  /** Every queued report, oldest first; one that cannot be read is deleted, not skipped. */
  pending(): readonly QueuedReport[];
  /** Forget one report, because it has been sent. */
  remove(report: QueuedReport): void;
  /** Delete every queued report and say how many there were. */
  purge(): number;
}

export type PostResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** One POST over HTTPS, with a timeout. Never throws: every failure is a result. */
export interface TelemetryPoster {
  post(request: Outgoing): Promise<PostResult>;
}

/**
 * The operating system's own machine identifier, and nothing else about the machine (D20). Called
 * only once the switch is on; throws, naming why, when this machine has none.
 */
export type MachineIdentifierSource = () => string;

/** The machine id: a keyed hash of the raw identifier, as hex. */
export type MachineIdHash = (raw: string) => string;

/**
 * A node instance's process exited unexpectedly (WI-0018-22), told by the runtime to the shell so
 * crash reports count node processes too. `stopped` is true when the crash-loop limit stopped it.
 * Carries no name: a node's name is the person's own words.
 */
export interface NodeCrashSink {
  nodeCrashed(stopped: boolean): void;
}
