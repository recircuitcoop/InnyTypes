// The only route from InnyTypes to a telemetry server (plan 0018 §3 telemetry.py: Port, the
// consent-first design kept whole; the port of TelemetryPipeline, telemetry.py:1125-1370).
//
// Everything here exists to make one sentence true: nothing leaves this machine that the person
// did not agree to, and nothing at all leaves it before they were asked (plan 0003 F2).
//
// * The switch decides, in one place. Every public method starts at `#allows`, which READS THE
//   SETTING AGAIN, every time: no copy, no flag remembered at start. `on` is the only answer that
//   queues or sends; `off` and `unset` both stop everything and empty the queue on the spot,
//   because a report already written would otherwise drain later, and "off" that still sends is
//   not off. A setting that cannot be read is never permission to send.
// * The machine identifier is read lazily, inside the gate, the first time a report is allowed:
//   a machine whose owner has not answered has not had its identifier looked at. The raw value is
//   registered with the log's redactor the moment it is read, and removed from every payload.
// * Every payload passes the one redaction (domain/telemetry/redact.ts) before it is queued, and
//   a transport renders only what was queued.
// * Reporting never waits on a server: `recordUsage` and `recordCrash` write one small file and
//   schedule the sender. The sender posts with a timeout and backs off between failures on the
//   injected clock, so a GlitchTip that is down, slow or gone costs a restart nothing.

import { redactPayload, type CredentialRedactor } from "../domain/telemetry/redact";
import {
  checkIdentifier,
  type QueuedReport,
  type ReportKind,
  type TelemetryAnswer,
} from "../domain/telemetry/reports";
import { hasEndpoint, outgoingFor, type Endpoints } from "../domain/telemetry/transports";
import type { Cancel, Clock } from "../ports/clock";
import type { Logger, SecretSink } from "../ports/logger";
import type {
  MachineIdentifierSource,
  MachineIdHash,
  ReportQueue,
  TelemetryPoster,
  TelemetrySetting,
} from "../ports/telemetry";

/** How long the sender waits after each consecutive failure, in order, the last repeating. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];

export interface TelemetryDeps {
  readonly setting: TelemetrySetting;
  readonly queue: ReportQueue;
  readonly poster: TelemetryPoster;
  /** Required, never defaulted: no spelling of this pipeline reads the real one by omission. */
  readonly machineIdentifier: MachineIdentifierSource;
  readonly hashIdentifier: MachineIdHash;
  readonly endpoints: Endpoints;
  /** The app's version, as the servers are told it. */
  readonly release: string;
  readonly clock: Clock;
  /** Wall-clock epoch ms, for a report's `at`. */
  readonly now: () => number;
  /** A fresh report id: 32 hex digits (a Sentry event id). */
  readonly newId: () => string;
  /** The one SecretRegistry's redact: every registered credential out of every string. */
  readonly credentials: CredentialRedactor;
  /** Where the raw machine identifier is registered, so no log line can ever show it. */
  readonly secrets: SecretSink;
  readonly logger: Logger;
  readonly backoffMs?: readonly number[];
}

/** What the Settings page is told: the answer, why it could not be read, and what waits. */
export interface TelemetryState {
  readonly answer: TelemetryAnswer;
  readonly problem: string | null;
  readonly queued: number;
}

export interface FlushResult {
  readonly sent: number;
  /** After a failure: how long the sender waits before the next attempt; null otherwise. */
  readonly retryInMs: number | null;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A kind of report, in the log's words: an `error` report is about a crash. */
const named = (kind: ReportKind): string => (kind === "error" ? "crash report" : "usage report");

export class TelemetryPipeline {
  readonly #deps: TelemetryDeps;
  readonly #backoff: readonly number[];
  #machineId: string | null = null;
  /** The raw identifier once read: removed from every payload by exact match. */
  #raw: string[] = [];
  #failures = 0;
  #scheduled: Cancel | null = null;
  #sending = false;
  #again = false;
  #running = false;
  #halted = false;

  constructor(deps: TelemetryDeps) {
    this.#deps = deps;
    this.#backoff =
      deps.backoffMs !== undefined && deps.backoffMs.length > 0
        ? deps.backoffMs
        : DEFAULT_BACKOFF_MS;
  }

  // ── what a caller reports ──────────────────────────────────────────────────────────────

  /** Queue one usage report, or nothing at all when the switch does not allow it. */
  recordUsage(payload: Readonly<Record<string, unknown>>): QueuedReport | null {
    return this.#report("usage", payload);
  }

  /** Queue one crash report, or nothing at all when the switch does not allow it. */
  recordCrash(payload: Readonly<Record<string, unknown>>): QueuedReport | null {
    return this.#report("error", payload);
  }

  // ── what the person sees and does ──────────────────────────────────────────────────────

  /** The switch now, read again, and how many reports wait (none unless it is on). */
  state(): TelemetryState {
    let answer: TelemetryAnswer;
    try {
      answer = this.#deps.setting.readTelemetry();
    } catch (error) {
      return { answer: "unset", problem: reasonOf(error), queued: 0 };
    }
    return { answer, problem: null, queued: this.pending().length };
  }

  /**
   * The person's answer, from the first-launch question or the switch: both answer the question.
   * Off takes effect at once: what is queued is deleted, not sent later. Throws when the answer
   * could not be stored, and then nothing changed.
   */
  answer(on: boolean): void {
    this.#deps.setting.writeTelemetry(on);
    this.#deps.logger.info(`telemetry is turned ${on ? "on" : "off"}`);
    if (on) {
      this.#wake();
    } else {
      this.#allows();
    }
  }

  /** The queued reports, gated like everything else: after off, the queue IS empty. */
  pending(): readonly QueuedReport[] {
    return this.#allows() ? this.#deps.queue.pending() : [];
  }

  // ── the sender ─────────────────────────────────────────────────────────────────────────

  /**
   * Send what is queued, in order, and say how many went. Never throws. Reads the switch again
   * BEFORE EVERY REPORT, so turning it off mid-drain stops the drain at that report.
   */
  async flush(): Promise<FlushResult> {
    let sent = 0;
    for (const report of this.pending()) {
      if (this.#halted || !this.#allows()) {
        return { sent, retryInMs: null };
      }
      let outgoing;
      try {
        outgoing = outgoingFor(report, this.#deps.endpoints, this.#deps.release);
      } catch (error) {
        // An endpoint that is not HTTPS, or gone from the build: there is nowhere this report
        // may go, and no later moment when there will be.
        this.#deps.logger.warn(`a ${named(report.kind)} is dropped unsent: ${reasonOf(error)}`);
        this.#deps.queue.remove(report);
        continue;
      }
      const result = await this.#deps.poster.post(outgoing);
      if (!result.ok) {
        this.#failures += 1;
        const delay = this.#backoff[Math.min(this.#failures, this.#backoff.length) - 1] ?? 0;
        this.#deps.logger.info(
          `a ${named(report.kind)} could not be sent (${result.detail}); ` +
            `trying again in ${String(Math.round(delay / 1000))} s`,
        );
        return { sent, retryInMs: delay };
      }
      this.#failures = 0;
      this.#deps.queue.remove(report);
      sent += 1;
    }
    return { sent, retryInMs: null };
  }

  /** Start sending in the background. Idempotent. */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#halted = false;
    this.#wake();
  }

  /** Stop sending. Touches neither the queue nor the network; a second call does nothing. */
  stop(): void {
    this.#running = false;
    this.#halted = true;
    this.#scheduled?.();
    this.#scheduled = null;
  }

  #wake(delayMs = 0): void {
    if (!this.#running) {
      return;
    }
    if (this.#sending) {
      this.#again = true;
      return;
    }
    if (this.#scheduled !== null) {
      // A backoff is running: a new report waits for it rather than cutting it short.
      return;
    }
    this.#scheduled = this.#deps.clock.after(delayMs, () => {
      this.#scheduled = null;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    this.#sending = true;
    let retryInMs: number | null = null;
    try {
      ({ retryInMs } = await this.flush());
    } catch (error) {
      // Telemetry never takes the shell down with it: the next report wakes the sender again.
      this.#deps.logger.warn(`the telemetry sender failed: ${reasonOf(error)}`);
    }
    this.#sending = false;
    // A report recorded while this drain ran asked for another.
    const again = this.#again;
    this.#again = false;
    if (retryInMs !== null) {
      this.#wake(retryInMs);
    } else if (again) {
      this.#wake();
    }
  }

  // ── the gate ───────────────────────────────────────────────────────────────────────────

  /**
   * The one place the switch is consulted, read again every time. `on` is the only answer that
   * permits anything; `off` and `unset` purge the queue here and now (off: what is queued is
   * deleted, not sent later; unset: nothing may wait before the question is answered).
   */
  #allows(): boolean {
    let answer: TelemetryAnswer;
    try {
      answer = this.#deps.setting.readTelemetry();
    } catch (error) {
      this.#deps.logger.warn(
        `the telemetry switch could not be read, so nothing is sent: ${reasonOf(error)}`,
      );
      return false;
    }
    if (answer === "on") {
      return true;
    }
    const dropped = this.#deps.queue.purge();
    if (dropped > 0) {
      this.#deps.logger.info(`telemetry is ${answer}: dropped ${String(dropped)} queued report(s)`);
    }
    return false;
  }

  /** Stamp, redact and queue one report. Null when nothing was queued. */
  #report(kind: ReportKind, payload: Readonly<Record<string, unknown>>): QueuedReport | null {
    if (!this.#allows()) {
      return null;
    }
    if (!hasEndpoint(this.#deps.endpoints, kind)) {
      // Nowhere to send it: queueing it would only rotate files on the person's disk.
      return null;
    }
    try {
      const stamped = {
        ...payload,
        kind,
        machine_id: this.#identity(),
        report_id: this.#deps.newId(),
        at: new Date(this.#deps.now()).toISOString(),
      };
      const report = this.#deps.queue.enqueue(
        kind,
        redactPayload(stamped, this.#deps.credentials, this.#raw),
      );
      this.#wake();
      return report;
    } catch (error) {
      // A full disk, a read-only folder, a machine with no identifier: none of them are the
      // caller's problem. The caller is a restart, and it carries on (telemetry.py:1319).
      this.#deps.logger.warn(`a ${named(kind)} could not be queued: ${reasonOf(error)}`);
      return null;
    }
  }

  /** The machine id, computed once, on the first report the switch allowed. */
  #identity(): string {
    if (this.#machineId === null) {
      const raw = checkIdentifier(this.#deps.machineIdentifier());
      // Unrenderable from this moment: in the log, and in every payload.
      this.#deps.secrets.protect(raw);
      this.#raw = [raw];
      this.#machineId = this.#deps.hashIdentifier(raw);
    }
    return this.#machineId;
  }
}
