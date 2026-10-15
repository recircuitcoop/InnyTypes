// The runtime's one journal replay (spec 7.2, plan 0018 §7).
//
// The spike gave every instance its own `flows:started` listener (`runtime/runtime.js:74`),
// so a flow of more than ten instances raised Node's MaxListeners warning. Here the runtime
// listens ONCE: each instance is attached as Node-RED constructs it, and on the next
// `flows:started` every instance attached since the last one is replayed, after every node of
// the flow exists, so what a replayed step emits has somewhere to go.
//
// WI-0018-08 wires it: `new JournalReplay({ store, logger, events: RED.events })` once, then
// `attach(node.id, nodeProcess, (message) => node.receive(message))` in each constructor, and
// the returned detach in its close.

import type { CallOp, OpResult } from "../domain/channel/messages";
import type { QueueReport } from "../domain/journal/queue";
import type { JournalStore } from "../ports/journal-store";
import type { Logger } from "../ports/logger";
import type { InputMessage } from "../ports/node-process";

/** Node-RED's `RED.events`, as far as the replay needs it. */
export interface FlowEvents {
  on(event: "flows:started", listener: () => void): unknown;
}

/** What the replay (and the job calls) needs of an instance's node process. */
export interface Replayable {
  replay(redeliver: (message: InputMessage) => void): number;
  queue(): QueueReport;
  /**
   * Spec 4.1 `cancel`: the node stops the input and answers with an error. An input waiting on a
   * person ends at once: its question goes, and the node forgets it.
   */
  cancel(inputId: string): void;
  /** Fail the run's inputs held at the bound, never journaled (plan 0022 §E); how many. */
  cancelHeld(runId: string): number;
}

/** One input a node is working on now, for `job.list` (WI-0018-11). */
export interface JobSummary {
  readonly id: string;
  readonly instanceId: string;
  readonly type: string;
  readonly attempts: number;
  readonly createdAt: number;
}

export interface JournalReplayDeps {
  readonly store: JournalStore;
  readonly logger: Logger;
  readonly events: FlowEvents;
}

interface Attached {
  readonly node: Replayable;
  readonly redeliver: (message: InputMessage) => void;
  replayed: boolean;
}

export class JournalReplay {
  readonly #deps: JournalReplayDeps;
  readonly #instances = new Map<string, Attached>();
  /** Entries already reported as belonging to no instance, so each is said once. */
  readonly #orphansSaid = new Set<string>();

  constructor(deps: JournalReplayDeps) {
    this.#deps = deps;
    deps.events.on("flows:started", () => {
      this.#flowsStarted();
    });
  }

  /** An instance was constructed; it is replayed on the next `flows:started`. */
  attach(
    instanceId: string,
    node: Replayable,
    redeliver: (message: InputMessage) => void,
  ): () => void {
    const attached: Attached = { node, redeliver, replayed: false };
    this.#instances.set(instanceId, attached);
    return () => {
      if (this.#instances.get(instanceId) === attached) {
        this.#instances.delete(instanceId);
      }
    };
  }

  /** Every live instance's queue, for the log (spec 7.6). */
  queues(): QueueReport[] {
    return [...this.#instances.values()].map((attached) => attached.node.queue());
  }

  /** `job.list`: every input handed to a node and not yet done, oldest first. */
  jobs(): JobSummary[] {
    return this.#deps.store
      .all()
      .filter((entry) => entry.state === "sent")
      .map(({ inputId, instanceId, type, attempts, createdAt }) => ({
        id: inputId,
        instanceId,
        type,
        attempts,
        createdAt,
      }));
  }

  /**
   * `job.cancel` (spec 4.1 `cancel`): sent to the instance's process, which ends
   * the input with an error that reaches Catch. False when no instance in the flow has it.
   */
  cancel(inputId: string): boolean {
    const entry = this.#deps.store.get(inputId);
    const attached = entry?.state === "sent" ? this.#instances.get(entry.instanceId) : undefined;
    if (attached === undefined) {
      return false;
    }
    this.#deps.logger.info(`cancel requested for input ${inputId}`);
    attached.node.cancel(inputId);
    return true;
  }

  /**
   * Run history's delete (plan 0022 §E): every input of the run an instance holds now is
   * cancelled, sent, waiting on a person, or held at its bound. Answers how many.
   */
  cancelRun(runId: string): number {
    let cancelled = 0;
    for (const attached of this.#instances.values()) {
      cancelled += attached.node.cancelHeld(runId);
    }
    for (const entry of this.#deps.store.all()) {
      const attached = this.#instances.get(entry.instanceId);
      // An input that came with no run is a run of its own.
      if ((entry.event.run ?? entry.inputId) !== runId || attached === undefined) {
        continue;
      }
      attached.node.cancel(entry.inputId);
      cancelled += 1;
    }
    if (cancelled > 0) {
      this.#deps.logger.info(`run ${runId} deleted: ${String(cancelled)} inputs in hand cancelled`);
    }
    return cancelled;
  }

  /** The shell's `job.*` calls (spec 10.2); a failure is an OpResult, never a rejection. */
  call(op: CallOp, args: unknown): OpResult {
    if (op === "job.list") {
      return { ok: true, value: this.jobs() };
    }
    const id =
      typeof args === "object" && args !== null ? (args as { id?: unknown }).id : undefined;
    if (op !== "job.cancel" || typeof id !== "string" || id === "") {
      return { ok: false, error: `${op} is not a job call with an id` };
    }
    return this.cancel(id)
      ? { ok: true, value: null }
      : { ok: false, error: "This job is no longer running." };
  }

  #flowsStarted(): void {
    const { logger, store } = this.#deps;
    let resent = 0;
    for (const attached of this.#instances.values()) {
      if (!attached.replayed) {
        attached.replayed = true;
        resent += attached.node.replay(attached.redeliver);
      }
    }
    if (resent > 0) {
      logger.info(`flows started: ${String(resent)} journaled inputs re-sent`);
    }
    // An entry whose instance is not in the flow is kept, and said: never dropped in silence.
    for (const entry of store.all()) {
      if (!this.#instances.has(entry.instanceId) && !this.#orphansSaid.has(entry.inputId)) {
        this.#orphansSaid.add(entry.inputId);
        logger.warn(
          `journaled input ${entry.inputId} belongs to instance ${entry.instanceId}, which is ` +
            `not in the running flow; it is kept, and re-sent if that instance starts again`,
        );
      }
    }
  }
}
