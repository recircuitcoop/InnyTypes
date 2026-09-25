// The IPC channel names between the app page's preload bridge and the shell. Both ends are
// built from this one file, so a renamed channel cannot leave one end talking to nothing.

export const IPC = {
  /** invoke: every child's status now. */
  childStatus: "inny:child-status",
  /** send, shell → page: one child's status changed. */
  childStatusChanged: "inny:child-status-changed",
  /** invoke: the Restart button, with the child's name. */
  restartChild: "inny:restart-child",
  /** invoke: where the application's secrets are kept (WI-0018-06). */
  secretStorage: "inny:secret-storage",
  /** invoke: the Anytype core service's status (WI-0018-18). */
  anytypeStatus: "inny:anytype-status",
  /** invoke: "Pair with Anytype": Anytype shows a four-digit code. */
  anytypePairStart: "inny:anytype-pair-start",
  /** invoke: the four-digit code, typed. */
  anytypePairComplete: "inny:anytype-pair-complete",
  /** invoke: the MCP endpoint, served against saved (WI-0018-19). */
  mcpEndpoint: "inny:mcp-endpoint",
  /** invoke: move the MCP endpoint, with a host and a port. */
  mcpEndpointMove: "inny:mcp-endpoint-move",
  /** send, shell → page: an action view presented (WI-0018-10). */
  viewPresented: "inny:view-presented",
  /** send, shell → page: the number of pending action views changed. */
  pendingViews: "inny:pending-views",
  /** invoke: the pending views last counted. */
  pendingViewsNow: "inny:pending-views-now",
  /** invoke: a view or snapshot call, `{op, args}`, answered by the runtime. */
  viewCall: "inny:view-call",
} as const;
