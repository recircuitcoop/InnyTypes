# UX strategy brief

Written 2026-09-27. Status: draft for the owner's review. No code changes follow until the owner
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
| 3 | **Several** summaries | Nothing. whodunnit's summary templates are a separate, unported add-on. |
| 4 | Send the summaries to Anytype | The Create/Update object nodes exist, but they need a hand-typed space and type key. **No routing, and no dynamic types.** |
| 5 | Analyse the updated Anytype context | Nothing. |
| 6 | Send to customer spaces | Nothing. Anytype sharing across spaces is not modelled. |
| 7 | Plan the next steps and schedule them | Nothing. There is no scheduler source and no task nodes. |

So *"I got NOTHING"* is literally true of the job. A redesign that only restyles the current pages
would still deliver nothing. **The rework has to make the pipeline real, and organise the app around
running it.**

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
  person is: a notification, a dock or tray badge, the home screen.
- **O2 "I have to build it myself."** Ship the owner's pipeline as a ready-made flow (a *template*,
  like Home Assistant's blueprints) that runs once Anytype is paired and the recorder is known. The
  canvas is for changing it, not for starting.
- **O3 "Each summary must land in the right place."** *Owner requirement:* InnyTypes reads the
  **object types from the Anytype spaces themselves**, so the destination, the fields and the forms
  are queried and filled in dynamically, not typed by hand. Summaries are routed by type and
  customer.
- **O4 "Ask me only what needs me."** The flow waits on real decisions only: who spoke, which
  customer, whether to approve before sending to a customer space. It asks in a notification with
  buttons, or a small pop-out, not by sending the person to a tab.
- **O5 "Next steps get lost."** Plan the next steps from the updated context and schedule them, as
  Anytype tasks with dates, or as a calendar entry to be decided.
- **O6 "I can't tell what is going on, or why it failed."** A plain-language history of runs with
  retry, showing names and never internal ids (*owner: "all must be human readable"*).
- **O7 "The app talks like a developer."** Fix the language, the visual weight and the layout
  (heuristic findings 1–10; the six bugs the owner confirmed).

## 5. What the app should be organised around (the owner's #10: "review the structure")

Today's structure follows the system's parts: Editor, Inbox, Snapshots, Events, Jobs, Packages,
Settings, Quit. The proposal is to follow the person's day instead:

| Area | Purpose | What it replaces |
|---|---|---|
| **Today** (home) | Recordings being processed, with their progress; **what waits for me**, answered in place; recent results that open the Anytype object | Inbox, Jobs, Snapshots, and the status blocks |
| **Flows** | My pipelines as a list: on or off, last run, health. **Edit** opens the canvas. **New from template** starts one. | Editor, Events (event types become a trigger setting inside a flow) |
| **Library** | Templates and node packages: install, update, trust | Packages |
| **Settings** | Anytype (connection, spaces, types, pairing), recorders and folders, AI clients (MCP), the app itself (login, updates, telemetry) | Settings |

- **Quit** leaves the navigation for the app menu.
- **Diagnostics** become one status indicator, with the details behind it (*owner #2: yes*).
- **The canvas is a place you go to change a flow, not the home screen.**

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
| A ready-made pipeline template running straight away beats a blank canvas for the owner's job | Usability, desirability | A paper or clickable prototype of "plug in → Today shows progress → one question → filed" with the owner |
| Reading Anytype's types dynamically is enough to route the summaries | Feasibility | A spike against the **TEST space only**: list its types, fill a form from one type's fields, create an object |
| A question asked in a notification is answered faster than one in a tab | Usability | Compare the two in the prototype |
| Several summaries can be defined once (templates) and reused per customer | Desirability | Owner review of a list of summary templates |

## 8. Questions still open for the owner

1. **Summaries:** which kinds, for example action items, decisions, a customer brief, internal
   notes? Is each one fixed, or chosen per recording?
2. **Customer:** how is the customer or meeting known? A calendar, a naming convention on the
   device, or the person telling it?
3. **Customer spaces:** what gets sent there, all or only some summaries? Does the person approve
   before anything is sent?
4. **Analysing the context:** what does that mean for you? Linking to earlier meetings, open
   actions, or changes in the customer's situation?
5. **Next steps:** scheduled where? Anytype tasks with dates, your calendar, or both?

## 9. Next

- Once the owner answers §8 and approves this brief:
  1. **interaction-design** for the four key moments: first run, plug-in to progress, the question,
     and the result;
  2. **ux-writing**;
  3. the **design system**;
  4. an **accessibility audit**.
- Then one plan (0019) combines the pipeline's missing pieces (steps 2–7), the new structure and the
  six bugs.
- The WI-27 review questions come after the structure is decided, because most of them depend on
  it.
