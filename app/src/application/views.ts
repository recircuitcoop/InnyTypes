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

import type { CallOp, ChildMessage, OpResult } from "../domain/channel/messages";
import {
  judgeActions,
  NOT_RUNNING,
  REFUSED_STATUS,
  refusalOf,
  titleOf,
  type DeployedView,
} from "../domain/views/views";
import type { Clock } from "../ports/clock";
import type { JournalStore } from "../ports/journal-store";
import type { Logger } from "../ports/logger";
import type { SnapshotStore } from "../ports/snapshot-store";
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
  /** Post to the shell. */
  readonly raise: (event: ViewEvent) => void;
}

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

  presented({ inputId, instanceId, content, first }: Presented): void {
    const window = this.#live.get(instanceId)?.window ?? "inline";
    this.#deps.logger.info(
      `view ${inputId} of instance ${instanceId} ${first ? "presented" : "re-presented"} ` +
        `(${first ? "first" : "quietly, waiting in the Inbox"})`,
    );
    this.#deps.raise({ v: 1, t: "present", id: inputId, window, first, title: titleOf(content) });
    this.changed();
  }

  snapshot({ instanceId, content, state }: Snapshotted): void {
    const { snapshots, clock, newId, logger } = this.#deps;
    const live = this.#live.get(instanceId);
    if (live === undefined) {
      logger.error(`a snapshot from instance ${instanceId}, which is not in the flow, was dropped`);
      return;
    }
    const record = {
      id: newId(),
      instanceId,
      type: live.type,
      label: live.label,
      time: clock.now(),
      content,
      state,
      window: live.window,
      actions: live.actions,
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
      window: live?.window ?? "inline",
    });
  }

  /** The Inbox (WI-0018-11): every view waiting on the person, oldest first. */
  #pendingViews(): { id: string; title: string; window: "inline" | "popout" }[] {
    return this.#deps.journal
      .all()
      .filter((entry) => entry.state === "awaiting" && entry.content !== null)
      .map((entry) => ({
        id: entry.inputId,
        title: titleOf(entry.content ?? {}),
        window: this.#live.get(entry.instanceId)?.window ?? "inline",
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
    if (live?.node.action(id, values) !== true) {
      return refused(NOT_RUNNING);
    }
    this.#deps.logger.info(
      `view ${id} ${values["__dismiss__"] === true ? "dismissed" : "submitted"} by the person`,
    );
    this.changed();
    return ok(null);
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
