# UX strategy brief

Written 2026-09-27; section 5 rewritten 2026-09-28 for the three surfaces the owner decided.
Status: draft for the owner's review. No code changes follow until the owner
approves it.

The inputs:
- the owner's own account of the job, 2026-09-27;
- the owner's answers on the heuristic top 10;
- `docs/ux/heuristic-evaluation.md`: 20 findings, one of them critical;
- `docs/ux/competitive-analysis.md`;
- the flow review: 30 screenshots of the current app, plus plan 0017's intended flow.

## 1. The problem, in the owner's words

> *"while innytypes is not functional, it takes ages and it is very uncomfortable. I need to connect
> the recording device and process the recordings immediately: transcription -> MULTIPLE summaries
> -> route the multiple summaries to AnyType -> Analyse AnyType renewed context -> Transmit to
> customer spaces -> plan new steps and schedule them ... I got NOTHING"*

**The finding that changes the strategy.** What has been built is a sound *platform*: a runtime
that recovers from crashes, verified packages, views that wait for the person, and Anytype nodes.
What has not been built is the *job*. Of the seven steps in the owner's pipeline, today's app does
one partly and none of the others:

| # | Step in the owner's job | What exists today |
|---|---|---|
| 1 | Plug in the recorder, and processing starts at once | monty's folder watcher emits `monty.new.v1`. **Drives** (the BOYA) are not covered yet: monty's WI-0002-05 is still being built. |
| 2 | Transcription | innyrize is planned; whodunnit, the engine, exists. **Not in the app.** |
| 3 | **Several** summaries, of different types, on the same text | No summary node definition. whodunnit's summary templates are a separate, unported add-on. |
| 4 | Send the summaries to Anytype | The Create/Update object nodes exist, but they need a hand-typed space and type key. **The app does not read spaces and types from Anytype for the node forms.** |
| 5 | Analyse the updated Anytype context | No analysis node definition. |
| 6 | Send to customer spaces, after approval | No send-to-space node, and no approval view node. |
| 7 | Plan the next steps and schedule them | No scheduling node definition. |

So *"I got NOTHING"* is literally true of the job. A redesign that only restyles the current pages
would still deliver nothing. **The rework has to make the pipeline real, and organise the app around
running it.**

**How the pipeline is made real (the owner's correction, 2026-09-27).** InnyTypes is not the
pipeline; the pipeline is a **Node-RED flow**, and every step in it is a **node definition** shipped
in a node package:
- the steps that don't exist yet are **new node definitions**, never features baked into the app:
  summary nodes (of different types, run on the same text, chosen per flow), an analysis node, a
  send-to-space node, a scheduling node, and an **approval view node** placed in the flow wherever
  the person wants approval;
- Anytype's spaces and object types are **data read from Anytype** and offered in the nodes' forms,
  so routing to a customer space is flow configuration, not app logic;
- the owner's pipeline ships as a **flow template** whose node forms the person fills in.

InnyTypes' own job is the runtime and the shell: run flows reliably, keep the palette of node
definitions, provide views and notifications, read Anytype's spaces and types for the node forms,
show what is running and what is waiting, and let the person edit the flow.

## 2. The job to be done

**Main job:** turn a customer conversation, recorded on a device, into filed and usable knowledge in
the right Anytype spaces, with the next steps planned, without waiting and without doing it by hand.

**Emotional job:** stop waiting and stop babysitting. Trust that nothing is lost, and that only the
decisions that need a person reach the person.

**The job map** (the eight stages of a job, applied to the owner's pipeline):

| Stage | In this job | The outcome the person wants |
|---|---|---|
| Define | Know which customer or meeting a recording belongs to | Minimise the effort of saying which customer and meeting |
| Locate | Plug in the recorder | Minimise the time from plugging in to processing starting (target: immediate, with no clicks) |
| Prepare | Transcribe, and tell who spoke | Minimise waiting, and minimise the speakers named wrongly |
| Confirm | Check the speakers and which summaries to make | Minimise the questions asked, and ask only when it's needed |
| Execute | Several summaries, sent to the right Anytype objects and types | Minimise manual filing, and minimise results in the wrong place |
| Monitor | Analyse the updated context; see progress | Minimise not knowing what is happening |
| Modify | Correct a summary, re-run a step | Minimise rework when one step is wrong |
| Conclude | Send to customer spaces; plan and schedule the next steps | Minimise the follow-ups forgotten or scheduled by hand |

## 3. The outcome and how to measure it

**North Star:** *recordings fully processed into Anytype*, from plugging in to summaries filed and
next steps scheduled, per week, together with the median time from plugging in to filed.

**Inputs to that:**
- the time to the first working pipeline after installing, which must be close to Granola's;
- how many questions each recording asks the person;
- the share of runs that finish with no error.

**HEART focus:** task success and adoption. Happiness and engagement come later.

## 4. Opportunities (opportunity solution tree)

The root outcome: **one recording goes from plug-in to filed summaries and scheduled next steps,
asking the person only what only they can answer.**

- **O1 "I wait ages and nothing happens."** Start on plug-in with no clicks. Show progress where the
  person is: a notification, a dock or tray badge, the Live board.
- **O2 "I have to build it myself."** Ship the owner's pipeline as a ready-made **flow template**
  (like Home Assistant's blueprints) whose node forms the person fills in once Anytype is paired and
  the recorder is known. The canvas is for changing it, not for starting.
- **O3 "Each summary must land in the right place."** *Owner requirement:* InnyTypes reads the
  **spaces and object types from Anytype itself** and offers them in the node forms, so the
  destination, the fields and the forms are queried and filled in dynamically, not typed by hand.
  Which summary goes to which customer space is decided in the flow.
- **O4 "Ask me only what needs me."** View nodes in the flow wait on real decisions only: who spoke,
  which customer, and an **approval view node** before a send-to-space node. They ask in a
  notification with buttons, or a small pop-out, not by sending the person to a tab.
- **O5 "Next steps get lost."** An analysis node and a scheduling node in the flow plan the next
  steps and schedule them in Anytype tasks and the calendar, as configured in the nodes.
- **O6 "I can't tell what is going on, or why it failed."** A plain-language history of runs with
  retry, showing names and never internal ids (*owner: "all must be human readable"*).
- **O7 "The app talks like a developer."** Fix the language, the visual weight and the layout
  (heuristic findings 1–10; the six bugs the owner confirmed).

## 5. What the app should be organised around (the owner's #10: "review the structure")

The current structure follows the system's parts: Editor, Inbox, Snapshots, Events, Jobs, Packages,
Settings, Quit. A first proposal regrouped those parts into four areas; the owner rejected it as
*"very faulty"* (2026-09-28), because it still organised the app by its parts. **The app is
organised by what the person is doing**, in three surfaces that match the three groups of the
expected flow: setting it up, configuring it, and living with it. One window shows one surface at a
time.

| Surface | What the person is doing | What is in it | What it replaces |
|---|---|---|---|
| **Setup** | Getting started, *"once and out of the way"* | A short walkthrough, never a settings page: consent to reports → pair Anytype → your recorder → pick node packages → one last choice, install a simple starter flow or not. The package step offers only the **official packages** that ship with InnyTypes (monty, innyrize and the like); third-party packages are added later in Configuration. **Yes** to the starter flow lands the person in Live, *"where the application lives"*; **No** takes them to Configuration › Flows to build their own. It never shows again. | The first-run screens |
| **Configuration** | Changing how it works | A *"multitab view"*: **Flows** (the list of flows, templates via **New flow**, the canvas, and **Save and run**) and **General** (the settings about no single flow: Anytype pairing, recorders and folders, AI apps (the MCP endpoint), start at login, updates, reports, packages, advanced diagnostics). | Editor, Events (event types become a source setting inside a flow), Packages, Settings |
| **Live** | Living with it, *"the room where the application lives"* | The **board** of the chosen flow: a source fires → nodes run with visible progress → the flow may wait with a question → the person answers → the result. Pop-outs and notifications reach the person when the window is closed. | Inbox, Jobs, Snapshots, and the status blocks |

**Packages become nodes.** Installing a package *"results in the creation of a new node for the
flow. Each time the node is used the flow provides the necessary configuration to the node for the
correct execution."* A node is a blank recipe card; the flow fills it in at each use, and its form
reads Anytype's spaces and types live.

**A result is not always in Anytype.** *"Because we are creating flows, it is ok to just do side
effects like moving a file or deleting it, so there are multiple event sinks."* A result line may
say "Meeting notes → Renaissance", "Moved recording to Archive" or "Deleted the recording"; no
screen assumes Anytype is the only end.

**The Live board.** The flow declares *what* exists: each view node is a card, a question or a
result, with its content and a suggested size. The *presentation*, size and placement, is set in
the Live window with **Edit layout**:
- **one board per flow**; switching flow switches board;
- a board has **tabs**; Edit layout adds and removes tabs, moves and resizes places on the board,
  and hides places entirely;
- the layout is InnyTypes' own per-flow state, kept outside the flow and untouched by a redeploy;
  a new view node gets a new place at the end;
- a hidden place's waiting question or failure still reaches the person by notification or pop-out,
  so a layout can never hide something urgent.

Shared across surfaces:
- **Dialogs, the runtime banner and the status pill** are components any surface uses.
- **The tray and notifications** are entry points into Live.
- **Quit** leaves the navigation for the app menu.
- **Diagnostics** become one status indicator, with the details behind it in Configuration ›
  General (*owner #2: yes*).
- **The canvas is a place you go to change a flow, not the home screen**; Live is where the app
  opens after setup.

## 6. Decisions the owner asked us to assess

- **#5, what "Dismiss" does to a waiting view.** Replace it with two named actions:
  - **"Later"** closes the view and keeps it waiting;
  - **"Skip this step"** ends that step, and the flow's error path takes over, after a confirmation.

  "Dismiss" can't say which of these it means.
- **#6, the weight of critical questions.** Confirmed: these block, or cannot be undone, so they
  need real dialogs.
  - **Quitting with undeployed edits:** a modal dialog, with the safe action as the default.
  - **Installing an unsigned package:** a warning dialog with the risk spelled out.
  - **The runtime down for good:** keep the banner (the owner judged it good), and make Restart the
    main button.

## 7. What to assume, and how to test it

| Assumption | Type | Test |
|---|---|---|
| A ready-made pipeline template running straight away beats a blank canvas for the owner's job | Usability, desirability | A paper or clickable prototype of "plug in → Live shows progress → one question → filed" with the owner |
| Reading Anytype's types dynamically is enough to route the summaries | Feasibility | A spike against the **TEST space only**: list its types, fill a form from one type's fields, create an object |
| A question asked in a notification is answered faster than one in a tab | Usability | Compare the two in the prototype |
| Several summaries can be defined once (templates) and reused per customer | Desirability | Owner review of a list of summary templates |

## 8. The owner's answers (2026-09-27)

1. **Summaries:** *"different types, ran on the same text. Not always the same."* So several summary
   nodes of different types in one flow, chosen per flow.
2. **Customer:** *"There are spaces for the customers."* The customer is a space; the flow routes
   to it.
3. **Customer spaces:** *"summaries, work, customer feedback... Currently there is always an
   approval before sending, but this will be managed in the node-red flow config with a new
   view."* So an approval view node, placed in the flow.
4. **Analysing the context:** *"I dont want you to bake this in the application flow: InnyType is
   configured by the node-red flow orchestrator with a new NODE DEFINITION."*
5. **Next steps:** *"both but this is IN THE NODE RED and NODE DEFINITION."* Anytype tasks and the
   calendar, through a scheduling node.

The rule behind all five: **anything the pipeline does is a node definition configured in the
flow; InnyTypes provides the runtime, the palette, the views and the data (spaces, types) the nodes
need.**

## 9. Next

- Once the owner approves this brief:
  1. **interaction-design** for the four key moments: first run, plug-in to progress, the question,
     and the result;
  2. **ux-writing**;
  3. the **design system**;
  4. an **accessibility audit**.
- Then one plan (0019) combines the missing node definitions (summary, analysis, send-to-space,
  scheduling, the approval view), reading spaces and types from Anytype for node forms, the flow
  template, the three surfaces (Setup, Configuration, Live, with the Live board), and the six bugs.
- The WI-27 review questions come after the structure is decided, because most of them depend on
  it.
