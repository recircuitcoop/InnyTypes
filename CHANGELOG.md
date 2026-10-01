# Changelog

All notable changes to InnyTypes are recorded here, newest first. Versions follow
[semantic versioning](https://semver.org/): the number changes when what you can rely on does.

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
