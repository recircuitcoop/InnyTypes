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
  /** invoke: the MCP endpoint's token, for Copy token (WI-0022-30). */
  mcpToken: "inny:mcp-token",
  /** invoke: a view call, `{op, args}`, answered by the runtime: Skip this step's dismissal. */
  viewCall: "inny:view-call",
  /** invoke: Answer: a pending view in its pop-out, with its id. */
  openView: "inny:open-view",
  /** send, shell → page: a run of a flow changed, `{flowId}` (plan 0022 §C). */
  runsChanged: "inny:runs-changed",
  /** send, shell → page: a notification was clicked; open Live on this flow (plan 0022 §M). */
  openLive: "inny:open-live",
  /** invoke: the runs' calls, `{op, args}`: list, get, "Clear done" and its undo, re-run, delete. */
  runCall: "inny:run-call",
  /** invoke: flow administration's calls, `{op, args}` (plan 0022 §D). */
  flowCall: "inny:flow-call",
  /** send, shell → page: the flows changed; Configuration › Flows asks again. */
  flowsChanged: "inny:flows-changed",
  /** invoke: the editor's palette and whether it is dirty (WI-0018-12). */
  editorPalette: "inny:editor-palette",
  /** send, shell → page: a quit found undeployed edits; ask the person. */
  quitQuestion: "inny:quit-question",
  /** invoke: the person's answer to the quit question. */
  quitAnswer: "inny:quit-answer",
  /** invoke: the launch-at-login switch (WI-0018-21). */
  launchAtLogin: "inny:launch-at-login",
  /** invoke: turn launch at login on or off, with a boolean. */
  setLaunchAtLogin: "inny:set-launch-at-login",
  /** invoke: the telemetry switch and its question (WI-0018-22). */
  telemetry: "inny:telemetry",
  /** invoke: answer the telemetry question or move the switch, with a boolean. */
  setTelemetry: "inny:set-telemetry",
  /** invoke: the reports waiting to be sent, in full (General's "See what would be sent"). */
  telemetryReports: "inny:telemetry-reports",
  /** invoke: the old installation's plugin environments still on disk (WI-0018-25). */
  legacyPackages: "inny:legacy-packages",
  /** invoke: the notice's Delete button; removes them all. */
  deleteLegacyPackages: "inny:delete-legacy-packages",
  // ── AppApi v2 (plan 0022 §N); each invoke carries `{op, args}` and answers an Answer ──
  /** invoke: a flow's board and saving one (`board.get`, `board.save`). */
  boardCall: "inny:board-call",
  /** send, shell → page: a flow's board changed, `{flowId}`. */
  boardChanged: "inny:board-changed",
  /** invoke: Setup (`setup.get`, `setup.move`, `setup.complete`, `setup.trySample`). */
  setupCall: "inny:setup-call",
  /** send, shell → page: Setup's state changed, with it. */
  setupChanged: "inny:setup-changed",
  /** invoke: InnyTypes' own update (`update.state`, `update.checkNow`, `update.quit`, `update.goBack`). */
  updateCall: "inny:update-call",
  /** send, shell → page: the update state changed, with it. */
  updateStateChanged: "inny:update-state-changed",
  /** invoke: a package's register, unregister, folder and go-back calls (plan 0022 §F). */
  packageCall: "inny:package-call",
  /** send, shell → page: a package was installed, removed, updated or re-checked. */
  packagesChanged: "inny:packages-changed",
  /** invoke: the status, and Run history's retention (`status.get`, `retention.get`, `retention.set`). */
  generalCall: "inny:general-call",
  /** send, shell → page: the status pill, banner or badge changed, with them. */
  statusChanged: "inny:status-changed",
} as const;
