// The flow administration's Node-RED (plan 0022 §D, decision D7): one tab is one flow, read and
// written through the documented `RED.runtime.flows.getFlow/addFlow/updateFlow/deleteFlow` only,
// never the internal `RED.nodes` (arch_pivot P9–P10 §2; the lint rule in app/eslint-rules/).
//
// These calls deploy, past the admin API's HTTP routes: application/flows.ts asks the deploy
// guard first. `updateFlow` deploys with Node-RED's "flows" type, which restarts only the flows
// that changed: the one tab.

import RED from "node-red";
import type { TabNode } from "../../domain/flows/tab";
import type { FlowEngine, FlowTab, FlowTabSummary, NewFlowTab } from "../../ports/flow-admin";

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The nodes of a list Node-RED handed over: each with an id and a type. */
function nodesOf(value: unknown): TabNode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (node): node is TabNode =>
      isRecord(node) && typeof node["id"] === "string" && typeof node["type"] === "string",
  );
}

/** Node-RED's not-found, as its runtime API rejects with it. */
const notFound = (error: unknown): boolean =>
  isRecord(error) && (error["code"] === "not_found" || error["status"] === 404);

/** A tab's label; a tab with none is called by its id, as the editor does. */
const labelOf = (label: unknown, id: string): string =>
  typeof label === "string" && label !== "" ? label : id;

export class NodeRedFlows implements FlowEngine {
  async tabs(): Promise<readonly FlowTabSummary[]> {
    const { flows } = await RED.runtime.flows.getFlows({});
    return nodesOf(flows)
      .filter((node) => node.type === "tab")
      .map((tab) => ({
        id: tab.id,
        label: labelOf(tab["label"], tab.id),
        disabled: tab["disabled"] === true,
      }));
  }

  async getFlow(id: string): Promise<FlowTab | null> {
    let flow: Fields;
    try {
      flow = await RED.runtime.flows.getFlow({ id });
    } catch (error) {
      if (notFound(error)) {
        return null;
      }
      throw error;
    }
    const { label, disabled, info, env } = flow;
    return {
      id,
      label: labelOf(label, id),
      disabled: disabled === true,
      ...(typeof info === "string" ? { info } : {}),
      ...(Array.isArray(env) ? { env } : {}),
      nodes: nodesOf(flow["nodes"]),
      configs: nodesOf(flow["configs"]),
    };
  }

  addFlow(flow: NewFlowTab): Promise<string> {
    // Node-RED's addFlow sets the nodes' `z` to the id it makes, on the objects it is given.
    return RED.runtime.flows.addFlow({
      flow: {
        label: flow.label,
        disabled: flow.disabled,
        ...(flow.info === undefined ? {} : { info: flow.info }),
        nodes: flow.nodes.map((node) => ({ ...node })),
        configs: flow.configs.map((node) => ({ ...node })),
      },
    });
  }

  async updateFlow(id: string, flow: FlowTab): Promise<void> {
    await RED.runtime.flows.updateFlow({
      id,
      flow: {
        label: flow.label,
        disabled: flow.disabled,
        ...(flow.info === undefined ? {} : { info: flow.info }),
        ...(flow.env === undefined ? {} : { env: [...flow.env] }),
        nodes: flow.nodes.map((node) => ({ ...node })),
        configs: flow.configs.map((node) => ({ ...node })),
      },
    });
  }

  async deleteFlow(id: string): Promise<void> {
    await RED.runtime.flows.deleteFlow({ id });
  }

  async secretsSet(node: TabNode): Promise<ReadonlySet<string>> {
    const shown = await RED.runtime.flows.getNodeCredentials({ id: node.id, type: node.type });
    return new Set(
      Object.entries(shown).flatMap(([key, value]) =>
        key.startsWith("has_") && value === true ? [key.slice("has_".length)] : [],
      ),
    );
  }
}
