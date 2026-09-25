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

import type { QueueReport } from "../domain/journal/queue";
import type { JournalStore } from "../ports/journal-store";
import type { Logger } from "../ports/logger";
import type { InputMessage } from "../ports/node-process";

/** Node-RED's `RED.events`, as far as the replay needs it. */
export interface FlowEvents {
  on(event: "flows:started", listener: () => void): unknown;
}

/** What the replay needs of an instance's node process. */
export interface Replayable {
  replay(redeliver: (message: InputMessage) => void): number;
  queue(): QueueReport;
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

  /** Every live instance's queue, for the Jobs page (spec 7.6). */
  queues(): QueueReport[] {
    return [...this.#instances.values()].map((attached) => attached.node.queue());
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
