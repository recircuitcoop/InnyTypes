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
  /** invoke: the Inbox as last known (WI-0018-11). cutover: WI-21 removes */
  inbox: "inny:inbox",
  /** send, shell → page: the whole Inbox, changed. cutover: WI-21 removes */
  inboxChanged: "inny:inbox-changed",
  /** invoke: "Open in window" for a pending view, with its id. */
  openView: "inny:open-view",
  /** invoke: a snapshot in a pop-out, with its id. */
  openSnapshot: "inny:open-snapshot",
  /** send, shell → page: the inputs in hand changed; the Jobs page asks again. cutover: WI-21 removes */
  jobsChanged: "inny:jobs-changed",
  /** send, shell → page: a run of a flow changed, `{flowId}` (plan 0022 §C). */
  runsChanged: "inny:runs-changed",
  /** invoke: the runs' calls, `{op, args}`: list, get, "Clear done" and its undo, re-run, delete. */
  runCall: "inny:run-call",
  /** invoke: flow administration's calls, `{op, args}` (plan 0022 §D). */
  flowCall: "inny:flow-call",
  /** send, shell → page: the flows changed; Configuration › Flows asks again. */
  flowsChanged: "inny:flows-changed",
  /** invoke: the runtime's lists and the Jobs page's cancel, `{op, args}`. cutover: WI-21 removes */
  listCall: "inny:list-call",
  /** invoke: Quit InnyTypes, from the window. */
  quit: "inny:quit",
  /** invoke: the editor's palette and whether it is dirty (WI-0018-12). */
  editorPalette: "inny:editor-palette",
  /** invoke: the runtime's editor calls, `{op, args}`: its node sets, and the node events. */
  editorCall: "inny:editor-call",
  /** invoke: the Events page's calls, `{op, args}` (WI-0018-13). cutover: WI-21 removes */
  eventCall: "inny:event-call",
  /** send, shell → page: a quit found undeployed edits; ask the person. */
  quitQuestion: "inny:quit-question",
  /** invoke: the person's answer to the quit question. */
  quitAnswer: "inny:quit-answer",
  /** invoke: the Packages page's state (WI-0018-16). */
  packages: "inny:packages",
  /** invoke: install a catalogue entry, with its id. */
  packageInstall: "inny:package-install",
  /** invoke: the shell's file chooser for "Install from file…". */
  packageChooseFile: "inny:package-choose-file",
  /** invoke: install from a file, with its path and whether unsigned was confirmed. */
  packageInstallFile: "inny:package-install-file",
  /** invoke: remove an installed package, with its name. */
  packageRemove: "inny:package-remove",
  /** invoke: check every installed package for a newer version now (WI-0018-17). */
  packageCheck: "inny:package-check",
  /** invoke: Apply: update a package to the newer version the last check found, with its name. */
  packageUpdate: "inny:package-update",
  /** invoke: install from a catalogue, with its source, the entry's id and the confirmation. */
  packageInstallSource: "inny:package-install-source",
  /** invoke: register a catalogue source, with its name, URL and public key. */
  sourceRegister: "inny:source-register",
  /** invoke: remove a registered source, with its name. */
  sourceRemove: "inny:source-remove",
  /** invoke: switch a source's auto-update, with its name and on or off. */
  sourceAutoUpdate: "inny:source-auto-update",
  /** invoke: the launch-at-login switch (WI-0018-21). */
  launchAtLogin: "inny:launch-at-login",
  /** invoke: turn launch at login on or off, with a boolean. */
  setLaunchAtLogin: "inny:set-launch-at-login",
  /** invoke: the telemetry switch and its question (WI-0018-22). */
  telemetry: "inny:telemetry",
  /** invoke: answer the telemetry question or move the switch, with a boolean. */
  setTelemetry: "inny:set-telemetry",
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
