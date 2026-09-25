// What the HTTP server asks before Node-RED's admin API sees a request (spec 11.3, plan 0018
// §2.2). application/deploy-guard.ts decides; adapters/nodered/guard-middleware.ts asks.

/** Which write to the flows a body came with. */
export type FlowsRoute =
  | "flows" // POST /red/flows: the whole deploy, a node array or `{flows: [...]}`
  | "flow"; // POST /red/flow and PUT /red/flow/:id: one tab, `{nodes, configs, subflows}`

/** Pass the request on, or refuse it with this status and body. */
export type GuardAnswer =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: { readonly code: string; readonly message: string };
    };

export interface RequestGuard {
  /** Any request, WebSocket upgrades included, by its Host header. */
  checkHost(host: string | undefined): GuardAnswer;
  /** A write to the flows, by the types its body names. */
  checkDeploy(route: FlowsRoute, body: unknown): Promise<GuardAnswer>;
}
