// The shell's eye on the run records (plan 0022 §I; interaction-design moments 2 to 4): what
// reaches the person while the window is closed.
//
// * The Live badge and the dock badge count the questions waiting for the person, from run
//   records, in every flow, hidden places included (domain/status liveBadgeCount): a hidden
//   place never hides a question, because the records know nothing of places.
// * News: a run that started, finished or failed since the flow was last read. The first read of
//   a flow is only a baseline, so a restart never throws a stack of notifications at the person
//   (the Inbox's P10e rule, for runs).
// * The start notification stops after five good runs (interaction-design "Loops"): once the
//   flow's records hold FIVE_GOOD_RUNS done runs, a start is news no more. The end notification
//   and the questions stay.
//
// What a piece of news says is the shell's (ui/strings.ts); this decides only what is news.

import type { OpResult } from "../domain/channel/messages";
import type { Run, RunState } from "../domain/runs/run";
import { liveBadgeCount } from "../domain/status/status";
import type { Logger } from "../ports/logger";

/** After this many done runs in a flow, a run starting is no longer notified. */
export const FIVE_GOOD_RUNS = 5;
/** How many of a flow's newest runs are compared from one read to the next. */
export const WATCHED_PAGE = 50;
/** At most this many waiting runs are counted per flow (run.list's largest page). */
export const WAITING_PAGE = 200;

/** Something that happened to a run, worth telling the person. */
export type RunNews =
  | {
      readonly kind: "started";
      readonly run: Run;
      /** About how long it takes, from the flow's recent good runs; null with none yet. */
      readonly minutes: number | null;
    }
  | { readonly kind: "done"; readonly run: Run }
  | { readonly kind: "failed"; readonly run: Run };

export interface RunWatchDeps {
  /** The runtime's `run.list`. */
  readonly list: (query: Readonly<Record<string, unknown>>) => Promise<OpResult>;
  /** The runtime's `flow.list`: the flows to read when the runtime (re)starts. */
  readonly flows: () => Promise<OpResult>;
  /** Tell the person: the shell words it and raises the notice. */
  readonly news: (news: RunNews) => void;
  /** The dock or taskbar badge: the questions waiting, everywhere. */
  readonly badge: (count: number) => void;
  readonly logger: Logger;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The runs of a `run.list` answer; null when it was refused. */
function runsOf(answer: OpResult): Run[] | null {
  if (!answer.ok || !isRecord(answer.value) || !Array.isArray(answer.value["runs"])) {
    return null;
  }
  return answer.value["runs"] as Run[];
}

/** A time that crossed a process boundary: a Date, or what one was serialised as. */
const msOf = (value: unknown): number =>
  value instanceof Date ? value.getTime() : new Date(String(value)).getTime();

/** Whole minutes a flow's recent good runs took on average; null with none. */
export function typicalMinutes(runs: readonly Run[]): number | null {
  const took = runs
    .filter((run) => run.state === "done" && run.endedAt !== null)
    .map((run) => msOf(run.endedAt) - msOf(run.startedAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (took.length === 0) {
    return null;
  }
  const average = took.reduce((sum, ms) => sum + ms, 0) / took.length;
  return Math.max(1, Math.round(average / 60_000));
}

export class RunWatch {
  readonly #deps: RunWatchDeps;
  /** Per flow read at least once: each of its newest runs' state, as last read. */
  readonly #known = new Map<string, Map<string, RunState>>();
  /** Per flow: the questions waiting in it. */
  readonly #waiting = new Map<string, number>();
  /** Per flow: the read in progress, so two reads of one flow never interleave. */
  readonly #reading = new Map<string, Promise<void>>();
  readonly #listeners: (() => void)[] = [];
  #count: number | null = null;

  constructor(deps: RunWatchDeps) {
    this.#deps = deps;
  }

  /** The questions waiting for the person, in every flow; 0 before any read. */
  pending(): number {
    return this.#count ?? 0;
  }

  /** Called whenever the count moves. */
  onChange(listener: () => void): void {
    this.#listeners.push(listener);
  }

  /** Read every flow again: the runtime has (re)started. */
  async refreshAll(): Promise<void> {
    const answer = await this.#deps.flows();
    if (!answer.ok || !Array.isArray(answer.value)) {
      return;
    }
    const ids = (answer.value as unknown[])
      .map((flow) => (isRecord(flow) ? flow["id"] : undefined))
      .filter((id): id is string => typeof id === "string" && id !== "");
    // A flow that is gone waits for nothing.
    for (const flowId of [...this.#waiting.keys()]) {
      if (!ids.includes(flowId)) {
        this.#waiting.delete(flowId);
        this.#known.delete(flowId);
      }
    }
    await Promise.all(ids.map((flowId) => this.changed(flowId)));
    this.#recount();
  }

  /** A run of `flowId` changed (the runtime's `runs` signal): read it, then tell what is news. */
  changed(flowId: string): Promise<void> {
    const before = this.#reading.get(flowId) ?? Promise.resolve();
    const next = before.then(() => this.#read(flowId));
    this.#reading.set(flowId, next);
    void next.finally(() => {
      if (this.#reading.get(flowId) === next) {
        this.#reading.delete(flowId);
      }
    });
    return next;
  }

  async #read(flowId: string): Promise<void> {
    const { list, logger } = this.#deps;
    let answers: OpResult[];
    try {
      answers = await Promise.all([
        list({ flowId, limit: WATCHED_PAGE }),
        list({ flowId, state: "waiting", limit: WAITING_PAGE }),
        list({ flowId, state: "done", limit: FIVE_GOOD_RUNS }),
      ]);
    } catch (error) {
      logger.warn(`the runs of flow ${flowId} could not be read: ${String(error)}`);
      return;
    }
    const [newest = null, waiting = null, good = null] = answers.map(runsOf);
    if (newest === null || waiting === null || good === null) {
      return; // the runtime is restarting; its next start reads every flow again
    }
    this.#waiting.set(flowId, liveBadgeCount(waiting));
    this.#tellNews(flowId, newest, good);
    this.#recount();
  }

  #tellNews(flowId: string, newest: readonly Run[], good: readonly Run[]): void {
    const known = this.#known.get(flowId);
    const now = new Map(newest.map((run) => [run.runId, run.state] as const));
    this.#known.set(flowId, known === undefined ? now : new Map([...known, ...now]));
    if (known === undefined) {
      return; // the baseline: nothing that happened before the first read is news
    }
    // Oldest first, so the notifications come in the order the runs did.
    for (const run of [...newest].reverse()) {
      const was = known.get(run.runId);
      if (was === run.state) {
        continue;
      }
      if (run.state === "done") {
        this.#deps.news({ kind: "done", run });
      } else if (run.state === "failed") {
        this.#deps.news({ kind: "failed", run });
      } else if (was === undefined && good.length < FIVE_GOOD_RUNS) {
        this.#deps.news({ kind: "started", run, minutes: typicalMinutes(newest) });
      }
    }
  }

  #recount(): void {
    let count = 0;
    for (const waiting of this.#waiting.values()) {
      count += waiting;
    }
    if (count === this.#count) {
      return;
    }
    this.#count = count;
    this.#deps.badge(count);
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
