// One row of Configuration › Flows (plan 0022 §D, ux-writing "Configuration › Flows"): what
// `flow.list` answers for a tab. Its name and switch, its health (domain/flows/health.ts) from
// its runs and its steps that are not set up, its last run, its view nodes (the places of its
// board), and its steps in wire order from the sources (the "Re-run from…" menu). Apart from
// application/flows.ts, which owns the writes, to keep each file under its 600 lines.

import { health, type FlowHealth } from "../domain/flows/health";
import { wireOrder, type TabNode } from "../domain/flows/tab";
import { configOf } from "../domain/forms/coerce";
import { secretKeys, withoutSecrets } from "../domain/forms/form-model";
import type { LoadedType } from "../domain/packages/declaration";
import type { Run, RunState } from "../domain/runs/run";
import type { FlowEngine, FlowNodeType, FlowTab } from "../ports/flow-admin";
import type { RunStore } from "../ports/run-store";
import type { SchemaValidator } from "../ports/schema-validator";

/** A health judgement reads at most this many of the flow's runs, newest first. */
export const HEALTH_RUNS = 1_000;
const PAGE = 200;

/** A step of a flow, in wire order: the "Re-run from…" menu, and the "not set up" count. */
export interface FlowStep {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly setUp: boolean;
}

/** A view node of the flow: a place on its board (domain/board ViewNode, with its name). */
export interface FlowViewNode {
  readonly id: string;
  readonly name: string;
  readonly kind: "question" | "result";
}

export interface FlowLastRun {
  readonly runId: string;
  readonly title: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly state: RunState;
}

/** One row of Configuration › Flows. */
export interface FlowSummary {
  readonly id: string;
  readonly name: string;
  readonly on: boolean;
  readonly health: FlowHealth;
  readonly lastRun: FlowLastRun | null;
  readonly viewNodes: readonly FlowViewNode[];
  readonly steps: readonly FlowStep[];
}

/** What a summary reads. */
export interface SummaryDeps {
  readonly engine: Pick<FlowEngine, "secretsSet">;
  readonly runs: Pick<RunStore, "list">;
  /** A node type InnyTypes generated; undefined for Node-RED's own. */
  readonly nodeType: (type: string) => FlowNodeType | undefined;
  readonly validator: SchemaValidator;
}

export async function flowSummary(flow: FlowTab, deps: SummaryDeps): Promise<FlowSummary> {
  const { nodeType } = deps;
  const setUp = new Map<string, boolean>();
  for (const node of [...flow.nodes, ...flow.configs]) {
    const type = nodeType(node.type);
    if (type !== undefined) {
      setUp.set(node.id, await isSetUp(node, type, deps));
    }
  }
  // Node-RED files a node with no position among the tab's config nodes: it is a step all the
  // same, so both lists are ordered.
  const ordered = wireOrder([...flow.nodes, ...flow.configs], (node) => {
    return nodeType(node.type)?.kind === "source";
  });
  const steps = ordered.flatMap((node): FlowStep[] => {
    const type = nodeType(node.type);
    if (type === undefined || type.kind === "source") {
      return [];
    }
    const name = stepName(node, type);
    return [{ id: node.id, name, type: node.type, setUp: setUp.get(node.id) === true }];
  });
  const viewNodes = ordered.flatMap((node): FlowViewNode[] => {
    const type = nodeType(node.type);
    if (type?.kind !== "view") {
      return [];
    }
    const kind = type.view === "action" ? "question" : "result";
    return [{ id: node.id, name: stepName(node, type), kind }];
  });
  const runs = recentRuns(flow.id, deps.runs);
  const latest = runs[0];
  const setups = [...setUp].map(([instanceId, ok]) => ({ instanceId, setUp: ok }));
  return {
    id: flow.id,
    name: flow.label,
    on: !flow.disabled,
    health: health({ id: flow.id }, runs, setups),
    lastRun:
      latest === undefined
        ? null
        : {
            runId: latest.runId,
            title: latest.title,
            startedAt: latest.startedAt,
            endedAt: latest.endedAt,
            state: latest.state,
          },
    viewNodes,
    steps,
  };
}

/**
 * The flow's runs, newest first, as far back as its health needs: until a finished run that
 * did not fail ends the trailing streak of failures, or HEALTH_RUNS.
 */
export function recentRuns(flowId: string, store: Pick<RunStore, "list">): Run[] {
  const runs: Run[] = [];
  let cursor: string | null = null;
  do {
    const page = store.list({ flowId, limit: PAGE, ...(cursor === null ? {} : { cursor }) });
    runs.push(...page.runs);
    if (page.runs.some((run) => run.state === "done")) {
      break;
    }
    cursor = page.next;
  } while (cursor !== null && runs.length < HEALTH_RUNS);
  return runs;
}

/**
 * Whether a step is set up: its config passes its schema, and every required secret is set.
 * The same rules its instance is constructed by (adapters/nodered/registration.ts).
 */
export async function isSetUp(
  node: TabNode,
  type: FlowNodeType,
  deps: Pick<SummaryDeps, "engine" | "validator">,
): Promise<boolean> {
  const config = configOf(type.config, node);
  if (deps.validator.check(withoutSecrets(type.config), config).length > 0) {
    return false;
  }
  // `config` never holds a secret: Node-RED keeps them apart, as credentials.
  const required = requiredSecrets(type);
  if (required.length === 0) {
    return true;
  }
  const set = await deps.engine.secretsSet(node);
  return required.every((key) => set.has(key));
}

/** A generated type, as flow administration reads it. */
export function flowNodeTypeOf(loaded: LoadedType): FlowNodeType {
  const { type, declaration } = loaded;
  return {
    package: declaration.package,
    kind: type.kind,
    ...(type.view === undefined ? {} : { view: type.view }),
    label: type.label,
    config: type.config,
  };
}

/** The step's name: the one given on the canvas, else its type's label. */
export function stepName(node: TabNode, type: FlowNodeType): string {
  const name = node["name"];
  return typeof name === "string" && name.trim() !== "" ? name : type.label;
}

/** The secrets the type's schema requires. */
export function requiredSecrets(type: FlowNodeType): string[] {
  const required = Array.isArray(type.config["required"]) ? type.config["required"] : [];
  return secretKeys(type.config).filter((key) => required.includes(key));
}
