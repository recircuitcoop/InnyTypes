---
type: plan
title: Actions a plugin declares — a button a person presses, delivered to the running plugin
status: TODO
created: 2026-09-23
updated: 2026-09-23
---

# 0011 — Actions a plugin declares

## What this is

A plugin can declare **settings** (plan 0004) and the application draws them. It cannot declare
anything a person *does*. There is no way for a person to say "now" to a running plugin: the only
channel into an addon is the event bus, and events flow publisher → subscriber between plugins,
never from the person.

This plan adds **actions**: a plugin declares a named action in its manifest, the application
draws it as a button, and pressing it delivers one request to that plugin's running process.
Nothing else — no scripts, no plugin-drawn UI, no return value rendered by the host.

## Why, in the words of the plugin that hit it

monty watches folders and mounted volumes and emits `monty.new.v1` for each file that appears.
When a card is plugged in, everything already on it is adopted **silently**, because announcing a
2,000-file card would flood subscriber queues bounded at 128 and drop the plugins that mattered.
The owner's rule for that, verbatim:

> "No, but user can re-emit event manually with a button press for every pre existing file"

monty had a CLI for exactly this kind of request once, writing into a directory its running
process polled. Both are gone — the CLI was deleted with monty's mount agent, and a whole-source
test keeps it deleted, because a plugin with its own side door is a plugin the host cannot
describe. The button belongs in the host, where every plugin's buttons look and behave alike.

monty is not a special case: "sync now", "re-scan", "retry the failed ones", "clear the cache"
are the first thing most plugins with state will want.

## The declaration

A manifest gains an optional `actions` list. Each action has an `id`, a `label`, optional `help`,
optional `confirm` (text shown before sending — for anything a person should not press by
accident), and optional `params`, which are **ordinary settings fields in plan 0004's
vocabulary**. No new field types: a form the host can already draw, validate and record is the
only form an action may ask for.

An action may instead be declared **on a table** with `on: "<table id>"`, including a nested
table (`on: "volumes.watch"`). The application then draws the button on every row of that table,
and the request carries the row's `unique` column value — so "re-announce this folder" is a
button on the folder's own row, not a picker asking which folder.

```json
{"actions": [
  {"id": "re-emit", "label": "Announce what is already there", "on": "folders"},
  {"id": "re-emit", "label": "Announce what is already there", "on": "volumes"},
  {"id": "re-emit", "label": "Announce what is already there", "on": "volumes.watch"}
]}
```

Refused at declaration, by name: an `id` outside the segment grammar; two actions with the same
`id` on the same target; `on` naming a field that is not a table; `params` on a row action (the
row *is* the parameter); a `params` field of a type outside the vocabulary.

## Delivery

Pressing the button sends one request to the plugin's **running** process: the action id, the
recorded values of its params, and — for a row action — the table path and the row's `unique`
value. The plugin receives it through a method the runner already calls on the plugin's own
thread; the plugin never sees another plugin's actions, and no plugin can send one.

**The host confirms delivery, not completion.** The request crosses a process boundary on the
same bounded, fire-and-forget machinery as events, so the application must say whether it
arrived. A request that could not be delivered is reported to the person who pressed the button,
in words, and never silently dropped: a person who pressed "announce" and heard nothing will
press it again, and a plugin whose action is idempotent only by luck will do the work twice.

A plugin that is **not running** — disabled, quarantined, failed to start — has its buttons drawn
disabled with the reason, rather than accepting a press it cannot deliver.

## Host API version

Declaring `actions` needs a host that delivers them. The `host_api` version that introduces this
plan is required by any manifest that declares one, older versions keep starting, and a manifest
declaring actions against an older `host_api` is refused naming the field — the same rule plan
0005 applied to `table`, for the same reason: a plugin whose buttons silently vanish on an older
host is worse than one that refuses to install.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | the declaration | `actions` in the manifest: plugin and row actions, `params` in the existing vocabulary, `confirm`, and every refusal above |
| 02 | delivery | the request crossing to the running plugin, its arrival method, delivery confirmed or reported as failed, and nothing delivered to a plugin that did not declare the action |
| 03 | the buttons | the application draws plugin actions on the plugin's page and row actions on each row, disabled with a reason when the plugin is not running, with `confirm` shown first |
| 04 | monty's re-emit | monty declares `re-emit` on `folders`, `volumes` and `volumes.watch` and handles it — worked in monty's repository against an installed host (monty plan 0002, slice 06) |

**Order.** 01 → 02 → 03. 04 needs all three and an installed host.

## Done

- **D1.** A manifest declaring a plugin action and a row action is accepted, and each refusal
  above is reported by name.
  <!-- demonstrated-by: tests/test_actions_declaration.py::test_every_malformed_action_is_refused_by_name -->
- **D2.** Pressing an action delivers exactly one request, with its params or its row's `unique`
  value, to the running plugin that declared it, and to no other plugin.
  <!-- demonstrated-by: tests/test_actions_delivery.py::test_a_press_reaches_only_the_plugin_that_declared_it -->
- **D3.** A request that cannot be delivered is reported to the person, and is never silently
  dropped.
  <!-- demonstrated-by: tests/test_actions_delivery.py::test_an_undelivered_press_is_reported -->
- **D4.** A plugin that is not running has its buttons disabled with the reason.
  <!-- demonstrated-by: tests/test_window_actions.py::test_a_stopped_plugins_buttons_say_why_they_are_disabled -->
- **D5.** A manifest declaring actions against an older `host_api` is refused naming the field; a
  plugin with no actions still starts on every supported version.
  <!-- demonstrated-by: tests/test_manifest.py::test_actions_need_the_host_api_that_introduced_them -->
- **D6.** monty's `re-emit` row action replays `monty.new.v1` for what is present in that row's
  scope.
  <!-- demonstrated-by: monty's own gate, against an installed host -->

Done when every clause above is demonstrated, and `verify.sh` is green.
