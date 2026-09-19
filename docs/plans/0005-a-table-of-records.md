---
type: plan
title: A table of records — the settings type a plugin with several of something needs
status: DRAFT
created: 2026-09-19
updated: 2026-09-19
---

# 0005 — A table of records

## What this is

Plan 0004 gave the host a settings vocabulary and monty proved it against a real plugin. It
found exactly one thing the vocabulary cannot say.

monty watches two kinds of source. **Folders** are a `list of path`, and they moved to the host:
declared, recorded, drawn, handed back. **Volumes** did not, because a volume source is not a
value — it is a record:

```python
class SourceSpec:
    id: str
    label: str
    volume_uuid: str | None
    volume_name: str | None
    globs: tuple[str, ...]
    destination: Path | None
    speakers: tuple[str, ...]
    language: str | None
```

and monty has several of them. A `list of <scalar>` cannot hold that, so monty's volume registry
stayed in a JSON file it reads itself — which is the exact outcome plan 0004 exists to end, and
is not monty's fault.

This plan adds the missing type: **a repeating group of declared fields**, through the whole
chain the other nine types already travel.

**The closed vocabulary is not the problem; it is the point.** A plugin cannot ship a widget, a
template or a shape of its own, because a plugin that can draw in the host's window can lie in
it. So the answer is a new type *in* the vocabulary, never an escape hatch beside it.

## What a plugin writes

```json
{
  "id": "volumes",
  "type": "table",
  "label": "Recorders",
  "group": "Sources",
  "help": "Each drive monty should copy from when it is plugged in",
  "row_label": "recorder",
  "required": false,
  "row": [
    {"id": "label",        "type": "text",  "label": "Name",        "required": true},
    {"id": "volume_uuid",  "type": "text",  "label": "Volume UUID"},
    {"id": "globs",        "type": "list of text", "label": "Patterns",
     "default": ["WAV/**/*.WAV"]},
    {"id": "destination",  "type": "path",  "label": "Copy to", "kind": "folder"},
    {"id": "language",     "type": "choice","label": "Language",
     "options": ["nl", "fr", "en"]}
  ]
}
```

A row is a mapping of the row's field ids to values. The table's value is a list of those
mappings, in the order the user put them in.

`row_label` is what the **Add** button says and what an error names — "recorder 2's Copy to is
not a folder" reads like something a person can find, and "row 2" does not.

## What it must not be

- **Not nestable.** A table's row holds scalars and `list of <scalar>`, never another table. A
  table inside a table is a database, needs a navigation model the window does not have, and no
  plugin has asked for one. Refused by name at declaration time (decision D1).
- **Not a free-form mapping.** Every column is declared, with its own type and constraints, and
  a row carrying a key the declaration does not name is refused. A settings type a plugin can
  put anything into is a settings file by another name.
- **Not identified by the host.** A row has no host-assigned id. If a plugin needs a stable
  identity for a row — monty does; its `SourceSpec.id` is what a recorded state is keyed by —
  that is a declared column the plugin marks unique (decision D3).

## The chain it has to travel

Each of these already exists for the other nine types, and each needs the table to fit it:

| where | what changes |
|---|---|
| **The declaration** (`addons/manifest.py`) | a `table` type whose `row` is itself a parsed declaration; nesting refused; per-column constraints as usual |
| **The store** (`addons/settings.py`) | a recorded value is a list of rows, validated cell by cell; an invalid cell is refused naming the row and the column, the rest of the table untouched |
| **The form** (`addons/settings_form.py`) | the published field carries the row declaration, the recorded rows, and per-cell errors, so the application can draw a table without reading anything else |
| **The drawing** (`helper/toolkit.py`, `helper/window.py`) | a table widget: a header, a row of widgets per record, an **Add** and a **Remove** per row — each cell drawn by the widget its column's type already has |
| **The runtime** (`addons/run.py`) | `context.settings["volumes"]` is a tuple of mappings, in recorded order |
| **The file** (`plugins/<id>.toml`) | a table reads as an array of tables, which is the one shape TOML makes legible to a person |

## What the file looks like

TOML's array-of-tables is what this type is for, so a settings file stays something a person can
read and edit:

```toml
[values]
destination = "/Users/someone/Recordings"

[[values.volumes]]
label = "Zoom H6"
volume_uuid = "8A1F-22C3"
globs = ["WAV/**/*.WAV"]
destination = "/Users/someone/Recordings/zoom"

[[values.volumes]]
label = "Field recorder"
globs = ["**/*.wav"]
```

Attribution stays per **field**, not per row: `[written.volumes]` records who last changed the
table. Per-row attribution would mean a bookkeeping table shaped like the data, and the question
it answers — "did I set this, or did the plugin?" — is asked of the setting, not the row
(decision D4).

## Validation rules

- Every cell is validated by its column's own rules — the same `check_settings_value` every
  scalar already goes through. A table adds no new way for a value to be right or wrong.
- **A required table needs at least one row**, and a table with no rows and `required: true`
  holds the plugin disabled with the reason, exactly as a required scalar with no value does
  (plan 0004, F1).
- **A required column is required in every row.** Row 2 missing a name is refused naming row 2.
- **A unique column may not repeat** across rows, refused naming both rows (D3).
- A save is per field, as it already is: a table with a bad cell is refused whole — it is one
  field — while other fields in the same save still record. Refusing only the offending row
  would record half a table the user typed as one thing (D2).

## Drawing it

A table is the first field whose widget is not one control, so the rules it needs:

- Each row is drawn from the row declaration, cell by cell, with the same widget map every
  scalar uses. A column of type `path` gets the same picker anywhere else does.
- **Add** appends an empty row, filled with each column's declared default.
- **Remove** takes a row out. It asks first when the row is not empty (D5).
- Cell errors are drawn beside their cell; the field's own error — "at least one recorder is
  required" — above the table.
- Order is what the user sees and what the plugin receives. Whether rows can be reordered is D6.

## The gate stays hermetic

Nothing here reaches outside: declarations are data, the store writes under a temporary
directory, the drawing is asserted through the headless desktop, and the toolkit's own widget
tree is asserted by the same stand-in the other nine types use.

**One test this plan must add beyond its own slices:** the existing "every declared type has a
drawing" test is parametrised over the vocabulary, so a tenth type that nobody drew fails it
already. That test is why this type cannot be half-added.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | the declaration | the `table` type, its `row` declaration, `row_label`, nesting refused, per-column constraints, a unique column |
| 02 | the store | rows recorded as an array of tables, cell-by-cell validation, the row-and-column error, the required-table hold |
| 03 | the form and the runtime | the published field carrying rows and per-cell errors; `context.settings` handing a plugin a tuple of mappings |
| 04 | the drawing | the table widget, Add, Remove with its confirmation, cell errors beside cells, on all three platforms |
| 05 | monty's volumes | monty declares its recorders as a table, deletes its JSON registry, and `monty mount` reads the host's values — the slice that proves the type is enough for the case that demanded it |

**Order.** 01 → 02 → 03 → 04 in this repository; 05 is work in monty's repository, after 03, and
is what closes `WI-0004-09`'s qualification.

## Decisions for the owner

**D1 — nesting.** *At stake:* a table inside a table needs a navigation model the window does not
have. *Options:* (a) refuse a table inside a row, by name, at declaration time; (b) allow one
level of nesting; (c) allow arbitrary nesting. *Proposal:* (a).

**D2 — a save with one bad cell.** *Options:* (a) the whole table is refused, as one field, and
other fields in the same save still record; (b) the good rows are recorded and the bad ones
refused; (c) the whole save is refused. *Proposal:* (a) — a table is one field, and a half-saved
table is a thing the user did not type.

**D3 — row identity.** *At stake:* monty keys recorded state by its source's id, so a row needs a
stable identity across edits. *Options:* (a) a declared column marked `unique: true`, which the
plugin chooses and the user sees; (b) a hidden host-assigned id per row; (c) no identity — rows
are their position. *Proposal:* (a). (b) is state the user cannot see or fix; (c) means editing a
table silently re-points everything keyed by it.

**D4 — attribution.** *Options:* (a) per field, as now — `[written.volumes]` records who last
changed the table; (b) per row. *Proposal:* (a).

**D5 — removing a row.** *Options:* (a) remove immediately, with an Undo for the session;
(b) ask first when the row is not empty; (c) remove immediately, no undo. *Proposal:* (b), the
cheapest to build and the hardest to regret. (a) is better and needs an undo model the window
does not have.

**D6 — reordering rows.** *Options:* (a) not in this plan: order is the order rows were added,
and a plugin that needs a different order sorts what it is handed; (b) up/down buttons per row;
(c) drag to reorder. *Proposal:* (a), noting that monty does not need it.

**D7 — how wide is a table allowed to be?** *At stake:* five columns of widgets per row is a lot
of window, and monty's record has eight fields. *Options:* (a) no limit, and the application
scrolls; (b) a declared limit the host enforces, refusing a declaration with more columns than
it can draw; (c) a limit on what is shown, with the rest behind a per-row "more". *Proposal:*
(a) for now, with (c) noted as the answer if a real plugin makes a table unreadable.

**D8 — does monty's `mount` command move too?** *At stake:* `python -m monty mount` is a launchd
program the host does not start, so it cannot be handed `context.settings` (this is why the
registry stayed behind). *Options:* (a) monty reads the host's recorded settings file directly
when it runs outside the host — one format, one place, read by two processes; (b) the host grows
a way to hand settings to a program it did not start; (c) volumes stay in monty's own file and
this plan covers the table type only, without its proving case. *Proposal:* (a): the file is the
host's, documented, and read-only from `mount`'s side. (b) is a new contract for one caller.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees.

This plan is done when, with monty installed:

- monty declares its recorders as a table, and the application draws it with a row per recorder
  and an Add button;
- typing a recorder's name, UUID and destination into that table records it, restarts monty, and
  monty matches that drive when it is plugged in;
- a row missing its required name is refused naming that row, and nothing about the other rows
  changes;
- `monty mount` uses the same values, and monty's own JSON registry is gone;
- the "every declared type has a drawing" test passes with ten types, not nine.
