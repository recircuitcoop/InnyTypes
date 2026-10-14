// Re-run and delete (plan 0022 §E, risk 3): Run history's ops in the runtime.
//
// * `run.rerun {flowId, runId, from?}` starts a NEW run that says which run it re-runs, and when
//   that one started (its caption). Without `from`, the source event, as the first step of the
//   run it all began with received it, is sent again out of the source instance with a fresh
//   envelope: a new event id, which is the new run's id. With `from`, that step's kept input
//   message is handed to the step again, through the same redeliver the journal replay uses, with
//   its run re-stamped; the earlier steps' results are kept on the new run. The new run's record
//   is written before anything is sent, so the run the source or the step starts is already the
//   re-run.
// * A run that was itself re-run from a step holds only the steps from that one on: its source
//   event, and the inputs of the steps before, are those of the run it re-runs, followed back
//   (`#lineage`) to the run its source started.
// * Refused, with a sentence, when the run is gone, the flow is gone or off, the step (or the
//   source) is no longer in the flow or not running, or the run never reached that step (its
//   input was not kept). Run, with a note on the new run's card, when the step's settings
//   changed since the run it re-runs started. The stored input is judged against the step's
//   declared input on the way in, by the instance's own input handler, as every input is.
// * `run.delete` cancels the run's inputs a node holds now, a question waiting on the person
//   among them, then deletes its snapshots and its records. Anytype is never touched: what a run
//   made there stays.
// * `run.rerunMany` and `run.deleteMany` take at most MAX_MANY runs.
//
// A settings change is seen by comparing each instance's config as Node-RED constructs it with
// the one it had before. That memory is this process's: after a restart, a change made before
// it is not known, and no note is written for it.

import type { CallOp, OpResult } from "../domain/channel/messages";
import type { JournaledMessage } from "../domain/journal/entry";
import type { Run, StepLine } from "../domain/runs/run";
import type { Clock } from "../ports/clock";
import type { FlowEngine, FlowTab } from "../ports/flow-admin";
import type { Logger } from "../ports/logger";
import type { InputMessage, NodeMessage, RerunTarget, RerunTargets } from "../ports/node-process";
import type { RunInputs, RunStore } from "../ports/run-store";
import { GONE_SENTENCE, NO_STEP_SENTENCE } from "./flows";
import type { JournalReplay } from "./journal-replay";
import { RUN_GONE_SENTENCE } from "./runs";

export const RUN_ACTION_OPS = [
  "run.rerun",
  "run.rerunMany",
  "run.delete",
  "run.deleteMany",
] as const;
export type RunActionOp = (typeof RUN_ACTION_OPS)[number];

export function isRunActionOp(op: CallOp): op is RunActionOp {
  return (RUN_ACTION_OPS as readonly string[]).includes(op);
}

/** How many runs one `run.rerunMany` or `run.deleteMany` takes. */
export const MAX_MANY = 100;
/** A re-run of a flow that is switched off (ui/strings.ts words it). */
export const FLOW_OFF_SENTENCE = "Switch this flow on to re-run it.";
/** A re-run from a step the run never reached, or whose input was too large to keep. */
export const NOT_REACHED_SENTENCE = "This run never reached that step.";
/** The note on a re-run whose step's settings changed since the run it re-runs (risk 3). */
export const SETTINGS_CHANGED_NOTE = "This step's settings changed since the run it re-runs.";

export interface RunActionsDeps {
  readonly store: Pick<RunStore, "run" | "started"> & RunInputs;
  readonly engine: Pick<FlowEngine, "getFlow">;
  /** The journal replay: it cancels the inputs of a run its instances hold now. */
  readonly replay: Pick<JournalReplay, "cancelRun">;
  /** Delete the snapshots the runs' steps took; answers how many. */
  readonly deleteSnapshots: (runIds: readonly string[]) => number;
  readonly clock: Clock;
  /** A new event id: the re-run's run id. */
  readonly newId: () => string;
  readonly logger: Logger;
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

/** `runIds`: one to MAX_MANY run ids. */
function runIds(args: Fields): string[] {
  const value = args["runIds"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MANY ||
    !value.every((id): id is string => typeof id === "string" && id !== "")
  ) {
    throw new Refused(`runIds must be 1 to ${String(MAX_MANY)} run ids`);
  }
  return value;
}

/** The instance that emitted a message: the last part of its envelope's `inny://` source. */
export function sourceOf(message: JournaledMessage): string | null {
  const event = isRecord(message.inny) ? message.inny["event"] : undefined;
  const source = isRecord(event) ? event["source"] : undefined;
  if (typeof source !== "string" || !source.startsWith("inny://")) {
    return null;
  }
  return source.slice(source.lastIndexOf("/") + 1) || null;
}

export class RunActions implements RerunTargets {
  readonly #deps: RunActionsDeps;
  readonly #targets = new Map<string, RerunTarget>();
  /** Each instance's config as last constructed, and when it last changed (null: never seen to). */
  readonly #configs = new Map<string, { json: string; changedAt: number | null }>();

  constructor(deps: RunActionsDeps) {
    this.#deps = deps;
  }

  /** An instance was constructed with `config`; the returned function detaches it on close. */
  attach(instanceId: string, config: unknown, target: RerunTarget): () => void {
    const json = JSON.stringify(config);
    const seen = this.#configs.get(instanceId);
    if (seen === undefined) {
      this.#configs.set(instanceId, { json, changedAt: null });
    } else if (seen.json !== json) {
      this.#configs.set(instanceId, { json, changedAt: this.#deps.clock.now() });
    }
    this.#targets.set(instanceId, target);
    return () => {
      if (this.#targets.get(instanceId) === target) {
        this.#targets.delete(instanceId);
      }
    };
  }

  /** Every re-run and delete op; never a rejection. */
  async call(op: RunActionOp, args: unknown): Promise<OpResult> {
    try {
      return { ok: true, value: await this.#answer(op, isRecord(args) ? args : {}) };
    } catch (error) {
      if (error instanceof Refused) {
        this.#deps.logger.info(`${op} refused: ${error.message}`);
        return { ok: false, error: error.message };
      }
      this.#deps.logger.error(`${op} failed: ${String(error)}`);
      return { ok: false, error: `${op} failed: ${(error as Error).message}` };
    }
  }

  async #answer(op: RunActionOp, args: Fields): Promise<unknown> {
    const flowId = text(args, "flowId");
    switch (op) {
      case "run.rerun": {
        const from = args["from"];
        if (from !== undefined && (typeof from !== "string" || from === "")) {
          throw new Refused("from must be a step's id");
        }
        return { runId: await this.#rerun(flowId, text(args, "runId"), from) };
      }
      case "run.rerunMany":
        return { started: await this.#rerunMany(flowId, runIds(args)) };
      case "run.delete":
        return { deleted: this.#delete(flowId, [text(args, "runId")]) };
      case "run.deleteMany":
        return { deleted: this.#delete(flowId, runIds(args)) };
    }
  }

  // ── re-run ─────────────────────────────────────────────────────────────────────────────

  async #rerun(flowId: string, runId: string, from: string | undefined): Promise<string> {
    const { store, clock, newId, logger } = this.#deps;
    const old = store.run(runId);
    if (old?.flowId !== flowId) {
      throw new Refused(RUN_GONE_SENTENCE);
    }
    const flow = await this.#deps.engine.getFlow(flowId);
    if (flow === null) {
      throw new Refused(GONE_SENTENCE);
    }
    if (flow.disabled) {
      throw new Refused(FLOW_OFF_SENTENCE);
    }
    const lineage = this.#lineage(old);
    const rerunId = newId();
    const at = clock.now();
    const start = {
      flowId,
      runId: rerunId,
      title: old.title,
      at,
      rerunOf: runId,
      rerunOfStartedAt: old.startedAt.getTime(),
      ...(old.durationSeconds === null ? {} : { durationSeconds: old.durationSeconds }),
    };
    if (from === undefined) {
      const first = lineage.at(-1) ?? old;
      if (first.rerunFrom !== null) {
        throw new Refused(RUN_GONE_SENTENCE); // the run its source started is no longer kept
      }
      const event = store.keptInputs(first.runId)[0] ?? null;
      if (event === null) {
        throw new Refused(NOT_REACHED_SENTENCE);
      }
      const source = this.#target(flow, sourceOf(event));
      store.started(start);
      source.emit(freshEvent(event, rerunId, at));
      logger.info(`run ${runId} of flow ${flowId} re-run from its source as ${rerunId}`);
      return rerunId;
    }
    const step = this.#target(flow, from);
    // The latest run of the lineage that went through the step holds its input.
    const reached = lineage.find((run) => run.steps.some((each) => each.instanceId === from));
    const index = reached?.steps.findIndex((each) => each.instanceId === from) ?? -1;
    const input = reached === undefined ? null : (store.keptInputs(reached.runId)[index] ?? null);
    if (reached === undefined || input === null) {
      throw new Refused(NOT_REACHED_SENTENCE);
    }
    store.started({
      ...start,
      rerunFrom: from,
      results: keptResults(old, reached, index),
      notes: this.#settingsChanged(from, reached.startedAt.getTime())
        ? [{ step: reached.steps[index]?.name ?? "", text: SETTINGS_CHANGED_NOTE }]
        : [],
    });
    step.redeliver(restamped(input, rerunId));
    logger.info(`run ${runId} of flow ${flowId} re-run from step ${from} as ${rerunId}`);
    return rerunId;
  }

  /** Each run from its source; a refused one is logged and skipped. Refused when none started. */
  async #rerunMany(flowId: string, ids: readonly string[]): Promise<number> {
    let started = 0;
    let first: Refused | null = null;
    for (const runId of ids) {
      try {
        await this.#rerun(flowId, runId, undefined);
        started += 1;
      } catch (error) {
        if (!(error instanceof Refused)) {
          throw error;
        }
        this.#deps.logger.info(`run ${runId} was not re-run: ${error.message}`);
        first ??= error;
      }
    }
    if (started === 0 && first !== null) {
      throw first;
    }
    return started;
  }

  /**
   * The run, then, while the run in hand was re-run from a step, the run it re-runs: back to the
   * run its source started (the last one), or as far as runs are still kept.
   */
  #lineage(run: Run): Run[] {
    const lineage = [run];
    let current = run;
    while (current.rerunFrom !== null && current.rerunOf !== null) {
      const before = this.#deps.store.run(current.rerunOf);
      if (before === null || lineage.some((seen) => seen.runId === before.runId)) {
        break;
      }
      lineage.push(before);
      current = before;
    }
    return lineage;
  }

  /** The running instance a re-run sends to: in the flow, and attached here. */
  #target(flow: FlowTab, instanceId: string | null): RerunTarget {
    const target = instanceId === null ? undefined : this.#targets.get(instanceId);
    if (
      instanceId === null ||
      target === undefined ||
      !flow.nodes.some((node) => node.id === instanceId)
    ) {
      throw new Refused(NO_STEP_SENTENCE);
    }
    return target;
  }

  #settingsChanged(instanceId: string, since: number): boolean {
    const changedAt = this.#configs.get(instanceId)?.changedAt ?? null;
    return changedAt !== null && changedAt > since;
  }

  // ── delete ─────────────────────────────────────────────────────────────────────────────

  #delete(flowId: string, ids: readonly string[]): number {
    const { store, logger } = this.#deps;
    const ours = ids.filter((runId) => store.run(runId)?.flowId === flowId);
    const cancelled = ours.reduce((sum, runId) => sum + this.#deps.replay.cancelRun(runId), 0);
    const snapshots = this.#deps.deleteSnapshots(ours);
    const deleted = store.deleteRuns(flowId, ours);
    logger.info(
      `${String(deleted)} runs of flow ${flowId} deleted: ${String(cancelled)} inputs in hand ` +
        `cancelled, ${String(snapshots)} snapshots deleted; Anytype is not touched`,
    );
    return deleted;
  }
}

/** The source's event again, with a fresh envelope: a new id (the new run's) and time. */
function freshEvent(message: JournaledMessage, runId: string, at: number): NodeMessage {
  const inny = isRecord(message.inny) ? message.inny : {};
  const event = { ...(inny["event"] as NodeMessage["inny"]["event"]), id: runId };
  return {
    payload: message.payload,
    topic: typeof message.topic === "string" ? message.topic : event.type,
    inny: { event: { ...event, time: new Date(at).toISOString() }, run: runId },
  };
}

/** A step's kept input with its run re-stamped; Node-RED gives it a new `_msgid`. */
function restamped(message: JournaledMessage, runId: string): InputMessage {
  const inny = isRecord(message.inny) ? message.inny : {};
  return {
    payload: message.payload,
    ...(message.topic === undefined ? {} : { topic: message.topic }),
    inny: { ...inny, run: runId },
  };
}

/**
 * What a re-run from step `index` of `reached` keeps: the results of `run` but those of that
 * step and the steps after it. `run` holds the results kept before it, when it was a re-run too.
 */
function keptResults(run: Run, reached: Run, index: number): Run["results"] {
  const again = new Set<StepLine["step"]>(reached.steps.slice(index).map((step) => step.name));
  return run.results.filter((result) => !again.has(result.step));
}
