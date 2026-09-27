# Design system

Written 2026-09-27, after `strategy-brief.md`, `interaction-design.md` and `ux-writing.md`. Status:
draft for the owner. The tokens are in `tokens/innytypes.tokens.json` (W3C Design Tokens format,
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

**Decision for the owner:** this is "Anytype's register, InnyTypes' own accent." The alternative,
copying Anytype's exact palette and type, would make the two apps hard to tell apart; the other
alternative, a loud identity, contradicts the background posture.

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

Named `category/component`; differences are variant properties, not names.

| Component | Properties (variants) | Notes |
|---|---|---|
| `control/button` | Kind: primary, secondary, quiet, destructive · State: default, hover, pressed, disabled, loading · Size: default, large | Primary is accent-filled; destructive is `state.failed`; quiet has no border. One primary per view. |
| `control/switch` | On, off · disabled | For flows (on/off) and settings. The label states the effect. |
| `control/text-field` | State: default, focus, filled, error, disabled · With suggestion | "Suggested" values are pre-filled and marked; an error line sits below. |
| `control/select` | State as text-field | Options come from data (spaces, types), never free text where a list exists. |
| `control/checkbox` | On, off, mixed · disabled | |
| `indicator/status-pill` | State: running, waiting, done, failed, off | The word plus the colour; used on cards, rows and the top-right status. |
| `indicator/progress` | Determinate, indeterminate | A thin bar; the time left is written beside it. |
| `indicator/badge` | Count | The "waiting for you" number on the nav and tray. |
| `text/link` | Default, hover, visited | Result links that open Anytype. |
| `media/icon` | Name | A single set, 16 and 20px, 1.5px stroke, from Lucide (ISC licence). |
| `layout/divider` | | Hairline, `surface.line`. |
| `feedback/tooltip` | | The status details, and absolute times behind relative ones. |

## Molecules

| Component | Made of | Job |
|---|---|---|
| `form/field` | label + control + help line + error line | One question or setting. |
| `form/suggested-field` | field + "Suggested" tag | A pre-filled answer the person can accept or change. |
| `list/row` | title + meta + status-pill + actions | A flow, a package, a setting section. |
| `card/result-line` | type → space link | One object a run made. |
| `nav/item` | icon + label + badge | Today, Flows, Library, Settings. |
| `dialog/buttons` | primary + secondary + cancel | The one order everywhere: the safe action is the default. |
| `notification/action-row` | up to three buttons | Answers in a notification. |

## Organisms

| Component | Properties | Job |
|---|---|---|
| `card/run` | State: copying, running, waiting, failed, done, resumed · With progress · With result lines | The Today card. The step line follows `ux-writing.md`; the step name is the node's canvas name. |
| `card/empty-state` | Area | One sentence and one action, per area. |
| `nav/sidebar` | Collapsed, expanded | The four areas, with the status pill at the bottom. |
| `dialog/confirm` | Kind: neutral, warning, destructive | Quit with unsaved edits; unsigned install; skip this step. Modal, with a scrim. |
| `banner/runtime` | Restarting, down | Kept from today; Restart is the primary button. |
| `popout/question` | With form, with buttons | The pop-out window: title, subtitle, fields, Continue · Later · Skip. Width `size.popout-width`. |
| `list/flows` | | Rows with switch, last run, health, Edit, Run history. |
| `list/library` | Section: templates, packages | Rows with Install / Update / Unsigned. |
| `panel/settings-section` | State line + controls | Anytype, Recorders, AI apps, Start at login, Updates, Reports, Advanced. |
| `canvas/frame` | Dirty, clean | The flow's name, Save and run, the Node-RED iframe. |
| `setup/step` | Step n of N | The first-run screens: title, body, the step's form, Back · Continue. |

## Templates

| Template | Layout |
|---|---|
| `page/standard` | Sidebar `size.nav-width` + content column with 24px gutters, max `size.reading-width` for prose, full width for lists and cards. |
| `page/canvas` | Sidebar + a frame that fills the rest; no page scroll. |
| `window/popout` | `size.popout-width`, content-sized height, `shadow.popout`. |
| `window/setup` | Centred column, 560px, one step at a time. |

## Screens (the deliverable)

Today (empty; three cards in three states; a card waiting for you), Flows, Library, Settings, the
canvas frame, the seven first-run screens, the question pop-out, the three dialogs, and the
runtime banner. Each in light and dark.

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
| 6 | `05 Templates` | The four templates, no content. |
| 7 | `06 Screens` | The screens above, light and dark. |
| 8 | `99 Archive` | Nothing yet. |

Build order: tokens and themes → library colours and typographies from tokens → icons → atoms →
molecules → organisms → templates → screens. Each stage references only the ones above it.

## From tokens to code

The app's CSS derives from the same file: `base` becomes `:root` custom properties, `light` the
default semantic set, `dark` the `prefers-color-scheme: dark` and `[data-theme="dark"]` overrides.
No component stylesheet may contain a raw colour; the architecture check will enforce it when the
build starts.
