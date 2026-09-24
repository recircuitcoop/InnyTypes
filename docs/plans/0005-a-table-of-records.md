---
type: plan
title: A table of records — the settings type a plugin with several of something needs
status: DONE
created: 2026-09-19
updated: 2026-09-24
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

## What the declaration settles (slice 01)

These are contracts the later slices read, decided while building the declaration and written
down here so the store, the form and the drawing do not each answer them again.

- **`table` is named beside the eight scalar types, not among them.** `SETTINGS_FIELD_TYPES`
  stays the eight a `list of <type>` may hold; `SETTINGS_TABLE_TYPE` is the tenth type's own
  name. **`list of table` is refused** — a table already holds several rows, so a list of them
  repeats a repetition, and a table whose row holds a table says the same thing once.
- **A column is addressed by the path down to it**, and a refusal names the whole path:
  `settings[0] (id 'libraries').row[1] (id 'recorders').row[0] (id 'label')`. Declaration
  positions are counted from zero, exactly as `settings[1]` already is, because they name a
  place in a file the author wrote.
- **A row of values is named by its row_label and its position counted from one** —
  `recorder 2`, never `row 2`, and in a nested table `(recorder 1).takes (take 2)`. One names
  a thing in a manifest; the other names a thing a person sees on screen.
- **`row_label` has no default.** A defaulted one would put "row 2" into the messages a
  person reads, which is the outcome this plan exists to avoid, so a table that omits it is
  refused like a `choice` that omits its options. An empty `row` is refused too: a table with
  no columns holds nothing.
- **`unique` is accepted on `text`, `number`, `choice` and `path`, and on nothing else.** A
  `secret`'s value never leaves the secret store and so is never there to compare; a
  `list of <type>` and a **nested table** are repeating or composite values rather than an
  identity. The marking is refused wherever it could not be honoured, `unique: false`
  included, because an attribute an author believes is in force is what the manifest refuses
  everywhere else. It may be declared only on a row field — a top-level field holds one value,
  with nothing to be unique among — and at most one column per row carries it. A **nested**
  row is its own row, so it may mark its own.
- **Visibility is judged one list at a time.** A row field's `shown_when` names a field of
  the **same** row; it may not reach into an enclosing row, a sibling table's row, or the form
  around the table.
- **A table's `default` is its whole starting set of rows**, judged here by exactly the rule
  slice 02's store will apply to a recorded value: every declared column judged by its own
  constraints, a key the row declaration does not name refused, and a required column that
  declares no default of its own refused when a row omits it — a required column that *has* a
  default may be omitted, because that default is what fills the cell. An **empty** default is
  refused: a table that starts with no rows is what a table with no default already is. Rows
  are held as immutable mappings, so a parsed declaration stays immutable all the way down.
- **The no-repeat half of `unique` belongs to the store**, not here. The declaration records
  the marking; whether two rows collide is a question about a set of recorded rows, and slice
  02 is where sets of rows are judged (*Validation rules*, above).

## What the store settles (slice 02)

The same kind of contract as the section above, decided while building the store, so the form,
the drawing and the runtime read them rather than answering them again.

- **A submitted list is the whole table, and rows are matched to what is recorded by
  position.** This is what makes D2's "keeps its previous value" mean something precise, and it
  is the difference between the two things a save does:
  - a row the user **edited** has a row at its position on disk, so a refusal leaves that row
    exactly as it was — every cell of it, including the ones the user was not editing;
  - a row the user **added** has nothing at its position, so a refusal leaves it *absent*.
    Never a half-filled row, and never one padded out with the columns' defaults: a row nobody
    could save is not a row.
  - a row the user **removed** is expressed by leaving it out of the list, and is removed.
  The matching holds at every depth — a refused `take` keeps the take recorded at that position
  inside the recorder at that position — so one rule covers the whole tree.
- **A write whose every submitted row was refused changes nothing at all**, exactly as a write
  of only invalid scalar fields already does. An **empty** list is not that case: it is the
  user emptying the table, and it is recorded (which is how a required table comes to be held
  with no rows). The file writes it as `volumes = []`, since an array of tables has no spelling
  for "none".
- **A column's own default fills a cell the row leaves out**, wherever a row is recorded or
  handed over. That is what slice 01 meant by "a required column that *has* a default may be
  omitted, because that default is what fills the cell" — the filling happens **here**, not in
  the declaration, whose `default` stays exactly the rows the author wrote. A table's declared
  default goes through the same judgement a recorded value does, so a plugin is handed one
  shape whether its rows came from the manifest or from the file.
- **`unique` is judged over the rows of one submission that pass**, never over a row kept from
  disk — a kept row is not what the user just typed, and accusing it would name a row they
  cannot see on the screen they are looking at. A repeat that survives that way (a kept row
  colliding with a new one) is caught by the very next read, which judges every recorded row
  together and holds the plugin with both named.
- **A cell's refusal is the row's name followed by the wording the column's own type already
  produces**: `volumes: recorder 2's interval is 3, below the declared min 5`. The tail is
  character-for-character what a top-level `interval` would say, because it is the same
  `check_settings_value` call with the column's id — one constraint cannot read two ways.
- **A required table with no usable row is absent from the values handed over**, and held with
  the reason, exactly as a required scalar with no value is. A table with *some* usable rows
  hands those over and is held only if something else is wrong: the rows that pass are real
  answers, and a person correcting row 2 of ten should see the other nine on screen.
- **A `secret` column is refused at any depth**, by field, and holds the plugin disabled. The
  declaration allows one (a `secret` is a legal row type; only marking it `unique` is refused),
  and this file is the one place a secret may never be (plan 0004, D6) — so the store refuses
  the whole table rather than writing a token into `plugins/<id>.toml`.

## What the form and the runtime settle (slice 03)

The same kind of contract again, decided while building the published form and the runtime, so
the drawing (slice 04) and monty (slice 05) read them rather than answering them again.

- **A refusal carries the address of the cell it is about, and that is the address the form
  places it at.** A `FieldProblem` about a table now carries a `CellAddress`: the rows to
  descend through — `(volumes, 2)`, then `(takes, 1)`, positions counted from one exactly as
  the row's name is — and the column of the last one. The published field answers to the same
  address (`field.error_for(problem.cell)`), so the application never derives a row name, a
  position or a key of its own to work out where a refusal goes. **One vocabulary across the
  save and the page** is the rule; two would drift the first time either side was amended.
  `column` is `None` when what is wrong is the **row** rather than a cell of it (a row that is
  not a mapping, a row carrying a key the declaration does not name), and the path is empty
  when it is the **table** rather than any row (`volumes must be a list of recorders`).
- **A cell's reason hangs on the cell, and nowhere else.** The field's own `error` is what is
  wrong with the table as a whole — "volumes is required and holds no recorder" — and a
  per-cell reason is never also repeated there, because the same sentence in two places on one
  page is what the drawing section already refuses. `PublishedForm.errors` is therefore
  field-level by construction; the hold is what still says the plugin is not running.
- **The whole tree is in one publish.** A published table carries its row declaration, its
  `row_label`, and its rows; a row carries its cells, its nested tables' rows under their own
  column ids, and its errors. Nothing below the top of the tree needs a second read, a
  manifest, a store or a lock to be drawn.
- **A table column is published as rows, never also as a cell.** A column whose declaration has
  a `row` is absent from the row's cell values and present in its nested rows, so there is one
  place to draw it from and no second one to disagree.
- **A refused row is published as it was submitted.** The store keeps the row that was on disk
  at that position (D2) — the right answer for the file and the wrong one for the screen, since
  a person cannot correct a value they cannot see. So the form remembers what the last save
  submitted for a table that was refused, publishes that, and forgets it the moment a save
  records the field. This is the table's form of the rule the form already had for a scalar: a
  refused value is shown as it was submitted.
- **A row is named once**, by the same function the store's refusals use, so `recorder 2` on
  the page and `recorder 2` in a sentence are one implementation rather than two spellings.
- **The runtime needed nothing of its own.** `context.settings["volumes"]` is the store's own
  judged value: a tuple of immutable mappings in recorded order, with a nested table column a
  tuple of mappings inside its row. A plugin writing a table back through `write_settings`
  goes through the same `written_by` check and the same per-row judgement a person's save
  does — so `user` refuses the plugin, `plugin` and `both` record it and attribute the write
  to the plugin, and one bad row among three costs that row alone.

## What the drawing settles (slice 04)

The same kind of contract again, decided while building the drawing, so monty (slice 05) and
whatever draws a table next read them rather than answering them again.

- **The table is a named type in the widget map, beside the eight scalars.** `FIELD_WIDGETS`
  gains `table`, `WidgetKind` gains a tenth member, and the toolkit gains a tenth builder —
  so both parametrised "every declared type has a drawing" tests sweep it without being told
  about it, and a table whose drawing is deleted fails the gate exactly as a `text` field's
  would. The tenth widget is the one that is **not a control**: it is a box of rows.
- **The drawing is a working copy, and only Save writes.** Add, Remove, a reorder and the
  per-row **more** change what is on the screen and nothing on disk; the rows a Save submits
  are the working copy in the order it is in at that moment. That is what makes D6 mean
  something ("a Save after a reorder writes the new order") and it is why a table is the one
  part of the page that survives a redraw: the drawing is kept until **what is published for
  it changes**, which a save that records or refuses it always does. A refusal therefore
  replaces the working copy with the submitted rows the form republishes (slice 03), and
  nothing an edit was in the middle of outlives the save it was submitted by.
- **Reading a table is two steps, and the order is the contract.** Every cell on the screen
  is folded back into its row first, and the rows are then asked what they hold. So a cell
  behind a **more** — never drawn, never read — is carried by a save rather than emptied by
  one, and what a person typed survives the redraw an **Add** causes.
- **D5 is asked on the row, not in a dialog.** A toolkit's dialog resolves on the event loop
  and could not answer a call that has to return now (the first-launch question already has
  this shape). So a Remove of a row that is not empty leaves the row in place, marked as the
  one being asked about, with **Remove it** and **Keep it** on it; only the confirmation
  removes it, and confirming a row nobody asked about is refused. A row is **empty** when
  every cell is empty *and* it holds no nested row — what would be lost is the nested row,
  which is exactly what D5 exists to stop losing.
- **The drag gesture is the seam; the move is real.** Toga has no drag-and-drop for a box, so
  the handle *is* the gesture: pressed on the row to move, then on the place to move it to.
  `move_row` is what a pointer drag would call when a toolkit offers one, and both positions
  are judged before anything moves, so the last place in the table is one a row can be
  dropped onto.
- **Three columns are shown before the more** (D7). One number, named once, read by the model
  that decides which cells exist and by the drawing that puts them on the screen.
- **A cell's reason is the widget immediately after its cell; the field's own reason is the
  first thing in the table's box.** Above the table, once, never repeated per row and never
  merged into a cell's — which is the drawing half of slice 03's "a cell's reason hangs on
  the cell, and nowhere else".
- **A row declaration this window cannot draw is refused before any row exists.** The columns
  are checked against the widget map at every depth when the table is built, not when a cell
  is drawn: a table with no rows yet would otherwise open fine and break the moment somebody
  pressed Add.
- **Depth is one indent per level**, applied by the same box every other part of the window
  is made of, so a table nested three deep needs no third rule.
- **A cell's reader belongs to its container.** A cell carries its column's id and a list
  element carries its field's id, so both take their reader straight back from the form's
  register and put back whatever they displaced — a column named like a field of the same
  form can no longer overwrite it.

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

A **nested** table is the same shape one level down, and TOML attaches each block to the row it
follows — so depth needs no new spelling and stays readable. Every one-line cell of a row is
written before the first nested block, because a block header is where its parent's own keys
stop:

```toml
[[values.volumes]]
label = "Zoom H6"

[[values.volumes.takes]]
file = "/Users/someone/Recordings/zoom/one.wav"

[[values.volumes.takes]]
file = "/Users/someone/Recordings/zoom/two.wav"

[[values.volumes.takes.markers]]
at = 1.5

[[values.volumes]]
label = "Field recorder"
```

The second `[[values.volumes]]` starts a new recorder, and the marker belongs to the take above
it — which is the whole reason this is the shape the plan asks for.

Attribution is per **field**, not per row, and what it records at all is D4 — see *Why
attribution exists*. Per-row attribution would mean bookkeeping shaped like the data, answering
a question nobody asks of a row.

## Detecting a mount is monty's problem, not the host's

**The host does not know what a volume is, and must not learn.** innytypes owns supervision,
discovery, dependency resolution, the event bus and the addon contracts; a drive is monty's
domain. A `VolumeProvider` in the host would be the host growing a feature for one plugin's
need, and the next plugin would want a camera API beside it. The owner, plainly: *"it is not
innytypes' problem to look for volume mounts! This is MONTY'S problem!"*

So everything below is **monty's** to build, in monty's repository, and it is written here only
because it is what slice 05 has to do to prove the table type against the case that demanded it.
What the host provides is what it already provides: the declared settings, recorded and handed
over.

The application runs on macOS, Linux and Windows (plan 0003, D7), so **no OS event mechanism is
used at all** — not launchd, not udev, not WMI. Each of those is one platform's answer, and
three of them would be three code paths that drift.

monty should follow the pattern the host uses for its own platform facts — the process table,
notifications, the machine id — because it is a pattern, not a shared implementation:

1. **One injected seam** in monty, `VolumeProvider`, which answers "what is mounted right now".
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
- **Every reader is injected**, so monty's gate proves the matching against a fake machine with
  duplicate names, missing UUIDs and a reader that fails — and never runs `diskutil`, reads
  `/dev`, or opens a Windows handle.
- **None of it is in the host, and none of it ever needs to be.** If a second plugin ever wants
  to know about mounted volumes, **monty tells it** — a new kind in monty's own namespace, on
  the bus the host already provides, subscribed to like any other. That is what the event bus is
  for, and it is why the host can stay ignorant of drives permanently rather than provisionally.
  The owner, settling it: *"then MONTY will send the messages!"*

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
- **Each row carries two arrows, up and down** (D6), settled by the owner when the drawing
  landed: *"so reordering is pushing on up and down arrows in the rows!"* A drag is what a
  toolkit with a drag gesture would offer, and Toga has none for a box — two presses standing
  in for one drag was worse than either. The arrow at a table's end is drawn **disabled rather
  than left out**, so a row's controls stay in the same places as it travels, and one press
  moves one place. `move_row` is still underneath, so a real drag can call it the day a
  toolkit offers one.
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
| 04 | the drawing | the tree widget: expand, Add, Remove with its confirmation, drag to reorder, the per-row **more**, cell errors beside cells, on all three platforms — landed, see *What the drawing settles* |
| 05 | monty's volumes | In **monty's** repository: it declares its recorders as a table, reads them from `context.settings`, and does its own mount detection — its own `VolumeProvider`, its own per-platform identity readers, its own factory refusing a platform it cannot read, polled on its own tick, UUID-first with the ambiguous-name refusal — and **deletes** `monty mount`, its launchd agent and its JSON registry |

**Order.** 01 → 02 → 03 → 04 in this repository. 05 is work in monty's repository, after 03, and
is what closes `WI-0004-09`'s qualification.

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

**D6 — reordering rows.** *Answer:* (c), rows reorder — *"will be useful IF we implement order
between plugins"* — and, once the drawing existed, settled as **up and down arrows on each
row**: *"so reordering is pushing on up and down arrows in the rows!"* The gesture matters less
than the capability; `move_row` underneath is what a pointer drag would call if the toolkit
ever offers one.

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
