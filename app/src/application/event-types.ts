// The runtime's half of the created event types (spec §9; WI-0018-13): it keeps the store,
// judges each change, and fires the deployed sources.
//
// A change only stores. The node types it adds or removes take effect when the shell restarts
// the runtime for `types` (spec 9.7), which it does on the answer: Node-RED cannot add a type to
// a running runtime. A deletion is judged against the deployed flows AND the editor's nodes
// that are not deployed, which the shell reads from the editor and hands in (P11b).

import {
  deletionRefusal,
  judgeCreate,
  judgeVersion,
  payloadRefusal,
  usageOf,
  userNodeType,
  type EventTypeRecord,
  type FlowNode,
  type Judged,
} from "../domain/events/event-types";
import type { CallOp, OpResult } from "../domain/channel/messages";
import type { Clock } from "../ports/clock";
import type { EventTypeStore } from "../ports/event-type-store";
import type { Logger } from "../ports/logger";
import type { SchemaValidator } from "../ports/schema-validator";

/** The event type calls (spec 10.2): the Events page's, through the shell. */
export type EventOp = Extract<CallOp, `event.${string}`>;

const EVENT_OPS: readonly EventOp[] = [
  "event.list",
  "event.create",
  "event.version",
  "event.delete",
  "event.fire",
];

export const isEventOp = (op: unknown): op is EventOp =>
  typeof op === "string" && (EVENT_OPS as readonly string[]).includes(op);

/** One version as the Events page lists it. */
export interface EventTypeSummary extends EventTypeRecord {
  readonly nodeType: string;
  /** The nodes using it: deployed, and only in the editor. */
  readonly deployed: readonly string[];
  readonly undeployed: readonly string[];
}

/** What a change answers: the type, and the node types it adds or removes on the restart. */
export interface EventTypeChange {
  readonly type: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface EventTypeServiceDeps {
  readonly store: EventTypeStore;
  readonly validator: SchemaValidator;
  /** The nodes of the deployed flows now (Node-RED's documented `flows.getFlows`). */
  readonly deployed: () => Promise<readonly FlowNode[]>;
  readonly clock: Clock;
  readonly logger: Logger;
}

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The editor's nodes as the shell hands them over; none when it sent none. */
export function flowNodesOf(value: unknown): FlowNode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .filter((node) => typeof node["id"] === "string" && typeof node["type"] === "string")
    .map((node) => ({ id: node["id"] as string, type: node["type"] as string }));
}

const refused = (error: string, status?: 409): OpResult =>
  status === undefined ? { ok: false, error } : { ok: false, error, status };

export class EventTypeService {
  readonly #deps: EventTypeServiceDeps;
  /** The deployed created sources, by instance id: their node type, and how to fire them. */
  readonly #sources = new Map<string, { nodeType: string; fire: (data: Fields) => void }>();

  constructor(deps: EventTypeServiceDeps) {
    this.#deps = deps;
  }

  /** A created source's instance, as Node-RED constructs it; the returned function detaches. */
  attachSource(instanceId: string, nodeType: string, fire: (data: Fields) => void): () => void {
    const entry = { nodeType, fire };
    this.#sources.set(instanceId, entry);
    return () => {
      if (this.#sources.get(instanceId) === entry) {
        this.#sources.delete(instanceId);
      }
    };
  }

  /** The payload schema of a created source's type, to check what arrives on its input. */
  checkPayload(schema: Fields, payload: unknown): string | null {
    const problems = this.#deps.validator.check(schema, payload);
    return problems.length === 0 ? null : payloadRefusal(problems);
  }

  async call(op: EventOp, args: unknown): Promise<OpResult> {
    const given = isRecord(args) ? args : {};
    switch (op) {
      case "event.list":
        return { ok: true, value: await this.#list(flowNodesOf(given["editor"])) };
      case "event.create": {
        const { name, label, schema } = given;
        return this.#store(
          judgeCreate(this.#deps.store.list(), { name, label, schema }, this.#now()),
        );
      }
      case "event.version": {
        const { name, label, schema } = given;
        const input = label === undefined ? { name, schema } : { name, schema, label };
        return this.#store(judgeVersion(this.#deps.store.list(), input, this.#now()));
      }
      case "event.delete":
        return this.#delete(given["type"], flowNodesOf(given["editor"]));
      case "event.fire":
        return this.#fire(given["type"], given["values"], given["instance"]);
    }
  }

  #now(): number {
    return this.#deps.clock.now();
  }

  async #list(editor: readonly FlowNode[]): Promise<EventTypeSummary[]> {
    const deployed = await this.#deps.deployed();
    return this.#deps.store.list().map((record) => {
      const nodeType = userNodeType(record.name, record.version);
      return { ...record, nodeType, ...usageOf(nodeType, deployed, editor) };
    });
  }

  #store(judged: Judged): OpResult {
    if (!judged.ok) {
      return refused(judged.error, judged.status);
    }
    const { record } = judged;
    this.#deps.store.add(record);
    const nodeType = userNodeType(record.name, record.version);
    this.#deps.logger.info(`event type ${record.type} created (node type ${nodeType})`);
    const change: EventTypeChange = { type: record.type, added: [nodeType], removed: [] };
    return { ok: true, value: change };
  }

  async #delete(type: unknown, editor: readonly FlowNode[]): Promise<OpResult> {
    const record = this.#deps.store.list().find((stored) => stored.type === type);
    if (record === undefined) {
      return refused(`No event type ${JSON.stringify(type)} exists.`);
    }
    const nodeType = userNodeType(record.name, record.version);
    const refusal = deletionRefusal(
      record.type,
      usageOf(nodeType, await this.#deps.deployed(), editor),
    );
    if (refusal !== null) {
      this.#deps.logger.warn(refusal);
      return refused(refusal, 409);
    }
    this.#deps.store.remove(record.type);
    this.#deps.logger.info(`event type ${record.type} deleted (node type ${nodeType})`);
    const change: EventTypeChange = { type: record.type, added: [], removed: [nodeType] };
    return { ok: true, value: change };
  }

  /** Spec 9.6: validated, then `fire` to every deployed source of the version (or the one). */
  #fire(type: unknown, values: unknown, instance: unknown): OpResult {
    const record = this.#deps.store.list().find((stored) => stored.type === type);
    if (record === undefined) {
      return refused(`No event type ${JSON.stringify(type)} exists.`);
    }
    const refusal = this.checkPayload(record.schema, values);
    if (refusal !== null) {
      return refused(refusal);
    }
    const nodeType = userNodeType(record.name, record.version);
    const targets = [...this.#sources].filter(
      ([id, source]) =>
        source.nodeType === nodeType && (typeof instance !== "string" || instance === id),
    );
    if (targets.length === 0) {
      return refused(`No deployed source emits ${record.type}.`);
    }
    for (const [, source] of targets) {
      source.fire(values as Fields);
    }
    const fired = targets.map(([id]) => id);
    this.#deps.logger.info(`${record.type} fired from ${fired.join(", ")}`);
    return { ok: true, value: { fired } };
  }
}
