// Flow administration's part of the AppApi contract (plan 0022 §D): what the page's flow calls
// answer. Apart from contract.ts, which re-exports it, to keep that file under its 600 lines.

/**
 * A flow call's answer (plan 0022 §D). A refusal is an answer too, `{refused: {reason,
 * sentence}}`, with the sentence to show: "Save or discard your changes on the canvas first."
 * while the canvas has unsaved changes. `ok: false` is a call that could not be made.
 */
export type FlowCall = Promise<
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }
>;

/** Why a flow write was refused, and the sentence that says so. */
export interface FlowRefusal {
  readonly refused: {
    readonly reason:
      | "dirty"
      | "loading"
      | "not-installed"
      | "gone"
      | "name"
      | "no-template"
      | "no-step"
      | "no-form"
      | "invalid";
    readonly sentence: string;
    readonly problems?: readonly { readonly path: string; readonly message: string }[];
  };
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
}

/** What `nodeOptions` asks for (plan 0022 §B, D9): the spaces, or one space's types. */
export type NodeOptionsQuery =
  { readonly source: "spaces" } | { readonly source: "types"; readonly spaceId: string };

/**
 * What `nodeOptions` answers as its value: each option's `value` is the plain string the step
 * stores (a space's id, a type's key), its `label` the name to show. A refusal's sentence is
 * shown in place of the options, e.g. "Pair with Anytype in Configuration › General to choose
 * a space." when InnyTypes is not paired.
 */
export type NodeOptionsAnswer =
  | { readonly options: readonly { readonly value: string; readonly label: string }[] }
  | {
      readonly refused: {
        readonly reason: "not-paired" | "unreachable" | "unavailable";
        readonly sentence: string;
      };
    };
