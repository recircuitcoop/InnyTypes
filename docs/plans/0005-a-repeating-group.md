---
type: plan
title: A repeating group — the tenth type, so a plugin can ask for a list of things
status: SUPERSEDED
created: 2026-09-19
updated: 2026-09-20
---

# 0005 — A repeating group

> **Superseded:** the owner chose arbitrary nesting rather than this proposal's one-level
> group. [0005 — A table of records](0005-a-table-of-records.md) is the approved design that
> was implemented by `WI-0005-01` through `WI-0005-05`.

## What this is

Plan 0004 closed the settings vocabulary on purpose, at nine types, and said so plainly: a
plugin cannot ship a widget, and *"a list of a list is not a type"*. That was right. This plan
adds the **tenth** type, because the first real plugin to use the vocabulary cannot express what
it needs, and the workarounds are worse than the type.

**`list of group`** — a repeatable *row* of fields, where each field is one of the existing nine
scalar types. One level deep. Nothing else changes.

## Why, in the words of the plugin that hit it

monty watches folders and volumes, and plan 0002 gives every watched thing its own switches: the
folder, whether it is enabled, which file extensions it emits events for, whether monty may
delete in it, and which other plugin's "done" kinds authorise that deletion. Per folder, not
globally — a card's `WAV` may be deletable while its `MANUAL` is not.

That is a list of tables, and the vocabulary has no table. monty's plan 0002 wrote down the three
ways out, and the owner chose the third:

- **Parallel lists** — `folders` as `list of path`, plus one `list of text` per switch, matched by
  position. *"Cheap, and horrible to get wrong by one."* It is also undrawable: the application
  would show five unrelated lists and no person could tell which row of one belongs to which row
  of another. The host's own validator could not say `folders[2].extensions is empty` — it would
  say `extensions[2] is empty` about a list that does not know what it is parallel to.
- **One folder, many installs** — flatten to a single folder per configured plugin. Clean, but
  *"the host has no notion of two instances of one addon today"*, and giving it one is a larger
  change than this plan.
- **Ask innytypes for a repeating group.** *"The right answer if this plan keeps per-folder
  switches, and an innytypes change rather than a monty one."*

monty is not a special case. Any plugin configuring *several of the same thing* — accounts,
feeds, cameras, mailboxes — meets the same wall on its first real form.

## The type

A field of type `list of group` declares a `fields` list. Each entry is an ordinary field
declaration of one of plan 0004's nine types. The host stores a list of objects, one per row,
keyed by the group's field ids.

```json
{
  "id": "folders",
  "type": "list of group",
  "label": "Watched folders",
  "group": "Sources",
  "fields": [
    {"id": "path", "type": "path", "kind": "folder", "label": "Folder", "required": true},
    {"id": "enabled", "type": "switch", "label": "Watch this folder", "default": true},
    {"id": "extensions", "type": "text", "label": "Extensions", "help": "Comma separated, or 'all'"},
    {"id": "delete_on_done", "type": "switch", "label": "May delete here", "default": false}
  ]
}
```

recorded as

```json
{"folders": [
  {"path": "/Volumes/RECORDER/WAV", "enabled": true, "extensions": ".wav", "delete_on_done": true},
  {"path": "/Users/x/Downloads", "enabled": false, "extensions": "all", "delete_on_done": false}
]}
```

### The rules, and why each one is a refusal rather than a feature

- **One level. A group's fields are scalar.** No `group` inside a `group`, and no
  `list of <type>` inside a `group` either. Plan 0004 refused a list of a list for the reason
  that still holds: the application draws a fixed set of shapes, and arbitrary nesting is a
  document format, not a form. One level covers "several of the same thing", which is the actual
  need.
- **`list of group` is the only way a group appears.** There is no bare `group` type. A single
  group of one row is a set of ordinary fields, and a plugin that declares one has written its
  form the long way round for no gain.
- **Ids are scoped to their row.** A group field's `id` must be unique within its group and may
  freely repeat an id used outside it: `folders[].path` and `volumes[].path` are different
  fields, and neither collides with a top-level `path`. The stored shape makes that natural; the
  validator must address errors the same way.
- **`shown_when` inside a group names a field in the same group**, and is evaluated per row —
  the whole point being that row 2's switch does not hide row 1's field. A group field naming a
  top-level field, or a top-level field naming a group field, is refused: the first is drawable
  but confusing, the second has no single value to test.
- **`required` means two different things, and both are useful.** On a field inside the group, it
  is required *in every row*. On the `list of group` itself, it means *at least one row*. A form
  with neither is one a person can save empty, which is the right default for a plugin that can
  idle with nothing configured.
- **`secret` is refused inside a group,** for this plan. Plan 0004 stores secrets outside the
  settings file under a per-plugin, per-field key; a per-row secret needs a key that survives
  rows being reordered and removed, and getting that wrong leaks one account's credential into
  another's row. It is a real need — an accounts list with a password each — and it deserves its
  own plan with its own rules, not a paragraph in this one.
- **A `default` on the list is a list of complete rows**, each judged exactly as a saved row is.
  A default row that would fail validation is a form nobody can save, refused at declaration
  time, which is where plan 0004 already refuses a `choice` defaulting outside its options.

### What the application draws

A titled block with one card per row, each card drawing the group's fields in declaration order,
plus **add**, **remove** and **reorder**. Reorder matters: monty's rows are independent, but a
plugin whose rows are tried in order — a list of servers, a list of rules — needs the order it
sees to be the order stored, and a list the person cannot reorder invites them to delete and
retype rows to move one.

Per-field errors address a row: `folders[1].path`. The application shows the message on that
field of that card, which is the whole reason this type exists rather than parallel lists.

## Host API version

A plugin that declares a group needs a host that understands one. Bump `HOST_API_VERSION` to
**3**, keep 2 and 1 starting, and refuse a `list of group` in a manifest that declares
`host_api: 2` — with an error naming the field and saying which version it needs, because the
alternative is a plugin whose form silently loses a section on an older host.

## What this costs

Small, and concentrated in the places plan 0004 already built:

| plan 0004 slice | what this plan adds |
|---|---|
| 01 the declaration | the type, its `fields`, the refusals above, the `host_api` gate |
| 02 the store | validating and recording a list of row objects; per-row defaults |
| 04 the form | publishing rows with per-row values and per-row errors; the save path |
| 08 the plugin page | the card list with add / remove / reorder, on all three platforms |

Nothing in plans 0001–0003 changes. Secrets (03), the enable switch (06) and `addons remove` (07)
are untouched.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | the declaration | `list of group` in the manifest: `fields`, one-level enforcement, id scoping, `shown_when` scoping, `required` both ways, `secret` refused, defaults judged as rows, and the `host_api: 3` gate |
| 02 | storing rows | validation and recording of a list of row objects, per-row defaults, per-row error addressing (`<id>[i].<field>`), and the atomic write plan 0004 slice 02 already does |
| 03 | the form and the save | the published form carries rows, their values and their per-row errors; save validates every row and reports every failing field at once |
| 04 | the cards | the window draws a card per row with add, remove and reorder, for each of the nine scalar types inside a group, on macOS, Linux and Windows |
| 05 | monty's folders | monty's settings become `folders` and `volumes` as `list of group`, proving the type against the plugin that asked for it — worked in monty's repository against an installed host |

**Order.** 01 → 02 → 03 → 04. 05 needs all of them and an installed host.

## Done

- **D1.** A manifest declaring `list of group` with scalar fields is accepted, and one nesting a
  group or a list inside a group is refused by name.
  <!-- demonstrated-by: tests/test_settings_declaration.py::test_a_group_is_one_level_deep -->
- **D2.** A group field's id may repeat an id used elsewhere, and a duplicate id within one group
  is refused.
  <!-- demonstrated-by: tests/test_settings_declaration.py::test_group_ids_are_scoped_to_their_group -->
- **D3.** `shown_when` inside a group is evaluated per row, and one crossing the group boundary in
  either direction is refused.
  <!-- demonstrated-by: tests/test_settings_form.py::test_shown_when_in_a_group_is_decided_row_by_row -->
- **D4.** `required` on a group field demands it in every row; `required` on the list demands at
  least one row; both report the row and field that failed.
  <!-- demonstrated-by: tests/test_settings_store.py::test_required_means_every_row_and_at_least_one_row -->
- **D5.** A `secret` inside a group is refused at declaration, with an error saying why and that a
  later plan owns it.
  <!-- demonstrated-by: tests/test_settings_declaration.py::test_a_secret_in_a_group_is_refused_for_now -->
- **D6.** Rows round-trip through the store unchanged, in the order they were saved, with defaults
  filled per row.
  <!-- demonstrated-by: tests/test_settings_store.py::test_rows_round_trip_in_order_with_defaults -->
- **D7.** Two rows failing different fields produce two separately addressed errors in one save.
  <!-- demonstrated-by: tests/test_settings_form.py::test_every_failing_row_is_reported_at_once -->
- **D8.** A manifest declaring a group with `host_api: 2` is refused, naming the field and the
  version it needs; a `host_api: 2` plugin with no group still starts.
  <!-- demonstrated-by: tests/test_manifest.py::test_a_group_needs_host_api_three -->
- **D9.** The window draws a card per row with add, remove and reorder, and each of the nine
  scalar types inside a group, on all three platforms.
  <!-- demonstrated-by: tests/test_window_settings.py::test_a_repeating_group_draws_as_reorderable_cards -->
- **D10.** monty declares `folders` as a `list of group` and its per-folder switches arrive in
  `context.settings` as rows.
  <!-- demonstrated-by: monty's own gate, against an installed host -->

Done when every clause above is demonstrated, and `verify.sh` is green.
