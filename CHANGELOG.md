# Changelog

All notable changes to InnyTypes are recorded here, newest first. Versions follow
[semantic versioning](https://semver.org/): the number changes when what you can rely on does.

## 0.3.0 — 2026-10-15

A new window. The seven pages of 0.2 (Editor, Inbox, Snapshots, Events, Jobs, Packages and
Settings) are replaced by three places: **Setup**, **Live** and **Configuration**. Your flows,
packages, pairing and settings from 0.2.1 are kept. A pre-release for macOS; see
[docs/INSTALL.md](docs/INSTALL.md).

- **Setup, once.** A new installation opens on a short walkthrough: Welcome, Reports, Connect
  Anytype, the folder to watch, the steps of a starter flow, and Ready, where you can try the flow
  with a 10-second sample. Quit halfway and it picks up where you were. If you already used 0.2.1
  with flows, you never see it.
- **Live.** Each flow has its own board, with its runs as cards that show each step as it
  happens. A question waits on the board with **Answer** and **Skip this step**, and the badge on
  Live and on the dock counts the questions waiting. Arrange a board with **Edit layout**: tabs,
  sizes, and places you hide (a hidden place still brings you its questions and failures).
- **Configuration › Flows.** Turn a flow on or off, rename, duplicate, export or delete it, start
  a new one from a template or a blank canvas, and edit it on the canvas with **Save and run**.
  Each flow says whether it is ready, how many steps are not set up yet, or since when it fails.
- **Run history.** Every run of a flow is listed, newest first, with a filter and a search.
  **Re-run** starts a run again, from the start or from one of its steps, and **Delete** removes
  runs and stops the ones still in progress. Runs are kept for 90 days unless you choose
  otherwise in General.
- **Configuration › General.** Anytype pairing, the folders watched, the address your AI apps use,
  start at login, updates, reports, how long runs are kept, and an Advanced section for support.
- **Packages in General.** Install from the catalogue or from a folder on this Mac, update,
  register or unregister, remove, and go back to the version before an update for 7 days. A
  package that is in use says which flows and steps use it before it can be unregistered or
  removed.
- **The address your AI apps use** has its Address field again, beside Port, and **Change** moves
  both at once without a restart. Only an address on your own Mac is accepted.
- **Set up ChatGPT.** General › AI apps lists the steps to add InnyTypes in the ChatGPT desktop
  app's own Settings, with **Copy address** and **Copy token** for the two values it asks for.
  The token is never shown. **Copy setup for Codex** stays, for Codex in a terminal.
- **Downloading a file through your AI app works.** A file from Anytype, a PDF or an image as
  much as a text, now comes back intact, up to 16 MB (ask for part of a larger one), and a large
  file no longer stops the Anytype tools. This fixes the known issue of 0.2.1.
- **Reports, only after a yes.** The question comes with the full privacy notice: what is sent,
  what never is, how long it is kept. If you say yes, usage counts are sent to Umami Cloud under a
  machine id that carries no name. Nothing is sent before you answer, and crash reports are not
  sent at all yet.
- **Easier to use.** Every screen and dialog works with the keyboard and a screen reader, follows
  your Mac's light or dark appearance, respects "Reduce motion", and is set in IBM Plex.
- **Updates and Go back.** General › Updates shows the version you run and checks for a new one.
  0.3.0 is the first version that records which version it is, so it has nothing to go back to:
  from the next release on, you can go back to the version before an update for 7 days, and a
  version that keeps crashing in its first minutes offers to go back (it never does so on its
  own). This pre-release is not yet connected to a release channel: install the next version from
  its download.

### What went away, and where it went

- **The Quit button in the window.** Quit from the InnyTypes menu (⌘Q) or the dock. Closing the
  window still keeps InnyTypes running.
- **The Inbox.** Questions wait on their flow's board in Live and open in their own window.
- **The Jobs page.** Live shows each run's steps on its card. To stop a run, delete it in Run
  history; a single step can no longer be cancelled on its own.
- **The Snapshots page.** Snapshots are still recorded, but the window does not show them; use
  **Re-run** in Run history to start a run again. Opening snapshots comes back in a later version.
- **The Events page.** Event types can no longer be made in the window. This comes back in a
  later version, as a setting of a flow's source.
- **Registering package sources in the window.** The window no longer lists, adds, removes or
  switches sources. A source you registered in 0.2.1 keeps working: its verified packages are
  offered under **Add a package… › From the catalogue**, beside the official ones (the official
  package wins when both have the same name). A new source can only be added by editing
  `shell-settings.json` by hand.
- **Check for updates, Apply and Install from file for packages.** Packages are checked at start
  and on their schedule, a row with a newer version offers **Update**, and **Add a package… › From
  a folder on this Mac…** takes a folder (no longer a `.tgz` file).
- **The canvas keeping in step while open.** The canvas loads afresh each time you open it.
  Leaving it drops changes not yet saved with **Save and run**, without asking.
- **The automatic rollback of InnyTypes' own update.** Replaced by Go back, which you choose.

## 0.2.1 — 2026-10-01

- The packaged app can start the Anytype MCP child again: it is unpacked beside the archive, where the bundled Node can read it. 0.2.0 served the endpoint but every Anytype call failed.
- Known issue, also in 0.1.0: a file downloaded through the endpoint (`API-download-file`) comes back damaged unless it is text, and one larger than about 1 MB stops the Anytype tools for up to about two minutes (in 0.1.0, until InnyTypes is quit and opened again). Fixed in the next version.

## 0.2.0 — 2026-10-01

A new application, rebuilt from scratch: InnyTypes is now a workflow orchestrator on an embedded
Node-RED canvas. A pre-release for macOS; see [docs/INSTALL.md](docs/INSTALL.md).

- **Flows on a canvas.** Draw a flow from sources (a recorder or a watched folder) and steps
  (transcribe, summarise, create an Anytype object), and turn it on. Only steps from installed
  packages appear in the palette.
- **Questions and results.** A step that needs you waits in the Inbox, with a notification and its
  own window. What a finished run made is kept on the Snapshots page, and runs in progress are on
  the Jobs page.
- **Runs survive a crash.** Every run is journaled. If the engine stops, it restarts on its own and
  picks each run up again at the step it was on.
- **Packages.** Install, update and remove packages from the Packages page, from the catalogue or
  from a file. Signed packages are checked before they run; an unsigned one asks first.
- **Pair with Anytype in Settings.** Type the four-digit code Anytype shows. The key stays in the
  same owner-only file as before, so an existing pairing carries over.
- **Your Anytype for your AI apps.** Claude, Codex and other MCP clients reach the Anytype tools at
  `http://127.0.0.1:31010/mcp` with a bearer token. The port can be moved in Settings without a
  restart.
- **Updates.** The application can update itself from GitHub Releases and installs an update only
  when its signature checks out. This pre-release is not yet connected to a release channel:
  install the next version from its download.
- **Your choice on reports.** Anonymous usage and crash reports are asked about once, on first
  launch, and nothing is sent before you answer.
- **Moving from 0.1.0.** Settings from the old installation are imported once, and the old
  launch-at-login entry is replaced.

0.1.0 was the previous application, written in Python; its notes follow below.

## 0.1.0 — 2026-09-18

The first version. One icon starts Anytype, the InnyTypes host, the Anytype MCP server and every
installed addon, and one Quit stops them all again.

### The application

- **Start everything from one icon.** Opening InnyTypes starts the helper, which starts Anytype —
  or adopts the one you already had running — and then the host, which starts the MCP server and
  your addons.
- **Turn it all off, easily.** Quit InnyTypes in the window, ⌘Q, the Dock menu, `innytypes quit`,
  logging out, or stopping the helper from Activity Monitor: each stops everything, and nothing
  starts itself again afterwards. `innytypes quit --force` stops a hung application. An Anytype
  that was already running when you started is left running.
- **A window, and no icon in the system tray.** It shows what is running, what has been given up
  on, updates waiting to be installed, the telemetry and launch-at-login switches, and Quit.
  Closing it leaves the application running; clicking the icon again brings it back.
- **Degrades instead of refusing.** With no Anytype API key, or with Anytype not running, the MCP
  server does not start, the host says why, and everything that does not need Anytype keeps
  working.

### Watching and restarting

- **One restart policy, in the helper.** A process that exits, hangs or uses too much is restarted
  with an increasing delay, a configurable number of times, and the helper never sleeps through a
  delay it is waiting on.
- **A process that keeps failing is left alone.** After five interventions in ten minutes it is
  quarantined and you are told; `innytypes helper release <id>` lets it try again. A quarantined
  host does not stop the helper watching and reporting.
- **It will not kill the wrong program.** Before signalling anything, the helper checks the
  process id, its start time and its executable together. A recorded id that now belongs to some
  other program is forgotten, never signalled.
- **Leftovers are cleaned up.** Children of a host that died are stopped before a new host starts,
  so nothing runs twice holding the same sockets.

### Addons

- **Each addon lives in its own environment**, installed explicitly with
  `innytypes addons install <addon>==<version>`, locked with hashes so what is installed is
  exactly what was resolved.
- **Addons talk over a bounded event bus.** An addon publishes and subscribes by event kind; a
  subscriber that hangs or falls behind is dropped and announced, and never delays anyone else.
- **Updates move as a transaction.** `innytypes addons outdated` shows what is available and why
  anything is held back; `innytypes addons update` applies it. Plugins that depend on each other
  update together, and a group that fails to start is put back as a whole.

### Anytype and its MCP server

- **The API key stays out of the way.** `innytypes anytype-mcp get-key` obtains it and stores it
  readable only by you; it is never printed, logged or included in an error.
- **The tools the server exposes are recorded**, so changing either pinned version shows exactly
  which tools were added, removed or reshaped.

### Updates to InnyTypes itself

- **Downloaded in the background, installed when you quit**, never while starting up. Every
  release is checked against its checksum and its signature before it is kept, and anything that
  fails either is deleted.
- **Undone if it will not run.** A new version that does not come up healthy is rolled back, and
  that version is not offered again.

### Telemetry

- **Off until you answer.** Nothing is sent, and nothing is even queued, before the first-launch
  question. `innytypes telemetry off` stops it at once and empties the queue;
  `innytypes telemetry show` prints exactly what would be sent.
- **Nothing of yours leaves the machine.** No Anytype content, names, credentials, file contents,
  transcripts, environment values, home paths, user names or host names. Reports are identified
  by a hash of the machine, which is never the machine's own identifier.

### Platforms

- macOS is built and tested end to end. A Linux package builds in a container. Windows is
  supported in code — the registry machine id, toast notifications and the quit-time updater —
  but a Windows package must be built on Windows.
- The application is not code-signed yet, so the first launch shows the operating system's
  warning about an unidentified developer.
