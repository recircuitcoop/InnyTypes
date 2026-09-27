# Interaction design: the four key moments

Written 2026-09-27, on top of `strategy-brief.md`, and corrected the same day after the owner's
answers: **the pipeline is a Node-RED flow made of node definitions; the app is the runtime and the
shell.** Nothing below hard-wires a pipeline step into the app. Status: draft for the owner.

## The app's posture

InnyTypes has three postures, and each moment below uses one of them:

| Posture | When | What that means for the design |
|---|---|---|
| **Background** (most of the time) | Watching the recorder and folders, transcribing, summarising, filing | Invisible while working. It speaks only when it needs the person or when something went wrong. A status indicator in the menu bar or tray, not a window. |
| **Brief** (seconds to a minute) | A question for the person; a glance at progress or a result | Obvious, few choices, remembered answers. It should be answerable without opening the main window. |
| **Focused** (minutes) | Editing a flow on the canvas, or the first run | The full window, dense information, keyboard shortcuts. |

The person is a *perpetual intermediate*: they set it up once, then live with it. The design
optimises for the hundredth recording, not the first, while the first must still work in ten
minutes.

## Moment 1: First run (focused, once)

**Goal:** a working pipeline within ten minutes of installing, with no canvas.

**Trigger:** the first launch.

**Rules, as a sequence of screens.** Each screen has one job and a Back button. Nothing is
skippable that the pipeline needs; everything else is.

1. **Welcome:** one sentence on what InnyTypes does, in the owner's terms: *records → transcript →
   summaries → Anytype → next steps*. **Continue.**
2. **Connect Anytype.** If Anytype is running, the four-digit pairing code; if not, "Open Anytype"
   and a wait. On success, the person's spaces and their object types are read, so every node form
   that follows can offer real choices. Which space is "mine" and which are customers' is decided in
   the nodes, not here.
3. **Your recorder.** "Plug in the recorder now." When a drive appears, its name and volume ID are
   shown, and the person confirms it. This is the step that makes step 1 of the job start with no
   clicks from then on. A folder can be chosen instead.
4. **Choose a flow template.** The owner's pipeline is offered as a template from the Library:
   recorder → transcribe → summaries → Anytype → analyse → approve → send → schedule. Choosing it
   installs the node packages it needs.
5. **Fill in the template's node forms**, one node at a time, in the order the event passes
   through them. Each form is the node's own configuration form; the app only sequences them and
   feeds them Anytype's spaces and types. For the owner's template: the transcription key and the
   usual speakers; each summary node's type and its Anytype object type; the customer spaces the
   send node may target; the scheduling node's targets. A node left unconfigured is shown as such
   on the flow, and the flow can be switched on once every node is ready.
6. **Telemetry**: the consent question, whole and with its buttons visible.
7. **Done.** The flow appears switched on, on the Today screen: "Waiting for a recording." A
   **"Try it with a test recording"** button runs the whole flow on a bundled 10-second sample, so
   the person sees the first result inside the first ten minutes.

**Feedback:** each step confirms what it found in the person's own words ("Found *BOYA*", "Read 14
types from *Renaissance*"), never a path or an id.

**Edge cases defined:**
- Anytype not installed: a link and a "Continue without Anytype for now" that leaves the flow
  switched off, with a reminder on Today.
- No recorder yet: "Set this up later" leaves a folder watcher instead.
- Pairing refused: the reason in one sentence, and Retry.
- Quitting mid-setup: it resumes at the same step next time.

## Moment 2: Plug in, and see progress (background, then brief)

**Goal:** from plugging the recorder in to filed summaries, with the person doing nothing unless
asked. *"I need to connect the recording device and process the recordings immediately."*

**Trigger (system):** the recorder mounts.

**Rules:**
- Processing starts within seconds, with no confirmation. The person confirmed the device once at
  setup.
- Every new recording on the device becomes one **run**, shown on Today as a card: the recording's
  name and length, the node it is at, and a progress bar for long steps. **The steps shown are the
  flow's own nodes**, named as on the canvas, in the order the event passes through them; change
  the flow and the card's steps change with it. The app has no fixed list of steps.
- Steps run in order per recording, and recordings run in parallel up to a limit.
- The person can **eject the recorder as soon as copying is done**. The card says "Safe to unplug"
  the moment the file is copied, because a person standing at the desk with a recorder in hand
  should not wait for the transcript.
- The laptop sleeping or the app quitting does not lose the run; it resumes, and the card says
  "Resumed".

**Feedback, by attention level:**
- **Menu bar / tray icon:** a small dot for "working", a number for "waiting for you", a warning
  colour for "something failed". No window opens by itself.
- **One notification at the start** ("Processing *2026-09-27 meeting.wav*, about 12 minutes"), and
  **one at the end** ("Filed: 3 summaries in *Renaissance*", with a button that opens the Anytype
  object). Nothing in between unless a question or an error.
- **The Today card**, when the person looks: the step, the time left, and what is done. Names,
  never ids.

**Loops:** feedback diminishes with repetition. After the first five successful runs, the start
notification stops; the end notification and questions stay.

**State machine of a run, as the person sees it** (the nodes here are the owner's template's; any
flow substitutes its own):

```
[source] → [node] → [view: waiting for you?] → [node] → … → done
   │          │               │                  │           │
   └──────────┴───────────────┴──────────────────┴─ failed (with retry) ─┘
```

Each node has three visible states: running (progress), waiting for you (a view), and failed (the
reason and a Retry). "Done" opens the result.

## Moment 3: The question (brief)

**Goal:** the flow stops for the one thing only the person knows, and gets an answer without pulling
the person into the app.

**Trigger (system):** an action view node in the flow is presented. Which questions exist, and
where they sit, is the flow's configuration; the approval before sending to a customer space is one
such view node.

**Rules:**
- The question is asked **in the notification** when it can be answered with buttons (up to three
  choices): "Which customer?" with the three most likely, "Is *Marie-Lise* speaker 2?" with Yes and
  No. This is Home Assistant's pattern; each button is tied to its own run, so two questions from two
  recordings never cross.
- A question that needs typing (the speakers' names, a title) opens a **small pop-out window** in
  front, sized to the form, with the most likely answers pre-filled from the last runs: the same
  customer's usual attendees, the last title pattern.
- **Smart defaults**: the flow guesses first and asks second. A speaker matched to the usual roster
  is proposed, not asked. Over time fewer questions are asked, which is the "long wow".
- **"Later"** closes the window and keeps the step waiting; the tray number stays. **"Skip this
  step"** ends the step and takes the flow's error path, after one confirmation, because it cannot
  be undone. There is no "Dismiss".
- **Waiting is not failing.** A question can wait for days. The run card says "Waiting for you since
  Tuesday" and the tray number stays until it is answered.
- The same question is never asked twice for the same recording after a restart.

**Feedback:** on answering, the pop-out closes itself and the card moves to the next step within a
second. No "thank you" screen.

**Edge cases:** a notification the OS dropped is still on Today; a question answered in the window
while its notification is still showing dismisses the notification; a pop-out closed by the window's
close button counts as "Later".

## Moment 4: The result (brief), and the actions after it

**Goal:** the person sees that the recording became knowledge in the right place, and can act on it.

**Trigger:** the last step finishes; or the person opens a finished run from Today.

**Rules:**
- A finished run shows **what was made and where**: each object the flow's nodes created, with its
  Anytype type and space, as a link that **opens the object in Anytype**. Anytype is the reading
  surface; InnyTypes does not re-render the content.
- The **planned next steps** the scheduling node made are listed with their dates, each linking to
  its task or calendar entry.
- **Actions on a result** are the flow's snapshot view's actions (plan 0017), for example "Summarise
  again", "Send to *customer* space", "Re-run from transcription". They are declared by the view
  node in the flow, not by the app. Each starts a new run, shown as a new card.
- A result stays on Today for a day, then lives in the run history under Flows, searchable by
  customer and date.

**Feedback:** the end notification carries the first link. On Today, a finished card is calm: a
tick, the counts, the links. Errors are the only thing in colour.

## What this changes in the current app, and what it keeps

**Keeps:** the runtime, the views (action and snapshot), the journal, the canvas for editing, the
locked palette, verified packages, the notice board's once-only rule, the crash banner.

**Changes:** the seven-tab structure becomes Today, Flows, Library and Settings; the first run
becomes a sequence; questions move into notifications and small pop-outs by default; results link
into Anytype; the Node-RED editor is reached from a flow's Edit button and is never the home screen.

**To build as node definitions, not app features:** summary nodes (several types), an analysis node,
a send-to-space node, a scheduling node (Anytype tasks and the calendar), and an approval view node.
Plus, in the app: reading Anytype's spaces and types for the node forms, and the flow template.
