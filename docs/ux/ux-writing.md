# UX writing: voice, vocabulary and the strings

Written 2026-09-27, on top of `strategy-brief.md` and `interaction-design.md`. Status: draft for the
owner. This is the wording the redesign uses; the build takes its strings from here. Nothing here
changes code yet. Revised 2026-09-28 for the three surfaces: Setup, Configuration (tabs Flows and
General) and Live.

## Voice

InnyTypes speaks like a capable assistant who has just done something for you and tells you in one
line. It is calm, specific and plain. It names things by what you call them (your recorder, your
spaces, your customers), never by how it is built.

| Do | Don't |
|---|---|
| "Filed 3 summaries in Renaissance." | "Run 8f2c completed: 3 objects created." |
| "Not paired with Anytype yet." | "no Anytype API key in /Users/.../anytype_api_key" |
| "Waiting for you: who spoke?" | "Action view pending (input 22783672)" |
| "Couldn't reach Anytype. Is it running?" | "ECONNREFUSED 127.0.0.1:31009" |
| "Transcribing, about 12 minutes left." | "innyrize-diarize (n1): 71% (640s of 900s)" |

**Rules**
- Second person, active voice, present tense for state and past tense for what got done.
- Front-load the outcome: what happened first, then why, then what to do.
- One idea per line. Under 60 characters where it must be scanned (cards, notifications, buttons).
- Nothing internal ever reaches the screen: no ids, pids, generations, ports, paths, type keys or
  package names. Those go to the log.
- Numbers are specific: "about 12 minutes", "3 summaries", never "some".
- Errors say what failed, the likely cause, and what to do. No blame, no codes, no dead ends.
- No exclamation marks, no jokes, no apologies.

## Vocabulary

The words the app uses, and the words it never uses. Terms in the plan's own architecture language
stay in the docs and the code; the person sees the left column only.

| The person sees | Never | Meaning |
|---|---|---|
| **flow** | pipeline, workflow, graph | One automation drawn on the canvas |
| **step** | node, node instance, type | One node of the flow, shown by its name on the canvas |
| **source** (in the palette only) | trigger, event source | A step that starts a flow |
| **question** | action view, HITL, present | A step where the flow waits for you |
| **result** | snapshot, snapshot view | What a finished run made, and where |
| **run** | job, execution, input | One recording (or event) going through a flow |
| **recorder** / **folder** | volume, mount, watcher | Where recordings come from |
| **space** / **object** / **type** | space id, type key | Anytype's own words |
| **template** | blueprint | A ready-made flow to fill in |
| **package** | node package, addon, plugin | Something installed in Configuration › General (or picked in Setup); each one adds steps to the palette |
| **board** | dashboard, layout, grid | A flow's page in Live; one per flow |
| **tab** | page, sheet, view | One page of a board; a board has one or more |
| **place** | slot, cell, widget, panel | Where one card, question or result sits on a board. "Slot" stays in the docs and code; on screen it is "place", and only in Edit layout |
| (the result line itself) | sink, event sink, output | Where a flow's result ended: "Meeting notes → *Renaissance*", "Moved recording to *Archive*". The person never sees a word for it, only what happened |
| **Anytype** | MCP child, services | Always by its name |
| **canvas** | editor, Node-RED | Where a flow is edited |
| **waiting for you** | pending, awaiting | A question not yet answered |
| **failed** | error, exception, refused | A step that could not finish |
| **on** / **off** | enabled, disabled, deployed | A flow's switch |

Node-RED's own words ("Deploy", "flow tab", "palette") stay inside the canvas; the app's pages say
"Save and run" for deploy where they wrap it.

## Navigation and page titles

The app has three surfaces, one at a time in the window. Setup has no navigation entry once the
first run is over; the navigation then holds Configuration and Live.

| Surface | Title | One-line purpose (shown when empty) |
|---|---|---|
| Setup (first run only) | **Set up InnyTypes** | (the screens below; never shown again) |
| Configuration › Flows | **Configuration**, tab **Flows** | "No flows yet. Start from a template, or open a blank canvas." |
| Configuration › General | **Configuration**, tab **General** | (sections below; never empty) |
| Live, no flow yet | **Live** | "Nothing lives here yet. Make a flow in Configuration › Flows." · [Go to Flows] |
| Live, a flow with nothing running | **Live**, the flow's name beside it | "Waiting for a recording. Plug in your recorder, or drop a file in a watched folder." |
| Live, a tab with no places | the tab's name | "This tab is empty. Choose Edit layout to move things here." |

The flow picker in Live is labelled **Flow**; switching it switches the board.

The status indicator, top right, is one word: **Running**, **Restarting…**, **Stopped**, or
**Needs attention**. Its tooltip holds the details.

## The first run (Setup)

Shown once, in this order. It ends with the starter-flow choice; after that, Setup never shows
again.

| Screen | Title | Body | Buttons |
|---|---|---|---|
| Welcome | **Welcome to InnyTypes** | "InnyTypes turns your recordings into notes, summaries and next steps, in Anytype and wherever else you point it, on its own. Set it up once. It takes about ten minutes." | Get started |
| Reports | **Help improve InnyTypes?** | "Send anonymous crash reports and usage counts. Never your recordings, transcripts or notes. You can change this in Configuration › General." | Send reports · Don't send |
| Anytype | **Connect Anytype** | Running: "Anytype is asking for a code. Type it here." Not running: "Open Anytype, then come back. InnyTypes will notice." | Connect · Skip for now |
| Anytype, done | | "Connected. Found 8 spaces." | Continue |
| Recorder | **Your recorder** | "Plug in your recorder now. InnyTypes will process every new recording on it." When found: "Found *BOYA*. Use this recorder?" | Use this recorder · Use a folder instead · Set up later |
| Packages | **Choose your packages** | "These come with InnyTypes. Each one adds steps you can use in your flows. You can add others later in Configuration › General." Rows: "*monty*: watches your recorder and folders." "*innyrize*: transcribes and tells who spoke." | Continue |
| Starter flow | **Start with a simple flow?** | "InnyTypes can install a ready-made flow now: your recordings are transcribed, summarised and filed. You can change every step later. Or build your own from scratch." | Install the simple flow · I'll build my own |
| Node forms (after Install) | **Set up: *step name*** (one per step) | The step's own form. Progress: "Step 3 of 7." | Continue · Back |
| Ready (after Install) | **Ready** | "Your flow is on. Plug in the recorder or drop a file to start. Or try it now with a 10-second sample." | Try with a sample · Open Live |

"I'll build my own" closes Setup and opens Configuration › Flows, with **New flow** in view.

## Live: the board

Each flow has one board. The flow decides what is on it (its cards, questions and results); the
person decides where each sits and how big, in **Edit layout**.

**Top of the board:** **Flow** picker · the board's tabs · **Edit layout**.

**Edit layout:**
- Entering: button **Edit layout**. A bar appears: "Editing the layout of *Recordings to
  Anytype*. Drag to move, drag a corner to resize." · **Done**
- Leaving: **Done**. The changes are kept; there is no separate save.
- Add a tab: **Add tab** · a new tab named "New tab", its name selected for typing.
- Rename a tab: double-click its name.
- Remove a tab: **Remove tab** on the tab. If it holds anything: "**Remove the tab *Customers*?**
  What's on it moves to the first tab. Nothing is deleted." · [Remove tab] [Cancel]. The last tab
  can't be removed: "A board needs at least one tab."
- Hide a place: **Hide** on the place. Its tooltip: "Hidden from the board. Questions and failures
  from it still reach you."
- Show hidden places: **Hidden (2)** in the bar opens the list · each row: the place's name ·
  **Show**. With none hidden, the button is not shown.
- A new place from a changed flow: "New on the board: *Approve sending*." (once, in the Edit
  layout bar)

**Card title:** the recording's name, and its length: "*2026-09-27 client call* · 48 min".

**Step line**, one of:
- "**Copying** from BOYA…" then "**Safe to unplug.**"
- "**Transcribing**, about 12 minutes left."
- "**Summarising** (2 of 3)."
- "**Filing** in *Renaissance*…"
- "**Waiting for you:** who spoke?" · button: **Answer**
- "**Waiting for you:** send to *Fritte Reinvention*?" · buttons: **Send** · **Not now**
- "**Failed** at *Transcribe*: Mistral refused the key. Check the key in the *Transcribe* step." ·
  **Retry**
- "**Resumed** after restart."
- "**Done.** 3 summaries in *Renaissance*, 2 next steps scheduled." · links
- "**Done.** Recording moved to *Archive*." (a flow with no Anytype end)

The step name is the node's name on the canvas, in bold. Never the type.

**Result lines.** One per thing the flow did. A flow's result may be in Anytype or elsewhere;
never assume Anytype.
- In Anytype (a link that opens the object): "Meeting notes → *Renaissance*" · "Customer brief →
  *Fritte Reinvention*"
- A scheduled step (a link to the task or calendar entry): "Follow up on pricing · due Thursday"
- A file moved (a link that opens the folder): "Moved recording to *Archive*"
- A file deleted (plain text): "Deleted the recording"
- Something sent elsewhere, by the node's own words: "Sent the summary to *Fritte Reinvention*"

**Result actions** (from the flow's own result step): "Summarise again", "Send to *space*",
"Re-run from transcription".

## Questions (view nodes)

**In a notification** (title, body, up to three buttons):
- "Who is speaker 2?" · "*client call*, 48 min" · [Marie-Lise] [Valerie] [Someone else]
- "Send the customer brief to *Fritte Reinvention*?" · "From *client call*" · [Send] [Not now]
- "Which customer is this?" · "*2026-09-27 client call*" · [Fritte] [Renaissance] [Choose…]

**In a pop-out window:**
- Title: the question. Subtitle: the recording's name and length.
- Form fields pre-filled with the best guess, marked "Suggested".
- Buttons: **Continue** (primary) · **Later** · **Skip this step**
- "Skip this step" confirms once: "Skip *Name the speakers*? The flow continues without names.
  This can't be undone for this run." · [Skip] [Keep waiting]
- A question left open shows "Waiting since Tuesday" on its card.

## Notifications (besides questions)

- Start: "Processing *client call*, about 12 minutes." (stops after five good runs)
- Done: "Filed: 3 summaries in *Renaissance*." · [Open in Anytype]. With no Anytype end, the first
  result line: "Done: moved *client call* to *Archive*." · [Open]
- A question or failure from a hidden place on the board is notified exactly as any other.
- Failed: "Couldn't finish *client call*. Transcription failed: Mistral refused the key." · [Retry] [Open]
- Runtime: "InnyTypes stopped unexpectedly and is restarting." Then, if it gives up: "InnyTypes
  stopped 5 times in 2 minutes and won't restart on its own." · [Restart]
- Update: "InnyTypes 1.1 is ready. It installs when you quit." · [Quit and update] [Later]
- Package: "*monty* 0.3 is available." · [Update] [Not now]

## Configuration › Flows

- Tabs at the top of Configuration: **Flows** · **General**.
- Row: flow name · **On**/**Off** switch · "Last run: today, 14:20 · done" · **Edit** · **Run history**.
- Health, in one phrase: "Ready", "1 step not set up", "Failing since Monday".
- New: **New flow ▾** → "From a template" · "Blank canvas".
- Deleting a flow: "Delete *Recordings to Anytype*? Its run history is deleted too. Runs in
  progress are stopped." · [Delete] [Cancel]
- Templates: under **New flow ▾ → From a template**, each as a card: name and one line, e.g.
  "Recordings to Anytype: transcribe, summarise, file, approve, send, schedule." · [Use this
  template]
- A step's form, placed on the canvas: its choices of space and type are read from Anytype as the
  form opens: "Reading your spaces…", then the list. Not paired: "Pair with Anytype in
  Configuration › General to choose a space."

## Configuration › General

Settings about no single flow; it replaces the old Settings page and the old list of packages.
Sections, each with a one-line state:
- **Anytype:** "Connected · 8 spaces" / "Not paired yet." · **Pair** / **Pair again**. Never a path.
- **Recorders and folders:** "BOYA · watching" · **Add a folder…**
- **AI apps** (the MCP endpoint): "Claude, Codex and other apps can use your Anytype through
  InnyTypes at `127.0.0.1:31010`." · **Change port** (pre-filled with the current port) · **Copy
  setup for Codex** etc.
- **Start at login:** switch · "InnyTypes starts when you log in."
- **Updates:** "Up to date · 1.0.3" · "Check automatically" switch.
- **Reports** (telemetry): "Sending anonymous crash reports." / "Not sending." · switch · **See
  what would be sent** (the queued reports, in full).
- **Packages:** "4 installed · 1 update" · each row: name · version · "Installed" / **Install** ·
  "Update to 0.3" · "by *publisher*" · a small "Unsigned" label where it applies · **Remove**.
  **Add a package…** installs one that doesn't come with InnyTypes.
  - Unsigned install, as a dialog: "**Install an unsigned package?** Nobody vouches for this code.
    It will run with your permissions." · [Install anyway] [Cancel]
  - Removing a package in use: "Can't remove *innyrize*: the flow *Recordings to Anytype* uses
    its *Transcribe* step. Remove that step first."
- **Advanced:** the status details (runtime, services, ports) live here, for support.

## Errors, by pattern

| Situation | Text |
|---|---|
| Anytype not reachable | "Couldn't reach Anytype. Is it running? InnyTypes will retry on its own." |
| Key refused | "Anytype refused the key. Pair again in Configuration › General." |
| Transcription key refused | "Mistral refused the key. Check the key in the *Transcribe* step." |
| Recorder full or unreadable | "Couldn't read *BOYA*. Unplug it and plug it back in." |
| A step's form incomplete | "*Summarise* isn't set up yet: choose an object type." |
| Port taken | "Port 31010 is used by another app. Choose another port." |
| Update download tampered | "The update didn't pass its safety check and wasn't installed. Try again later." |
| Runtime down for good | "InnyTypes stopped unexpectedly 5 times in 2 minutes, so it's no longer restarted. Press Restart to try again." (kept as is) |
| Quit with unsaved canvas edits | "**Save your flow before quitting?** Unsaved changes on the canvas are lost otherwise." · [Save and quit] [Quit without saving] [Cancel] |

## The Node-RED canvas

The canvas keeps Node-RED's words inside it. Around it, the app says:
- above the canvas: the flow's name and **Save and run** (Deploy), with "Unsaved changes" when
  dirty;
- the palette categories: **Sources**, **Steps**, **Questions and results**;
- a step's form title: the step's name, with its package below in small text.

## Accessibility of the words

- Every icon-only control has a text label for screen readers, from this list.
- State is never colour alone: "Failed" is written, not only red.
- Times are relative and absolute on hover: "Tuesday" (2026-09-23, 14:20).
