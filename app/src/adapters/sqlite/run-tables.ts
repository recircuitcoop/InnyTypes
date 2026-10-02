// The run records' tables in `journal.sqlite` (plan 0022 §C, decision D15): `runs`, `run_steps`
// and `run_lines`, read back into domain Runs and written from them.
//
// What is stored is the FOLDED state, not the fold's inputs. Each change loads the run from its
// rows, applies the new events with domain/runs/run.ts `applyEvent` (or `fold` for a new run),
// and writes back what changed: the run's row, each step that changed, the lines that were
// added. So the domain's rules are the only rules, and a read is one query per table with no
// replay. Steps and lines are only ever appended by the fold, which is what makes the diff a
// plain comparison by position.
//
// An event the fold refuses (RunTransitionError: a step answering a view that is not waiting,
// a step of a run that never started) leaves the run as it was and is reported through
// `problem`; it never fails the journal write it came with. A SQL failure does fail it: the
// caller's transaction rolls both back (adapters/sqlite/journal.ts).
//
// A limitation, on purpose: a run is stored by its run id ALONE, though the domain keys it by
// `{flowId, runId}`. Decision D7 makes that one key: a run belongs to the tab of the source that
// emitted its event, and one event has one source, so it cannot be two runs in two flows. Were
// that ever to change (an event entering a second tab through a link node as a run of that tab),
// `runs` would need `(flow_id, run_id)` as its key, and `run_steps` and `run_lines` a flow column.
//
// Steps are addressed by their input id (`run_steps.input_id`), which every step event carries:
// two inputs of one run open at one instance are two steps, and each status, `done` and failure
// reaches its own.
//
// No I/O here beyond the statements; the caller owns the transaction.

import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { JournalEntry } from "../../domain/journal/entry";
import {
  applyEvent,
  fold,
  isFinished,
  RunTransitionError,
  type ResultLine,
  type Run,
  type RunEvent,
  type RunKey,
  type StepLine,
} from "../../domain/runs/run";
import { stepDoneEvent, stepStatusEvent, type StepStatus } from "../../domain/runs/step-report";
import type { RunChange } from "../../ports/journal-store";
import type { RunPage, RunQuery, RunStart } from "../../ports/run-store";
import {
  cursorOf,
  date,
  flag,
  keptMessage,
  likeAnywhere,
  msOrNull,
  parseCursor,
  runOf,
  type LineRow,
  type RunRow,
  type StepRow,
} from "./run-rows";

/** A run as its rows hold it, with each step's input id beside it, by position. */
interface Stored {
  readonly run: Run;
  readonly inputIds: readonly string[];
}

/** A step a change appends: its input id, and its message as kept for re-runs. */
interface Appended {
  readonly inputId: string;
  readonly message: string | null;
}

export class RunTables {
  readonly #db: DatabaseSync;
  readonly #problem: (message: string) => void;
  readonly #run: StatementSync;
  readonly #steps: StatementSync;
  readonly #lines: StatementSync;
  readonly #upsertRun: StatementSync;
  readonly #insertStep: StatementSync;
  readonly #updateStep: StatementSync;
  readonly #insertLine: StatementSync;
  readonly #stepRun: StatementSync;
  readonly #phase: StatementSync;
  readonly #idle: StatementSync;
  readonly #clearedAt: StatementSync;

  constructor(db: DatabaseSync, problem: (message: string) => void) {
    this.#db = db;
    this.#problem = problem;
    this.#run = db.prepare("SELECT * FROM runs WHERE run_id = ?");
    this.#steps = db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq");
    this.#lines = db.prepare("SELECT * FROM run_lines WHERE run_id = ? ORDER BY seq");
    this.#upsertRun = db.prepare(
      "INSERT INTO runs (run_id, flow_id, title, duration_s, state, started_at, ended_at, " +
        "resumed, copy_text, copied, failure_step, failure_instance, failure_text, rerun_of, " +
        "rerun_from, cleared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (run_id) DO UPDATE SET flow_id = excluded.flow_id, title = excluded.title, " +
        "duration_s = excluded.duration_s, state = excluded.state, " +
        "started_at = excluded.started_at, ended_at = excluded.ended_at, " +
        "resumed = excluded.resumed, copy_text = excluded.copy_text, copied = excluded.copied, " +
        "failure_step = excluded.failure_step, failure_instance = excluded.failure_instance, " +
        "failure_text = excluded.failure_text, rerun_of = excluded.rerun_of, " +
        "rerun_from = excluded.rerun_from, cleared = excluded.cleared",
    );
    this.#insertStep = db.prepare(
      "INSERT INTO run_steps (input_id, run_id, seq, instance_id, label, started_at, ended_at, " +
        "state, status_text, progress_done, progress_total, eta_s, question, message) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#updateStep = db.prepare(
      "UPDATE run_steps SET label = ?, ended_at = ?, state = ?, status_text = ?, " +
        "progress_done = ?, progress_total = ?, eta_s = ?, question = ? WHERE input_id = ?",
    );
    this.#insertLine = db.prepare(
      "INSERT INTO run_lines (run_id, seq, kind, sink, step, text, space_id, object_id, folder, " +
        "due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#stepRun = db.prepare("SELECT run_id FROM run_steps WHERE input_id = ?");
    this.#phase = db.prepare("UPDATE run_steps SET phase = ? WHERE input_id = ?");
    this.#clearedAt = db.prepare("UPDATE runs SET cleared_at = ? WHERE run_id = ?");
    this.#idle = db.prepare(
      "SELECT run_id, flow_id FROM runs AS r WHERE state = 'running' AND NOT EXISTS " +
        "(SELECT 1 FROM run_steps AS s WHERE s.run_id = r.run_id AND s.ended_at IS NULL)",
    );
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────

  load(runId: string): Stored | null {
    const row = this.#run.get(runId) as RunRow | undefined;
    if (row === undefined) {
      return null;
    }
    const steps = this.#steps.all(runId) as unknown as StepRow[];
    const lines = this.#lines.all(runId) as unknown as LineRow[];
    const run = runOf(row, steps, lines);
    return { run, inputIds: steps.map((step) => step.input_id) };
  }

  list(query: RunQuery): RunPage {
    const where = ["flow_id = ?"];
    const params: (string | number)[] = [query.flowId];
    if (query.state !== undefined) {
      where.push("state = ?");
      params.push(query.state);
    }
    if (query.since !== undefined) {
      where.push("started_at >= ?");
      params.push(query.since);
    }
    if (query.search !== undefined && query.search.trim() !== "") {
      const like = likeAnywhere(query.search.trim());
      where.push(
        "(title LIKE ? ESCAPE '\\' OR failure_text LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM " +
          "run_steps AS s WHERE s.run_id = runs.run_id AND s.label LIKE ? ESCAPE '\\') OR EXISTS " +
          "(SELECT 1 FROM run_lines AS l WHERE l.run_id = runs.run_id AND l.text LIKE ? " +
          "ESCAPE '\\'))",
      );
      params.push(like, like, like, like);
    }
    if (query.cursor !== undefined) {
      const after = parseCursor(query.cursor);
      where.push("(started_at < ? OR (started_at = ? AND run_id < ?))");
      params.push(after.startedAt, after.startedAt, after.runId);
    }
    // One more than asked: whether there is a next page, without a count.
    const rows = this.#db
      .prepare(
        `SELECT run_id FROM runs WHERE ${where.join(" AND ")} ` +
          "ORDER BY started_at DESC, run_id DESC LIMIT ?",
      )
      .all(...params, query.limit + 1) as { run_id: string }[];
    const runs = rows
      .slice(0, query.limit)
      .map((row) => this.load(row.run_id)?.run)
      .filter((run): run is Run => run !== undefined);
    const last = runs.at(-1);
    return { runs, next: rows.length > query.limit && last !== undefined ? cursorOf(last) : null };
  }

  idle(): RunKey[] {
    return (this.#idle.all() as { run_id: string; flow_id: string }[]).map((row) => ({
      flowId: row.flow_id,
      runId: row.run_id,
    }));
  }

  // ── changing ───────────────────────────────────────────────────────────────────────────

  /** A journal write's change to its step's run. The run's key when it changed. */
  journalChange(entry: JournalEntry, change: RunChange): RunKey | null {
    // An input that came with no run (a Node-RED inject feeding a node) is a run of its own.
    const runId = entry.event.run ?? entry.inputId;
    const stored = this.load(runId);
    const key: RunKey = { flowId: stored?.run.flowId ?? entry.flowId ?? "", runId };
    const at = date(change.at);
    const events: RunEvent[] = [];
    const appended: Appended[] = [];
    if (stored === null) {
      if (change.kind !== "journaled" && change.kind !== "resent") {
        this.#problem(`run ${runId} has no record; its step ${entry.inputId} changed unrecorded`);
        return null;
      }
      events.push({ ...key, kind: "started", title: entry.event.type, at: date(entry.createdAt) });
    }
    // Every step event names its input: two inputs of one instance are two steps.
    const step = { instanceId: entry.instanceId, inputId: entry.inputId };
    switch (change.kind) {
      case "journaled":
        events.push({ ...key, ...step, kind: "stepStarted", name: change.name, at });
        appended.push({ inputId: entry.inputId, message: keptMessage(entry) });
        break;
      case "resent":
        return this.#resent(stored, key, entry, change.name, at);
      case "presented":
        events.push({ ...key, ...step, kind: "presented", question: change.question, at });
        break;
      case "submitted":
        events.push({ ...key, ...step, kind: "submitted", at });
        break;
      case "done":
        events.push({
          ...stepDoneEvent(key, step.instanceId, at, change.outcome),
          inputId: step.inputId,
        } as RunEvent);
        break;
      case "failed":
        events.push({ ...key, ...step, kind: "stepFailed", text: change.reason, at });
        break;
    }
    return this.#apply(stored, events, appended);
  }

  /**
   * A replayed entry re-sent: the run is resumed. An entry journaled before 0.3.0 gave its run
   * no flow and its step no name; the identity that re-sends it fills them in.
   */
  #resent(
    found: Stored | null,
    key: RunKey,
    entry: JournalEntry,
    name: string,
    at: Date,
  ): RunKey | null {
    let stored = found;
    const events: RunEvent[] = [];
    const appended: Appended[] = [];
    if (stored === null) {
      events.push({ ...key, kind: "started", title: entry.event.type, at: date(entry.createdAt) });
    } else {
      stored = this.#fillBlanks(stored, entry, name);
    }
    const flowKey: RunKey = { flowId: stored?.run.flowId ?? key.flowId, runId: key.runId };
    if (stored?.inputIds.includes(entry.inputId) !== true) {
      const { instanceId, inputId } = entry;
      events.push({ ...flowKey, kind: "stepStarted", instanceId, inputId, name, at });
      appended.push({ inputId: entry.inputId, message: keptMessage(entry) });
    }
    const finished = stored !== null && isFinished(stored.run.state);
    if (!finished) {
      events.push({ ...flowKey, kind: "resumed", at });
    }
    return this.#apply(stored, events, appended, stored !== found, found);
  }

  #fillBlanks(stored: Stored, entry: JournalEntry, name: string): Stored {
    const flowId =
      stored.run.flowId === "" && entry.flowId !== undefined ? entry.flowId : stored.run.flowId;
    const index = stored.inputIds.indexOf(entry.inputId);
    const steps = stored.run.steps.map((step, n) =>
      n === index && step.name === "" ? { ...step, name } : step,
    );
    return { inputIds: stored.inputIds, run: { ...stored.run, flowId, steps } };
  }

  /** A source started a run; one that exists already is left as it is. */
  started(start: RunStart): RunKey | null {
    if (this.load(start.runId) !== null) {
      return null;
    }
    const event: RunEvent = {
      flowId: start.flowId,
      runId: start.runId,
      kind: "started",
      title: start.title,
      at: date(start.at),
      ...(start.durationSeconds === undefined ? {} : { durationSeconds: start.durationSeconds }),
    };
    return this.#apply(null, [event], []);
  }

  /**
   * A `status` with `in` for `inputId`'s step. A status for a step with no record, or one that
   * has ended (a status written late, after its `done`), is the badge's only, as before 2.1.
   */
  stepStatus(inputId: string, status: StepStatus, at: number): RunKey | null {
    const row = this.#stepRun.get(inputId) as { run_id: string } | undefined;
    const stored = row === undefined ? null : this.load(row.run_id);
    const index = stored?.inputIds.indexOf(inputId) ?? -1;
    const step = stored?.run.steps[index];
    if (stored === null || step === undefined || step.endedAt !== null) {
      return null;
    }
    if (status.phase !== undefined) {
      this.#phase.run(status.phase, inputId);
    }
    const event = { ...stepStatusEvent(stored.run, step.instanceId, date(at), status), inputId };
    return this.#apply(stored, [event], []);
  }

  settle(runId: string, at: number): RunKey | null {
    const stored = this.load(runId);
    if (
      stored === null ||
      stored.run.state !== "running" ||
      stored.run.steps.some((step) => step.endedAt === null)
    ) {
      return null;
    }
    return this.#apply(stored, [{ ...stored.run, kind: "finished", at: date(at) }], []);
  }

  /** "Clear done" (`cleared` true) or its undo, on one run; its key when it changed. */
  setCleared(runId: string, cleared: boolean, at: number): RunKey | null {
    const stored = this.load(runId);
    if (stored === null) {
      return null;
    }
    const key = { flowId: stored.run.flowId, runId };
    const changed = this.#apply(stored, [{ ...key, kind: "cleared", cleared, at: date(at) }], []);
    if (changed !== null) {
      this.#clearedAt.run(cleared ? at : null, runId);
    }
    return changed;
  }

  /**
   * Folds `events` onto the stored run (or a new one) and writes what changed. A run the events
   * left as it was (late activity of a finished run) is not written, unless `rewrite`. The rows
   * are compared with `rows`: the run as stored, before any blank was filled in.
   */
  #apply(
    stored: Stored | null,
    events: readonly RunEvent[],
    appended: Appended[],
    rewrite = false,
    rows: Stored | null = stored,
  ): RunKey | null {
    let run: Run | null = stored?.run ?? null;
    try {
      for (const event of events) {
        if (run !== null) {
          this.#lateActivity(run, event);
        }
        run = run === null ? fold([event]) : applyEvent(run, event);
      }
    } catch (error) {
      if (!(error instanceof RunTransitionError)) {
        throw error;
      }
      const runId = events[0]?.runId ?? "?";
      this.#problem(`run ${runId} kept as it was: ${error.message}`);
      return null;
    }
    if (run === null || (run === stored?.run && !rewrite)) {
      return null;
    }
    this.#write(run, rows, appended);
    return { flowId: run.flowId, runId: run.runId };
  }

  /**
   * Activity on a finished run is never silent: a step starting on a done run reopens it, and
   * anything else is ignored by the fold; either way it is said.
   */
  #lateActivity(run: Run, event: RunEvent): void {
    const own = event.kind === "cleared" || event.kind === "finished" || event.kind === "resumed";
    if (!isFinished(run.state) || own) {
      return;
    }
    const step = "instanceId" in event ? (event.inputId ?? event.instanceId) : "of the source";
    if (run.state === "done" && event.kind === "stepStarted") {
      this.#problem(`run ${run.runId} was done; step ${step} started, and reopened it`);
      return;
    }
    this.#problem(`run ${run.runId} is ${run.state}; late ${event.kind} of step ${step} ignored`);
  }

  #write(run: Run, before: Stored | null, appended: readonly Appended[]): void {
    this.#upsertRun.run(
      run.runId,
      run.flowId,
      run.title,
      run.durationSeconds,
      run.state,
      run.startedAt.getTime(),
      msOrNull(run.endedAt),
      flag(run.resumed),
      run.copyText,
      flag(run.copied),
      run.failure?.step ?? null,
      run.failure?.instanceId ?? null,
      run.failure?.text ?? null,
      run.rerunOf,
      run.rerunFrom,
      flag(run.cleared),
    );
    const old = before?.run;
    const known = before?.inputIds ?? [];
    run.steps.forEach((step, index) => {
      const inputId = known[index];
      if (inputId !== undefined) {
        if (step !== old?.steps[index]) {
          this.#updateStep.run(
            step.name,
            msOrNull(step.endedAt),
            step.state,
            step.statusText,
            step.progress?.done ?? null,
            step.progress?.total ?? null,
            step.etaSeconds,
            step.question,
            inputId,
          );
        }
        return;
      }
      const added = appended[index - known.length];
      if (added === undefined) {
        throw new Error(`run ${run.runId} gained a step no journal entry started`);
      }
      this.#insertStep.run(
        added.inputId,
        run.runId,
        index,
        step.instanceId,
        step.name,
        step.startedAt.getTime(),
        msOrNull(step.endedAt),
        step.state,
        step.statusText,
        step.progress?.done ?? null,
        step.progress?.total ?? null,
        step.etaSeconds,
        step.question,
        added.message,
      );
    });
    this.#appendLines(run, old);
  }

  /** The notes, warnings and results the change added, after those already stored. */
  #appendLines(run: Run, old: Run | undefined): void {
    let seq = (old?.notes.length ?? 0) + (old?.warnings.length ?? 0) + (old?.results.length ?? 0);
    const insert = (kind: string, line: StepLine, result?: ResultLine): void => {
      this.#insertLine.run(
        run.runId,
        seq,
        kind,
        result?.sink ?? null,
        line.step,
        line.text,
        result?.anytype?.spaceId ?? null,
        result?.anytype?.objectId ?? null,
        result?.folder ?? null,
        result?.due ?? null,
      );
      seq += 1;
    };
    for (const note of run.notes.slice(old?.notes.length ?? 0)) {
      insert("note", note);
    }
    for (const warning of run.warnings.slice(old?.warnings.length ?? 0)) {
      insert("warning", warning);
    }
    for (const result of run.results.slice(old?.results.length ?? 0)) {
      insert("result", result, result);
    }
  }
}
