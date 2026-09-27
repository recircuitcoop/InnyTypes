# InnyTypes — Heuristic Evaluation (current build, 30 screenshots, 2026-09-27)

Scope: Nielsen's 10 usability heuristics applied to the 30 screenshots in `ux-capture/shots/`,
read against the intended product in plan 0017 (sources, nodes, views, flows; action views that
wait for a person; snapshots whose actions start new runs; Anytype as the reason the app exists).
The UI is known, unstyled scaffolding — most findings below are about **what happens and what is
said**, not about missing visual polish, because polish will not fix them.

## Summary

**20 findings**: 1 Critical, 7 High, 10 Moderate, 2 Low.

| Severity | Count | Meaning |
|---|---|---|
| Critical | 1 | Prevents a person completing a task |
| High | 7 | Significant difficulty or a wrong belief about what happened |
| Moderate | 10 | A workaround exists, but it costs the person something |
| Low | 2 | Cosmetic, or an accepted cost of the current scaffolding stage |

Three things are working and worth keeping as the app is styled:
- The snapshot's disabled "Run again" button explains itself in place ("Nothing is wired to the
  'Run again' output.") instead of hiding or silently failing (shot 15).
- The crash banner uses plain language and offers one clear recovery action, "Restart" (shot 30).
- Quitting with undeployed editor changes offers a non-destructive default and an explicit escape
  hatch: Deploy-and-quit / Quit-and-discard / Cancel (shot 29).

## Findings by heuristic, most severe first

### 10 — Help and documentation

**[Critical] No explanation of the product before the person is asked to operate it.**
Screen: 01 → 02. The very first thing shown is a telemetry consent question. The second is a bare
Node-RED canvas. Nobody has told the person what a source, node, view, flow, or snapshot is —
the whole vocabulary the plan is built on. A person who has never seen Node-RED has no way to
guess that this canvas is where their automations live.
Why it hurts: the product's entire value depends on a mental model (event → node → view →
snapshot) that is genuinely new. Dropped in cold, the person must reverse-engineer it from raw
editor chrome, or give up.
Direction: a one-time explanation of the four or five core concepts, shown before or instead of
the bare canvas, in the app's own words rather than Node-RED's.

**[Moderate] Anytype pairing gives no help finding "the code."**
Screen: 24. The form says "The code Anytype shows," with no pointer to where in Anytype to look.
Why it hurts: pairing is a one-time, easy-to-fumble step; a person who has Anytype open but
doesn't know where the pairing code lives is stuck with no recourse in-app.
Direction: name the exact screen/menu in Anytype, or link to it.

### 6 — Recognition rather than recall

**[High] The app's own vocabulary is never taught by the app.**
Screens: 02, 09, 11. Node labels ("Watch a folder", "Probe", "Ask (pop-out kit)") appear on the
canvas, but nothing in the chrome ever says "this is a *source*," "this is a *node*," "this is a
*view*." The person has to hold the plan's taxonomy in their head, supplied from outside the app.
Why it hurts: without in-app reinforcement, every return visit re-triggers the same "wait, what
is this again" the first visit did.
Direction: label node categories in the palette and canvas with the product's own terms (source /
node / view), not just as an internal grouping.

### 1 — Visibility of system status

**[High] Raw runtime diagnostics are shown permanently on every single screen.**
Screens: all 30, e.g. 02, 06, 18. "runtime — running — generation 3 · pid 31006 · port 50431" sits
above the navigation on every page, unconditionally.
Why it hurts: this is implementation detail (process ids, ports, restart-generation counters)
presented as if it were something the person needs to track continuously. It also eats screen
space that never varies except when something is actually wrong.
Direction: collapse this to a status pill ("OK" / "Problem — details") and only expand it when
there is something to say.

**[High] Anytype's settings status is stuck at "starting" on the very screen meant to show it paired.**
Screens: 24, 25, 26, 27, 28. Screenshot 25 is captured specifically to show "Settings after
completing Anytype pairing," yet the page still reads "Anytype: starting" — identical to 24, 26,
27 and 28.
Why it hurts: the one piece of status a person needs after pairing — did it work? — never changes
to say so. There is no way to tell, from this screen, whether pairing succeeded.
Direction: make "paired" (and "failed," separately from "starting") a real, distinct state shown
here.

**[High] A success message and a "nothing exists" message are shown at the same time.**
Screen: 17. Directly under "Created user.greeting.v1. The runtime restarts for it; the editor
keeps its edits." the same page says "No event types yet. Create one below."
Why it hurts: the person just watched their action succeed and is immediately told, in the same
breath, that it didn't happen. Trust in every other confirmation message on this page is now
suspect.
Direction: while the runtime is restarting to pick up the new type, say so ("Restarting to add
this type…") instead of showing the stale empty-state copy next to the success line.

**[Moderate] Cancelling a job doesn't change the job's own listed status.**
Screens: 18, 19. After pressing Cancel, the job entry ("inny-popoutkit-slow (slow1), attempt 1,
since …") is left exactly as it was; a separate, unrelated-looking line, "Cancel sent.", is
appended below it.
Why it hurts: "sent" is not "cancelled" — the person can't tell from this screen whether the job
actually stopped, is stopping, or ignored the request.
Direction: update the job row itself (e.g. "cancelling…" → "cancelled") instead of appending a
disconnected line.

**[Moderate] Snapshots, Events and Jobs only update on a manual click, with no sense of freshness.**
Screens: 03–07. Each list page has a "Refresh" button and nothing else — no auto-update, no "last
checked" time.
Why it hurts: for a workflow app where jobs can run 10+ minutes and inbox items can wait days
(per the plan), a person has no way to know whether an empty list is current or just stale since
their last click.
Direction: poll automatically, or at least timestamp the last refresh.

**[Moderate] Safety-relevant explanatory text is cut off at the bottom of the window.**
Screens: 27, 28. The launch-at-login caveat is visibly truncated mid-sentence ("…and this run is
not one"), with no visible affordance suggesting there is more below.
Why it hurts: this looks like it's explaining why a toggle won't do what's asked (running from an
uninstalled build) — exactly the kind of caveat a person needs before they conclude a setting is
broken.
Direction: don't let a fixed-height container hide the sentence that explains a control's limits.

### 2 — Match between system and the real world

**[Moderate] Timestamps are raw ISO-8601 with milliseconds and a UTC "Z".**
Screens: 14, 18. "2026-09-27T12:03:50.442Z" appears as the only rendering of "when."
Why it hurts: no ordinary person reads this format at a glance; it reads as a debug log line, not
as "3 minutes ago" or a local clock time.
Direction: humanize timestamps; keep the precise one in a tooltip if needed.

**[Moderate] Full filesystem paths are shown as if they were meaningful to the reader.**
Screens: 08/23, 21, 22. Settings shows two full absolute paths for where an Anytype API key file
would live; installing a package shows the full temp path of the folder being installed from.
Why it hurts: this is exactly the kind of detail a non-technical desktop-app user tunes out or is
frightened by, and it doesn't actually help them do anything differently.
Direction: state the plain consequence ("no Anytype key found yet") and put the path behind a
"details" disclosure for support purposes only.

**[Moderate] Installed packages are listed with no indication of what any of them do.**
Screens: 07, 20. "everycontrol 0.0.0 (shipped)", "folderflow 0.0.0 (shipped)", "popoutkit 0.0.0
(shipped)", etc. sit next to "anytype 0.1.0 (shipped)" with equal weight and zero description.
Why it hurts: a person auditing what's installed on their machine (which this page exists for)
can't tell a real capability from a test fixture, or judge whether any of it is something they
want running.
Direction: every listed package needs at least a one-line "what this does."

### 4 — Consistency and standards

**[High] Critical prompts look exactly like ordinary navigation.**
Screens: 29, 30. "Deploy and quit / Quit and discard / Cancel" and "Restart" render as the same
plain, same-sized buttons as "Editor / Inbox / Snapshots …" directly below them.
Why it hurts: a one-way, consequential decision (discard my edits? give up on a crashed runtime?)
carries no more visual weight than switching pages. It is easy to miss that a decision is being
asked at all, or to misjudge how serious it is.
Direction: this needs the visual language of a dialog, not a row of buttons that reads like more
nav — even before real styling exists, position/borders/grouping can do this.

**[Moderate] The same running thing is identified two different ways on two different pages.**
Screens: 11 vs 18. The canvas calls it "Probe"; the Jobs page calls the same running work
"inny-popoutkit-slow (slow1)". Nothing ties the two names together for the person reading Jobs.
Why it hurts: a person trying to find "the folder-watch flow" in Jobs has no way to match it to
what they see on the canvas.
Direction: carry the node's canvas label through to every other screen that refers to it.

### 3 — User control and freedom

**[High] "Dismiss" on a pending action doesn't say what it does to that action.**
Screen: 13. The pop-out action view offers "Submit" and, separately, "Dismiss," with no
indication of whether Dismiss discards the pending request or just closes the window (the plan
promises a pending action survives being closed and is never silently dropped — but the button
itself gives no such assurance).
Why it hurts: a person who wants to "deal with this later" has to guess whether the safe move is
to close the window (untouched by any labelled button) or to click a button labelled "Dismiss,"
which sounds final.
Direction: rename or split the control so "close, still pending" and "discard this request" (if
that even exists) are never the same word.

**[Moderate] "Quit InnyTypes" sits in the main navigation row with no separation from ordinary pages.**
Screen: 02 (present on every screen). It is one button among eight, styled identically to
"Editor" or "Jobs."
Why it hurts: quitting a desktop app that runs long jobs and holds pending actions is not a
same-weight action as switching tabs; a misclick costs more here than anywhere else in the row.
Direction: move Quit out of the page-switching row entirely (menu, or a visually separated
corner control).

### 9 — Help users recognize, diagnose, and recover from errors

**[Moderate] The crash banner appears above a UI that is otherwise frozen mid-action.**
Screen: 30. "The InnyTypes runtime stopped unexpectedly 5 times in 2 minutes… Press Restart to
try again" is correct and readable, but it sits above the exact same stacked "Node added to
palette" tooltips and half-open node-edit form that were on screen before the crash.
Why it hurts: the person gets a clear message about the runtime, but the rest of the window looks
like nothing happened, or like their in-progress edit is still live when it may not be.
Direction: when the runtime is down for good, the rest of the screen should visibly reflect that
(disable/grey the canvas) rather than leaving stale interactive-looking chrome in place.

### 8 — Aesthetic and minimalist design

**[Moderate] Multiple toast/tooltip notifications stack and can cover the working canvas.**
Screen: 29. "The flows on the server have been updated," two separate "Node added to palette"
tooltips, all stacked, only one with a "Done" dismiss — together they occlude the node the person
was just working on.
Direction: cap simultaneous notifications, or collapse related ones ("2 node types added") into
one line.

**[Low] The whole app is unstyled browser defaults.**
Screens: all 30. Acknowledged as the current scaffolding stage, not re-raised heuristic by
heuristic below — but flagged once because several findings above (destructive prompts looking
like nav, diagnostics crowding every page) will only partly improve with styling; some are
structural, not decorative.

### 7 — Flexibility and efficiency of use

**[Low] No shortcuts, bulk actions, or non-manual refresh anywhere outside the editor.**
Screens: 03–07. Expected at this build stage; noted so it isn't lost once the product stabilizes.

## Information architecture, as it is today

Top-level nav (present, identically styled, on every screen): **Editor · Inbox · Snapshots ·
Events · Jobs · Packages · Settings · Quit InnyTypes**.

| Item | Holds | Altitude |
|---|---|---|
| Editor | The Node-RED canvas: build and deploy flows | Build |
| Inbox | Pending action views waiting on the person, with a badge | User task |
| Snapshots | Recorded views of what a flow produced, each re-triggerable | User task |
| Events | Create/list event *types* (the schema of what can travel on a wire) | System/runtime concept |
| Jobs | Currently-running node processes, with cancel | System/runtime concept |
| Packages | Installed node packages, catalogue, install-from-file | System/runtime concept |
| Settings | Secrets, MCP endpoint, Anytype pairing, launch at login, telemetry | Configuration |
| Quit InnyTypes | Exits the app | Action, mis-scaled as nav |

**It is organised by system parts, not by user tasks.** Four of the seven real destinations
(Editor, Events, Jobs, Packages) are runtime/architecture concepts straight out of the plan's own
vocabulary table — a person doesn't arrive wanting to look at "Events" or "Jobs" for their own
sake, they arrive wanting to know "what needs me" (Inbox), "what happened" (Snapshots, and really
also Jobs history), or "let me build something" (Editor). Putting Events and Jobs at the same nav
altitude as Inbox and Snapshots mixes "here is what Node-RED is doing internally" with "here is
what you, the person, asked for or are waiting on." Quit is scaled as if it were an eighth
destination rather than an exit.

## Top 10 to fix

1. Explain the source → node → view → flow → snapshot model before or instead of dropping a
   person straight onto the bare canvas (Critical, H10).
2. Collapse the permanent pid/port/generation diagnostics into a status pill shown on every page
   (High, H1/H2).
3. Make "paired" a real, visibly different state from "starting" in Anytype settings (High, H1).
4. Stop showing "Created X" and "No event types yet" on screen together after creating a type
   (High, H1).
5. Clarify what "Dismiss" does to a pending action view — keep it pending, or drop it, but say
   which (High, H3).
6. Give destructive/critical prompts (quit-with-edits, restart-after-crash) their own visual
   weight, separate from ordinary page-navigation buttons (High, H4/H5).
7. Stop truncating safety/explanatory text (telemetry, launch-at-login) at the bottom of a
   fixed-height box (High, H1/H9).
8. Reflect a cancelled job's new status on the job row itself, not as a separate appended line
   (Moderate, H1).
9. Carry a node's canvas label through to the Jobs page instead of showing an internal id there
   (Moderate, H4).
10. Reorganise the nav around what a person is trying to do (what needs me / what happened /
    build something / configure) instead of the runtime's own part names (Events, Jobs, Packages
    as peers of Inbox and Snapshots) (Moderate–High, IA).
