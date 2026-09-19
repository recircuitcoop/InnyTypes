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
   the restart attempts and backoff, the breaker's window, the stability defaults. D3 decides how
   many of those a person may edit here.
4. **This application.** Telemetry, launch at login, the version, a staged update with its Apply,
   and **Quit**.
5. **Plugins.** Add a plugin, and the list: every installed plugin with its state, a Remove and
   an Update where one is waiting. The same actions the plugin's own tab carries — see D4.

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
  wrong (decision D6).
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
| 02 | the application's tab | the five groups above, assembled from what already exists, with Quit fixed to this tab |
| 03 | a plugin's tab | one plugin's form, switch, state, remove and update — the plugin page of plan 0004, narrowed to one plugin |
| 04 | the drawing | `toga.OptionContainer` (or its equivalent), the tab strip, the selected tab, what a tab switch does to unsaved typing, and the platform sweep |
| 05 | what a person sees first | which tab is selected on opening, what a notification's click selects, and what happens to the selection when a plugin is added or removed |

**Order.** 01 → 02 and 03 (either order) → 04 → 05.

## Decisions for the owner

**D1 — what a plugin's tab is named.** *Options:* (a) the plugin's id, `monty`, which is what
every message about it already says; (b) a display name from its manifest, which no manifest has
today and would be a new field; (c) the id, with the state as a suffix — `monty (held)`.
*Proposal:* (a). The id is what `helper status`, every error and every command already use, and a
second name for one plugin is a second thing to learn.

**D2 — a plugin with no settings.** *Options:* (a) it still gets a tab, carrying its switch,
state and Remove; (b) plugins with no settings appear only in the application tab's list.
*Proposal:* (a): every plugin is in the same place, and "where do I turn this off" has one
answer.

**D3 — may the helper's own numbers be edited in the window?** The tick, the restart attempts and
backoff, the breaker's window, the stability defaults. *Options:* (a) shown, not editable — the
file is the place, and the window says which file; (b) editable, with the same validate-and-refuse
the plugin forms already have; (c) not shown at all.
*Proposal:* (a) for now. They are numbers a person changes once, and every one of them already
has a refusal path in `config.toml` that the window would have to grow a second time.

**D4 — the plugin list on the application tab, when each plugin has its own tab.** *Options:*
(a) the list is names and states only, and every action lives on the plugin's own tab, with Add
the one exception; (b) the list carries Remove and Update too, so a person can act without
leaving the tab; (c) no list at all — the tab strip *is* the list.
*Proposal:* (a). Two Removes for one plugin is two things to test and one thing to get wrong;
(c) loses the overview that says which of six plugins needs attention.

**D5 — obtaining the Anytype key.** *Options:* (a) it stays `innytypes anytype-mcp get-key`, and
the tab says so; (b) a button on the application tab that runs it, with the four-digit code typed
into the window. *Proposal:* (a) here, noting (b) as the obvious next step — the key flow is
interactive and deserves its own slice rather than a corner of this one.

**D6 — a tab switch with something typed in.** *Options:* (a) fold the widgets back into the
working copy on every switch, exactly as Save does, so nothing is lost and nothing is written;
(b) save on switch; (c) ask. *Proposal:* (a). (b) writes what a person has not finished typing;
(c) asks a question about something they may not have meant to change.

**D7 — where Quit lives.** *Options:* (a) on the application's tab only; (b) outside the tabs
altogether, always visible; (c) on every tab. *Proposal:* (b), which keeps F1's promise without
repeating the control — Quit belongs to the application, not to a page of it.

**D8 — which tab opens first.** *Options:* (a) the application's, always; (b) the one that was
open last; (c) the first plugin that needs attention — held, quarantined or broken — and the
application's tab when none does. *Proposal:* (c), falling back to (a). A window that opens on
the thing that is wrong is a window that tells you something.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees.

This plan is done when, with monty installed:

- the window opens with a tab strip: **InnyTypes** and **monty**;
- monty's tab carries its form, its recorder table, its switch, its state and its Remove, and
  nothing about the application;
- the application's tab carries what is running, Anytype's state, the helper's numbers,
  telemetry, launch at login, a waiting update, Add a plugin and the plugin list;
- typing into monty's table, switching to the application's tab and back, loses nothing;
- installing a second plugin adds a third tab without restarting the application, and removing it
  takes that tab away;
- Quit is reachable from wherever the window is, and still stops everything.
