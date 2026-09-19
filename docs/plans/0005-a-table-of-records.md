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

This plan adds the missing type: **a repeating group of declared fields, which may itself
contain one** — so what a plugin can declare is a **tree**, not a flat table (D1). It travels the
whole chain the other nine types already travel.

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

## What it is, and what it must not be

- **It nests** (D1). A row may hold another table, so a declaration describes a tree. The
  drawing is therefore a tree — an outline of rows that expand — rather than a grid, and every
  rule below applies at every depth. The owner's reason, and it is the right one: *"the
  structure then becomes a tree and there are fine representations for that."*
- **Not a free-form mapping.** Every column is declared, with its own type and constraints, and
  a row carrying a key the declaration does not name is refused. A settings type a plugin can
  put anything into is a settings file by another name.
- **Not identified by the host.** A row has no host-assigned id. A plugin that needs a stable
  identity for a row — monty does; its `SourceSpec.id` is what recorded state is keyed by —
  marks one of its own columns `unique`. That marking is **optional**: a table whose rows need
  no identity declares none, and a plugin that wants a subtler rule than "this column repeats"
  resolves it itself (D3).

## The chain it has to travel

Each of these already exists for the other nine types, and each needs the table to fit it:

| where | what changes |
|---|---|
| **The declaration** (`addons/manifest.py`) | a `table` type whose `row` is itself a parsed declaration, to any depth; per-column constraints as usual |
| **The store** (`addons/settings.py`) | a recorded value is a list of rows, validated cell by cell at every depth; the rows that pass are recorded and the rest refused, each naming its row and column |
| **The form** (`addons/settings_form.py`) | the published field carries the row declaration, the recorded rows, and per-cell errors, so the application can draw a table without reading anything else |
| **The drawing** (`helper/toolkit.py`, `helper/window.py`) | a tree widget: rows that expand, an **Add**, a **Remove** and a drag handle per row, the later columns behind a per-row **more**, each cell drawn by the widget its column's type already has |
| **The runtime** (`addons/run.py`) | `context.settings["volumes"]` is a tuple of mappings, in recorded order |
| **The file** (`plugins/<id>.toml`) | a table reads as an array of tables, nested as declared — the one shape TOML makes legible to a person |

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

Attribution is per **field**, not per row, and what it records at all is D4 — see *Why
attribution exists*. Per-row attribution would mean bookkeeping shaped like the data, answering
a question nobody asks of a row.

## Detecting a mount on three platforms

The application runs on macOS, Linux and Windows (plan 0003, D7), so **no OS event mechanism is
used at all** — not launchd, not udev, not WMI. Each of those is one platform's answer, and
three of them would be three code paths that drift.

The pattern is the one this project already uses for the process table, notifications and the
machine id:

1. **One injected seam**, `VolumeProvider`, which answers "what is mounted right now".
2. **A factory that picks per platform** and **refuses** a platform it has no reader for, rather
   than quietly answering "nothing is mounted" — a silent empty list is how a plugin looks
   healthy while doing nothing.
3. **Polled on the plugin's own tick**, so detection is one code path everywhere. A drive
   plugged in while InnyTypes is closed is noticed when it next starts, which is the same
   behaviour as today, since monty's agent is installed on no machine.
4. **`on_mount` does not change.** It is already pure: registered sources in, matches out.

### A volume's identity, per platform

**Matching is by UUID first, and the fallback is what makes duplicate names dangerous:** two
drives called `RECORDER` are one name and two disks, and a name-only match would copy the wrong
one. `psutil.disk_partitions()` answers on all three platforms but gives a device and a mount
point, never a UUID, so identity is its own seam with its own per-platform reader:

| platform | where the identifier comes from | what it is |
|---|---|---|
| macOS | `diskutil info -plist <mount point>` | `VolumeUUID` |
| Linux | `/dev/disk/by-uuid` (the symlink whose target is this partition's device), with `blkid` as the fallback | the filesystem UUID |
| Windows | `GetVolumeInformationW` through `ctypes`, or `wmic volume get DeviceID` | the volume serial number |

Rules that hold on all three:

- **A volume with no readable identifier is not a UUID match.** It can still match by name, and
  such a match stays flagged `needs_confirmation`, which is what monty's `on_mount` already
  does — the flag exists precisely because acting on a name alone could copy a stranger's drive.
- **A name that matches two mounted volumes is not a match at all.** It is reported as
  ambiguous, naming both mount points, and monty asks rather than guesses. This is the case the
  owner asked for: *"the match will work even if 2 volumes have the same name."*
- **The reader is asked once per tick**, not once per registered source, so ten sources on one
  machine do not mean ten `diskutil` calls.
- **Every reader is injected**, so the gate proves the matching against a fake machine with
  duplicate names, missing UUIDs and a reader that fails — and never runs `diskutil`, reads
  `/dev`, or opens a Windows handle.

## Validation rules

- Every cell is validated by its column's own rules — the same `check_settings_value` every
  scalar already goes through. A table adds no new way for a value to be right or wrong.
- **A required table needs at least one row**, and a table with no rows and `required: true`
  holds the plugin disabled with the reason, exactly as a required scalar with no value does
  (plan 0004, F1).
- **A required column is required in every row.** Row 2 missing a name is refused naming row 2.
- **A unique column may not repeat** across rows, refused naming both rows (D3).
- **A save records the rows that pass and refuses the rows that do not** (D2), each by its own
  reason. A table is the one field where partial recording is right: a table of ten recorders is
  ten things the user entered, not one, and losing nine because the tenth has a typo is the
  behaviour a person would call a bug. The refused rows keep their previous values and their
  errors are shown against them.

## Drawing it

A table is the first field whose widget is not one control, and with D1 it is a tree, so:

- Each row is drawn from the row declaration, cell by cell, with the same widget map every
  scalar uses. A column of type `path` gets the same picker it does anywhere else.
- A column that is **itself a table** draws as a nested, collapsible group under its row. Depth
  is drawn as indentation, and a row collapses to its first column so a deep declaration stays
  readable.
- **Only the first columns are shown**, with the rest behind a per-row **more** (D7). Eight
  columns of widgets per row is a window nobody can read, and monty's record has eight.
- **Add** appends an empty row, filled with each column's declared default.
- **Remove** takes a row out, asking first when the row is not empty (D5).
- **Rows can be dragged to reorder** (D6). The owner's reason to have it now: the same control
  is what ordering between plugins would need, and building it twice is how two of them end up
  behaving differently.
- Cell errors are drawn beside their cell; the field's own error — "at least one recorder is
  required" — above the table.

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
| 01 | the declaration | the `table` type, its `row` declaration, `row_label`, **nesting to any depth**, per-column constraints, an optional `unique` column |
| 02 | the store | rows recorded as an array of tables at every depth, cell-by-cell validation, **the rows that pass recorded and the rest refused**, the row-and-column error, the required-table hold |
| 03 | the form and the runtime | the published field carrying rows, nested rows and per-cell errors; `context.settings` handing a plugin a tuple of mappings, nested as declared |
| 04 | the drawing | the tree widget: expand, Add, Remove with its confirmation, drag to reorder, the per-row **more**, cell errors beside cells, on all three platforms |
| 05 | the volume seam | `VolumeProvider` and the per-platform identity readers, the ambiguous-name refusal, and the factory that refuses an unknown platform — in innytypes, because three platforms is the host's problem, not each plugin's |
| 06 | monty's volumes | monty declares its recorders as a table, reads them from `context.settings`, polls the seam on its own tick, and **deletes** `monty mount`, its launchd agent and its JSON registry — the slice that proves the type against the case that demanded it |

**Order.** 01 → 02 → 03 → 04 in this repository, and 05 beside them (it needs none of the table
type). 06 is work in monty's repository, after 03 and 05, and is what closes `WI-0004-09`'s
qualification.

## Decisions

Answered by the owner on 2026-09-19, except the two below marked open.

**D1 — nesting.** *Answer:* (c), arbitrary nesting — *"the structure then becomes a tree and
there are fine representations for that."* A row may hold a table; a declaration is a tree; the
drawing is an outline rather than a grid. Every rule in this plan applies at every depth, and
slice 04 grows accordingly.

**D2 — a save with one bad cell.** *Answer:* (b), the rows that pass are recorded and the rest
refused, each by its own reason. A table of ten recorders is ten things the user entered, and
losing nine to a typo in the tenth is what a person would call a bug.

**D3 — row identity.** *Answer:* (a), a declared column marked `unique` — **and never
compulsory**: a table whose rows need no identity declares none, and a plugin wanting a subtler
rule than "this column repeats" resolves it itself. The host enforces the marking when it is
there and asks nothing when it is not.

**D4 — attribution.** *Answer:* (a), keep it as it is — the writer and the timestamp, per field.
The owner asked first why it exists at all: "innytype is an application that runs locally for ONE
user at all times. It is never distributed execution." It is not about users; it is about **two
writers on one machine, the user and the plugin** — see *Why attribution exists* below. Kept
whole rather than reduced to a flag, so the window can say when as well as who.

**D5 — removing a row.** *Answer:* (b), ask first when the row is not empty.

**D6 — reordering rows.** *Answer:* (c), drag to reorder — *"will be useful IF we implement
order between plugins"*. Built now, because the same control is what ordering between plugins
would need and building it twice is how two of them end up behaving differently.

**D7 — how wide a table may be.** *Answer:* (c), the first columns are shown and the rest sit
behind a per-row **more**. monty's record has eight fields, so this is the case rather than the
hypothetical.

**D8 — does `monty mount` move too?** *Answer: the question dissolves — there is no second
reader.* The owner: "Monty is a PLUGIN for innytypes. It only sends events over for other
plugins to consume: it makes no sense for monty to exist otherwise than through the host."
`monty mount`, its launchd agent and its JSON registry are **deleted**. The plugin polls what is
mounted on its own tick, exactly as it already polls folders, and calls its own pure `on_mount`
with the volumes the host handed it.

And a correction that goes further than the question asked (see *Detecting a mount on three
platforms*): launchd was never the right answer anyway, because it is macOS only —
*"using launchd is making the code usable for macos platforms only. We agreed on a different
way: find it and apply it for ALL mount detections."*

### Why attribution exists

It is not about two people; it is about **two writers on one machine — you and the plugin**
(plan 0004, D11 and F2). A plugin may write its own settings back, which is what lets one keep
what an authorisation gave it rather than inventing a store of its own. That creates two
questions attribution answers, and nothing else does:

1. **Whether to restart the plugin.** A value the *user* changed restarts the plugin so it runs
   on what was chosen (D10). A value the *plugin itself* just wrote must not: restarting it
   would throw away the authorisation it was in the middle of, and a plugin that writes on every
   start would restart for ever. `innytypes/helper/settings_watch.py` makes exactly that
   distinction today, by reading `[written.<id>].by`.
2. **Whether the user is surprised.** "set by monty" beside a value nobody typed is the
   difference between a setting that changed and a setting that changed mysteriously.

So if attribution goes, the restart rule needs another signal — the plugin's own write would
have to be marked some other way, or every plugin write would have to restart the plugin.

Settled as (a): the writer and the timestamp, per field, unchanged from plan 0004.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees.

This plan is done when, with monty installed:

- monty declares its recorders as a table, and the application draws it with a row per recorder
  and an Add button;
- two mounted volumes with the same name do not produce a wrong match: the UUID decides, and
  where no UUID can be read the ambiguity is reported rather than guessed;
- `monty mount`, monty's launchd agent and its JSON registry are gone, and monty notices a drive
  by polling on its own tick on all three platforms;
- typing a recorder's name, UUID and destination into that table records it, restarts monty, and
  monty matches that drive when it is plugged in;
- a row missing its required name is refused naming that row, and nothing about the other rows
  changes;
- `monty mount` uses the same values, and monty's own JSON registry is gone;
- the "every declared type has a drawing" test passes with ten types, not nine.
