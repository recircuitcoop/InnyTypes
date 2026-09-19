---
type: plan
title: A tab for each plugin, and one for the application itself
status: DRAFT
created: 2026-09-19
updated: 2026-09-19
---

# 0006 — A tab for each plugin

## What this is

The window is one scroll. Plan 0003 gave it the process list, the two switches and Quit; plan
0004 added the plugin page, and plan 0005 put a table inside it. With one plugin installed that
is already a long page, and monty's own settings are seven columns and two folder lists. With
three plugins it is unreadable.

The owner's request, verbatim:

> innytype configuration there should be one tab per installed plugin and one tab for the
> application core configuration (mcp, helper, plugin management...)

So the window becomes **tabs**: one for each installed plugin, and one for the application
itself.

**This plan moves what exists; it does not invent settings.** Every control named here is
already built and already reachable — the plugin forms (plan 0004), the enable switch, add,
remove and update (plan 0004 slice 08), the telemetry and launch-at-login switches (plan 0003),
the process list, the staged update and Quit. What changes is where they sit, and what a person
sees first.

## The shape

| tab | what is on it |
|---|---|
| **InnyTypes** — the application's own | what is running, the Anytype MCP server, the helper's own settings, telemetry and launch at login, a waiting update, plugin management (add, and the list with remove and update), and **Quit** |
| **one per installed plugin**, named for the plugin | that plugin's settings form, its enable switch, its state and reason, its own remove and its own pending update |

A plugin with **no** declared settings still gets a tab, because it still has a switch, a state
and a Remove — a plugin that is installed and has nowhere to be looked at is a plugin nobody can
turn off (decision D2).

## What goes on the application's tab

Grouped, in this order — most looked at first:

1. **Running now.** The process list plan 0003 already draws: the host, the MCP server, Anytype,
   every plugin process, each with its state and reason.
2. **Anytype.** Whether the MCP server is running and why not when it is not; whether an API key
   is set (never what it is); and the tool surface's pinned versions. Obtaining a key is a
   command today (`innytypes anytype-mcp get-key`) and stays one until D5 says otherwise.
3. **The helper.** Its numbers are in `config.toml` and no window has ever shown them: the tick,
   the restart attempts and backoff, the breaker's window, the stability defaults. They are
   **editable here** (D3), through the same declared-field machinery a plugin's settings already
   use — one validator, one refusal, one Save — so the window grows no second way to judge a
   number.
4. **This application.** Telemetry, launch at login, the version, a staged update with its Apply,
   and **Quit**.
5. **Plugins.** Three things, in this order (D4):
   - **Installed:** every installed plugin with its state, and its **Remove** and **Update**
     right there, so six plugins can be dealt with without visiting six tabs.
   - **The official list:** the plugins this application's own index publishes, each with what
     it is and an **Install**, and marked when it is already installed.
   - **Other sources:** any plugin index the user has registered, listed the same way, with the
     source each entry came from named beside it. Adding and removing a source lives here too.

   Installing from a list is `innytypes addons install` with the requirement filled in for you;
   nothing about how an install works changes. What the index is, and what registering a source
   means, are follow-ups F1 and F2 — this plan draws them and does not invent them.

## What goes on a plugin's tab

Everything about that plugin and nothing about any other: its name and version, where it came
from, its availability word and reason, its **Enabled** switch, its settings form exactly as
plan 0004 publishes it, its **Save settings**, its **Remove**, and its pending update with an
Apply. A broken plugin — no readable manifest — still gets a tab carrying the reason and Remove,
because that is precisely the plugin someone needs to act on.

## Rules the tabs must follow

- **The tab strip is built from what is installed, on every draw.** Installing a plugin adds a
  tab; removing one takes its tab away and returns to the application's tab. No tab outlives its
  plugin.
- **A tab's content is drawn from the one view the host publishes** (plan 0004, "What the
  application is told, in one place"). Tabs change where things are drawn, never where they come
  from.
- **Switching tabs loses nothing typed.** Today's page folds the widgets back into rows only on
  Save; a tab switch must do the same fold, or typing into monty's table and clicking another tab
  would throw the typing away. This is the sharpest thing in this plan and the easiest to get
  wrong (D6).
- **Every form has both a Save and a Cancel** (D6). Save records; **Cancel throws the working
  copy away and redraws from what is recorded**, which is the only way to undo typing that was
  never meant — including rows added, removed or moved, since those change the working copy and
  nothing else until a Save.
- **The window still opens, and still quits, when a plugin's tab cannot be drawn.** One bad
  plugin loses its own tab's contents, with the reason in its place — never the window.
- **Quit lives on the application's tab and nowhere else**, and is never behind a scroll: F1's
  "clear and easy way of turning the whole InnyTypes application off" must not become "find the
  right tab first" (decision D7).

## The gate stays hermetic

The tab strip, the tab a switch lands on, and what each tab holds are all assertions against the
headless desktop, as every other drawing already is. The toolkit's own tabs (`toga.OptionContainer`)
are asserted through the same stand-in the nine widget kinds use, and the platform sweep still
asserts one drawing on all three platforms.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | the tab model | `WindowContents` becomes a set of tabs: the application's, one per installed plugin, each with the elements it carries; the rules about appearing, disappearing and falling back |
| 02 | the application's tab | the five groups above, assembled from what already exists, with the helper's numbers editable through the declared-field machinery |
| 02b | the plugin lists | installed with Remove and Update, the official list with Install, other registered sources and the adding and removing of them |
| 03 | a plugin's tab | one plugin's form, switch, state, remove and update — the plugin page of plan 0004, narrowed to one plugin — and Save beside Cancel on every form |
| 04 | the drawing | `toga.OptionContainer` (or its equivalent), the tab strip, the selected tab, what a tab switch does to unsaved typing, and the platform sweep |
| 05 | what a person sees first | which tab is selected on opening, what a notification's click selects, and what happens to the selection when a plugin is added or removed |

**Order.** 01 → 02 and 03 (either order) → 02b → 04 → 05. 02b waits on F1 and F2 being answered.

## Decisions

Answered by the owner on 2026-09-19.

**D1 — what a plugin's tab is named.** *Answer:* (a), the plugin's id. It is what `helper
status`, every error and every command already say.

**D2 — a plugin with no settings.** *Answer:* (a), it still gets a tab — and the owner's reason
is stronger than the one proposed: *"otherwise it will not be possible to change the settings and
make the plugins work!"* A plugin's tab is where a person goes to make it work, so a plugin
without one is a plugin nobody can start.

**D3 — may the helper's own numbers be edited in the window?** *Answer:* (b), editable. They go
through the same declared-field machinery a plugin's settings use — the same types, the same
validation, the same per-field refusal, the same Save — so there is one way to judge a number in
this application rather than two. What is declared here is the host's own settings declaration,
written once beside the config module.

**D4 — the plugin list on the application tab.** *Answer:* (b) **and more**: the installed list
carries Remove and Update, and beside it sit **the official list of plugins** and **any other
plugin source the user has registered**. So the tab answers three questions at once: what is
installed, what could be, and where else to look. This reverses plan 0004's D12, which kept the
page to what is installed because no index existed; the index is what this answer asks for, and
follow-ups F1 and F2 settle it.

**D5 — obtaining the Anytype key.** *Answer:* (a), it stays `innytypes anytype-mcp get-key`, and
the tab says so.

**D6 — a tab switch with something typed in.** *Answer:* (a), fold the widgets back into the
working copy — **and give every form a Save and a Cancel**. Cancel throws the working copy away
and redraws from what is recorded, which is what makes typing safely reversible: without it,
"fold and keep" would mean a mistake follows you from tab to tab with no way back.

**D7 — where Quit lives.** *Answer:* (b), outside the tabs altogether, always visible. Quit
belongs to the application, not to a page of it (F1 of plan 0003).

**D8 — which tab opens first.** *Answer:* (a), the application's tab, always. Predictable beats
clever: a window that opens somewhere different each time is one a person has to read before
acting.

## Follow-up decisions

D4 asked for something that does not exist yet. These two settle it, and slice 02b waits on them.

**F1 — what the official list is.** *At stake:* a list of plugins this application offers has to
come from somewhere, and that somewhere becomes a thing to publish and keep.
*Options:* (a) a signed JSON index on the same server the release index already lives on, listing
id, versions, a description and where each is published — the release machinery of plan 0003
slice 09 already knows how to fetch and verify such a file; (b) a directory in the repository,
shipped inside each release, so the list moves only when the application does; (c) a page on
l1nx.it, read as HTML.
*Proposal:* (a). It reuses what is built, it can name a plugin that is newer than the
application, and it is signed by the same key the releases are.

**F2 — what registering another source means.** *At stake:* plan 0003's D16 already allows an
automatic update from any publisher, checked only by the lock's hashes, so a registered source is
not a trust decision so much as a place to look.
*Options:* (a) a URL of an index in the same format as the official one, added and removed in
this tab, stored in `config.toml` beside the other switches, and every entry shown with the
source it came from; (b) the same, plus a per-source switch for whether its plugins may update
automatically; (c) no user sources at all — the official list only.
*Proposal:* (a), with (b) noted: the owner already decided that trust is the lock's job, so a
second trust control here would contradict D16 rather than add to it.

**F3 — what Cancel cancels.** *Options:* (a) the tab it is on: that plugin's form returns to what
is recorded, and other tabs are untouched; (b) everything unsaved in the window; (c) the last
change only, an undo.
*Proposal:* (a). A control on a page acts on that page, and (c) is an undo model the window does
not have.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees.

This plan is done when, with monty installed:

- the window opens with a tab strip: **InnyTypes** and **monty**;
- monty's tab carries its form, its recorder table, its switch, its state and its Remove, and
  nothing about the application;
- the application's tab carries what is running, Anytype's state, the helper's numbers as
  editable fields, telemetry, launch at login, a waiting update, the installed list with Remove
  and Update, the official list with Install, and any other registered source;
- changing a helper number through the window is refused the same way a bad plugin setting is,
  and a good one takes effect without a restart;
- typing into a form and pressing Cancel leaves what was recorded, and pressing Save records it;
- typing into monty's table, switching to the application's tab and back, loses nothing;
- installing a second plugin adds a third tab without restarting the application, and removing it
  takes that tab away;
- Quit is reachable from wherever the window is, and still stops everything.
