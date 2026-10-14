// The runtime's views (spec §8, plan 0017 Views; WI-0018-10).
//
// An action view makes the flow WAIT for the person: its step is journaled `awaiting` with the
// content it presented, survives restarts, and continues when the person submits (or ends in
// Catch when they dismiss). A snapshot view records what the flow produced; each of its
// actions starts a NEW run from its own output port, whenever it is pressed, for as long as
// the view is in the flow and the port is wired. Otherwise the press is refused with 409 and
// the reason (spec 8.4), never dropped.
//
// This service is told what the view instances do (the Views port, by the Node-RED glue),
// raises `present` and the pending count to the shell, keeps snapshots behind the
// SnapshotStore port, and answers the shell's `view.*` and `snapshot.*` calls (spec 10.2),
// the Inbox's and the Snapshots page's lists among them. Pages and pop-outs are the shell's.
//
// What a view sends back is judged HERE, once for both paths (the pop-out and the app's own
// pages): the bounds, then the type's `answer` schema or the default shape (spec 8.5.7, plan
// 0021 §1-3). A refused answer reaches no node, and the view keeps waiting. A component's
// props are judged here too, at present (spec 8.1.5), and a view's draft is kept here, judged
// by the bounds alone and never sent to the node (spec 8.1.6).

import type { CallOp, ChildMessage, OpResult } from "../domain/channel/messages";
import { drafted } from "../domain/journal/entry";
import type { JsonSchema } from "../domain/packages/declaration";
import {
  boundsProblem,
  defaultShapeProblem,
  isDismissal,
  PROPS_REFUSED,
  propsProblem,
  REFUSED_ANSWER,
  REFUSED_DRAFT,
} from "../domain/views/answers";
import {
  boundedContent,
  judgeActions,
  isWidgetContent,
  NOT_RUNNING,
  presentedWindow,
  REFUSED_STATUS,
  refusalOf,
  SAMPLE_TOO_LARGE,
  titleOf,
  type DeployedView,
} from "../domain/views/views";
import type { Clock } from "../ports/clock";
import type { JournalStore } from "../ports/journal-store";
import type { Logger } from "../ports/logger";
import type { SchemaValidator } from "../ports/schema-validator";
import type { SnapshotStore } from "../ports/snapshot-store";
import type { ViewContent } from "../ports/node-process";
import type { LiveView, Presented, Snapshotted, Views } from "../ports/views";

/** What the runtime raises to the shell about views (spec 10.2). */
export type ViewEvent = Extract<ChildMessage, { t: "present" } | { t: "pending" }>;

export interface ViewServiceDeps {
  readonly journal: JournalStore;
  readonly snapshots: SnapshotStore;
  readonly clock: Clock;
  /** A fresh snapshot id (a UUID in the app). */
  readonly newId: () => string;
  readonly logger: Logger;
  /** Judges an answer against its type's `answer` schema (ajv, compiled once per schema). */
  readonly validator: SchemaValidator;
  /** Post to the shell. */
  readonly raise: (event: ViewEvent) => void;
}

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a dismissal sends the node: the marker, and nothing else the page put beside it. */
const DISMISSAL: Fields = Object.freeze({ __dismiss__: true });

/** How many snapshots the Snapshots page lists. */
export const SNAPSHOT_LIST_LIMIT = 200;

const refused = (error: string): OpResult => ({ ok: false, error });
const ok = (value: unknown): OpResult => ({ ok: true, value });

/** A call's `args`, with the string fields it names and an optional `values` object. */
function argsOf(args: unknown, names: readonly string[]): { [name: string]: string } | string {
  if (!isRecord(args)) {
    return "the call's arguments must be an object";
  }
  const found: Record<string, string> = {};
  for (const name of names) {
    const value = args[name];
    if (typeof value !== "string" || value === "") {
      return `the call's ${name} must be a non-empty string`;
    }
    found[name] = value;
  }
  return found;
}

function valuesOf(args: unknown): Fields | string {
  const values = isRecord(args) ? (args["values"] ?? {}) : {};
  return isRecord(values) ? values : "the call's values must be an object";
}

export class ViewService implements Views {
  readonly #deps: ViewServiceDeps;
  /** The view instances in the deployed flow now, by instance id. */
  readonly #live = new Map<string, LiveView>();
  /** The pending count last raised; null before the first. */
  #pending: number | null = null;

  constructor(deps: ViewServiceDeps) {
    this.#deps = deps;
  }

  // ── the Views port: what the instances do ──────────────────────────────────────────────

  attach(instanceId: string, view: LiveView): () => void {
    this.#live.set(instanceId, view);
    return () => {
      if (this.#live.get(instanceId) === view) {
        this.#live.delete(instanceId);
      }
    };
  }

  propsRefusal(instanceId: string, content: ViewContent): string | null {
    const live = this.#live.get(instanceId);
    const schema = live?.props ?? null;
    const problem = propsProblem(content, (props) =>
      schema === null ? null : this.#schemaProblem("props", schema, props),
    );
    if (problem === null) {
      return null;
    }
    const type = live?.type ?? "a view not in the flow";
    this.#deps.logger.warn(`the props of [${type} ${instanceId}] were refused: ${problem}`);
    return PROPS_REFUSED;
  }

  presented({ inputId, instanceId, content, first }: Presented): void {
    // A widget is drawn only in the pop-up, whatever the instance's window (plan 0021 §8).
    const window = presentedWindow(this.#live.get(instanceId)?.window ?? "inline", content);
    const widget = isWidgetContent(content);
    this.#deps.logger.info(
      `view ${inputId} of instance ${instanceId} ${first ? "presented" : "re-presented"} ` +
        `(${first ? "first" : "quietly, waiting in the Inbox"})`,
    );
    // The run the question belongs to, so its notification's buttons are bound to it.
    const entry = this.#deps.journal.get(inputId);
    const flowId = entry?.flowId ?? "";
    const runId = entry?.event.run ?? "";
    this.#deps.raise({
      v: 1,
      t: "present",
      id: inputId,
      window,
      first,
      title: titleOf(content),
      ...(flowId === "" ? {} : { flowId }),
      ...(runId === "" ? {} : { runId }),
      ...(widget ? { widget } : {}),
    });
    this.changed();
  }

  snapshot({ instanceId, content, state, inputId }: Snapshotted): void {
    const { snapshots, clock, newId, logger, journal } = this.#deps;
    const live = this.#live.get(instanceId);
    if (live === undefined) {
      logger.error(`a snapshot from instance ${instanceId}, which is not in the flow, was dropped`);
      return;
    }
    // An audio item over the bound is refused in place; the snapshot is kept (plan 0020).
    const bounded = boundedContent(content);
    if (bounded.refused > 0) {
      logger.warn(`a snapshot from [${live.type} ${instanceId}]: ${SAMPLE_TOO_LARGE}`);
    }
    const record = {
      id: newId(),
      instanceId,
      type: live.type,
      label: live.label,
      time: clock.now(),
      content: bounded.content,
      state,
      window: live.window,
      actions: live.actions,
      // Its run, as the journal knows the input; an input with no run is a run of its own.
      ...(inputId == null ? {} : { run: journal.get(inputId)?.event.run ?? inputId }),
    };
    try {
      snapshots.put(record);
      logger.info(`snapshot ${record.id} recorded from [${live.type} ${instanceId}]`);
    } catch (error) {
      logger.error(`a snapshot from [${live.type} ${instanceId}] was not kept: ${String(error)}`);
    }
  }

  /** Count the pending views again, and raise the count when it moved. */
  changed(): void {
    let count: number;
    try {
      count = this.#deps.journal.all().filter((entry) => entry.state === "awaiting").length;
    } catch (error) {
      this.#deps.logger.error(`the pending views could not be counted: ${String(error)}`);
      return;
    }
    if (count !== this.#pending) {
      this.#pending = count;
      this.#deps.raise({ v: 1, t: "pending", count });
    }
  }

  // ── the shell's calls (spec 10.2) ──────────────────────────────────────────────────────

  /** Answer one call; a failure is an OpResult, never a rejection. */
  call(op: CallOp, args: unknown): Promise<OpResult> {
    try {
      return Promise.resolve(this.#answer(op, args));
    } catch (error) {
      return Promise.resolve(refused(String(error)));
    }
  }

  #answer(op: CallOp, args: unknown): OpResult {
    switch (op) {
      case "view.get":
        return this.#view(args);
      case "view.submit":
        return this.#submit(args);
      case "view.draft":
        return this.#draft(args);
      case "view.list":
        return ok(this.#pendingViews());
      case "snapshot.get":
        return this.#snapshot(args);
      case "snapshot.action":
        return this.#press(args);
      case "snapshot.list":
        return ok(this.#snapshotList());
      default:
        return refused(`the InnyTypes runtime does not serve ${op}`);
    }
  }

  /** The pending view `id`, or `gone` once it is no longer waiting. */
  #view(args: unknown): OpResult {
    const parsed = argsOf(args, ["id"]);
    if (typeof parsed === "string") {
      return refused(parsed);
    }
    const id = parsed["id"] as string;
    const entry = this.#deps.journal.get(id);
    if (entry?.state !== "awaiting" || entry.content === null) {
      return ok({ kind: "gone", id });
    }
    const live = this.#live.get(entry.instanceId);
    return ok({
      kind: "view",
      id,
      instanceId: entry.instanceId,
      type: entry.type,
      // Only the view's own package may draw it with its web component (spec 8.5).
      package: live?.package ?? null,
      content: entry.content,
      window: presentedWindow(live?.window ?? "inline", entry.content),
      // The person's unfinished answer, for the page to start from (spec 8.1.6).
      draft: entry.draft ?? null,
    });
  }

  /**
   * The Inbox (WI-0018-11): every view waiting on the person, oldest first. A widget is marked,
   * so the Inbox offers it in the pop-up only (plan 0021 §8).
   */
  #pendingViews(): { id: string; title: string; window: "inline" | "popout"; widget?: true }[] {
    return this.#deps.journal
      .all()
      .filter((entry) => entry.state === "awaiting" && entry.content !== null)
      .map((entry) => ({
        id: entry.inputId,
        title: titleOf(entry.content ?? {}),
        window: presentedWindow(
          this.#live.get(entry.instanceId)?.window ?? "inline",
          entry.content,
        ),
        ...(isWidgetContent(entry.content) ? { widget: true as const } : {}),
      }));
  }

  /** The Snapshots page's list: the newest records, newest first. */
  #snapshotList(): object[] {
    return this.#deps.snapshots.list(SNAPSHOT_LIST_LIMIT).map((record) => ({
      id: record.id,
      instanceId: record.instanceId,
      label: record.label,
      title: titleOf(record.content),
      time: record.time,
    }));
  }

  /** Submit or dismiss (`values.__dismiss__ === true`) the pending view `id` (spec 8.2). */
  #submit(args: unknown): OpResult {
    const parsed = argsOf(args, ["id"]);
    const values = valuesOf(args);
    if (typeof parsed === "string" || typeof values === "string") {
      return refused(typeof parsed === "string" ? parsed : (values as string));
    }
    const id = parsed["id"] as string;
    const entry = this.#deps.journal.get(id);
    if (entry?.state !== "awaiting") {
      return refused("This view is no longer waiting.");
    }
    const live = this.#live.get(entry.instanceId);
    if (live === undefined) {
      return refused(NOT_RUNNING);
    }
    // A dismissal is view.submit's alone (spec 8.2.2): only here may it skip the schema, and
    // only its marker reaches the node.
    const dismissal = isDismissal(values);
    const problem = dismissal ? boundsProblem(values) : this.#judge(live, values);
    if (problem !== null) {
      this.#deps.logger.warn(`view ${id} of type ${live.type}: the answer was refused: ${problem}`);
      return refused(REFUSED_ANSWER);
    }
    if (!live.node.action(id, dismissal ? DISMISSAL : values)) {
      return refused(NOT_RUNNING);
    }
    this.#deps.logger.info(`view ${id} ${dismissal ? "dismissed" : "submitted"} by the person`);
    this.changed();
    return ok(null);
  }

  /**
   * Keep the person's unfinished answer to the pending view `id` (spec 8.1.6): judged by the
   * bounds alone, stored with its journal entry in place of the last, never sent to the node.
   */
  #draft(args: unknown): OpResult {
    const parsed = argsOf(args, ["id"]);
    const values = valuesOf(args);
    if (typeof parsed === "string" || typeof values === "string") {
      return refused(typeof parsed === "string" ? parsed : (values as string));
    }
    const id = parsed["id"] as string;
    const entry = this.#deps.journal.get(id);
    if (entry?.state !== "awaiting") {
      return refused("This view is no longer waiting.");
    }
    const problem = boundsProblem(values);
    if (problem !== null) {
      this.#deps.logger.warn(`view ${id} of type ${entry.type}: the draft was refused: ${problem}`);
      return refused(REFUSED_DRAFT);
    }
    this.#deps.journal.put(drafted(entry, values, this.#deps.clock.now()));
    return ok(null);
  }

  /**
   * What is wrong with an answer to `live`, or null: the bounds, then the type's `answer`
   * schema (ajv's first keyword and schema path), or the default shape. A `__dismiss__` key
   * means nothing here: a snapshot press is never a dismissal. The reason names no key and no
   * value of the answer: it is logged.
   */
  #judge(live: LiveView, values: Fields): string | null {
    const outOfBounds = boundsProblem(values);
    if (outOfBounds !== null) {
      return outOfBounds;
    }
    if (live.answer === null) {
      return defaultShapeProblem(values);
    }
    return this.#schemaProblem("answer", live.answer, values);
  }

  /** Where `value` first fails the type's `which` schema, naming nothing of the value; or null. */
  #schemaProblem(which: "answer" | "props", schema: JsonSchema, value: Fields): string | null {
    const failure = this.#deps.validator.firstFailure(schema, value);
    return failure === null
      ? null
      : `the ${which} schema refused it (${failure.keyword} at ${failure.schemaPath})`;
  }

  #deployed(instanceId: string): DeployedView | null {
    const live = this.#live.get(instanceId);
    return live === undefined
      ? null
      : { ports: live.ports, wires: live.wires, running: live.node.pid !== null };
  }

  /** The snapshot `id`, each action judged against the flow as it is NOW (spec 8.4). */
  #snapshot(args: unknown): OpResult {
    const parsed = argsOf(args, ["id"]);
    if (typeof parsed === "string") {
      return refused(parsed);
    }
    const id = parsed["id"] as string;
    const record = this.#deps.snapshots.get(id);
    if (record === null) {
      return ok({ kind: "gone", id });
    }
    const actions = judgeActions(record, this.#deployed(record.instanceId));
    const pkg = this.#live.get(record.instanceId)?.package ?? null;
    return ok({ kind: "snapshot", ...record, package: pkg, actions });
  }

  /** A press: judged again now, then `trigger` to the current process, or 409 and why. */
  #press(args: unknown): OpResult {
    const parsed = argsOf(args, ["id", "action"]);
    const values = valuesOf(args);
    if (typeof parsed === "string" || typeof values === "string") {
      return refused(typeof parsed === "string" ? parsed : (values as string));
    }
    const { id, action: actionId } = parsed as { id: string; action: string };
    const record = this.#deps.snapshots.get(id);
    const action = record?.actions.find((declared) => declared.id === actionId);
    if (record === null || action === undefined) {
      return refused(`There is no action ${JSON.stringify(actionId)} on snapshot ${id}.`);
    }
    const refusal = refusalOf(action, this.#deployed(record.instanceId));
    const live = this.#live.get(record.instanceId);
    const problem = refusal === null && live !== undefined ? this.#judge(live, values) : null;
    if (problem !== null) {
      this.#deps.logger.warn(
        `a press of ${actionId} on snapshot ${id} (type ${record.type}) was refused: ${problem}`,
      );
      return refused(REFUSED_ANSWER);
    }
    const sent =
      refusal === null &&
      live?.node.trigger(action.id, { id: record.id, state: record.state }, values) === true;
    if (!sent) {
      const reason = refusal ?? NOT_RUNNING;
      this.#deps.logger.warn(`a press of ${actionId} on snapshot ${id} was refused: ${reason}`);
      return { ok: false, error: reason, status: REFUSED_STATUS };
    }
    this.#deps.logger.info(`${actionId} on snapshot ${id} pressed: a new run starts`);
    return ok(null);
  }
}
