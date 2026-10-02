// The runs read model's service in the runtime (plan 0022 §C): what Live and Run history ask,
// and what keeps the run records moving between journal writes.
//
// * The journal's own writes record steps in its transaction (ports/journal-store.ts). This
//   service hears the rest: a source starting a run (its emission with no `in`), a step's
//   `status` with `in`, and each committed change, from the store.
// * A run is done when the flow has nothing left to do for it. Nothing says so outright. The
//   criterion: no step of it open, and no instance holding an input of it at its queue bound
//   (HeldInputs, told by adapters/process/input-journal.ts). On top of that, a quiet `settleMs`
//   with no change is a debounce: a step's output reaches the next node a turn after its `done`.
//   What a crash left is settled at start (store `idle`). A run settled too early (a Node-RED
//   delay node between two steps is invisible here) is reopened by its next step: the domain's
//   rule (domain/runs/run.ts), so no step is ever dropped.
// * `runs {flowId}` replaces `jobs`: one signal per flow per turn, raised on every committed
//   journal write as well as on every run change, so the old Jobs page follows its inputs.
// * A step's `status` writes are coalesced: at most one transaction per STATUS_MS, carrying
//   every status since, in order.
// * "Clear done" is a flag, undoable for a minute (decision D8); never a delete.
// * Retention (D8): finished runs older than `runs.retentionDays` (90 by default; null is
//   Forever) are pruned at start and daily. A run in progress is never pruned.

import type { CallOp, OpResult } from "../domain/channel/messages";
import { RUN_STATES, type RunState } from "../domain/runs/run";
import type { StepStatus } from "../domain/runs/step-report";
import type { Cancel, Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { HeldInputs } from "../ports/node-process";
import type { RunQuery, RunStore, StepStatusUpdate } from "../ports/run-store";

export const DEFAULT_RETENTION_DAYS = 90;
/** How long "Clear done" can be undone (decision D8). */
export const UNDO_CLEAR_MS = 60_000;
/** How long a run with no step open waits, with no change, before it is done. */
export const SETTLE_MS = 2_000;
/** At most one `status` transaction per this many milliseconds. */
export const STATUS_MS = 250;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;
/** `run.get` of a run no longer kept, and an undo with nothing to undo (ui/strings.ts words both). */
export const RUN_GONE_SENTENCE = "This run is no longer kept.";
export const NOTHING_TO_UNDO_SENTENCE = "Nothing was cleared in the last minute.";

export type RunOp = "run.list" | "run.get" | "run.clearDone" | "run.undoClear";

export function isRunOp(op: CallOp): op is RunOp {
  return op === "run.list" || op === "run.get" || op === "run.clearDone" || op === "run.undoClear";
}

export interface RunServiceDeps {
  readonly store: RunStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Tells the shell a run of `flowId` changed: the `runs` message. */
  readonly signal: (flowId: string) => void;
  /**
   * The `runs.retentionDays` setting, read at each prune: days, null for Forever, undefined when
   * unset (DEFAULT_RETENTION_DAYS). Throws when unreadable.
   */
  readonly retentionDays: () => number | null | undefined;
  readonly settleMs?: number;
}

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class Refused extends Error {}

function text(args: Fields, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new Refused(`${name} is required`);
  }
  return value;
}

/** `run.list`'s arguments, checked; a wrong one is refused with what is wrong. */
export function listQuery(args: unknown): RunQuery {
  const fields = isRecord(args) ? args : {};
  const { state, since, search, cursor, limit } = fields;
  if (state !== undefined && !RUN_STATES.includes(state as RunState)) {
    throw new Refused(`state must be one of ${RUN_STATES.join(", ")}`);
  }
  if (since !== undefined && (typeof since !== "number" || !Number.isFinite(since))) {
    throw new Refused("since must be a time in milliseconds");
  }
  if (search !== undefined && typeof search !== "string") {
    throw new Refused("search must be text");
  }
  if (cursor !== undefined && typeof cursor !== "string") {
    throw new Refused("cursor must be the next of the page before");
  }
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE)
  ) {
    throw new Refused(`limit must be a whole number from 1 to ${String(MAX_PAGE)}`);
  }
  return {
    flowId: text(fields, "flowId"),
    ...(state === undefined ? {} : { state: state as RunState }),
    ...(since === undefined ? {} : { since }),
    ...(search === undefined ? {} : { search }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: limit ?? DEFAULT_PAGE,
  };
}

/** A run's title: the name the source gave its event, else the event's type. */
export function runTitle(type: string, data: unknown): string {
  if (isRecord(data)) {
    for (const name of ["title", "name", "file"]) {
      const value = data[name];
      if (typeof value === "string" && value.trim() !== "") {
        return name === "file" ? (value.split(/[\\/]/).pop() ?? value) : value;
      }
    }
  }
  return type;
}

/** The recording's length, when the source's event says it. */
export function runDuration(data: unknown): number | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const value = data["durationSeconds"] ?? data["duration_s"];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class RunService implements HeldInputs {
  readonly #deps: RunServiceDeps;
  readonly #settles = new Map<string, Cancel>();
  readonly #flows = new Set<string>();
  /** Inputs held at a queue bound, by run. */
  readonly #held = new Map<string, number>();
  #statuses: StepStatusUpdate[] = [];
  #statusTimer: Cancel | null = null;
  #lastStatusWrite = Number.NEGATIVE_INFINITY;
  #queued = false;
  #prune: Cancel | null = null;

  constructor(deps: RunServiceDeps) {
    this.#deps = deps;
    deps.store.onChange((key) => {
      this.#signal(key.flowId);
      this.#armSettle(key.runId);
    });
    deps.store.onJournalWrite((flowId) => {
      this.#signal(flowId);
    });
  }

  // ── held inputs (ports/node-process.ts HeldInputs) ─────────────────────────────────────

  held(runId: string): void {
    this.#held.set(runId, (this.#held.get(runId) ?? 0) + 1);
  }

  /** A held input went on (journaled, so a change follows) or was dropped: settle again. */
  released(runId: string): void {
    const left = (this.#held.get(runId) ?? 1) - 1;
    if (left > 0) {
      this.#held.set(runId, left);
    } else {
      this.#held.delete(runId);
    }
    this.#armSettle(runId);
  }

  /** At start: settle what a crash left, prune, and prune again every day. */
  start(): void {
    const { store, clock } = this.#deps;
    for (const key of store.idle()) {
      this.#settle(key.runId);
    }
    this.#pruneNow();
    const daily = (): void => {
      this.#prune = clock.after(DAY_MS, () => {
        this.#pruneNow();
        daily();
      });
    };
    daily();
  }

  stop(): void {
    this.#writeStatuses();
    this.#prune?.();
    this.#prune = null;
    for (const cancel of this.#settles.values()) {
      cancel();
    }
    this.#settles.clear();
  }

  // ── from the instances (adapters/nodered/registration.ts RunReports) ──────────────────

  /** A source's emission with no `in`: a new run. */
  emitted(fields: {
    readonly flowId: string;
    readonly runId: string;
    readonly type: string;
    readonly data: unknown;
  }): void {
    const { store, clock, logger } = this.#deps;
    const durationSeconds = runDuration(fields.data);
    try {
      store.started({
        flowId: fields.flowId,
        runId: fields.runId,
        title: runTitle(fields.type, fields.data),
        at: clock.now(),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      });
    } catch (error) {
      logger.error(`run ${fields.runId} could not be recorded: ${String(error)}`);
    }
  }

  /**
   * A `status` with `in`. Written at once when none was written in the last STATUS_MS, else
   * with the others when that window ends. Two in a row for one step with no copy phase are one.
   */
  stepStatus(inputId: string, status: StepStatus): void {
    const { clock } = this.#deps;
    const at = clock.now();
    const last = this.#statuses.at(-1);
    if (
      last?.inputId === inputId &&
      last.status.phase === undefined &&
      status.phase === undefined
    ) {
      this.#statuses[this.#statuses.length - 1] = {
        inputId,
        status: { ...last.status, ...status },
        at,
      };
    } else {
      this.#statuses.push({ inputId, status, at });
    }
    if (this.#statusTimer !== null) {
      return;
    }
    const wait = this.#lastStatusWrite + STATUS_MS - at;
    if (wait <= 0) {
      this.#writeStatuses();
      return;
    }
    this.#statusTimer = clock.after(wait, () => {
      this.#statusTimer = null;
      this.#writeStatuses();
    });
  }

  #writeStatuses(): void {
    this.#statusTimer?.();
    this.#statusTimer = null;
    const updates = this.#statuses;
    if (updates.length === 0) {
      return;
    }
    this.#statuses = [];
    this.#lastStatusWrite = this.#deps.clock.now();
    try {
      this.#deps.store.stepStatuses(updates);
    } catch (error) {
      const which = updates.map((update) => update.inputId).join(", ");
      this.#deps.logger.error(`the status of ${which} could not be recorded: ${String(error)}`);
    }
  }

  // ── the shell's calls ──────────────────────────────────────────────────────────────────

  /** `run.list`, `run.get`, `run.clearDone`, `run.undoClear`; never a rejection. */
  call(op: RunOp, args: unknown): OpResult {
    try {
      return { ok: true, value: this.#answer(op, isRecord(args) ? args : {}) };
    } catch (error) {
      if (error instanceof Refused) {
        return { ok: false, error: error.message };
      }
      this.#deps.logger.error(`${op} failed: ${String(error)}`);
      return { ok: false, error: `${op} failed: ${(error as Error).message}` };
    }
  }

  #answer(op: RunOp, args: Fields): unknown {
    const { store, clock } = this.#deps;
    switch (op) {
      case "run.list":
        return store.list(listQuery(args));
      case "run.get": {
        const run = store.run(text(args, "runId"));
        if (run === null) {
          throw new Refused(RUN_GONE_SENTENCE);
        }
        return run;
      }
      case "run.clearDone":
        return { count: store.clearDone(text(args, "flowId"), clock.now()) };
      case "run.undoClear": {
        const count = store.undoClear(text(args, "flowId"), clock.now() - UNDO_CLEAR_MS);
        if (count === 0) {
          throw new Refused(NOTHING_TO_UNDO_SENTENCE);
        }
        return { count };
      }
    }
  }

  // ── changes ────────────────────────────────────────────────────────────────────────────

  #signal(flowId: string): void {
    this.#flows.add(flowId);
    if (!this.#queued) {
      this.#queued = true;
      queueMicrotask(() => {
        this.#queued = false;
        const flows = [...this.#flows];
        this.#flows.clear();
        for (const flowId of flows) {
          this.#deps.signal(flowId);
        }
      });
    }
  }

  /** Any change starts the wait again: a run settles only after a quiet `settleMs`. */
  #armSettle(runId: string): void {
    this.#settles.get(runId)?.();
    this.#settles.set(
      runId,
      this.#deps.clock.after(this.#deps.settleMs ?? SETTLE_MS, () => {
        this.#settles.delete(runId);
        this.#settle(runId);
      }),
    );
  }

  /** Done only with nothing held for it; the store checks no step of it is open. */
  #settle(runId: string): void {
    if (this.#held.has(runId)) {
      return; // its release arms the wait again
    }
    try {
      this.#deps.store.settle(runId, this.#deps.clock.now());
    } catch (error) {
      this.#deps.logger.error(`run ${runId} could not be settled: ${String(error)}`);
    }
  }

  #pruneNow(): void {
    const { store, clock, logger } = this.#deps;
    let days: number | null;
    try {
      const setting = this.#deps.retentionDays();
      days = setting === undefined ? DEFAULT_RETENTION_DAYS : setting;
    } catch (error) {
      logger.warn(
        `runs.retentionDays could not be read (${String(error)}); keeping ` +
          `${String(DEFAULT_RETENTION_DAYS)} days`,
      );
      days = DEFAULT_RETENTION_DAYS;
    }
    if (days === null) {
      return; // Forever
    }
    try {
      const pruned = store.prune(clock.now() - days * DAY_MS);
      if (pruned > 0) {
        logger.info(`pruned ${String(pruned)} runs that ended over ${String(days)} days ago`);
      }
    } catch (error) {
      logger.error(`runs could not be pruned: ${String(error)}`);
    }
  }
}
