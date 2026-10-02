# Design system

Written 2026-09-27, after `strategy-brief.md`, `interaction-design.md` and `ux-writing.md`. Status:
draft for the owner; revised 2026-09-28 for the three surfaces (Setup, Configuration, Live). The
tokens are in `tokens/innytypes.tokens.json` (W3C Design Tokens format,
importable into Penpot's Tokens tab). The Penpot file is built from this document, following the
`penpot-atomic-design` skill's build order and page plan.

## Direction

InnyTypes is an assistant that runs in the background and steps forward only to ask or to report.
Its look follows that: **quiet surfaces, one accent, colour reserved for state.** It sits beside
Anytype, so its register is Anytype's, calm and note-like, rather than a developer tool's or a
SaaS dashboard's; it keeps its own identity through the accent and the type, so a person always
knows which of the two apps they are in.

The identity comes from the app icon: a white arrow on black. The neutrals are near-black and
off-white with a faint cool-green bias, and the accent is a deep evergreen, which reads as calm
and settled rather than urgent. Blue, amber, red and green are **state colours only** (running,
waiting for you, failed, done); they never decorate.

The direction is "Anytype's register, InnyTypes' own accent."

## Foundations (the tokens)

**Colour.** Two neutral ramps (`ink` for light mode text, `night` for dark mode surfaces and text)
and four state ramps (`green`, `blue`, `amber`, `red`), each with a soft tint (`3`), a dark-mode
value (`5`), a light-mode value (`7`) and a dark-mode tint (`8`). The semantic tokens a component
uses are `surface.*`, `text.*`, `accent.*`, `state.*`, `focus` and `shadow.*`, defined once per
theme. Components never reference a raw ramp.

**Type.** IBM Plex Sans for everything read, IBM Plex Mono for the few places that show a value
that must be copied (the endpoint address). Both open source; Plex was drawn by Bold Monday (NL).
Five sizes: caption 12, body 14, body-large 16, title 20, page 26. Weights 400, 500, 600. Body
line height 1.5, headings 1.2. Uppercase labels get 0.06em tracking.

**Space.** A 4px scale: 4, 8, 12, 16, 24, 32, 48, 64. Cards use 16 inside, 12 between rows; pages
use 24 side gutters at desktop width and 16 at narrow width.

**Shape.** Radius 4 (controls), 8 (cards, dialogs), 12 (pop-outs), pill (status pills). One
hairline stroke for lines; a 2px accent ring for focus.

**Elevation.** Two shadows only: `raised` for a card that floats over the canvas surface, `popout`
for a pop-out window or dialog. Everything else is flat.

**Motion.** `quick` (120ms) for state changes on controls, `settle` (240ms) for a card moving to
its next step or a pop-out appearing. Nothing loops. `prefers-reduced-motion` disables both.

**Dark mode.** Both themes are complete; every semantic token has a value in each. The accent
lightens in dark mode (`green.5`) so it keeps contrast on `night.2`.

## Contrast

Text on surfaces meets WCAG AA at all sizes: `ink.1` on `paper.1` is 13.9:1; `night.5` on `night.2`
is 12.1:1; `text.secondary` on both is above 5:1. State text colours (`*.7` on light tints, `*.5`
on dark tints) are above 4.5:1. State is always also written in words, per `ux-writing.md`.

## Atoms

Each atom is one component with fixed variant axes. Names are as they appear in the Assets panel.

| Component | Variant axes | Spec |
|---|---|---|
| Button | Kind: Primary, Secondary, Quiet, Destructive. State: Default, Hover, Pressed, Disabled, Loading. Size: Default (32), Large (40) | Primary: accent fill, on-accent text. Secondary: panel fill, hairline line. Quiet: no fill, no line. Destructive: failed fill. Radius s. Padding 8 × 12, body 14 medium. One Primary per view. |
| Switch | State: On, Off. Disabled | 32 × 18 track, radius pill; On uses accent. The label states the effect. |
| Text field | State: Default, Focus, Filled, Error, Disabled. Suggested: Yes, No | Height 32, radius s, hairline line; Focus adds the 2px focus ring. Suggested shows the tag "Suggested" in caption. |
| Select | State as Text field | Same frame as Text field with a chevron; options come from data. |
| Checkbox | State: On, Off, Mixed. Disabled | 16 square, radius s. |
| Status pill | State: Running, Waiting, Done, Failed, Off | Caption 12 medium, radius pill, state-soft fill, state text. The word is always present. |
| Progress | Mode: Determinate, Indeterminate | 4px bar, radius pill, running colour on sunken track. |
| Badge | Count | 18 circle, waiting fill, on-accent text, caption 12 semibold. |
| Link | State: Default, Hover, Visited | Accent text, underline on hover. |
| Icon | Name | Lucide, 16 and 20, 1.5px stroke, text colour. |
| Divider | | 1px, surface line. |
| Tooltip | | Panel fill, raised shadow, radius s, caption text. |
| Icon button | Kind: Quiet, Secondary. State: Default, Hover, Pressed, Disabled | 32 square, radius s, a 16 icon; Secondary has the panel fill and hairline. |
| Radio | State: On, Off. Disabled | 16 circle; On is accent with an on-accent dot. |
| Textarea | State as Text field | 280 × 88, radius s, hairline; text wraps, 12 padding. |
| Number field | State as Text field | A Text field with up/down chevrons (16) at the right. |
| Range | State: Default, Focus, Disabled | 4px track, sunken; accent fill; 16 knob with hairline. |
| Chip | Kind: Default, Selected, Removable | 24 high, radius pill, caption 12 medium; Selected is accent-soft with accent text; Removable ends in an × icon. |
| Spinner | Size: 16, 20 | The loader-circle icon in running colour. |
| Skeleton | Kind: Text, Block, Circle | Sunken fill, radius s (Text) or m (Block). |
| Kbd | Key | 22 high, sunken fill, hairline, radius s, mono 13. |
| Code | Kind: Inline, Block | Sunken fill, radius s, mono 13; Block has 12 padding and wraps lines. |

The twelve atoms above the rule are the ones the first spec named; the rest are the kitchen sink
the owner asked for (2026-10-01). Penpot `02 Atoms` and `app/src/ui/components/atoms/` carry all
twenty-two, 1:1.

## Molecules

| Component | Made of | Spec |
|---|---|---|
| Field | State: Default, Error, Disabled. Suggested: Yes, No | Label body 14 medium above; help and error in caption; 4px gaps. Suggested=Yes shows the "Suggested" tag right of the label (it is a prop of Field, not a second component). |
| List row | Kind: Flow, Package, Run. State: Default, Hover. Actions: One, Two | 48 high, 16 side padding, hairline divider below; Two adds a Quiet button after the Secondary one (Flow: Edit · Run history; Package: Update · Remove). |
| Result line | Sink: Anytype, File, Scheduled, Plain | Body 14. What the flow did, in any sink: Anytype ("Meeting notes → *Renaissance*", link opens the object), File ("Moved recording to *Archive*", link opens the folder), Scheduled ("Follow up on pricing · due Thursday", no link), Plain ("Deleted the recording", `check` icon, no link). The same four kinds as `done.results` in protocol 2.1 and `ResultSink` in the domain. |
| Nav item | Surface: Live, Configuration. State: Default, Hover, Active | 36 high; the active item has accent-soft fill; Live carries the badge. |
| Dialog buttons | Kind: Neutral, Destructive | Right-aligned, 8px gap; the safe action is Primary; Destructive puts the red button last. |
| Notification actions | Count: 1, 2, 3 | Secondary size Default, 8px gap. |
| Search field | State: Default, Typing | A Text field with the search icon, radius pill. |
| Combobox | State: Closed, Open | A Text field with a chevron; Open shows the options list with the typed match. |
| Multi-select | State: Empty, Filled | A field holding Removable chips and a placeholder. |
| Date field | State: Default, Filled, Open | A Text field with the clock icon; Open shows a month grid. |
| File drop | State: Idle, Over, Filled | Dashed hairline, 24 padding; Over is accent-soft; Filled names the folder. |
| Table row | Kind: Header, Row, Hover | Header is sunken with caption-medium uppercase labels. |
| Key-value | Kind: Text, Mono, Pill | A 160 label column in secondary, then the value. |
| Tab | State: Default, Hover, Active | 40 high; Active has the 2px accent underline. |
| Tab strip | | Tabs on a hairline baseline. |
| Segmented control | Options: 2, 3, 4 | Sunken track, radius s; the selected segment is panel with the raised shadow. |
| Menu item | State: Default, Hover, Danger, Disabled | 32 high, icon + label + optional Kbd; Danger is failed text. |
| Menu | | Panel, radius m, popout shadow, 4 padding; items and dividers. |
| Toast | Kind: Info, Done, Failed, Waiting | Panel, radius m, popout shadow; icon in the state colour, one sentence, an optional Secondary action, ×. |
| Inline message | Kind: Info, Warning, Failed, Done | State-soft fill, radius s, icon + one sentence. |
| Stepper | Position: Start, Middle, End | "Step n of N" caption over dots; the current dot is wide and accent. |

The first seven molecules are the ones the first spec named; the rest are the kitchen sink the
owner asked for (2026-10-01). Penpot `03 Molecules` and `app/src/ui/components/molecules/` carry
all twenty-one, 1:1. (Segmented control's Options=4 and Menu's five-item form are owed to Penpot.)

## Organisms

The app has three surfaces, one at a time in the window: **Setup** (first run only),
**Configuration** (tabs Flows and General) and **Live** (one Board per flow). Dialog, Runtime
banner and Status pill belong to no surface; any surface uses them. The tray and notifications
open Live.

| Component | Variant axes | Spec |
|---|---|---|
| Run card | State: Copying, Running, Waiting, Failed, Done, Resumed. Done also: Notes, Warnings, Both | Panel fill, radius m, raised shadow, 16 padding. Title body-large semibold; step line body 14 with the step name in bold; progress under it when running; result lines when done; buttons per `ux-writing.md`. **One card per source event, per flow** (owner, 2026-10-02): a board lists one card for every event its source fired, newest first; cards are never merged. The Done state carries a badge row under the title: the Done pill, then, only when present, a "2 notes" pill (Off colour, text.secondary) and a "1 warning" pill (Waiting colour); pressing one expands the card to list the lines with their step names. |
| Empty state | Area: Flows, Live without a flow, Live with nothing running, Empty tab | One sentence body 14 secondary, one Secondary button where `ux-writing.md` gives one, centred, 48 top margin. |
| Sidebar (surface navigation) | Mode: Setup, Main | 200 wide, canvas fill, the status pill at the bottom. Main: two Nav items, Live and Configuration; Live's badge counts what waits for you. Setup: no Nav items, only the step list of the walkthrough; it is never shown after the first run. |
| Tab strip | | 40 high, hairline line below; each tab a label body 14 medium, the active one with a 2px accent underline. Used by Configuration (Flows, General) and by the Board. |
| Dialog | Kind: Neutral, Warning, Destructive | 440 wide, panel fill, radius m, popout shadow, scrim behind; title 20, body 14, Dialog buttons. Warning and Destructive tint the title's icon only. |
| Runtime banner | State: Restarting, Down | Full width under the top bar, waiting-soft fill (Restarting) or failed-soft (Down); Restart is Primary. |
| Question pop-out | Form: Yes, No | 440 wide window; title 20, subtitle caption secondary, Fields, buttons Continue (Primary), Later, Skip this step (Quiet). Only the chrome is InnyTypes'. The title and every field are the view node's own `present.content`, drawn through the contract below; "Who is speaker 2?" is innyrize's content shown as a sample, never an InnyTypes form. |
| Configuration › Flows list | | List rows: name, Switch, "Last run", health pill, Edit, Run history, and a ⋯ Icon button opening the Menu (Rename, Duplicate, Export flow…, divider, Delete flow in danger); New flow (Primary, menu: From a template, Blank canvas) above. Delete flow opens the Destructive dialog (owner, 2026-10-02). |
| Run history | State: Rows, Selected, Empty, Filtered-empty | A Configuration screen per flow: title "Run history" + flow name + "← Flows" link; caption on retention; filter row (Segmented control All · Waiting · Failed · Done, a Select "Last 7 days", a Search field); a table (Table rows: checkbox, When, Event, Took, State pill, Notes pills, ⋯ Icon button) with a failed row's sentence under it in state.failed; Selected shows the bar "3 runs selected · Re-run · Delete · Clear selection" (accent-soft, 48 high) above the table; the row ⋯ Menu: Open result, Re-run, Re-run from… ›, Open in Anytype, divider, Delete run (danger). Re-run is the runtime replaying the journaled event; run history is a view over the journal, the board a filter of it. |
| Configuration › General section | Section: Anytype, Recorders and folders, AI apps, Start at login, Updates, Reports, Packages, Advanced | Title 20, one-line state in secondary, then Fields; 24 between sections. **Updates** is InnyTypes' own update status (owner, 2026-10-02): the state sentence from `ux-writing.md` with a Progress when downloading, Check now (Secondary), Quit and update (Primary when ready), Go back to the previous version (Quiet, with a dialog), the "Check automatically" Switch, a Release notes Link. **Packages** holds a Package row per package (below) under "Add a package…" (Secondary, menu: From the catalogue · From a folder on this Mac…). |
| Package row | State: Registered, Not registered, Installing, Verifying, Failed check, Update available, Updating, Updated (rollback offered), From a folder | 64 high (two lines), 16 side padding, hairline divider. Line 1: name body-medium, version mono, "by publisher" caption. Line 2: up to three Status pills with their words ("Registered"/"Not registered", "Installed"/"Not installed"/"Installing · 60%"/"Verifying…"/"Failed its check", "Up to date"/"Update to 0.4 available"/"Updating…"/"Updated to 0.4 on Tuesday") each with a "checked when" caption, plus "Unsigned" and "From a folder: path" captions where they apply. Actions right-aligned, 8 gap: Register/Unregister (Quiet), Install/Remove (Secondary), Update or Check for changes (Primary when available) or Go back (Quiet). A row never shows a state InnyTypes has not verified. |
| Board | Mode: Viewing, Edit layout | Tab strip above; below it the active tab's Slots on a 12-column grid, 16 gaps. The flow picker and Edit layout (Secondary) sit right of the tabs. Edit layout adds the Edit-layout bar and a dashed hairline outline on each Slot. |
| Slot | Kind: Card, Question, Result. Size: S, M, L. Hidden: Yes, No | Holds one view node's content: Card is a Run card, Question is the question inline (same fields as the Question pop-out), Result is Result lines. S spans 4 columns, M 6, L 12. Hidden shows only in Edit layout, at 40% opacity with a "Hidden" pill; it is not drawn in Viewing. The on-screen word for a slot is "place". |
| Edit-layout bar | | Full width under the Tab strip, accent-soft fill, 48 high: the one-line instruction in body 14, then Add tab (Quiet), Hidden (n) (Quiet, opens the hidden list), Done (Primary). |
| Canvas frame | State: Clean, Dirty | Top bar 48 with the flow's name, "Unsaved changes" in secondary, Save and run (Primary); the Node-RED frame fills the rest. |
| Setup step | | 560 centred column; "Step n of N" caption, title page 26, body 14, the form, Back (Quiet) and Continue (Primary). |

## The contract: what a package can declare

Decided with the owner on 2026-10-01. InnyTypes owns the transport, the journal, the inbox,
notifications, the pop-out sandbox and the *rendering* of a view. A node package owns the
*content*: a view node sends `present {content}` (node protocol v2 §8) and InnyTypes draws it
from a fixed vocabulary. Nothing in InnyTypes knows what a speaker, a summary or an invoice is.
That is the guarantee that the application is not locked to one kind of flow: whatever a node
declares inside the vocabulary, InnyTypes can draw; anything outside it is a contract change,
never a one-off widget.

The design system shows this contract as its own set of components, one per content kind and,
for `form`, one per JSON Schema shape, each mapped to the atom that renders it. This table is the
spec for a Penpot page `04b Contract` (or a section of `05 Templates`) and for
`app/src/ui/view/render.ts`, which must agree with it.

| Declared by the node | Drawn by InnyTypes as |
|---|---|
| `title` | title 20 |
| `text` | body 14, preformatted |
| `fields` (key → value) | Key-value rows |
| `form` property, `type: string` | Field with a Text field |
| `form` property, `enum` | Field with a Select |
| `form` property, `type: boolean` | Field with a Switch |
| `form` property, `type: number` / `integer` | Field with a Number field |
| `form` property, `format: date` | Field with a Date field |
| `form` property, `type: string` with `maxLength` > 200 or `format: multiline` | Field with a Textarea |
| `form` property, array of `enum` | Field with a Multi-select |
| `form` property with a `default` the node guessed | the same Field, tagged Suggested |
| `table` `{columns, rows}` | Table rows |
| `media` image (`data:image/…` or a package-origin file) | an image |
| `media` audio (`data:audio/…` or a package-origin file) | a **Listen** control (plan 0020; not yet in the contract) |
| `anytype` `{objectId, spaceId, name?}` | a Link that Anytype opens |
| `component` `{element}` | the package's own web component, in the sandboxed frame |
| snapshot `actions` | Secondary buttons; a disabled one carries its reason as a Tooltip |

**Sample data proves the genericity.** Every organism and screen uses content from at least
three unrelated flows, so no component reads as if one story were the product: *Recordings to
Anytype* (a question "Who is speaker 2?", a result "Meeting notes → Renaissance"), *Invoices from
the mailbox* (a question "Which supplier is this?", a result "Filed in Accounting") and *Photos
from the camera card* (a result "Moved 42 files to Archive"). Step names on a run card are the
flow's own node names and must differ between the three.

What is narrow today is the catalogue, not the contract: the node packages that exist are
anytype, monty (the recorder) and innyrize. That is a roadmap fact.

## Templates

| Template | Layout |
|---|---|
| `page/configuration` | Sidebar `size.nav-width` + the Tab strip (Flows, General) + content column with 24px gutters, max `size.reading-width` for prose, full width for lists. |
| `page/canvas` | Sidebar + a frame that fills the rest; no page scroll. Opened from Configuration › Flows. |
| `page/live` | Sidebar + the Board filling the rest with 24px gutters; the page scrolls vertically only. |
| `window/popout` | `size.popout-width`, content-sized height, `shadow.popout`. |
| `window/setup` | Centred column, 560px, one step at a time. |

## Screens (the deliverable)

- **Setup:** the walkthrough screens (Welcome, Reports, Connect Anytype, Choose your packages,
  Start with a simple flow?, one node form, Ready). There is no recorder step: a recorder is a
  source a node package (monty) provides, so asking for it belongs to that package's node form,
  never to InnyTypes' own setup (owner, 2026-10-02).
- **Configuration › Flows:** the list (with a row's ⋯ menu open), the canvas frame, and Run
  history (rows with one failed and one selected).
- **Configuration › General.**
- **Live:** the empty board; a board with three cards in three states, all from ONE flow (one
  card per source event: three recordings of *Recordings to Anytype*, one Running, one Waiting,
  one Done with "2 notes · 1 warning"); a waiting question; Edit layout on (with a hidden slot).
  The three unrelated flows appear across screens (Flows list, templates, contract board), never
  mixed on one board.
- The question pop-out, the three dialogs, and the runtime banner.

Each in light and dark.

## Penpot file plan

Two files: **InnyTypes Design System** (the library) and **InnyTypes App** (the screens), the
second linked to the first.

| # | Page | Holds |
|---|---|---|
| 1 | `00 Foundations` | A rendered view of the tokens: the ramps, the type scale, the space rhythm, the two shadows. Documentation only; the tokens live in the Tokens tab. |
| 2 | `01 Icons` | The Lucide subset, one grid, 16 and 20. |
| 3 | `02 Atoms` | The atoms above, each as a variant container. |
| 4 | `03 Molecules` | |
| 5 | `04 Organisms` | |
| 6 | `05 Templates` | The five templates, no content. |
| 7 | `06 Screens` | The screens above, light and dark. |
| 8 | `99 Archive` | Nothing yet. |

Build order: tokens and themes → library colours and typographies from tokens → icons → atoms →
molecules → organisms → templates → screens. Each stage references only the ones above it.

## From tokens to code

The app's CSS derives from the same file: `base` becomes `:root` custom properties, `light` the
default semantic set, `dark` the `prefers-color-scheme: dark` and `[data-theme="dark"]` overrides.
No component stylesheet may contain a raw colour; the architecture check will enforce it when the
build starts.

### Decision: the UI stack (2026-10-01)

**Chosen: Tailwind CSS 4 for styling, Ark UI for widget behaviour, high fidelity to the Penpot
specs.** Decided by the owner after the review below.

| Option | What it gives | Why it was or was not chosen |
|---|---|---|
| Tailwind 4 | Utility classes compiled to one CSS file; its `@theme` block binds to our tokens, so the "no raw colour in components" rule holds. Runs as its own CSS step; esbuild stays. | **Chosen.** |
| daisyUI 5 on Tailwind | ~50 ready-styled components and a themeable look. | Not chosen: its components carry their own radii, heights and focus rings, so matching the Penpot specs means paying twice, once for its styling and once to undo it. Speed over fidelity; the owner wants fidelity. |
| Our own atoms on Tailwind only | Exactly the Penpot specs, nothing to undo. | Chosen for the look, but it leaves keyboard handling and ARIA for combobox, multi-select, tabs, toasts, steppers and date pickers to be written by hand. |
| Ark UI | Headless widgets (behaviour and accessibility, zero look) built on Zag.js; we dress them with our atoms. Covers the long tail of widgets that node schemas and `present` frames may declare. | **Chosen.** Not reinventing keyboard handling and ARIA, not fighting someone else's styling. |
| Zag.js directly | The same engine without a framework. | Fallback only: Ark writes the wiring we would otherwise write. |

**Consequence still open: Ark UI is not vanilla.** It ships bindings for React, Solid, Vue and
Svelte only, and the renderer today is plain TypeScript bundled with esbuild. Adopting Ark UI
means adopting one of those frameworks for the renderer (shell and runtime processes are not
affected). Recommendation: **React**, as Ark's most-used binding with the largest pool of examples
and reviewers; Solid is the lighter alternative with the same Ark coverage. The owner decides the
framework before plan 0019 is written; the plan then carries the migration of `app/ui`.
