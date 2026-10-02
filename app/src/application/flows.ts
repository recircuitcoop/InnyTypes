// Flow administration in the runtime (plan 0022 §D, decision D7): one Node-RED tab is one flow,
// and the runtime owns every write to it, never the page.
//
// * These ops write through Node-RED's documented flow API, past the HTTP routes the deploy
//   guard sits in front of. So every write first asks the SAME DeployGuard `checkDeploy` those
//   routes ask, and is refused while the canvas holds unsaved changes: the shell, which alone can
//   see the editor, says whether it does in `canvasDirty` on every write, and a write without it
//   is refused too.
// * A refusal is an answer, `{refused: {reason, sentence}}`, never a thrown error and never a
//   channel failure; `call` never rejects.
// * A new flow (a duplicate, a template's copy) starts off: a person switches it on, Setup only
//   once its health is Ready (plan 0022 §H). Its nodes get new ids and no credentials, so a step
//   that needs a secret reads "not set up" until it is given one.
// * Every change tells the shell once per turn: the `flows` signal.

import type { CallOp, OpResult } from "../domain/channel/messages";
import { remapIds, withoutCredentials, type TabNode } from "../domain/flows/tab";
import { configOf } from "../domain/forms/coerce";
import { secretKeys, withoutSecrets } from "../domain/forms/form-model";
import type { FieldProblem } from "../domain/packages/declaration";
import type { Clock } from "../ports/clock";
import type {
  FlowEngine,
  FlowMetaStore,
  FlowNodeType,
  FlowTab,
  TemplateSource,
} from "../ports/flow-admin";
import type { Logger } from "../ports/logger";
import type { RequestGuard } from "../ports/request-guard";
import type { RunStore } from "../ports/run-store";
import type { SchemaValidator } from "../ports/schema-validator";
import { flowSummary, requiredSecrets, stepName, type FlowSummary } from "./flow-summary";

export { flowNodeTypeOf, type FlowSummary } from "./flow-summary";

/** The sentence every write is refused with while the canvas has unsaved changes. */
export const DIRTY_SENTENCE = "Save or discard your changes on the canvas first.";
/** A canvas loaded but not readable yet may hold unsaved changes: refused, with this. */
export const LOADING_SENTENCE = "The canvas is still loading; try again in a moment.";
export const GONE_SENTENCE = "This flow no longer exists.";
export const NAME_SENTENCE = "Give the flow a name.";
export const NO_TEMPLATE_SENTENCE = "This template is not available.";
export const NO_STEP_SENTENCE = "This step is no longer in the flow.";
export const NO_FORM_SENTENCE = "This step has no form to fill in.";
/** A flow's name is at most this long. */
export const NAME_MAX = 100;

export const FLOW_OPS = [
  "flow.list",
  "flow.templates",
  "flow.setOn",
  "flow.rename",
  "flow.duplicate",
  "flow.export",
  "flow.delete",
  "flow.fromTemplate",
  "flow.node.form",
  "flow.node.configure",
] as const;

export type FlowOp = (typeof FLOW_OPS)[number];

export function isFlowOp(op: CallOp): op is FlowOp {
  return (FLOW_OPS as readonly string[]).includes(op);
}

export type RefusalReason =
  | "dirty"
  | "loading"
  | "not-installed"
  | "gone"
  | "name"
  | "no-template"
  | "no-step"
  | "no-form"
  | "invalid";

export interface Refusal {
  readonly refused: {
    readonly reason: RefusalReason;
    readonly sentence: string;
    /** `invalid` only: what is wrong, field by field. */
    readonly problems?: readonly FieldProblem[];
  };
}

export interface FlowAdminDeps {
  readonly engine: FlowEngine;
  /** The DeployGuard the HTTP routes use: the same check, for the same writes. */
  readonly guard: Pick<RequestGuard, "checkDeploy">;
  readonly runs: Pick<RunStore, "list" | "deleteFlowRuns">;
  /** Cancel every input of the flow a node holds now (spec 4.1 `cancel`); answers how many. */
  readonly cancelInputs: (flowId: string) => number;
  readonly meta: FlowMetaStore;
  readonly templates: TemplateSource;
  /** A node type InnyTypes generated; undefined for Node-RED's own. */
  readonly nodeType: (type: string) => FlowNodeType | undefined;
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  /** A new Node-RED node id. */
  readonly newId: () => string;
  readonly logger: Logger;
  /** Tells the shell the flows changed: the `flows` message. */
  readonly signal: () => void;
}

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Wrong arguments: a mistake of the caller, answered as a failed call. */
class BadArgs extends Error {}

/** A refusal on the way: answered as `{refused}`. */
class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.refused.sentence);
  }
}

const refuse = (reason: RefusalReason, sentence: string, problems?: FieldProblem[]): never => {
  throw new Refused({
    refused: { reason, sentence, ...(problems === undefined ? {} : { problems }) },
  });
};

function text(args: Fields, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new BadArgs(`${name} is required`);
  }
  return value;
}

/** An optional new flow name: absent, or a name. */
function optionalName(args: Fields): string | null {
  return args["name"] === undefined ? null : checkedName(args["name"]);
}

function checkedName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "" || name.length > NAME_MAX) {
    return refuse("name", NAME_SENTENCE);
  }
  return name;
}

/** `{path, message}` problems as one clause: "space_id is required; count must be >= 1". */
function described(problems: readonly FieldProblem[]): string {
  return problems
    .map(
      (problem) => `${problem.path === "" ? "the form" : problem.path.slice(1)} ${problem.message}`,
    )
    .join("; ");
}

/** What a write deploys, for the guard; and the write itself. */
interface Prepared<T> {
  readonly body: object;
  readonly run: () => Promise<T>;
}

/** The guard's body for a tab: the route `flow`'s `{nodes, configs}`. */
const bodyOf = (nodes: readonly TabNode[], configs: readonly TabNode[]) => ({
  nodes: [...nodes],
  configs: [...configs],
});

export class FlowAdmin {
  readonly #deps: FlowAdminDeps;
  #queued = false;

  constructor(deps: FlowAdminDeps) {
    this.#deps = deps;
  }

  /** The flows changed (a write here, or any deploy): the shell hears it once this turn. */
  changed(): void {
    if (this.#queued) {
      return;
    }
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      this.#deps.signal();
    });
  }

  /** Every `flow.*` op; never a rejection. */
  async call(op: FlowOp, args: unknown): Promise<OpResult> {
    try {
      return { ok: true, value: await this.#answer(op, isRecord(args) ? args : {}) };
    } catch (error) {
      if (error instanceof Refused) {
        this.#deps.logger.info(`${op} refused: ${error.refusal.refused.sentence}`);
        return { ok: true, value: error.refusal };
      }
      if (error instanceof BadArgs) {
        return { ok: false, error: error.message };
      }
      this.#deps.logger.error(`${op} failed: ${String(error)}`);
      return { ok: false, error: `${op} failed: ${(error as Error).message}` };
    }
  }

  async #answer(op: FlowOp, args: Fields): Promise<unknown> {
    switch (op) {
      case "flow.list":
        return this.#list();
      case "flow.templates":
        return this.#deps.templates.index();
      case "flow.export":
        return this.#export(text(args, "id"));
      case "flow.node.form":
        return this.#form(text(args, "flowId"), text(args, "nodeId"));
      case "flow.setOn":
        return this.#setOn(args);
      case "flow.rename":
        return this.#rename(args);
      case "flow.duplicate":
        return this.#duplicate(args);
      case "flow.delete":
        return this.#delete(args);
      case "flow.fromTemplate":
        return this.#fromTemplate(args);
      case "flow.node.configure":
        return this.#configure(args);
    }
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────

  async #flow(id: string): Promise<FlowTab> {
    return (await this.#deps.engine.getFlow(id)) ?? refuse("gone", GONE_SENTENCE);
  }

  async #list(): Promise<FlowSummary[]> {
    const { engine } = this.#deps;
    const summaries: FlowSummary[] = [];
    for (const tab of await engine.tabs()) {
      const flow = await engine.getFlow(tab.id);
      if (flow !== null) {
        summaries.push(await flowSummary(flow, this.#deps));
      }
    }
    return summaries;
  }

  async #export(id: string): Promise<{ name: string; nodes: TabNode[] }> {
    const flow = await this.#flow(id);
    const tab: TabNode = {
      id: flow.id,
      type: "tab",
      label: flow.label,
      disabled: flow.disabled,
      ...(flow.info === undefined ? {} : { info: flow.info }),
      ...(flow.env === undefined ? {} : { env: flow.env }),
    };
    return { name: flow.label, nodes: withoutCredentials([tab, ...flow.nodes, ...flow.configs]) };
  }

  /** `flow.node.form`: the step's config schema, `innytype` annotations left for the caller. */
  async #form(flowId: string, nodeId: string) {
    const flow = await this.#flow(flowId);
    const { node, type } = this.#step(flow, nodeId);
    return {
      flowId,
      nodeId,
      type: node.type,
      package: type.package,
      stepName: stepName(node, type),
      schema: type.config,
      values: configOf(type.config, node),
      secretsSet: [...(await this.#deps.engine.secretsSet(node))].sort(),
    };
  }

  #step(flow: FlowTab, nodeId: string): { node: TabNode; type: FlowNodeType } {
    const node = [...flow.nodes, ...flow.configs].find((each) => each.id === nodeId);
    if (node === undefined) {
      return refuse("no-step", NO_STEP_SENTENCE);
    }
    const type = this.#deps.nodeType(node.type);
    return type === undefined ? refuse("no-form", NO_FORM_SENTENCE) : { node, type };
  }

  // ── writing ────────────────────────────────────────────────────────────────────────────

  /**
   * Every write: refused while the canvas has unsaved changes; then `prepare` reads what the
   * write needs, and the deploy guard checks the body it would deploy; then the write, then the
   * signal.
   */
  async #write<T>(args: Fields, prepare: () => Promise<Prepared<T>>): Promise<T> {
    const dirty = args["canvasDirty"];
    if (typeof dirty !== "boolean") {
      throw new BadArgs("canvasDirty must say whether the canvas has unsaved changes");
    }
    if (dirty) {
      return args["canvasLoading"] === true
        ? refuse("loading", LOADING_SENTENCE)
        : refuse("dirty", DIRTY_SENTENCE);
    }
    const { body, run } = await prepare();
    const answer = await this.#deps.guard.checkDeploy("flow", body);
    if (!answer.ok) {
      return refuse("not-installed", `${answer.body.message}.`);
    }
    const result = await run();
    this.changed();
    return result;
  }

  async #setOn(args: Fields): Promise<{ id: string; on: boolean }> {
    const id = text(args, "id");
    const on = args["on"];
    if (typeof on !== "boolean") {
      throw new BadArgs("on must be true or false");
    }
    return this.#write(args, async () => {
      const flow = await this.#flow(id);
      return {
        body: bodyOf(flow.nodes, flow.configs),
        run: async () => {
          if (flow.disabled !== on) {
            return { id, on }; // already so: nothing to deploy
          }
          await this.#deps.engine.updateFlow(id, { ...flow, disabled: !on });
          this.#deps.logger.info(`flow ${id} switched ${on ? "on" : "off"}`);
          return { id, on };
        },
      };
    });
  }

  async #rename(args: Fields): Promise<{ id: string; name: string }> {
    const id = text(args, "id");
    const name = checkedName(args["name"]);
    return this.#write(args, async () => {
      const flow = await this.#flow(id);
      return {
        body: bodyOf(flow.nodes, flow.configs),
        run: async () => {
          await this.#deps.engine.updateFlow(id, { ...flow, label: name });
          return { id, name };
        },
      };
    });
  }

  /** A copy of the tab, off, with new ids and no credentials (D7). */
  async #duplicate(args: Fields): Promise<{ id: string; name: string }> {
    const id = text(args, "id");
    const requested = optionalName(args);
    return this.#write(args, async () => {
      const flow = await this.#flow(id);
      const remapped = remapIds([...flow.nodes, ...flow.configs], this.#deps.newId);
      const nodes = remapped.slice(0, flow.nodes.length);
      const configs = remapped.slice(flow.nodes.length);
      const name = requested ?? `${flow.label} (copy)`;
      return {
        body: bodyOf(nodes, configs),
        run: async () => {
          const { engine, meta, clock, logger } = this.#deps;
          const newId = await engine.addFlow({
            label: name,
            disabled: true,
            ...(flow.info === undefined ? {} : { info: flow.info }),
            nodes,
            configs,
          });
          meta.set(newId, { template: meta.get(id)?.template ?? null, createdAt: clock.now() });
          logger.info(`flow ${id} duplicated as ${newId}`);
          return { id: newId, name };
        },
      };
    });
  }

  /** A template's tab, added off, with new ids. */
  async #fromTemplate(args: Fields): Promise<{ id: string; name: string }> {
    const templateId = text(args, "templateId");
    const requested = optionalName(args);
    return this.#write(args, () => {
      const { templates } = this.#deps;
      const entry = templates.index().find((template) => template.id === templateId);
      const exported = entry === undefined ? null : templates.nodes(templateId);
      if (entry === undefined || exported === null) {
        return refuse("no-template", NO_TEMPLATE_SENTENCE);
      }
      const info = exported.find((node) => node.type === "tab")?.["info"];
      const nodes = remapIds(
        exported.filter((node) => node.type !== "tab"),
        this.#deps.newId,
      );
      const name = requested ?? entry.name;
      return Promise.resolve({
        body: bodyOf(nodes, []),
        run: async () => {
          const { engine, meta, clock, logger } = this.#deps;
          const id = await engine.addFlow({
            label: name,
            disabled: true,
            ...(typeof info === "string" ? { info } : {}),
            nodes,
            configs: [],
          });
          meta.set(id, { template: templateId, createdAt: clock.now() });
          logger.info(`flow ${id} made from the template ${templateId}`);
          return { id, name };
        },
      });
    });
  }

  /**
   * Delete a flow: the inputs its nodes hold are cancelled, then the tab goes (its instances
   * close as removed, and drop their journal entries), then its runs and its meta. WI-0022-12
   * must hook its board store in here, to delete the flow's layout with its meta. The tab goes
   * before the runs, so no step still in flight records a run of a flow already gone.
   */
  async #delete(args: Fields): Promise<{ id: string; runs: number }> {
    const id = text(args, "id");
    return this.#write(args, async () => {
      await this.#flow(id);
      return {
        // A delete deploys no type: the guard's check is asked all the same, as for every write.
        body: bodyOf([], []),
        run: async () => {
          const { engine, runs, meta, logger } = this.#deps;
          const cancelled = this.#deps.cancelInputs(id);
          await engine.deleteFlow(id);
          const deleted = runs.deleteFlowRuns(id);
          meta.remove(id);
          logger.info(
            `flow ${id} deleted: ${String(cancelled)} inputs in hand cancelled, ` +
              `${String(deleted)} runs deleted`,
          );
          return { id, runs: deleted };
        },
      };
    });
  }

  /**
   * `flow.node.configure`: the values checked against the step's schema (ajv, the `innytype`
   * keyword an annotation), then the tab updated and that tab deployed. A secret left empty
   * keeps the one set.
   */
  async #configure(args: Fields): Promise<{ flowId: string; nodeId: string }> {
    const flowId = text(args, "flowId");
    const nodeId = text(args, "nodeId");
    const values = args["values"];
    if (!isRecord(values)) {
      throw new BadArgs("values must be an object");
    }
    return this.#write(args, async () => {
      const flow = await this.#flow(flowId);
      const { node, type } = this.#step(flow, nodeId);
      const changed = await this.#configured(node, type, values);
      const swap = (list: readonly TabNode[]) =>
        list.map((each) => (each.id === nodeId ? changed : each));
      const updated: FlowTab = { ...flow, nodes: swap(flow.nodes), configs: swap(flow.configs) };
      return {
        body: bodyOf(updated.nodes, updated.configs),
        run: async () => {
          await this.#deps.engine.updateFlow(flowId, updated);
          this.#deps.logger.info(`step ${nodeId} of flow ${flowId} configured`);
          return { flowId, nodeId };
        },
      };
    });
  }

  /** The node with `values` applied, or the refusal naming what is wrong. */
  async #configured(node: TabNode, type: FlowNodeType, values: Fields): Promise<TabNode> {
    const secrets = new Set(secretKeys(type.config));
    const plainSchema = withoutSecrets(type.config);
    const declared = Object.keys(
      isRecord(plainSchema["properties"]) ? plainSchema["properties"] : {},
    );
    const plain = Object.fromEntries(
      declared.filter((key) => key in values).map((key) => [key, values[key]]),
    );
    const given = Object.fromEntries(
      [...secrets].flatMap((key) => {
        const value = values[key];
        return typeof value === "string" && value !== "" ? [[key, value]] : [];
      }),
    );
    const problems = [...this.#deps.validator.check(plainSchema, plain)];
    const unset = requiredSecrets(type).filter((key) => !(key in given));
    if (unset.length > 0) {
      const set = await this.#deps.engine.secretsSet(node);
      for (const key of unset.filter((each) => !set.has(each))) {
        problems.push({ path: `/${key}`, message: "is required" });
      }
    }
    if (problems.length > 0) {
      return refuse(
        "invalid",
        `${stepName(node, type)} isn't set up yet: ${described(problems)}.`,
        problems,
      );
    }
    // The declared values replace the old ones; one the form left out is cleared.
    const kept = Object.fromEntries(
      Object.entries(node).filter(([key]) => !declared.includes(key)),
    );
    return {
      ...kept,
      ...plain,
      ...(Object.keys(given).length === 0 ? {} : { credentials: given }),
    } as TabNode;
  }
}
