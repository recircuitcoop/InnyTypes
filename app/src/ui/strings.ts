// Every word the application shows (plan 0022 §O): one keyed entry per line of
// docs/ux/ux-writing.md, by section, in its order. Components and screens take keys, never
// sentences (eslint-rules/no-jsx-text.mjs); the domain stays structured and words nothing;
// ui/words.ts turns the domain's values into these sentences.
//
// * A slot is `{name}`, filled by `t(key, {name: …})`; the compiler knows each key's slots, so a
//   missing or misspelt one fails tsc.
// * `*…*` marks a name the person gave or chose (a flow, a step, a space); the component draws
//   it in italics, as ux-writing does.
// * Plurals are two keys, `….one` and `….other`; `plural(n, …)` picks one.
// * Nothing internal is ever in a template: no id, pid, port, path, type key or package-internal
//   name (strings.test.ts "no string carries an internal"). A value that is one arrives in a slot,
//   and only three keys may carry such a slot: `general.aiApps.line` (the endpoint's address),
//   `general.aiApps.setup` (the endpoint's URL, in the command Copy setup copies) and
//   `packages.fromFolder.caption` (the folder a package came from).
//
// The Setup walkthrough is Welcome → Reports → Connect Anytype → Source folder → the starter's
// step forms → Ready (owner decisions 1 and 8, 2026-10-02).
//
// Lines ux-writing does not give, decided by WI-0022-10 and marked `// decided`: the first tab's
// name, the between-steps lines, the unchecked and going-back update states, a check that failed
// for another reason than the connection, three or more uses in one refusal, a shipped package's
// refusal, and the "not available yet" answer of a call whose work item has not landed.

export const STRINGS = {
  // ── Navigation and page titles ───────────────────────────────────────────────────────────
  "nav.main": "InnyTypes", // decided (WI-0022-11): the main sidebar's spoken name, the product's
  "nav.setup": "Set up InnyTypes",
  "nav.configuration": "Configuration",
  "nav.flows": "Flows",
  "nav.general": "General",
  "nav.live": "Live",
  "flows.empty": "No flows yet. Start from a template, or open a blank canvas.",
  "live.empty": "Nothing lives here yet. Make a flow in Configuration › Flows.",
  "live.empty.goToFlows": "Go to Flows",
  "live.idle":
    "Waiting for a recording. Plug in your recorder, or drop a file in a watched folder.",
  "live.tabEmpty": "This tab is empty. Choose Edit layout to move things here.",
  "live.flowPicker": "Flow",
  "status.running": "Running",
  "status.restarting": "Restarting…",
  "status.stopped": "Stopped",
  "status.needsAttention": "Needs attention",

  // ── The first run (Setup) ────────────────────────────────────────────────────────────────
  "setup.welcome.title": "Welcome to InnyTypes",
  "setup.welcome.body":
    "InnyTypes turns your recordings into notes, summaries and next steps, in Anytype and wherever else you point it, on its own. Set it up once. It takes about ten minutes.",
  "setup.welcome.start": "Get started",
  "setup.reports.title": "Help improve InnyTypes?",
  "setup.reports.body":
    "Send anonymous crash reports and usage counts. Never your recordings, transcripts or notes. You can change this in Configuration › General.",
  "setup.reports.send": "Send reports",
  "setup.reports.dontSend": "Don't send",
  "setup.anytype.title": "Connect Anytype",
  "setup.anytype.running": "Anytype is asking for a code. Type it here.",
  "setup.anytype.notRunning": "Open Anytype, then come back. InnyTypes will notice.",
  "setup.anytype.connect": "Connect",
  "setup.anytype.skip": "Skip for now",
  "setup.anytype.connected.one": "Connected. Found {n} space.",
  "setup.anytype.connected.other": "Connected. Found {n} spaces.",
  "setup.continue": "Continue",
  "setup.back": "Back",
  // Owner decisions 1 and 8: no "Choose your packages" step (packages are set up on their own)
  // and no "Start with a simple flow?" choice (the starter is always installed). Removed keys:
  // setup.packages.title, .body, .anytype, .monty, .innyrize; setup.starter.title, .body,
  // .install, .own. "I'll build my own" moved to Ready (setup.ready.own).
  // Source folder: the folder the starter flow watches. The folder's name, chosen, shows in full
  // under the button: it is the person's own folder, not a line.
  "setup.folder.title": "Source folder",
  "setup.folder.body":
    "Choose the folder InnyTypes watches. Every new file in it starts your flow.",
  "setup.folder.choose": "Choose a folder…",
  "setup.form.title": "Set up: *{step}*",
  "setup.form.progress": "Step {step} of {of}.",
  "setup.ready.title": "Ready",
  "setup.ready.body":
    "Your flow is on. Drop a file in *{folder}* to start. Or try it now with a 10-second sample.",
  "setup.ready.sample": "Try with a sample",
  "setup.ready.openLive": "Open Live",
  "setup.ready.own": "I'll build my own",
  // The Setup sidebar's labels, in order; the step forms share "Steps".
  "setup.nav.welcome": "Welcome",
  "setup.nav.reports": "Reports",
  "setup.nav.anytype": "Anytype",
  "setup.nav.folder": "Source folder",
  "setup.nav.steps": "Steps",
  "setup.nav.ready": "Ready",
  // The privacy notice beside the reports question, in Setup's Reports step and in General ›
  // Reports while it is unanswered (D25; owner, 2026-10-15: "show the full notice again"). Only
  // what is true of this version: usage counts go to Umami Cloud after a yes; crash reports have
  // nowhere to go yet (D23).
  "privacy.optional":
    "Reports are optional, and saying no changes nothing else: InnyTypes keeps restarting its processes and updating its packages either way.", // decided
  "privacy.sent": "What is sent", // decided
  "privacy.sent.where":
    "If you say yes, usage counts go to Umami Cloud, an analytics service. Each one carries:", // decided
  "privacy.sent.machineId":
    "a machine id: an HMAC-SHA256 hash of your computer's own identifier. The identifier itself never leaves this computer, and the hash can't be matched to it in any other software", // decided
  "privacy.sent.versions":
    "the InnyTypes version, your operating system, its version and the processor type", // decided
  "privacy.sent.packages": "which packages are installed, at which versions", // decided
  "privacy.sent.stamp": "when the report was made, and a random number that tells it apart", // decided
  "privacy.sent.crashes": "Crash reports aren't sent: this version has nowhere to send them.", // decided
  "privacy.never": "What is never sent", // decided
  "privacy.never.line":
    "Anything from your Anytype content, the names of your objects, spaces, flows or steps, your Anytype key or any other key, token or password, anything you set a step up with, the contents of any file, audio or transcript, the values of environment variables, full paths inside your home folder, your user name, your computer's name, or its raw identifier.", // decided
  "privacy.kept": "How long it is kept", // decided
  "privacy.kept.line": "Usage counts are kept for 13 months.", // decided
  "privacy.rights": "Your rights under the GDPR", // decided
  "privacy.rights.pseudonymous":
    "The machine id carries no name, but under the GDPR it is still pseudonymous personal data. That is why it is kept only that long.", // decided
  "privacy.rights.line":
    "You have the right to see what was sent about you, to have it deleted, and to object to its use. See what would be sent, in Configuration › General, shows each report exactly as it would leave.", // decided
  "privacy.rights.change":
    "Nothing is sent until you answer. You can change your answer at any time in Configuration › General, and turning reports off deletes anything still waiting to be sent.", // decided

  // ── Live: the board, Edit layout ─────────────────────────────────────────────────────────
  "board.editLayout": "Edit layout",
  "board.editing": "Editing the layout of *{flow}*. Drag to move, drag a corner to resize.",
  "board.done": "Done",
  "board.addTab": "Add tab",
  "board.newTab": "New tab",
  "board.firstTab": "Overview", // decided: a new board's first tab ("Main" is the sidebar's)
  "board.removeTab": "Remove tab",
  "board.removeTab.title": "Remove the tab *{tab}*?",
  "board.removeTab.body": "What's on it moves to the first tab. Nothing is deleted.",
  "board.lastTab": "A board needs at least one tab.",
  "board.hide": "Hide",
  "board.hidden.tooltip": "Hidden from the board. Questions and failures from it still reach you.",
  "board.hidden": "Hidden ({n})",
  "board.show": "Show",
  "board.newPlace": "New on the board: *{place}*.",
  // The keyboard alternative to dragging a place (plan 0022 §P).
  "board.moveToTab": "Move to tab",
  "board.moveEarlier": "Move earlier",
  "board.moveLater": "Move later",
  "board.size": "Size {size}",
  // decided (WI-0022-12): words the Live board needs that ux-writing does not give.
  "board.of": "Board of {flow}", // decided: the tabs' spoken group name
  "board.arrange": "Arrange", // decided: a place's ⋯ button, spoken with its name
  "board.sizeHeading": "Size", // decided: the heading over Size S, M, L
  "board.hiddenPill": "Hidden", // decided: the pill on a hidden place in Edit layout
  "board.place.runs": "Runs", // decided: the place that lists the flow's run cards
  "board.tabName": "Tab name", // decided: the field that renames a tab in Edit layout
  "board.refused.tabName": "Give the tab a name.", // decided: an empty tab name is not kept

  // ── Run cards: title, step line, the Done badge, result lines ────────────────────────────
  "card.title.minutes": "{name} · {minutes} min",
  "card.step.copying": "Copying",
  "card.step.copyingNoText": "Copying…", // decided: a source that says nothing while it copies
  "card.step.safeToUnplug": "Safe to unplug.",
  "card.step.betweenSteps": "Running…", // decided: between one step and the next
  "card.step.progress": "({done} of {total})",
  "card.step.timeLeft.one": "about {n} minute left",
  "card.step.timeLeft.other": "about {n} minutes left",
  "card.step.waiting": "Waiting for you:",
  "card.step.failed": "Failed",
  "card.step.failedAt": "at {step}: {reason}",
  "card.step.resumed": "Resumed",
  "card.step.resumedRest": "after restart.",
  "card.step.done": "Done.",
  "card.answer": "Answer",
  "card.send": "Send",
  "card.notNow": "Not now",
  "card.retry": "Retry",
  "card.clearDone": "Clear done",
  "card.undo": "Undo", // decided: "Clear done" is undoable for a minute
  "card.pill.done": "Done",
  "card.pill.notes.one": "{n} note",
  "card.pill.notes.other": "{n} notes",
  "card.pill.warnings.one": "{n} warning",
  "card.pill.warnings.other": "{n} warnings",
  "card.notes": "Notes",
  "card.warnings": "Warnings",
  "card.noteStep": "{step}:",
  "card.waitingSince": "Waiting since {day}",
  "card.nothingToUndo": "Nothing was cleared in the last minute.", // decided
  "history.runGone": "This run is no longer kept.", // decided
  "result.arrow": "→",

  // ── Questions (view nodes) ───────────────────────────────────────────────────────────────
  "question.suggested": "Suggested",
  "question.continue": "Continue",
  "question.later": "Later",
  "question.skip": "Skip this step",
  "question.skip.confirm":
    "Skip *{step}*? The flow continues without {without}. This can't be undone for this run.",
  // decided (WI-0022-13): a step that does not say what the flow goes without
  "question.skip.confirmStep": "Skip *{step}*? This can't be undone for this run.",
  "question.skip.yes": "Skip",
  "question.keepWaiting": "Keep waiting",
  "question.subtitle": "*{event}*, {minutes} min",
  "question.from": "From *{event}*",
  "question.choose": "Choose…",
  "question.someoneElse": "Someone else",

  // ── Notifications (besides questions) ────────────────────────────────────────────────────
  "notify.start.one": "Processing *{event}*, about {n} minute.",
  "notify.start.other": "Processing *{event}*, about {n} minutes.",
  "notify.start.noEstimate": "Processing *{event}*.", // decided: no good run to estimate from yet
  "notify.filed": "Filed: {result}.",
  "notify.done": "Done: {result}.",
  "notify.failed": "Couldn't finish *{event}*. {reason}",
  "notify.runtime.restarting": "InnyTypes stopped unexpectedly and is restarting.",
  "notify.runtime.gaveUp":
    "InnyTypes stopped {count} times in {minutes} minutes and won't restart on its own.",
  "notify.update.ready": "InnyTypes {version} is ready. It installs when you quit.",
  "notify.package.available": "*{name}* {version} is available.",
  "notify.openInAnytype": "Open in Anytype",
  "notify.open": "Open",
  "notify.restart": "Restart",
  "notify.quitAndUpdate": "Quit and update",
  "notify.later": "Later",
  "notify.update": "Update",
  "notify.notNow": "Not now",

  // ── Configuration › Flows ────────────────────────────────────────────────────────────────
  "flows.on": "On",
  "flows.off": "Off",
  "flows.lastRun": "Last run: {day}, {time} · {state}",
  "flows.edit": "Edit",
  "flows.runHistory": "Run history",
  "flows.more": "More",
  "flows.rename": "Rename",
  "flows.rename.name": "Name", // decided (WI-0022-14): the Rename dialog's one field
  "flows.duplicate": "Duplicate",
  "flows.export": "Export flow…",
  "flows.delete": "Delete flow",
  "flows.health.ready": "Ready",
  "flows.health.notSetUp.one": "{n} step not set up",
  "flows.health.notSetUp.other": "{n} steps not set up",
  "flows.health.noSource": "This flow has no source yet.",
  "flows.health.failingSince": "Failing since {day}",
  "flows.new": "New flow",
  "flows.new.template": "From a template",
  "flows.new.blank": "Blank canvas",
  "flows.delete.confirm":
    "Delete *{flow}*? Its run history is deleted too. Runs in progress are stopped.",
  "flows.delete.yes": "Delete",
  "flows.template.card": "{name}: {line}",
  "flows.template.use": "Use this template",
  // A flow write's refusal (application/flows.ts words the same for the canvas; a test holds them equal).
  "flows.refused.dirty": "Save or discard your changes on the canvas first.",
  "flows.refused.loading": "The canvas is still loading; try again in a moment.",
  "flows.refused.gone": "This flow no longer exists.",
  "flows.refused.name": "Give the flow a name.",
  "flows.refused.noTemplate": "This template is not available.",
  "flows.refused.noStep": "This step is no longer in the flow.",
  "flows.refused.noForm": "This step has no form to fill in.",
  "flows.refused.notInstalled":
    "A step of this flow comes from a package that isn't installed. Add it in Configuration › General.",
  "runState.copying": "copying",
  "runState.running": "running",
  "runState.waiting": "waiting for you",
  "runState.failed": "failed",
  "runState.done": "done",

  // ── Configuration › Flows › Run history ──────────────────────────────────────────────────
  "history.title": "Run history",
  "history.back": "Flows",
  "history.retention.days":
    "Runs are kept for {days} days. Change this in Configuration › General.",
  "history.retention.forever":
    "Runs are kept until you delete them. Change this in Configuration › General.", // decided
  "history.filter.all": "All",
  "history.filter.waiting": "Waiting",
  "history.filter.failed": "Failed",
  "history.filter.done": "Done",
  "history.range.days": "Last {n} days",
  "history.range.any": "Any time", // decided
  "history.search": "Search runs",
  "history.column.when": "When",
  "history.column.event": "Event",
  "history.column.took": "Took",
  "history.column.state": "State",
  "history.column.notes": "Notes",
  "history.when": "{day} {time}",
  "history.took": "{n} min",
  "history.state.copying": "Copying",
  "history.state.running": "Running",
  "history.state.waiting": "Waiting for you",
  "history.state.done": "Done",
  "history.state.failed": "Failed",
  "history.failedLine": "Failed at {step}: {reason}",
  "history.openResult": "Open result",
  "history.rerun": "Re-run",
  "history.rerunFrom": "Re-run from…",
  "history.openInAnytype": "Open in Anytype",
  "history.deleteRun": "Delete run",
  "history.selected.one": "{n} run selected",
  "history.selected.other": "{n} runs selected",
  "history.delete": "Delete",
  "history.clearSelection": "Clear selection",
  "history.rerunOf": "Re-run {day} {time}",
  "history.deleteRun.confirm":
    "Delete this run? Its results in Anytype are kept; only InnyTypes' record of it goes.",
  "history.deleteRuns.confirm":
    "Delete {n} runs? Their results in Anytype are kept; only InnyTypes' record of them goes.",
  "history.empty": "No runs yet. Plug in your recorder, or drop a file in a watched folder.",
  "history.emptyFiltered": "No {state} runs in the last {days} days.",
  // decided (WI-0022-15): the filter row's and the table's spoken names
  "history.filterLabel": "Show",
  "history.clearSearch": "Clear the search",
  "history.selectAll": "Select all runs",
  "history.selectRun": "Select {event}",
  // decided (WI-0022-15): a re-run refused, as the runtime refuses it (application/run-actions.ts)
  "history.refused.flowOff": "Switch this flow on to re-run it.",
  "history.refused.notReached": "This run never reached that step.",
  "form.readingSpaces": "Reading your spaces…",
  "form.readingTypes": "Reading the space's types…",
  "form.notPaired": "Pair with Anytype in Configuration › General to choose a space.",
  "form.unreachable": "Open Anytype, then come back.",
  "form.unavailable": "Couldn't read from Anytype. Open this step's form again.",

  // ── Configuration › General ──────────────────────────────────────────────────────────────
  "general.anytype": "Anytype",
  "general.anytype.connected.one": "Connected · {n} space",
  "general.anytype.connected.other": "Connected · {n} spaces",
  "general.anytype.notPaired": "Not paired yet.",
  "general.pair": "Pair",
  "general.pairAgain": "Pair again",
  "general.recorders": "Recorders and folders",
  "general.recorder.watching": "{name} · watching",
  "general.addFolder": "Add a folder…",
  "general.aiApps": "AI apps",
  "general.aiApps.line":
    "Claude, Codex and other apps can use your Anytype through InnyTypes at `{address}`.",
  "general.changePort": "Change port",
  "general.copySetup": "Copy setup for {app}",
  "general.startAtLogin": "Start at login",
  "general.startAtLogin.line": "InnyTypes starts when you log in.",
  "general.updates": "Updates",
  "general.checkNow": "Check now",
  "general.checkAutomatically": "Check automatically",
  "general.releaseNotes": "Release notes",
  "general.quitAndUpdate": "Quit and update",
  "general.goBack": "Go back to {version}",
  "general.goBack.confirm": "Go back to {version}? Your flows and settings are kept.",
  "general.goBack.yes": "Go back",
  "general.reports": "Reports",
  "general.reports.on": "Sending anonymous usage counts.",
  "general.reports.crashNotYet": "Crash reports aren't sent yet.",
  "general.reports.off": "Not sending.",
  "general.reports.see": "See what would be sent",
  "general.retention": "Keep runs for", // decided: the retention choice (D8)
  "general.retention.days": "{n} days",
  "general.retention.forever": "Forever",
  "general.advanced": "Advanced",
  // Decided by WI-0022-18: the General lines ux-writing does not give.
  "general.anytype.starting": "Connecting to Anytype…", // decided
  "general.anytype.unavailable": "Anytype can't be used right now. Advanced has the details.", // decided
  "general.anytype.connected": "Connected.", // decided: the spaces could not be counted
  "general.anytype.code": "The code Anytype shows", // decided
  "general.anytype.codeRefused": "Anytype didn't take that code. Type the four digits it shows.", // decided
  "general.recorder.off": "{name} · not watching: its flow is off", // decided
  "general.recorders.none": "No recorder or folder is watched yet.", // decided
  "general.aiApps.notServed": "AI apps can't reach your Anytype through InnyTypes right now.", // decided
  // "Copy setup for …" (ux-writing): the AI app's name and the one command the button copies,
  // the endpoint's URL in its slot and its token read from the variable at call time, never
  // copied. Kept here, the one file that may name an AI app (independent-client.test.ts).
  "general.aiApps.app": "Codex", // decided
  "general.aiApps.setup":
    "codex mcp add innytypes --url {url} --bearer-token-env-var INNYTYPES_MCP_TOKEN", // decided
  "general.aiApps.copied": "Copied. Paste it in a terminal.", // decided
  "general.aiApps.moved":
    "Moved. Apps set up with the old address need the new one: copy their setup again.", // decided
  "general.startAtLogin.refused": "The system didn't allow it, so nothing changed.", // decided
  "general.reports.switch": "Send reports", // decided: the switch's label
  "general.reports.nothing": "Nothing is waiting to be sent.", // decided
  "general.reports.hide": "Hide what would be sent", // decided
  "general.runs": "Run history", // decided: retention's section (D8)
  "general.runs.days": "Runs are kept for {n} days.", // decided
  "general.runs.forever": "Runs are kept until you delete them.", // decided
  "general.advanced.line": "Status details for support.", // decided
  "general.advanced.runtime": "Runtime", // decided
  "general.advanced.services": "Services", // decided
  "general.advanced.process": "Process, port, generation", // decided
  "general.advanced.anytype": "Anytype", // decided
  "general.advanced.anytypeProcess": "Anytype bridge: process, answers", // decided
  "general.advanced.endpoint": "Served", // decided
  "general.advanced.saved": "Saved", // decided
  "general.advanced.ignored": "Ignored settings", // decided
  "general.advanced.secrets": "Secrets", // decided
  "general.advanced.secrets.keychain": "In the system keychain", // decided
  "general.advanced.secrets.file": "In files only this account can read", // decided
  "general.advanced.legacy": "Left from the old installation", // decided
  "general.advanced.legacy.delete": "Delete them", // decided
  "general.port.more": "One more", // decided: the port field's steps
  "general.port.less": "One less", // decided
  "update.unchecked": "Not checked yet · {version}", // decided
  "update.upToDate": "Up to date · {version} · checked {day} {time}",
  "update.checking": "Checking…",
  "update.downloading": "Downloading {version} · {percent}%",
  "update.ready": "{version} is ready. It installs when you quit.",
  "update.checkFailed.noConnection": "Couldn't check for updates: no connection.",
  "update.checkFailed.unreadable": "Couldn't check for updates: the answer was unreadable.", // decided
  "update.lastChecked": "Last checked {day}.",
  "update.installFailed": "Update to {version} didn't pass its safety check and wasn't installed.",
  "update.updated": "Updated to {version} on {day}.",
  "update.rollingBack": "Going back to {version}…", // decided
  "update.notReady": "No update is ready to install yet.", // decided
  "update.goBackGone": "Going back is no longer offered.", // decided (WI-0022-20)

  // Packages
  "general.packages": "Packages",
  "packages.installedCount": "{n} installed",
  "packages.line": "{installed} · {updates}", // the section's state: "4 installed · 1 update"
  "packages.updateCount.one": "{n} update",
  "packages.updateCount.other": "{n} updates",
  "packages.add": "Add a package…",
  "packages.fromCatalogue": "From the catalogue",
  "packages.fromFolderMenu": "From a folder on this Mac…",
  "packages.by": "by *{publisher}*",
  "packages.registered": "Registered",
  "packages.notRegistered": "Not registered",
  "packages.register": "Register",
  "packages.unregister": "Unregister",
  "packages.installed": "Installed",
  "packages.notInstalled": "Not installed",
  "packages.installing": "Installing · {percent}%",
  "packages.verifying": "Verifying…",
  "packages.failedCheck": "Failed its check",
  "packages.install": "Install",
  "packages.installAgain": "Install again", // decided (WI-0022-19): a package that failed its check
  "packages.shippedFailed": "Reinstall InnyTypes to restore it.", // decided (WI-0022-19)
  "packages.folderUnreadable": "Its folder can't be read.", // decided (WI-0022-19)
  "packages.remove": "Remove",
  "packages.upToDate": "Up to date",
  "packages.available": "Update to {version} available",
  "packages.changed": "Changed without a new version", // decided (WI-0022-19, plan 0013)
  "packages.blocked": "Update to {version} held back", // decided (WI-0022-27)
  "packages.blocked.reason": "It was rolled back: {reason}.", // decided (WI-0022-27)
  "packages.blocked.unread": "Held back: {reason}.", // decided (WI-0022-27): never tried, record unread
  "packages.updating": "Updating…",
  "packages.updated": "Updated to {version} on {day}",
  "packages.updatedUndated": "Updated to {version}", // decided (WI-0022-19): an update 0.2.x made, its day unknown
  "packages.update": "Update",
  "packages.checkForChanges": "Check for changes",
  "packages.goBack": "Go back to {version}",
  "packages.goBack.confirm": "Go back to *{name}* {version}? The flows that use it keep running.",
  "packages.inUse.one":
    "Can't {action} *{name}*: the flow *{flow}* uses its *{step}* step. Remove that step first.",
  "packages.inUse.many": "Can't {action} *{name}*: {uses}. Remove those steps first.",
  "packages.inUse.use": "*{flow}* uses its *{step}* step",
  "packages.inUse.and": "{list} and {last}",
  "packages.inUse.comma": "{list}, {next}",
  "packages.action.unregister": "unregister",
  "packages.action.remove": "remove",
  "packages.shipped": "*{name}* comes with InnyTypes and can't be removed. Unregister it instead.", // decided
  "packages.fromFolder.caption": "From a folder: *{path}*",
  "packages.unsigned": "Unsigned",
  "packages.unsigned.title": "Install an unsigned package?",
  "packages.unsigned.body": "Nobody vouches for this code. It will run with your permissions.",
  "packages.installAnyway": "Install anyway",
  "packages.checked": "checked {when}",
  "packages.checkedAt": "{day} {time}", // decided (WI-0022-19): "today 09:14", as Updates says it
  // What a package action came to when it did not happen (WI-0022-19): decided.
  "packages.busy": "Another package is being installed or updated. Try again once it's done.", // decided
  "packages.goBackExpired":
    "Going back is offered for seven days after an update, and they have passed.", // decided
  "packages.installFailed": "The package wasn't installed. Nothing on your Mac changed.", // decided
  "packages.updateFailed": "*{name}* wasn't updated. The version you had keeps running.", // decided
  "packages.goBackFailed": "*{name}* went back to {version}, but not all of its steps started.", // decided
  "packages.offers.none": "The catalogue has nothing more to install.", // decided

  // ── Errors, by pattern ───────────────────────────────────────────────────────────────────
  "error.anytypeUnreachable":
    "Couldn't reach Anytype. Is it running? InnyTypes will retry on its own.",
  "error.keyRefused": "Anytype refused the key. Pair again in Configuration › General.",
  "error.stepKeyRefused": "{service} refused the key. Check the key in the *{step}* step.",
  "error.recorderUnreadable": "Couldn't read *{recorder}*. Unplug it and plug it back in.",
  "error.formIncomplete": "*{step}* isn't set up yet: {what}.",
  "error.portTaken": "Port {port} is used by another app. Choose another port.",
  "error.updateTampered":
    "The update didn't pass its safety check and wasn't installed. Try again later.",
  "error.runtimeDown":
    "InnyTypes stopped unexpectedly {count} times in {minutes} minutes, so it's no longer restarted. Press Restart to try again.",
  "quit.title": "Save your flow before quitting?",
  "quit.body": "Unsaved changes on the canvas are lost otherwise.",
  "quit.save": "Save and quit",
  "quit.discard": "Quit without saving",
  "dialog.cancel": "Cancel",
  // A call refused before it reached its work (AppApi's Refusal): decided.
  "refused.notAvailable": "This isn't available yet.",
  "refused.restarting": "InnyTypes is restarting. Try again in a moment.",
  "refused.down": "InnyTypes isn't running. Press Restart to try again.",
  "refused.failed": "That didn't work. Try again in a moment.",

  // ── The Node-RED canvas ──────────────────────────────────────────────────────────────────
  "canvas.saveAndRun": "Save and run",
  "canvas.unsaved": "Unsaved changes",
  "canvas.palette.sources": "Sources",
  "canvas.palette.steps": "Steps",
  "canvas.palette.questions": "Questions and results",
  "canvas.palette.createdSource":
    "Emits {type}, created in the app. Add it to a flow on its canvas in Configuration › Flows, and wire a message into its input: its payload is checked against the type's schema.",

  // ── Accessibility of the words; times ────────────────────────────────────────────────────
  "a11y.close": "Close",
  "a11y.more": "More",
  "time.today": "today",
  "time.yesterday": "yesterday",
  "time.sunday": "Sunday",
  "time.monday": "Monday",
  "time.tuesday": "Tuesday",
  "time.wednesday": "Wednesday",
  "time.thursday": "Thursday",
  "time.friday": "Friday",
  "time.saturday": "Saturday",
  "time.hover": "{date}, {time}",
} as const;

export type Strings = typeof STRINGS;
export type StringKey = keyof Strings;

/** The slot names of a template: "Step {step} of {of}." → "step" | "of". */
export type SlotsOf<S extends string> = S extends `${string}{${infer Slot}}${infer Rest}`
  ? Slot | SlotsOf<Rest>
  : never;

/** The keys without a slot: a table of them (a state to its word) is worded with `t(key)`. */
export type PlainKey = {
  [K in StringKey]: [SlotsOf<Strings[K]>] extends [never] ? K : never;
}[StringKey];

/** The values a key's slots take; a key without slots takes none. */
export type ParamsOf<K extends StringKey> = [SlotsOf<Strings[K]>] extends [never]
  ? []
  : [params: Readonly<Record<SlotsOf<Strings[K]>, string | number>>];

/** A key with the values of its slots, as a Refusal carries one across IPC. */
export interface Sentence {
  readonly key: StringKey;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** The line `key` with its slots filled. A slot without a value is left as written. */
export function t<K extends StringKey>(key: K, ...params: ParamsOf<K>): string {
  return fill(STRINGS[key], params[0]);
}

/** `t` for a key and values that arrive as data (a Sentence across IPC). */
export function sentence(value: Sentence): string {
  return fill(STRINGS[value.key], value.params);
}

function fill(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, slot: string) => {
    const value = params[slot];
    return value === undefined ? whole : String(value);
  });
}

/** The keys that come as a `.one`/`.other` pair. */
type PluralBase = {
  [K in StringKey]: K extends `${infer Base}.one` ? Base : never;
}[StringKey];

/** `base.one` when `n` is 1, else `base.other`, with `{n}` and any other slots filled. */
export function plural(
  n: number,
  base: PluralBase,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const key = `${base}.${n === 1 ? "one" : "other"}` as StringKey;
  return fill(STRINGS[key], { ...params, n });
}
