---
type: plan
title: A tab for each plugin, and one for the application itself
status: DONE
created: 2026-09-19
updated: 2026-09-20
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
| **InnyTypes** — the application's own | what is running, the Anytype MCP server, the helper's own settings, telemetry and launch at login, a waiting update, and plugin management (add, and the lists with install, remove and update) |
| **the window itself**, outside the strip | **Quit**, visible whichever tab is selected (D7) |
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
4. **This application.** Telemetry, launch at login, the version, and a staged update with its
   Apply. **Quit is not here** — D7 puts it on the window itself, outside the strip.
5. **Plugins.** Three things, in this order (D4):
   - **Installed:** every installed plugin with its state, and its **Remove** and **Update**
     right there, so six plugins can be dealt with without visiting six tabs.
   - **The official list:** the plugins this application's own index publishes, each with what
     it is and an **Install**, and marked when it is already installed.
   - **Other sources:** any plugin index the user has registered, listed the same way, with the
     source each entry came from named beside it, and **its own "update automatically" switch**
     (F2). Adding and removing a source lives here too.

   Installing from a list is `innytypes addons install` with the requirement filled in for you;
   nothing about how an install works changes.

   **An index is a signed JSON file published in a repository** (F1) — the official one is this
   project's own, and any plugin developer who publishes the same file at a URL becomes a source
   by doing so. There is no registry to be admitted to and nobody to ask: the convention *is* the
   mechanism. Trust is unchanged from plan 0003's D16 — the lock's hashes decide whether an
   artifact is the one that was published, and no index can say otherwise.

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
- **Quit lives on the window itself, outside the tabs, and nowhere else** (D7), and is never
  behind a scroll: F1's "clear and easy way of turning the whole InnyTypes application off" must
  not become "find the right tab first". There is **one** Quit in the model, not one per path:
  when the tabbed drawing lands, `WindowContents.quit` goes and the drawing reads the window's
  own control, or the application ships with two Quit controls that can disagree.

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
| 02b | the plugin index | the index file's format, fetching and verifying it, caching it, and the registered sources in `config.toml` each with its own auto-update switch |
| 02c | the plugin lists | the three lists on the tab: installed with Remove and Update, the official list with Install, other sources with theirs, and the adding and removing of a source |
| 03 | a plugin's tab | one plugin's form, switch, state, remove and update — the plugin page of plan 0004, narrowed to one plugin — and Save beside Cancel on every form |
| 04 | the drawing | `toga.OptionContainer` (or its equivalent), the tab strip, the selected tab, what a tab switch does to unsaved typing, and the platform sweep |
| 05 | what a person sees first | which tab is selected on opening, what a notification's click selects, and what happens to the selection when a plugin is added or removed |

**Order.** 01 → 02 and 03 (either order) → 02b → 02c → 04 → 05. Nothing waits on a decision: all
eight decisions and all three follow-ups are answered.

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

Answered by the owner on 2026-09-19.

**F1 — what the official list is.** *Answer:* (a), a signed JSON index — **published in a
repository**, the way a release index already is. The owner's addition matters more than the
choice: *"any plugin developper who follows this convention can become a plugin source."* So the
format is not this project's private arrangement with itself; it is a published convention, and
adopting it is the whole of becoming a source. Nothing admits a developer and nobody can refuse
one. The official index is simply the one this application ships pointed at.

**F2 — what registering another source means.** *Answer:* (b): a URL of an index in that same
format, added and removed on the application's tab, stored in `config.toml`, every entry shown
with the source it came from — **and each source carrying its own "update automatically"
switch**.

This does not contradict plan 0003's D16, and the distinction is worth writing down because it
will be mistaken later: D16 settles **whether an artifact is genuine** (the lock's hashes say so,
for every publisher alike, and a source cannot vouch for one). The per-source switch settles
**whether this machine acts on its own** when that source publishes something new. A source you
trust completely may still be one you would rather update by hand. Verification is not consent.

**F3 — what Cancel cancels.** *Answer:* (a), the tab it is on. That plugin's form returns to what
is recorded; every other tab keeps whatever is typed into it. A control on a page acts on that
page.

## Done

- The assembled window opens with **InnyTypes** and one tab per installed plugin, always on
  **InnyTypes**, including held and quarantined plugins
  (`test_the_assembled_window_always_opens_on_the_application_tab`).
- Reopen and the already-running second-launch path return to **InnyTypes** rather than the
  previously selected plugin (`test_reopening_forgets_the_plugin_that_was_last_open` and
  `test_a_second_launch_reopens_the_window_and_starts_nothing`).
- A clicked plugin notification opens its plugin tab; an application notification opens
  **InnyTypes** (`test_notification_click_selects_its_plugin_or_the_application`).
- Installing a plugin adds its tab without moving selection
  (`test_install_adds_a_tab_without_moving_selection`).
- Removing an unselected plugin preserves selection, while removing the selected plugin falls
  back to **InnyTypes**
  (`test_removing_selected_and_unselected_plugins_obeys_the_selection_rule`).
- Plugin tabs carry their forms, tables, state and actions; Save and Cancel remain local
  (`test_a_fully_described_plugin_tab_carries_every_part` and
  `test_cancel_is_local_to_one_tab`).
- The application's tab carries its process, helper-setting, update and plugin-list groups
  (`test_application_group_has_existing_controls_but_not_quit` and the
  `test_application_tab.py` and `test_plugin_lists.py` suites).
- Switching tabs preserves unsaved scalar and table values
  (`test_tabs_follow_the_model_and_switching_folds_text_and_table_widgets`).
- Quit is outside the tab strip and remains reachable from every tab
  (`test_quit_is_drawn_last_and_always`).
- `docs/loop/verify.sh` exits zero and prints `gate: GREEN`.
