// One instance's side of the journal (spec §7) and its queue bound (spec 7.6), for
// node-process.ts: which store calls happen when, what is logged, and which inputs may go
// to the process. The rules themselves are in domain/journal; the store is the JournalStore
// port.
//
// Replay without a marker (plan 0018 §7). The spike tagged a replayed message `_innyReplay`,
// and the tag reached Catch and Complete. Here the replayed message carries its four journaled
// fields and nothing else; this instance remembers the message OBJECT it handed to Node-RED
// (a WeakMap), and knows it again when Node-RED's `receive` delivers that same object back as
// an input. Node-RED's `receive` emits the object it was given, uncloned.

import {
  isFirstPresentation,
  journaledMessage,
  newEntry,
  onClose,
  onReplay,
  presented,
  submitted,
  type CloseReason,
  type JournalEntry,
  type JournaledEvent,
  type JournaledMessage,
} from "../../domain/journal/entry";
import { admit, type QueueReport, type QueueSettings } from "../../domain/journal/queue";
import type { Clock } from "../../ports/clock";
import type { JournalStore } from "../../ports/journal-store";
import type { InputDelivery, NodeIdentity, ViewContent } from "../../ports/node-process";
import type { NodeProcessDeps } from "./node-process-settings";

/** An input held at the bound: not journaled yet, not sent (spec 7.6 "hold"). */
export interface Held {
  readonly message: JournaledMessage;
  readonly delivery: InputDelivery;
}

/** An input the journal let through: journaled, to be written to the process under `id`. */
export interface Admitted {
  readonly id: string;
  readonly event: JournaledEvent;
  /** A replayed action view: it waits on a person again (spec 7.4). */
  readonly awaiting: boolean;
}

export interface InputJournalDeps {
  readonly store: JournalStore;
  readonly clock: Clock;
  readonly queue: QueueSettings;
  readonly instanceId: string;
  readonly type: string;
  /** The instance's name for a person, in the error of a step that is given up. */
  readonly label: string;
  readonly newId: () => string;
  readonly log: (level: "info" | "warn" | "error", message: string) => void;
}

/** The journal side of the instance `identity`, from a node process's dependencies. */
export function inputJournalFor(
  identity: NodeIdentity,
  deps: Pick<NodeProcessDeps, "journal" | "clock" | "newId" | "settings">,
  log: InputJournalDeps["log"],
): InputJournal {
  return new InputJournal({
    store: deps.journal,
    clock: deps.clock,
    queue: deps.settings.queue,
    instanceId: identity.id,
    type: identity.type,
    label: identity.name || identity.typeId,
    newId: deps.newId,
    log,
  });
}

export class InputJournal {
  readonly #deps: InputJournalDeps;
  /** Messages handed to Node-RED for replay, by object, to their input ids. */
  readonly #replays = new WeakMap<object, string>();
  readonly #held: Held[] = [];
  #refused = 0;

  constructor(deps: InputJournalDeps) {
    this.#deps = deps;
  }

  // ── inputs ─────────────────────────────────────────────────────────────────────────────

  /**
   * A new input, with `outstanding` inputs already journaled. Under the bound it is journaled
   * (spec 7.1) and admitted; at the bound it is held or failed (spec 7.6). A refused input is
   * finished here, with its `done(err)`; null means there is nothing to send.
   */
  admit(message: JournaledMessage, delivery: InputDelivery, outstanding: number): Admitted | null {
    const { store, clock, queue, instanceId, type, log } = this.#deps;
    switch (admit(outstanding, queue)) {
      case "fail":
        this.#refused += 1;
        log(
          "error",
          `queue full: ${String(outstanding)} inputs outstanding (the bound); an input was ` +
            `failed (${String(this.#refused)} so far)`,
        );
        delivery.done(new Error("queue full"));
        return null;
      case "hold":
        if (this.#held.length === 0) {
          log(
            "warn",
            `queue full: ${String(outstanding)} inputs outstanding (the bound); holding ` +
              `further inputs until one finishes`,
          );
        }
        this.#held.push({ message, delivery });
        return null;
      case "send":
        break;
    }
    const id = this.#deps.newId();
    const entry = newEntry({ inputId: id, instanceId, type, message, now: clock.now() });
    try {
      store.put(entry);
    } catch (error) {
      log("error", `input ${id} failed: the journal could not record it: ${String(error)}`);
      delivery.done(new Error(`the journal could not record this input: ${String(error)}`));
      return null;
    }
    return { id, event: entry.event, awaiting: false };
  }

  /**
   * A replayed input (spec 7.2–7.4), under its original id, by the retry rules: re-sent with
   * the entry updated, or given up with `done(err)` and the entry cleared.
   */
  readmit(id: string, delivery: InputDelivery, inFlight: boolean): Admitted | null {
    const { store, clock, log } = this.#deps;
    if (inFlight) {
      log("warn", `ignored a second replay of input ${id}: it is already in flight`);
      delivery.done(new Error(`input ${id} is already in flight`));
      return null;
    }
    const entry = store.get(id);
    if (entry === null) {
      log("warn", `replayed input ${id} has no journal entry any more; nothing to re-send`);
      delivery.done();
      return null;
    }
    const decision = onReplay(entry, clock.now());
    if (decision.kind === "fail") {
      store.clear(id);
      log("error", `input ${id} failed: ${decision.message}`);
      delivery.done(new Error(`${this.#deps.label}: ${decision.message}`));
      return null;
    }
    store.put(decision.entry);
    log("info", `re-sending journaled input ${id}: ${decision.why}`);
    return { id, event: decision.entry.event, awaiting: decision.entry.state === "awaiting" };
  }

  /** The oldest held input, when there is one. */
  nextHeld(): Held | undefined {
    const next = this.#held.shift();
    if (next !== undefined && this.#held.length === 0) {
      this.#deps.log("info", "queue below its bound again; every held input has been sent");
    }
    return next;
  }

  /** Every held input, removed: the crash-loop stop fails them. */
  takeHeld(): Held[] {
    return this.#held.splice(0);
  }

  report(outstanding: number): QueueReport {
    const { instanceId, queue } = this.#deps;
    return {
      instanceId,
      outstanding,
      held: this.#held.length,
      refused: this.#refused,
      bound: queue.bound,
      policy: queue.policy,
    };
  }

  // ── the life of an entry ───────────────────────────────────────────────────────────────

  /**
   * The step presented a view. Whether it is the FIRST presentation is read from the journal
   * before the entry is updated (spec 8.1.2); the deadline is the journaled one.
   */
  presented(
    inputId: string,
    content: ViewContent,
    timeoutMs: number | null,
  ): { first: boolean; deadline: number | null } {
    const { store, clock, log } = this.#deps;
    try {
      const entry = store.get(inputId);
      if (entry === null) {
        return { first: true, deadline: null };
      }
      const updated = presented(entry, content, clock.now(), timeoutMs);
      store.put(updated);
      const first = isFirstPresentation(entry);
      const deadline = updated.deadline ?? null;
      if (deadline !== null) {
        const at = new Date(deadline).toISOString();
        log("info", `view ${inputId} ${first ? "" : "re-"}presented; times out at ${at}`);
      }
      return { first, deadline };
    } catch (error) {
      log("error", `the journal entry of ${inputId} could not be updated: ${String(error)}`);
      return { first: true, deadline: null };
    }
  }

  submitted(inputId: string): void {
    this.#update(inputId, (entry, now) => submitted(entry, now));
  }

  /** `done` or `error`: the entry is cleared (spec 7.1). A failing store is logged. */
  finished(inputId: string): void {
    try {
      this.#deps.store.clear(inputId);
    } catch (error) {
      this.#deps.log(
        "error",
        `the journal entry of ${inputId} could not be cleared: ${String(error)}`,
      );
    }
  }

  /**
   * The instance closes. Its open steps are marked by the close rules (planned or not); a
   * removal drops every entry it has, each logged (spec 6.7); held inputs are journaled for
   * the next start with no attempt used, or dropped and logged on a removal.
   */
  close(reason: CloseReason, open: readonly string[]): void {
    const { store, clock, instanceId, type, log } = this.#deps;
    const now = clock.now();
    const held = this.#held.splice(0);
    try {
      if (reason === "removed") {
        for (const entry of store.forInstance(instanceId)) {
          store.clear(entry.inputId);
          log("warn", `node removed from the flow; journaled input ${entry.inputId} dropped`);
        }
        if (held.length > 0) {
          log("warn", `node removed from the flow; ${String(held.length)} held inputs dropped`);
        }
        return;
      }
      for (const inputId of open) {
        const entry = store.get(inputId);
        const decision = entry === null ? null : onClose(entry, reason, now);
        if (decision?.kind === "keep" && decision.entry !== entry) {
          store.put(decision.entry);
        }
      }
      for (const { message } of held) {
        const inputId = this.#deps.newId();
        store.put(newEntry({ inputId, instanceId, type, message, now, attempts: 0 }));
      }
      if (held.length > 0) {
        log("info", `${String(held.length)} held inputs journaled for the next start`);
      }
    } catch (error) {
      log("error", `the journal could not be updated on close (${reason}): ${String(error)}`);
    }
  }

  // ── replay ─────────────────────────────────────────────────────────────────────────────

  /**
   * Hand every journaled entry of this instance to `redeliver` (Node-RED's `node.receive`), as
   * a fresh message of exactly its journaled fields. Returns how many.
   */
  redeliver(redeliver: (message: JournaledMessage) => void): number {
    const entries = this.#deps.store.forInstance(this.#deps.instanceId);
    for (const entry of entries) {
      const message = { ...journaledMessage(entry.message) };
      this.#replays.set(message, entry.inputId);
      redeliver(message);
    }
    return entries.length;
  }

  /** The input id when `message` is one this instance handed out for replay; once only. */
  claim(message: JournaledMessage): string | undefined {
    const inputId = this.#replays.get(message);
    if (inputId !== undefined) {
      this.#replays.delete(message);
    }
    return inputId;
  }

  #update(inputId: string, change: (entry: JournalEntry, now: number) => JournalEntry): void {
    try {
      const entry = this.#deps.store.get(inputId);
      if (entry !== null) {
        this.#deps.store.put(change(entry, this.#deps.clock.now()));
      }
    } catch (error) {
      this.#deps.log(
        "error",
        `the journal entry of ${inputId} could not be updated: ${String(error)}`,
      );
    }
  }
}
