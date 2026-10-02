// Flow administration (plan 0022 §D, decision D7): one Node-RED tab is one flow, and the runtime
// owns every write to it. What application/flows.ts needs of the world:
//
// * FlowEngine: Node-RED's documented `RED.runtime.flows.getFlow/addFlow/updateFlow/deleteFlow`
//   (adapters/nodered/flows.ts), never the internal `RED.nodes`;
// * FlowMetaStore: `flows-meta.json`, which keeps only `{template, createdAt}` per flow. The
//   tab's `disabled` flag is the on/off switch's truth; nothing mirrors it (plan 0022 §C);
// * TemplateSource: `app/templates`, checked at build (tools/templates/check.mjs).

import type { TabNode } from "../domain/flows/tab";
import type { JsonSchema, Kind } from "../domain/packages/declaration";

/** A tab as the flow list needs it. */
export interface FlowTabSummary {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
}

/** One tab whole, as `getFlow` answers it: no node carries its credentials. */
export interface FlowTab extends FlowTabSummary {
  readonly info?: string;
  readonly env?: readonly unknown[];
  readonly nodes: readonly TabNode[];
  /** The config nodes scoped to the tab. */
  readonly configs: readonly TabNode[];
}

/** A tab to add: Node-RED gives it its id, and every node the tab's `z`. */
export interface NewFlowTab {
  readonly label: string;
  readonly disabled: boolean;
  readonly info?: string;
  readonly nodes: readonly TabNode[];
  readonly configs: readonly TabNode[];
}

export interface FlowEngine {
  /** Every tab deployed now, in the order the canvas shows them. */
  tabs(): Promise<readonly FlowTabSummary[]>;
  /** One tab; null when there is none with that id. */
  getFlow(id: string): Promise<FlowTab | null>;
  /** Add a tab and deploy it; answers its new id. */
  addFlow(flow: NewFlowTab): Promise<string>;
  /**
   * Replace a tab and deploy that tab only. A node may carry `credentials` to set; a node
   * without keeps the ones it has.
   */
  updateFlow(id: string, flow: FlowTab): Promise<void>;
  /** Remove a tab and every node on it. */
  deleteFlow(id: string): Promise<void>;
  /** The names of the node's secrets that are set: never their values. */
  secretsSet(node: TabNode): Promise<ReadonlySet<string>>;
}

/** What `flows-meta.json` keeps of a flow: which template made it, and when it was made. */
export interface FlowMeta {
  readonly template: string | null;
  /** Epoch ms. */
  readonly createdAt: number;
}

export interface FlowMetaStore {
  get(flowId: string): FlowMeta | null;
  /** Durable when it returns. */
  set(flowId: string, meta: FlowMeta): void;
  remove(flowId: string): void;
}

/** An entry of `app/templates/index.json`. */
export interface FlowTemplate {
  readonly id: string;
  readonly name: string;
  /** One line under the name: "transcribe, summarise, file, approve, send, schedule". */
  readonly line: string;
  /** The packages its steps come from. */
  readonly packages: readonly string[];
  readonly official: boolean;
}

export interface TemplateSource {
  /** The templates offered, in the index's order. */
  index(): readonly FlowTemplate[];
  /** A template's tab export, its tab node included; null when there is no such template. */
  nodes(id: string): readonly TabNode[] | null;
}

/** A node type InnyTypes generated, as flow administration reads it. */
export interface FlowNodeType {
  readonly package: string;
  readonly kind: Kind;
  readonly view?: "action" | "snapshot";
  readonly label: string;
  readonly config: JsonSchema;
}
