---
type: plan
title: A view that is a widget
status: DRAFT
created: 2026-10-01
updated: 2026-10-01
---

# 0021 — A view that is a widget

Status: DRAFT, awaiting the owner

**Goal:** a view node can hand the person a real interactive widget, drawn by its own node
package in the pop-up window, whose answer is structured JSON that reaches the flow unchanged.

Target: **release 0.4.0.** 0.2.1 is current; 0.3.0 (design system and UX) comes first, and this
plan builds on its chrome and tokens.

## The observation

The owner, 2026-10-01: a view may be a full widget, such as drag-and-drop reordering by
importance, answering with an ordered list. Widgets live in the **pop-up window only**; the Live
board's Question slot shows "**Waiting for you:** …" with **Answer**. The owner, verbatim: "why
was the bridge data structure a flat string in the first place? it should be json from the first
place. because the flows are run by node-red the most natural choice should have been JSON from
the start". It holds: every hop below the pop-up carries JSON, and one shell function flattens it.

## What the code says

**1. A package can already draw a view, in a sandbox, but answers only flat values.**

- `component` `{element}` is "the view's OWN package's web component, in the pop-out sandbox"
  (`docs/specs/node-protocol-v2.md:642`), used only for a valid element name and the view's own
  package (`app/src/domain/views/popout.ts:108-121`, `ELEMENT_NAME` `:95`, `isPackageHost` `:97`).
- The page, on `inny-view://<package>/`, loads exactly one script, `component.js`, from the
  package's `view/` folder (`app/src/adapters/electron/schemes.ts:94-120`, `popout.ts:209-210`).
- The sandbox: partition `inny-views` (`popout.ts:18`), webPreferences (`:32-46`), the CSP
  (`:21-23`), a request filter (`schemes.ts:137-141`); the §8.5.9 probes pass from inside a
  package component (spec `:729-737`).
- The bridge is three calls with no ids (`app/src/shell/view-preload.ts:9-14`), each window bound
  to one target (`app/src/adapters/electron/popouts.ts:99-117`). The element gets the view as
  `view` and answers with an `inny-submit` event (`app/src/ui/view/view.ts:63-66`, `:98-104`).
- **An element that never registers fails silently**: `attach` does nothing (`view.ts:100`).

**2. Where the flat restriction is enforced: in one place, the pop-out adapter in the shell.**

- `sanitizeValues` keeps a flat object of strings, finite numbers and booleans, drops long keys,
  truncates strings at 2,000 and drops the rest silently (`popout.ts:63-90`; spec §8.5.7
  `:725-727`). It runs only in `popouts.ts`, on `submit` (`:210-214`) and snapshot `action`
  (`:112-116`); the preload passes values untouched (`view-preload.ts:11-13`).
- **The in-app path is not sanitised at all.** An inline view submits through `submitView`
  (`app/src/shell/app-bridge.ts:73`), forwarded unchanged (`app/src/shell/runtime-calls.ts:47-58`).
- The runtime only requires an object (`valuesOf`, `app/src/application/views.ts:71-74`), then
  writes the `action` frame as is (`views.ts:239`; `app/src/adapters/process/node-process.ts:172-181`).
- **Nothing downstream needs it flat.** `action.values` and `trigger.values` are any object
  (spec `:424`, `:432`); `emit.data` is any JSON (`:456`) and becomes `msg.payload` (§5.1
  `:496`). The only bound below the shell is the 1 MiB frame (§3.5 `:322-327`).

The flat shape is a pop-out sanitiser, not a property of the protocol.

**3. A view type cannot declare its widget's input or answer today.**

- A type declares `config`, `outputs`, `actions` (with `form`), `input`, `event` and `payload`
  (spec §2.4 `:134-152`, schema `:244-266`). Nothing describes a view's answer or its props.
- **The name `input` is taken**: a boolean, "a source gets one input" (`:148`, `:258`, `:265`).
  D6 proposes `props` and `answer` instead.
- ajv 8.20.0 on JSON Schema 2020-12 is already the validator (`app/package.json:41`,
  `app/src/adapters/schema/ajv-validator.ts:8`).

**4. A widget's code is already covered by the package's hash.** `files.json` lists every file,
signed, and the content hash is compared per version (`app/src/domain/packages/archive.ts:1-19`,
`contentHash` `:165`; spec §2.3.5). A `view/` file is covered like any other. The shell reads it
from the declared folder at request time (`app/src/shell/main.ts:495-496`, `schemes.ts:110`);
a path install is re-judged when its folder is scanned (`app/src/domain/packages/versions.ts:280-291`).

**5. The SDKs and the suite know nothing of components.** TS `ViewContent` has `title`, `text`,
`fields`, `form` and an open index (`sdk/ts/src/node.ts:54-60`); Python's `present` sends any dict
(`sdk/python/src/innytypes_node/__init__.py:191-192`). **C15 is already taken** by the
runtime-side checks (spec `:941`), so the new cases are C16 to C19 (view cases:
`app/test/conformance/sdk-views.test.ts`, C10 `:89`). A component fixture exists
(`app/test/fixtures/popoutkit/view/component.js:86`). `inny-pack` checks only the declaration
schema (`tools/inny-pack/cli.ts:117`). `docs/ux/design-system.md:121` still says "a contract
change, never a one-off widget"; its `component` row (`:145`) and Question pop-out (`:104`)
predate this.

## The change

1. **JSON across the bridge.** `submit` and `action` carry any JSON object. `sanitizeValues` is
   removed; one judgement replaces it **in the runtime** (`application/views.ts`), so the pop-out
   and the in-app path are judged alike:
   - bounds: 64 KiB serialised, depth 8, 1,000 keys in all, strings up to 16 KiB;
   - any key `__proto__`, `constructor` or `prototype`, at any depth, is refused;
   - the type's `answer` schema, compiled once per type with ajv 2020-12.

   The shell also checks the 64 KiB size before the IPC hop.
2. **The old shape is the default.** A type with no `answer` schema gets today's: a flat object
   of strings, numbers and booleans, keys up to 64 characters. A string over 2,000 characters is
   **refused**, no longer truncated. No package that exists sends more.
3. **A refusal keeps the question waiting.** Nothing reaches the node and the pop-up stays open,
   saying under the buttons:
   > "That answer couldn't be sent: it doesn't match what this step expects. Your answer is
   > still here. Try again, or skip this step."

   The log gets the type, the input id and ajv's first error, never the values. `__dismiss__`
   stays outside the schema (spec §8.2.2).
4. **Declared props.** `content.component` becomes `{element, props?}`, judged at `present`
   against the type's `props` schema with the same bounds. Failing props fail the step ("the
   view's props do not match its declared schema"). Props are journaled with the content, so a
   re-presentation after a restart replays them (spec §8.1.2).
5. **Fallback.** `content` may carry `form` beside `component`. The page draws the form instead
   when the element is not defined within 3 s, a CSP violation is reported while it loads, or
   `component.js` is missing. With no `form`, it says "This question can't be shown here. Skip
   this step, or open it again after updating *package*." and offers **Skip this step** only.
6. **The chrome stays InnyTypes'.** The page draws the title, a "Package content" note and
   **Continue** · **Later** · **Skip this step**, as 0.3.0 defines them; the widget draws only
   its body. The bridge gains two calls (§8.5.6 becomes "five calls, none taking an id"):
   - `setValid(boolean)` enables Continue, which starts disabled for a widget. It is page-local:
     the preload dispatches an `inny-valid` event and makes no IPC call.
   - `draft(values)`, judged by the same bounds, is stored with the journal entry, returned by
     `get()`, and cleared on submit and on dismiss.

   **Continue** calls the widget's `answer()` and submits the result; the widget does not submit
   itself (D2). `inny-submit` keeps working for components written before 0.4.0.
7. **Tokens in the sandbox.** The shell serves `tokens.css` (the semantic tokens as CSS custom
   properties, light and dark, generated at build time from `docs/ux/tokens/innytypes.tokens.json`)
   and `view-kit.css` (button, field, list row, drag handle, written only against those
   variables) beside `view.js`. `style-src 'self'` already allows both; the CSP is unchanged.
8. **Pop-up only.** A view with `component` is never drawn inline, whatever its `window`. Its
   Question slot and Inbox row show "**Waiting for you:** *title*" with **Answer**, which opens
   the pop-up.
9. **SDKs and tools.**
   - TS SDK: `defineView(name, {render, answer})`, a plain web component with props, `setValid`,
     `draft` and `answer()` wired. No framework.
   - Python SDK: `present` accepts `component` with `props`.
   - `inny-pack build` compiles `props` and `answer`, and refuses a package whose `component`
     content has no `view/component.js`.
   - App: a dev-only **Preview a view…** menu item (unpackaged, or `INNY_DEV=1`) opens a chosen
     view type with its declared sample props in the real sandbox, and logs the answer (D4).
10. **Spec and design.** Spec §2.4, §2.6, §4.5, §8.1.3, §8.5.6, §8.5.7 and §12.2 change as
    above. `design-system.md:145` becomes "the sandboxed frame with the token variables and
    InnyTypes' chrome; worked example: reorder", and `:121` "anything outside it is drawn by the
    package's own widget, in the pop-up, inside InnyTypes' chrome". Penpot `04 Organisms`: the
    Question pop-out gains **Form=Widget** with the reorder example (drawn in WI-0021-05).

## Security

**Unchanged:** scheme, host rule, partition, webPreferences, CSP, request filter, no network,
navigation or new windows, and the window-to-target binding. The §8.5.9 probes also run from
inside the reorder fixture. **Changed:** the silent sanitiser becomes schema validation plus
bounds, in the runtime, on both paths; what was dropped silently is now refused loudly.

**Closed:** a widget posting oversized or deep JSON, which would bloat the journal, fail the
input at the 1 MiB frame or stall the parser, is stopped by the bounds. `__proto__` keys aimed at
a node's object handling are refused at any depth.

**Still true:** a widget can put anything its schema allows into the flow. Nodes must treat an
answer as input; the SDK docs say so.

## Decisions for the owner

- **D1, the bounds.** Recommended: 64 KiB serialised, depth 8, 1,000 keys, 16 KiB per string.
  A reorder of 200 items with titles fits in under 20 KiB.
- **D2, who triggers submit.** Recommended: **Continue** only; InnyTypes owns the moment of
  sending, so Later and Skip this step stay consistent. The alternative, the widget calling
  `submit`, suits one-click widgets but splits the chrome.
- **D3, drafts.** Recommended: in. A long reorder survives Later, a closed window and a restart,
  for one journal field and one bridge call.
- **D4, the preview command.** Recommended: in, dev-only. Otherwise authors test a widget only by
  running a flow.
- **D5, the Inbox.** Recommended: a plain "Waiting for you" row with **Answer**, no thumbnail.
- **D6, the schema dialect and names.** Recommended: JSON Schema 2020-12, the dialect ajv already
  runs. The fields are `props` and `answer`, because `input` is taken by sources (spec §2.4).

## Acceptance

- A nested answer (an array of objects, 3 levels deep) reaches the node's `action` frame
  deep-equal. Proved by `app/test/unit/view-answers.test.ts` "a structured answer reaches the
  node unchanged".
- A value over any bound, or `__proto__` at depth 3, is refused; the entry stays `awaiting` and
  no frame is written. Proved by `view-answers.test.ts` "bounds refuse, the view keeps waiting".
- An answer failing the `answer` schema is refused with the sentence above, on both paths.
  Proved by `view-answers.test.ts` "the schema judges both paths".
- With no `answer` schema, today's flat answers pass. Proved by `view-answers.test.ts` "no schema
  means today's shape", and C10 and C11 in `sdk-views.test.ts` pass unchanged.
- Props are judged at `present` and handed back after a restart, and a draft is returned by
  `get()` until submit or dismiss. Proved by `app/test/unit/view-props.test.ts` "props survive a
  restart" and "a draft is kept until answered".
- **C16** a structured submit is accepted; **C17** a schema refusal keeps the view awaiting;
  **C18** the fallback form is drawn when the element never registers; **C19** Continue stays
  disabled until `setValid(true)`. All run in the real sandbox via `app/test/e2e/app-pages.e2e.ts`
  "widget views", with fixture `app/test/fixtures/widgetkit`. Its `view/component.js` defines
  `widgetkit-reorder`, with no dependencies, and a second type names an element never defined.
  The §8.5.9 probes pass from inside `widgetkit-reorder` in the same e2e.
- The CSP header is byte-identical to the spec, with `tokens.css` and `view-kit.css` served
  under it. Proved by `app/test/unit/schemes.test.ts` "tokens served, CSP unchanged".
- A widget view is never drawn inline; slot and Inbox show "Waiting for you" with Answer.
  Proved by `app/test/unit/app-pages.test.ts` "a widget view is pop-up only".
- `inny-pack build` refuses an invalid `answer` schema and a missing `view/component.js`. Proved
  by the `tools/inny-pack` test "view schemas and folder are checked". `defineView` and Python
  `present` with `props` both pass C16.
- `docs/loop/verify.sh` exits zero and prints `gate: GREEN`.

## Work items

Listed here only; nothing goes to `docs/loop/inbox/` until the owner approves. All five ship in
0.4.0, after 0.3.0, whose chrome and tokens they use.

```yaml
- id: WI-0021-01-json-answers-judged-in-the-runtime
  title: Answers are JSON, judged in the runtime by bounds and the type's answer schema
  intent: The flat sanitiser in the shell is the only thing that flattens answers. Replace it with one judgement both paths share.
  acceptance:
  - The structured, bounds, both-paths and no-schema bullets of plan 0021 pass with their tests.
  - sanitizeValues is gone; spec 2.4, 2.6 and 8.5.7 say what the code does.
  - 'docs/loop/verify.sh exits zero and prints gate: GREEN.'
  canonical_id: '0021'
  canonical_source: plans
  slice: '01'
  size: M
  status: TODO
  depends_on: []
- id: WI-0021-02-props-drafts-and-the-five-call-bridge
  title: Component props are declared and stored, drafts are kept, setValid gates Continue
  intent: A widget needs its input and a place to keep unfinished work, and InnyTypes owns the moment of sending.
  acceptance:
  - The props and draft bullets of plan 0021 pass with their tests.
  - Spec 4.5, 8.1 and 8.5.6 describe component {element, props}, draft and setValid.
  - 'docs/loop/verify.sh exits zero and prints gate: GREEN.'
  canonical_id: '0021'
  canonical_source: plans
  slice: '02'
  size: M
  status: TODO
  depends_on: [WI-0021-01-json-answers-judged-in-the-runtime]
- id: WI-0021-03-fallback-tokens-and-pop-up-only
  title: A widget that fails to load falls back, the sandbox gets the tokens, widgets stay in the pop-up
  intent: A missing element is silent today. The widget must look like InnyTypes and never appear on the board.
  acceptance:
  - The CSP, pop-up-only and C18 bullets of plan 0021 pass with their tests.
  - 'docs/loop/verify.sh exits zero and prints gate: GREEN.'
  canonical_id: '0021'
  canonical_source: plans
  slice: '03'
  size: M
  status: TODO
  depends_on: [WI-0021-02-props-drafts-and-the-five-call-bridge]
- id: WI-0021-04-sdks-inny-pack-and-conformance
  title: defineView, Python present with props, inny-pack checks, and C16 to C19 in the real sandbox
  intent: Authors need one way to write a widget, and the suite must prove it inside the sandbox.
  acceptance:
  - C16 to C19 and the probe bullet pass through app-pages.e2e.ts with the widgetkit fixture.
  - The inny-pack and SDK bullets of plan 0021 pass.
  - 'docs/loop/verify.sh exits zero and prints gate: GREEN.'
  canonical_id: '0021'
  canonical_source: plans
  slice: '04'
  size: M
  status: TODO
  depends_on: [WI-0021-03-fallback-tokens-and-pop-up-only]
- id: WI-0021-05-preview-and-the-design-contract
  title: The dev-only preview command, the design-system row, and Form=Widget in Penpot
  intent: Authors can see a widget without running a flow, and the design system says widgets exist.
  acceptance:
  - Preview a view… opens the widgetkit reorder with its sample props and logs the answer it would send.
  - design-system.md lines 121 and 145 read as plan 0021 says; the Penpot organism has Form=Widget.
  - 'docs/loop/verify.sh exits zero and prints gate: GREEN.'
  canonical_id: '0021'
  canonical_source: plans
  slice: '05'
  size: S
  status: TODO
  depends_on: [WI-0021-04-sdks-inny-pack-and-conformance]
```

## Non-goals

- Widgets anywhere outside the pop-up; any change to the sandbox or its CSP; network access or
  third-party scripts inside a widget; raising the 1 MiB frame bound.
- More than one script per package: `component.js` stays the one entry point, and a package
  with several widgets defines them all there.
