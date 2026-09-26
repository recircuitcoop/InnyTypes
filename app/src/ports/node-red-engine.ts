// The embedded Node-RED, as far as the application layer needs it (plan 0018 §2.3).
//
// Only the documented runtime API is behind it (arch_pivot P9–P10 §2): the node sets come from
// `RED.runtime.nodes.getNodeList`, never from the internal `RED.nodes`.

/** One node set, as `RED.runtime.nodes.getNodeList` lists it. */
export interface NodeSet {
  /** `<module>/<set name>`, for example `node-red/inject`. */
  readonly id: string;
  /** `node-red` for Node-RED's own core nodes and for local files (the generated types). */
  readonly module: string;
  readonly types: readonly string[];
  readonly enabled: boolean;
  /** Why the set failed to load; its types are then not registered. */
  readonly err?: string;
}

export interface NodeRedEngine {
  /** Every node set Node-RED knows now, loaded or not. */
  nodeSets(): Promise<readonly NodeSet[]>;
}

/** A node set as an open editor holds it: its id and its types (WI-0018-12). */
export interface NodeSetSummary {
  readonly id: string;
  readonly types: readonly string[];
}

/**
 * Keeping an open editor's palette in step with a new runtime generation (arch_pivot P11b).
 * Node-RED's own `runtime-event`s `node/added` and `node/removed`, the ones a palette install
 * raises: `RED.events` is documented, but those ids and their payload are Node-RED's own
 * convention (P11 §4), pinned to 5.0.7 by test/integration/editor-events-contract.test.ts.
 */
export interface NodeRedEditorEvents extends NodeRedEngine {
  /**
   * Raise `node/added` with what `getNodeList` lists for these set ids; the editor then fetches
   * each set's definitions itself. Returns the ids raised (an id Node-RED no longer has is not).
   */
  raiseNodeAdded(ids: readonly string[]): Promise<readonly string[]>;
  /** Raise `node/removed` for sets the editor holds and the runtime no longer has. */
  raiseNodeRemoved(sets: readonly NodeSetSummary[]): void;
}
