// The part of Node-RED 5's embedding API that InnyTypes uses, and nothing more.
//
// Node-RED ships no types. Declaring only the public surfaces keeps the internal `RED.nodes`
// out of reach of the compiler as well as of the lint rule (arch_pivot P9–P10 §2): what is
// not declared here cannot be called without a type error.
declare module "node-red" {
  import type { EventEmitter } from "node:events";
  import type { Server } from "node:http";
  import type { RequestHandler } from "express";

  /** One node set, as the documented runtime API lists it. */
  interface NodeRedNodeSet {
    readonly id: string;
    readonly module: string;
    readonly types: readonly string[];
    readonly enabled: boolean;
    readonly err?: string;
  }

  interface NodeRedApi {
    /** Once per process, before `start`. */
    init(server: Server, settings: Record<string, unknown>): void;
    /** Once per process: a `start` after `stop` breaks Node-RED (arch_pivot P9 surprise 1). */
    start(): Promise<void>;
    stop(): Promise<void>;
    version(): string;
    /** The editor and the admin API, an Express app mounted at `httpAdminRoot`. */
    readonly httpAdmin: RequestHandler;
    readonly events: EventEmitter;
    readonly runtime: {
      readonly nodes: {
        getNodeList(options: Record<string, never>): Promise<NodeRedNodeSet[]>;
      };
      /** The deployed flows: every node, config node and tab, as last deployed. */
      readonly flows: {
        getFlows(options: Record<string, never>): Promise<{ flows?: unknown[] }>;
        /** One tab, its nodes without credentials; rejects with `code: "not_found"`. */
        getFlow(options: { id: string }): Promise<Record<string, unknown>>;
        /** Adds a tab and deploys it; answers the tab's new id. */
        addFlow(options: { flow: Record<string, unknown> }): Promise<string>;
        /** Replaces one tab and deploys the changed flows only. */
        updateFlow(options: { id: string; flow: Record<string, unknown> }): Promise<string>;
        deleteFlow(options: { id: string }): Promise<void>;
        /** A node's credentials as the editor sees them: `has_<key>` for each password. */
        getNodeCredentials(options: { id: string; type: string }): Promise<Record<string, unknown>>;
      };
    };
  }

  const RED: NodeRedApi;
  export default RED;
}
