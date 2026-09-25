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
