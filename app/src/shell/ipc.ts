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
  /** invoke: the Inbox as last known (WI-0018-11). */
  inbox: "inny:inbox",
  /** send, shell → page: the whole Inbox, changed. */
  inboxChanged: "inny:inbox-changed",
  /** invoke: "Open in window" for a pending view, with its id. */
  openView: "inny:open-view",
  /** invoke: a snapshot in a pop-out, with its id. */
  openSnapshot: "inny:open-snapshot",
  /** invoke: the runtime's lists and the Jobs page's cancel, `{op, args}`. */
  listCall: "inny:list-call",
  /** invoke: Quit InnyTypes, from the window. */
  quit: "inny:quit",
  /** invoke: the editor's palette and whether it is dirty (WI-0018-12). */
  editorPalette: "inny:editor-palette",
  /** invoke: the runtime's editor calls, `{op, args}`: its node sets, and the node events. */
  editorCall: "inny:editor-call",
  /** send, shell → page: a quit found undeployed edits; ask the person. */
  quitQuestion: "inny:quit-question",
  /** invoke: the person's answer to the quit question. */
  quitAnswer: "inny:quit-answer",
} as const;
