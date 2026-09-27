// Telemetry's edges, in memory (WI-0018-22): a switch that counts its reads, a queue, a poster that
// records every request and answers as told, and an identifier source that counts its calls. No
// fake here can reach a network or this machine's own identifier.

import type { TelemetryDeps } from "../../src/application/telemetry";
import { SecretRegistry } from "../../src/domain/redaction/registry";
import type { JsonObject } from "../../src/domain/telemetry/redact";
import type { QueuedReport, ReportKind, TelemetryAnswer } from "../../src/domain/telemetry/reports";
import type { Endpoints, Outgoing } from "../../src/domain/telemetry/transports";
import type {
  PostResult,
  ReportQueue,
  TelemetryPoster,
  TelemetrySetting,
} from "../../src/ports/telemetry";
import { FakeClock } from "./clock";
import { RecordingLogger } from "./children";

export class MemorySetting implements TelemetrySetting {
  answer: TelemetryAnswer;
  reads = 0;
  unreadable = false;
  unwritable = false;

  constructor(answer: TelemetryAnswer = "unset") {
    this.answer = answer;
  }

  readTelemetry(): TelemetryAnswer {
    this.reads += 1;
    if (this.unreadable) {
      throw new Error("shell-settings.json is not JSON");
    }
    return this.answer;
  }

  writeTelemetry(on: boolean): void {
    if (this.unwritable) {
      throw new Error("could not write shell-settings.json: EACCES");
    }
    this.answer = on ? "on" : "off";
  }
}

export class MemoryQueue implements ReportQueue {
  reports: QueuedReport[] = [];
  #next = 1;
  unwritable = false;

  enqueue(kind: ReportKind, payload: JsonObject): QueuedReport {
    if (this.unwritable) {
      throw new Error("ENOSPC: no space left on device");
    }
    const report = { sequence: this.#next++, kind, payload };
    this.reports.push(report);
    return report;
  }

  pending(): readonly QueuedReport[] {
    return [...this.reports];
  }

  remove(report: QueuedReport): void {
    this.reports = this.reports.filter((queued) => queued.sequence !== report.sequence);
  }

  purge(): number {
    const count = this.reports.length;
    this.reports = [];
    return count;
  }
}

/** Records every request; answers ok unless `answer` says otherwise (or never, for a hang). */
export class RecordingPoster implements TelemetryPoster {
  readonly sent: Outgoing[] = [];
  answer: (request: Outgoing) => PostResult | "hang" = () => ({ ok: true });

  post(request: Outgoing): Promise<PostResult> {
    this.sent.push(request);
    const answer = this.answer(request);
    return answer === "hang" ? new Promise<never>(() => undefined) : Promise.resolve(answer);
  }
}

/** A fake OS identifier: long enough to be one, and unique enough to find if it ever leaks. */
export const RAW_IDENTIFIER = "C0FFEE00-1234-5678-9ABC-TELEMETRYRAW1";

export const ENDPOINTS: Endpoints = {
  glitchtipDsn: "https://publickey123@glitchtip.test/42",
  umamiUrl: "https://umami.test",
  umamiWebsiteId: "website-1",
};

export interface TelemetryWorld {
  readonly deps: TelemetryDeps;
  readonly setting: MemorySetting;
  readonly queue: MemoryQueue;
  readonly poster: RecordingPoster;
  readonly clock: FakeClock;
  readonly registry: SecretRegistry;
  readonly logger: RecordingLogger;
  /** How often the machine identifier source was called. */
  readonly identifierCalls: () => number;
}

/** A pipeline's whole world, with a switch answered `answer`. */
export function telemetryWorld(
  answer: TelemetryAnswer = "on",
  overrides: Partial<TelemetryDeps> = {},
): TelemetryWorld {
  const setting = new MemorySetting(answer);
  const queue = new MemoryQueue();
  const poster = new RecordingPoster();
  const clock = new FakeClock();
  const registry = new SecretRegistry();
  const logger = new RecordingLogger();
  let calls = 0;
  let ids = 0;
  const deps: TelemetryDeps = {
    setting,
    queue,
    poster,
    machineIdentifier: () => {
      calls += 1;
      return RAW_IDENTIFIER;
    },
    hashIdentifier: (raw) => `hash-of-${String(raw.length)}-chars`,
    endpoints: ENDPOINTS,
    release: "9.9.9",
    clock,
    now: () => Date.UTC(2026, 8, 26, 12),
    newId: () => `report${String((ids += 1)).padStart(26, "0")}`,
    credentials: (text) => registry.redact(text),
    secrets: { protect: (secret) => registry.protect(secret) },
    logger,
    ...overrides,
  };
  return {
    deps,
    setting,
    queue,
    poster,
    clock,
    registry,
    logger,
    identifierCalls: () => calls,
  };
}

/** A report the test expects was queued. */
export function queued(report: QueuedReport | null): QueuedReport {
  if (report === null) {
    throw new Error("nothing was queued");
  }
  return report;
}

/** Let the pipeline's pending promises run (a drain awaits the poster). */
export async function settle(): Promise<void> {
  for (let n = 0; n < 20; n += 1) {
    await Promise.resolve();
  }
}
