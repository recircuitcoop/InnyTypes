// Flow administration's part of the AppApi contract (plan 0022 §D): what the page's flow calls
// answer. Apart from contract.ts, which re-exports it, to keep that file under its 600 lines.
import type { Answer } from "./answer";

/** A flow call's answer: its value, or a refusal (answer.ts) with the line that says why. */
export type FlowAnswer<T> = Promise<Answer<T>>;

/** A flow made, renamed or duplicated: its id and name. */
export interface FlowNamed {
  readonly id: string;
  readonly name: string;
}

/** A step's form (plan 0022 §D): its schema, values and name; `innytype` options unresolved. */
export interface NodeForm {
  readonly flowId: string;
  readonly nodeId: string;
  /** The step's Node-RED type: data for the form, never shown. */
  readonly type: string;
  /** The package the step comes from, shown small under the step's name. */
  readonly package: string;
  readonly stepName: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly values: Readonly<Record<string, unknown>>;
  /** The secret fields that hold a value; their values never reach the page. */
  readonly secretsSet: readonly string[];
}

/** One row of Configuration › Flows, as `flow.list` answers it. */
export interface FlowSummary {
  readonly id: string;
  readonly name: string;
  /** The switch: the tab's own `disabled` flag, inverted. */
  readonly on: boolean;
  readonly health:
    | { readonly kind: "ready" }
    | { readonly kind: "steps-not-set-up"; readonly count: number }
    /** No source node: nothing can start a run ("This flow has no source yet."). */
    | { readonly kind: "no-source" }
    | { readonly kind: "failing-since"; readonly since: Date };
  readonly lastRun: {
    readonly runId: string;
    readonly title: string;
    readonly startedAt: Date;
    readonly endedAt: Date | null;
    /** As RunRecord's. */
    readonly state: "copying" | "running" | "waiting" | "failed" | "done";
  } | null;
  /** The flow's view nodes: the places of its board. */
  readonly viewNodes: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: "question" | "result";
  }[];
  /** Its steps in wire order from the sources: the "Re-run from…" menu. */
  readonly steps: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly setUp: boolean;
  }[];
}

/** An entry of `app/templates/index.json`: a card under New flow › From a template. */
export interface FlowTemplateEntry {
  readonly id: string;
  readonly name: string;
  readonly line: string;
  readonly packages: readonly string[];
  readonly official: boolean;
  /** Setup's "Install the simple flow" (plan 0022 §H); exactly one template is the starter. */
  readonly starter: boolean;
}

/** What `nodeOptions` asks for (plan 0022 §B, D9): the spaces, or one space's types. */
export type NodeOptionsQuery =
  { readonly source: "spaces" } | { readonly source: "types"; readonly spaceId: string };

/**
 * What `nodeOptions` answers: each option's `value` is the plain string the step stores (a
 * space's id, a type's key), its `label` the name to show. Not paired, Anytype not running, or
 * anything else: a refusal whose line is shown in place of the options ("Pair with Anytype in
 * Configuration › General to choose a space.").
 */
export interface NodeOptions {
  readonly options: readonly { readonly value: string; readonly label: string }[];
}
