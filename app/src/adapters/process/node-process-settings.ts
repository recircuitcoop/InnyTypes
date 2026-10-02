// The settings and dependencies of a node process (node-process.ts), apart so that file
// stays under the 600-line limit (plan 0018 §2.3).

import { DEFAULT_QUEUE, type QueueSettings } from "../../domain/journal/queue";
import { DEFAULT_CRASH_LOOP, type CrashLoopSettings } from "../../domain/supervision/breaker";
import type { Clock } from "../../ports/clock";
import type { JournalStore } from "../../ports/journal-store";
import type { Logger, SecretSink } from "../../ports/logger";
import type { HeldInputs } from "../../ports/node-process";
import type { Notifier } from "../../ports/notifier";
import type { NodeCrashSink } from "../../ports/telemetry";
import type { ProcessTree } from "./process-tree";

/** Every number a node process is run by (spec 4.4, 6.3, 6.5). */
export interface NodeProcessSettings {
  /** `start` → `ready`, or the process is killed and counted as an unexpected exit. */
  readonly readyDeadlineMs: number;
  /** `close` → exit, or SIGKILL. */
  readonly closeDeadlineMs: number;
  /** An unexpected exit → the next process. */
  readonly respawnDelayMs: number;
  readonly crashLoop: CrashLoopSettings;
  /**
   * After the process exits, how long its pipes may stay open before the exit is handled
   * anyway. Normally they close at once, and waiting for that is what lets a `done` written
   * just before the exit be read before its input is failed.
   */
  readonly exitGraceMs: number;
  /** The bound on outstanding inputs and what happens at it (spec 7.6). */
  readonly queue: QueueSettings;
}

export const DEFAULT_NODE_PROCESS: NodeProcessSettings = {
  readyDeadlineMs: 30_000,
  closeDeadlineMs: 5_000,
  respawnDelayMs: 1_000,
  crashLoop: DEFAULT_CRASH_LOOP,
  exitGraceMs: 500,
  queue: DEFAULT_QUEUE,
};

export interface NodeProcessDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly notifier: Notifier;
  readonly tree: ProcessTree;
  /** A fresh envelope id (a UUID in the app). */
  readonly newId: () => string;
  /** The log redactor: every credential is registered before the process can print a line. */
  readonly secrets: SecretSink;
  /** The runtime's one journal; this instance writes its own entries to it. */
  readonly journal: JournalStore;
  readonly settings: NodeProcessSettings;
  /** Told of every unexpected exit, for the crash reports (WI-0018-22); absent in most tests. */
  readonly crashes?: NodeCrashSink;
  /** Told which runs have inputs held at the queue bound (plan 0022 §C); absent in most tests. */
  readonly held?: HeldInputs;
}
