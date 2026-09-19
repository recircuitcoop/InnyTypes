---
type: plan
title: Plugin configuration, the enable switch, and the page that manages plugins
status: APPROVED
created: 2026-09-19
updated: 2026-09-19
---

# 0004 — Plugin configuration and management

## What this is

A plugin needs settings — monty needs to be told which volumes and folders to watch, and it is
useless until it is. Today it reads a file of its own, which means every plugin invents its own
place, its own format and its own way of being wrong, and the application cannot show a person
any of it.

This plan moves that to the host. **innytypes defines what a plugin may ask for, records the
answers, and tells the application what to draw.** A plugin declares its settings; it does not
store them, validate them or draw them.

The owner's request, verbatim:

> innytypes should define the api for configuration of the running plugins. This tells the gui
> application what to show and how to show it. Innytypes is responsible for recording the running
> values. Each installed plugin must also have a toggle in innytype to enable and disable.
> Innytypes also has a page where the application can add, remove, update plugins.

Four things, then:

1. **A settings API.** A plugin declares its settings as data; the host publishes that to the
   application as *what to show and how to show it*.
2. **The host records the values.** One place, one format, one validator, one set of rules about
   what may be written down and what may not.
3. **An enable switch per installed plugin.** A plugin can be installed and off.
4. **A plugin page.** Add, remove and update plugins from the application.

## How it fits with the plans that exist

- **Plan 0001** owns the manifest, discovery, the start order and the addon runner. The settings
  declaration is a new optional manifest section, like `stability` and `update` (plan 0003), and
  the runner is what hands an addon its values.
- **Plan 0003** owns the helper: the config file, the restart policy, the control channel, the
  update machinery (`addons outdated` / `update`), and the application window whose contents are
  a model this plan extends.
- **The invariant this plan must not break:** the host imports no addon. A settings declaration
  is therefore **data recorded at install time**, read from the recorded manifest — never a
  callable the host invokes, and never code the host runs to find out what to draw.

**What does not exist yet and this plan needs:** there is no `addons remove`. Install, list,
outdated and update exist; uninstall was never built, and a page with a remove button needs it.

## The settings API

### A plugin declares, the host decides

A plugin's manifest gains an optional `settings` section: an ordered list of fields, each of a
**type the host defines**. The host's vocabulary is closed on purpose. A plugin cannot ship a
widget, a template, a script or a stylesheet, because a plugin that can draw in the host's window
can lie in the host's window — and because a fixed vocabulary is the only way the application can
look like one application.

The vocabulary, settled by decision D1 — all nine types:

| type | what the application draws | what the host stores |
|---|---|---|
| `text` | one-line field | a string |
| `paragraph` | multi-line field | a string |
| `number` | number field, with `min` / `max` / `step` | an int or float |
| `switch` | a checkbox | a boolean |
| `choice` | a dropdown of `options` | one of the option values |
| `multiple-choice` | a list with checkboxes | a list of option values |
| `path` | a file or folder picker, with `kind: file \| folder` | a string path |
| `secret` | a password field that never shows what is stored | see *Secrets* |
| `list of <type>` | a repeatable row of one of the above | a list |

Every field carries: `id`, `type`, `label`, optional `help`, optional `default`, optional
`required`, and the type's own constraints. Fields may be grouped (`group: "Sources"`) so the
application can draw sections. Order is the order in the manifest.

A field may declare `shown_when: {field: <id>, equals: <value>}`, so a setting that only makes
sense when another is on is not shown when it is off (decision D2).

### What the declaration says exactly

Settled while building slice 01, because every later slice reads this shape:

- **A repeatable field is spelled `list of <type>`**, exactly as the table above writes it —
  `type: "list of path"`, with the element type inside the `type` string rather than in a second
  attribute, so the whole type is in one place. A list of a list is not a type.
- **A list's constraints are its elements' constraints.** `min` on a `list of number` bounds every
  number in the list; `options` on a `list of choice` is the list each row chooses from.
- **A `default` is judged against its own field's type and constraints**, because a default is a
  value like any other: a `choice` defaulting to something that is not one of its options is a form
  nobody could save. A list-valued default is held as a tuple. An explicit null default is refused
  — no type in the vocabulary stores "nothing", and an author who means "no default" omits it.
- **`step` is a drawing hint, not a value rule.** It is what the application's picker increments
  by; no value is ever refused for falling between two steps.
- **`shown_when` may name a field declared earlier or later, but never itself.** Order is how the
  form is drawn; visibility is decided over the whole form at once. Naming an id that is not
  declared anywhere in the same section is refused, naming the missing id.
- **Fields may share a `group` freely**, and grouping never reorders anything: the parsed order is
  the manifest's order, exactly, so an author reading their manifest top to bottom reads the form
  the user will see.
- **`written_by` defaults to `user`** (F2). The three writers are `user`, `plugin` and `both`.
- **A `path` must declare its `kind`**, and a `choice` or `multiple-choice` its `options` (at least
  one, each named once): the application draws a file picker or a folder picker, not "either".
- **A constraint declared on a type that has no use for it is refused**, like any other unknown
  manifest field — it is a typo its author believes is in force.
- **A plugin that declares no `settings` section has no fields**, an empty form rather than an
  absent one the application has to special-case.

### The host publishes a form, not a manifest

The application does not read manifests. It asks the host for a **form**: the declared fields,
each already carrying its **current value**, its default, and any **error** attached to it from
the last time a value failed validation. One call gives the application everything it needs to
draw the page, and the same call answers for a plugin that is running, stopped, disabled or
broken.

Saving is the mirror: the application hands back values by field id, and the host **validates,
records, and reports per-field errors**. An invalid value is refused by field, never silently
coerced and never partially applied (the house rule: refuse rather than warn).

### What the form publishes exactly

Settled while building slice 04, because the window (slice 08) draws from this shape and
nothing else:

- **Two calls.** *Publish* answers with the whole page; *save* takes values by field id and
  answers with the store's own per-field outcome — what was recorded, and what was refused with
  the reason naming it. A save is a person's entry unless it says otherwise, so its writer
  defaults to `user`; a plugin writing its own values back (D11) is the call that has to say so.
- **Every declared field, in the manifest's order**, each carrying what the widget is drawn
  from — type (and a list's element type), label, help, group, required, `written_by` and the
  type's own constraints — and what the widget is filled from: the current value, the declared
  default, whether it is shown, who last wrote it and when, and its error.
- **The current value is the one the person is looking at:** the recorded value that passed
  (with declared defaults already filled in), or the recorded value that was **refused** — a
  person cannot correct what they cannot see — or nothing at all. No type in the vocabulary
  stores "nothing", so "no value" is unambiguous and always means unanswered.
- **A `secret` publishes neither a value nor a default**, not even a default its own manifest
  declared: that is still a secret-shaped literal, and a secret is answered rather than
  pre-filled. All the form says about one is **whether it is set**, asked of the store's own
  `secret_is_set` seam — exposed for this — so the host has one implementation of that question
  rather than two that could disagree once slice 03 is wired to one of them.
- **A field's error comes from whichever source has the more recent news:** the refusal from the
  last save, or the hold from judging what is on disk against the declaration in force (D5, F1).
  A refused write records nothing, so the open form is where that reason lives between the save
  and the redraw; the save that records the field clears it.
- **`shown_when` is evaluated by the host**, over the whole form at once, against the same
  values the form publishes. The comparison is typed: `true` never equals `1`, because a
  `number` holding 1 is not a `switch` that is on. A condition naming a field with no value is
  not satisfied, and neither is one naming a `secret` — `equals` compares values, and the form
  does not know a secret's.
- **Availability is one word and one sentence.** A state somebody else recorded — the user's own
  disable (slice 06), the helper's quarantine — is injected and **wins over a hold**, because
  the three need different actions and correcting a folder will not start a plugin that was
  switched off. The settings decide only when nothing else has taken the plugin out of service,
  and the sentence is absent only when the plugin is simply enabled.
- **The form answers the same way whatever state the plugin is in** — running, stopped,
  disabled, held or quarantined — with the same fields, values and errors, and publishing it
  creates nothing on disk.
- **Groups are published in the order their first field appears**, ungrouped fields included as
  a section of their own, so the application never has to infer the page's shape from the field
  list.

### What a plugin gets

`AddonContext` (plan 0001, the runner) gains three members, and **every one of them is bound to
the plugin they were built for** — there is no argument anywhere that names an addon, exactly as
there is none on its emitter:

- `settings: Mapping[str, object]` — the recorded values, already validated against the
  declaration, with defaults filled in. A plugin therefore never parses a settings file, never
  validates, and never has to handle a missing key. **Read once, when the plugin starts**: a
  value that changes afterwards restarts it (D10), so the mapping a plugin holds is never stale
  and there is nothing to re-read.
- `secret(field_id) -> str | None` — one of *its own* `secret` fields. A secret's value is not
  in the mapping, because a mapping is a thing that gets logged, reported and handed on; this is
  the one way back to one, it takes a field id and nothing else, and it answers only for the
  plugin whose context it is. A field id that is not a declared secret of that plugin raises,
  rather than answering "not set" — which would be a lie a plugin cannot act on.
- `write_settings(values) -> WriteOutcome` — the plugin **writing its own settings back** (D11),
  validated against its own declaration and refused by field the same way a person's entry is.
  That is what lets a plugin keep what an authorisation gave it — a token, a paired device —
  without inventing a store of its own. Follow-up F2 settles which fields it may write and what
  the window shows about it; a `secret` written this way goes to the secret store and is still
  never readable through `settings` or the form.

**All three arrive with no library attached.** The context, the store it is read from, the
secret store beside it and the events the plugin emits and receives are the *contract layer*,
and that layer imports no third-party package at all: a plugin environment installs `innytypes`
with an empty dependency list, so nothing we hold can collide with anything the plugin holds
(plan 0001, *What an addon environment contains*). Before that was true, a plugin naming
`psutil` at a version other than ours simply could not be installed. `innytypes.addons.run` —
the module a plugin process *is* — reaches none of the host's own packages either, which is
what keeps the rule from decaying the next time something is imported for convenience.

A plugin held disabled is a plugin that is not started, so a context is only ever built from
values that fit: a field whose recorded value no longer validates is absent from the mapping,
and the hold (D5) is what the host acts on.

That is a change to the addon contract, so `host_api` moves to 2 (decision D3), and monty's own
settings file is superseded (decision D9).

## Recording the values

- **The host owns the store.** One file per plugin, under the per-user config directory beside
  `config.toml` — `plugins/<addon-id>.toml` (decision D4). Per plugin rather than one shared
  file, so a malformed one cannot stop the helper reading its own settings, and removing a plugin
  is one file to delete.
- **Every write is atomic**, with a per-process scratch name, as the helper's config already does
  — the application window and the CLI can both write.
- **Reads are re-reads.** The same rule the helper's switches follow: a value changed while
  something runs is seen on the next read, with no cache to invalidate.
- **Validation happens on write and on start.** A recorded value that no longer fits the
  declaration — because the plugin updated and its schema changed — does not fall back to a
  default and does not stop the update: the plugin is **held disabled with the reason**, its
  offending fields are marked in the form, and it starts again when they are corrected (D5).

### What the store records exactly

Settled while building slice 02, because every later slice reads or writes through it:

- **The file is two tables.** `[values]` holds one setting per line, in the order the plugin
  declares them, and is the only part a person edits by hand. `[written.<setting>]` holds F2's
  bookkeeping — `by` (`user`, or the plugin's own id) and `at` (an RFC 3339 timestamp in UTC) —
  kept out of `[values]` so that the part a person reads stays one value per line. A file
  carrying any other table is refused by name: it is not a file this host wrote.
- **A write is judged field by field and is never all-or-nothing.** The valid fields in a call
  are recorded; each invalid one is refused with its own reason naming it, and its prior value
  is left exactly as it was. A call in which every field is refused does not touch the file at
  all.
- **"Held disabled" is a value, not an omission.** A read answers with a *hold* — the offending
  fields and one sentence — or with nothing, and "nothing" is the only way to read "fine". A
  field that is wrong is **absent** from the values a plugin would be handed, so a held plugin's
  values are incomplete by construction rather than quietly defaulted. Held disabled, the user's
  own disable and quarantine are three distinct states with three distinct words, because they
  need three different actions.
- **A value recorded for a field the declaration no longer mentions is kept, not dropped.** It
  is ignored on read and preserved on write: a plugin that dropped a field, or was rolled back,
  must not cost the user what they typed. Unknown *keys* are therefore not refused the way
  unknown *tables* are — the known keys belong to a declaration that changes under the file's
  feet, which is exactly the case D5 is about.
- **A `secret` field has nothing in its place in this file.** The store refuses a write to one,
  by field, pointing at the secret store; it never hands a secret value back, even if somebody
  planted one in the file by hand; and it asks an injected *is this secret set?* predicate — the
  seam slice 03 fills — only in order to decide whether a **required** secret still holds the
  plugin disabled. With no predicate wired up, no secret is set, which is the truthful answer.
- **A recorded value is judged by the declaration's own validator**, the same one that judges a
  manifest's `default`, so a constraint can never mean one thing in a manifest and another in a
  settings file.

### Secrets

A `secret` field is the one type whose value does **not** go in the plugin's settings file. It
goes where the Anytype API key goes: a file of its own, mode 0600, outside the tree, never in a
log, never in a `repr`, never in telemetry (decision D6). The form shows whether a secret is set,
never what it is.

**Telemetry may never carry a settings value of any type.** The redaction function's *never sent*
list gains plugin settings, and its test gains a case that plants one.

Settled while building slice 03, because the rest of the plan reads these:

- **Where a secret lives:** `secrets/<addon-id>/<field-id>`, beside the Anytype key in the
  per-user config directory. The file is **0600** and both directories are **0700**, set by the
  `os.open` that creates them rather than by a later `chmod`. A directory per plugin is what makes
  D8's removal one directory rather than a search.
- **A field id becomes a file name, so it is checked as one.** The manifest's own rule for a field
  id is "a non-empty string", which would accept `../../../../etc/cron.d/evil`. The secret store
  refuses any id that is not lowercase letters and digits joined by single dots, hyphens or
  underscores — lowercase included, because on a case-insensitive filesystem `Token` and `token`
  would be two declared fields sharing one file. The refusal is at the store, which is the one
  place a declared name turns into a path.
- **`list of secret` is refused when a value is stored.** The type parses — the vocabulary allows
  a list of any scalar — but "one file per secret" has no spelling for a list, and inventing a
  container format for credentials is the thing this arrangement exists to avoid. A plugin that
  needs two credentials declares two `secret` fields.
- **An empty secret is refused**, because an empty file reads as "configured" and then fails at
  the far end. "No longer set" is done by clearing the field, which removes its file.
- **The two stores are two halves of one save, not two stores.** The settings store refuses a
  `secret` by field; the secret store takes it and answers in the same per-field shape, so the
  form (slice 04) sends each field to one of them and has one kind of result to merge. The
  settings store asks the secret store one question — has a **required** secret been answered? —
  which is what lets F1 hold a plugin disabled for a missing credential it can never see. "Is
  this field a secret?" has one answer, and it lives with the declaration.
- **The only way back to a value** is the host reading it to hand a plugin its own credential
  (slice 05). Reading a plugin's settings returns *set* or *not set* for every `secret` field and
  never the value, whatever the settings file happens to hold — fail closed.
- **Every write is scratch-and-rename**, so an overwrite replaces the old value whole: a
  truncate-in-place leaves the tail of the previous credential behind the new one if the write is
  interrupted. The scratch file is 0600 for its whole life, and a rename replaces a symlink
  planted at the target rather than writing through it.
- **Removal leaves behind anything the store did not write.** `addons remove` deletes the secret
  files this store made; a link or a directory somebody else put there is neither followed nor
  deleted, and it keeps the plugin's directory alive rather than being removed by guess.
- **The never-sent list** gains `setting`, `config`, `field` and `value` as key-name fragments, and
  the privacy notice says in words that nothing a plugin was configured with is ever sent. A stored
  secret is *also* removed by exact match, because storing one registers it with the same
  credential redactor the log filter uses.

## The enable switch

Every installed plugin is **enabled or disabled**, recorded by the host beside its other state.

- **Disabled means not started.** The host does not start it; the helper does not restart it; the
  resolver does not hold back the plugins that merely subscribe to it. A plugin that *requires* a
  disabled plugin cannot start, and is reported the way a missing requirement already is (plan
  0001's degradation rule).
- **Disabling a running plugin stops it**, through the control channel, as an expected stop — so
  the restart policy does not undo it and the breaker counts nothing.
- **Enabling starts it**, in the resolver's order relative to what is already running.
- **Disabled is not quarantined.** Quarantine is the helper giving up (plan 0003 slice 06);
  disabled is the user's choice. They are different words in `helper status`, in the window, and
  in the record, because they need different actions: `helper release` versus the switch.
- **Install-time default:** a newly installed plugin is enabled (decision D7).

**Where the state is recorded, settled in slice 06:** `plugins.<id>.enabled` in the helper's
`config.toml`, beside that plugin's `pinned` and `update_mode`, and **absence means enabled** —
the file records only the departures from D7, so installing writes nothing. Three reasons it is
there and not elsewhere:

- it has to **survive a reboot**, and a quarantine deliberately does not: quarantines live in the
  runtime directory so a machine that comes back up is not still refusing to start something for
  a reason nobody can see, while a switch the user flipped is an instruction and must outlive the
  reboot;
- it is a decision **about** the plugin, not an answer the plugin asked for: the settings file
  holds values against the fields a plugin *declares*, and no plugin declares whether it may run
  — putting the switch there would also let a plugin write it back (D11);
- `config.toml` already holds exactly this kind of per-plugin decision, is already re-read live
  and written atomically, and is already injectable everywhere.

**One question, asked by both halves.** "Why must this child not start right now?" has one answer
(`innytypes.children.HoldsBack`), given in one word — `disabled`, `held-disabled` — or nothing at
all. The host asks it before it spawns; the restart policy asks it before it decides on a restart
*and* again before a due restart is issued, because a plugin can be switched off during its own
backoff. So **held disabled is enforced by the same seam as the switch**: a plugin whose required
settings have no value is not started and not restarted, and it starts the moment the values are
correct, with nothing to flip (F1).

**When more than one is true, the word names what has to be done first.** Disabled outranks
quarantined outranks held: nobody releases a quarantine on a plugin they turned off, a quarantine
is cleared by nothing but `helper release`, and a hold clears itself. The three states are
otherwise independent — `helper release` never touches the switch, and disabling never touches a
quarantine.

**Enabling asks the host to start everything that should be running**, through one command
(`start-all`), rather than naming the plugin. *Where* a plugin starts is the resolver's answer and
only the host holds it; a switch that named one child would start it out of its place, ahead of a
plugin it subscribes to.

**A requirement that is not starting reads like any other unmet requirement**, with the word in
the sentence: `requires beta, which is disabled`, beside `requires beta==1.0.0, which is not
installed`. The plugin that is switched off is not itself reported as held back — nothing is wrong
with it.

**The command line records the switch and says so.** `innytypes addons enable|disable <id>` writes
the state; it cannot reach a running host, because the control channel is still in-process, so it
prints what it did and tells the user to use the window's switch to start or stop the plugin now.
`helper status` shows all three words, and the window draws its plugin rows from the same answer.

## The plugin page

The application's window (plan 0003 slice 07b) gains a page listing every installed plugin with:
its id and version, where it came from (index, path, editable, git), whether it is enabled,
whether it is running, quarantined or broken, its pending update if any, and its settings form.

Actions, each of which the host already owns or this plan builds:

| action | what it uses |
|---|---|
| **Add** | `addons install` — index, local path, or editable checkout (plan 0001 slices 08, 08c) |
| **Remove** | `addons remove` — **built by this plan**, because it does not exist |
| **Update** | `addons outdated` and `addons update` (plan 0003 slices 12, 13) |
| **Enable / disable** | the switch above |
| **Configure** | the form above |

### Removing a plugin

New, and it needs its own rules:

- **Stop it first**, as an expected stop, and only then touch its environment.
- **Refuse when another installed plugin requires it**, naming that plugin — the same rule the
  resolver already applies, applied before the damage rather than after.
- **Everything it had goes** (D8): its environment, its recorded manifest, its settings file and
  its secret. Reinstalling starts from the declaration's defaults, which is what "remove" was
  taken to mean.
- **Nothing is removed that was not recorded**: removal walks the installation the host recorded,
  never a path a caller supplies, so a broken record makes removal refuse rather than delete by
  guess.

**The refusals come before the stop**, not just before the deletion. A plugin that is going
nowhere is not stopped on the way to being told so, so a refused removal leaves it running.

**The order of destruction is part of the contract**, because a removal is four filesystem
operations and any one of them can be the last — the power goes, the process is killed — and
what is left has to be something the next `addons list` can tell the truth about:

1. **The recorded manifest first**, as a single unlink. From that instant discovery reports the
   plugin as broken — "no manifest.json recorded … reinstall the addon" — which is visible, and
   invisible to the resolver, which is only ever handed manifests that parsed. Nothing will try
   to start it.
2. **The environment second**, as one tree. The other order produces the one state that must
   never exist: a manifest that still parses beside an environment that is half deleted, which
   discovery reports as *installed* and the host then tries to launch an interpreter out of.
   Installed-but-actually-gone is worse than broken, because only one of the two says anything.
3. **The settings file and the secrets last**, when what is left is inert. The opposite order
   would leave a whole, startable plugin whose required fields have no values — held disabled
   for a reason nobody caused — which is worse to wake up to than an orphaned TOML file.

So every point at which a removal can be interrupted leaves either a plugin that is entirely
there, or one that is visibly incomplete and started by nobody.

**`innytypes addons remove` needs the running application, and says so when it cannot reach
it.** Removal stops the plugin through the control channel, and only the host stops its own
children (plan 0001, invariant 9); both halves of that channel are still injected callables
rather than anything two processes speak over (plan 0003 slice 05). So the command refuses in
one line and deletes nothing, exactly as `addons update` already does, until that channel
exists. The function behind it takes the channel as an argument, so the window's plugin page
(slice 08) drives the same removal with the host's own channel.

### What the page draws exactly

Settled while building slice 08:

- **One object, handed over whole.** The view the host publishes is the object the drawing is
  given — not a copy, not a summary, not a list the page walks a second time. That is what makes
  "the window composes nothing" a fact a test can assert by identity rather than by counting
  calls.
- **A broken plugin is on the page.** Its recorded manifest could not be read, so it has no
  version, no source and no form, and it is listed anyway with the word **broken** and the
  reason: a plugin that is on the machine and will not start is the one a person most needs to
  see. Everything else on a line is present because there is a manifest to state it.
- **The run state is the availability word plus two.** `enabled`, `disabled`, `held-disabled`
  and `quarantined` are chosen by `plugin_state` and never re-decided; the page adds only
  **running** — a fact it asks the host for — and **broken**, which outranks everything because
  it is the reason none of the other answers exist.
- **Removability is asked before the control is drawn**, through the same rule `addons remove`
  refuses by, so the Remove control on a plugin another plugin requires is drawn disabled with
  the reason under it rather than refusing when pressed.
- **Nine widgets, named once.** `text` a one-line box, `paragraph` a many-line box, `number` a
  spinner carrying the declared bounds and step, `switch` a switch, `choice` a single-select,
  `multiple-choice` one box per declared option, `path` the file or folder picker its `kind`
  decides, `secret` a password box, and `list of <type>` the element type's own widget once per
  value. A declared type with no widget **stops the drawing by name**; it is never skipped,
  never blank and never drawn as a text box that would mangle it.
- **One drawing on every platform.** InnyTypes ships one toolkit inside one bundle, so the page
  consults the platform nowhere: the widget tree is identical on macOS, Windows and Linux, and
  that is asserted rather than assumed.
- **A `secret`'s box is empty on every draw and empty means "leave it".** The value is never in
  the box, the placeholder or the sentence beside it — only *set* or *not set* — and a save that
  carries an empty secret box leaves the stored value alone, so opening the page and pressing
  Save cannot wipe a credential nobody typed.
- **The form is held for as long as the page is**, one per plugin, because the only state a form
  keeps is the per-field refusals from the last save and a refused write records nothing on disk.
  It is rebuilt when the recorded declaration moves under it, which is what a plugin update does
  (D5).
- **Configure is the two halves of one save.** The page sends every field to the settings store
  except the declared `secret`s, which go to the secret store, and merges the one per-field shape
  both answer in — so a form holding a folder and a token saves in one press.

## What the application is told, in one place

The host exposes one read-only view the window draws from, and one call per action. The view
holds, per plugin: identity, source, enabled, run state, pending update, the settings form (with
values and errors), and whether it can be removed. The window never composes this from three
different modules, and never reads a manifest, a lock or an environment itself.

**The five actions are five calls and no logic.** Add is `addons install` (by requirement, by
path, or editable — and which of the two it is, is said rather than sniffed at); remove is
`addons remove`; update is the applier, injected because applying one needs a staging root, a
lock resolver and a heartbeat reader that the page has no business knowing about; enable and
disable are the switch; configure is the form's save. The page's own code is: ask for the view,
hand it to the drawing, route a press, draw again.

### Wiring it to the application that runs (slice 11)

Everything above is worth nothing until the entry point passes it, and for several slices it
did not: `ApplicationWindow` took the process list, the plugin page, the pending core and
plugin updates, the telemetry pipeline and the usage snapshot, `innytypes-helper` passed none
of them, and the window a person opened held two switches and Quit. So the wiring is a slice
with a rule of its own:

- **Every optional seam the window has is filled by the entry point, and that is asserted.**
  `ApplicationWindow.unfilled` derives the seams from the class's own `__init__` signature —
  a parameter defaulting to `None` is a seam — so the assertion covers a seam added next
  month without anybody remembering to extend a list.
- **The window opens the plugin page**, and a page that refuses to draw does not take the
  window with it: the refusal is logged and the contents — Quit among them — are on screen.
  F1 outranks every source here.
- **A page drawn before a host has connected lists every plugin as stopped.** The helper
  listens and the host connects, so there is a moment at every launch when the control channel
  has no host on it, and an application that would not open its own window then is worse than
  one that says nothing is running yet.
- **A saved value restarts the plugin through the one restart path** (D10). The plugin host is
  given the helper's settings watch, keeps it in step with what each view says is running, and
  asks it to look again as soon as a save has written a file — so a folder typed into the form
  takes effect while the window is still open, and the helper's own tick does not restart the
  plugin a second time for a change already acted on.
- **Apply on a core release is a yes, not an installation** (plan 0003, D11). A core release is
  swapped in at a quit and at no other moment, so the press is recorded and the quit installs
  it. `innytypes.helper.swap.default_core_staging_path` is the one spelling of where a staged
  release waits, for the three things that have to agree about it: the check that stages one,
  the window that says one is waiting, and the quit that installs it.
- **Two controls are honestly absent** rather than wired to something that would guess. **Add**
  needs a dialog saying *which* plugin, which the toolkit has not got yet, and a plugin update
  needs the applier's staging root, lock resolver and heartbeat reader, which the helper's tick
  owns. Both refuse by name when pressed.

## The gate stays hermetic

Nothing new here needs a network, a process or a real installation:

- The settings declaration is parsed and validated as data, like the rest of the manifest.
- The store is a file under `tmp_path`.
- The enable switch and removal drive an **injected control channel** and an **injected
  installer**, exactly as the existing install and update slices do.
- Secrets are written to `tmp_path` and asserted at mode 0600, with the same
  canary-that-can-fail pattern the key tests use.
- The contract layer's freedom from libraries is proved in a **subprocess with those libraries
  blocked from importing at all**, so the proof needs no second environment, no `uv` and no
  network — and it fails loudly the moment an import creeps back in.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | the declaration | the optional `settings` manifest section: the field types, their constraints, grouping, `shown_when`, and refusal of anything malformed |
| 02 | the store | per-plugin settings files, atomic writes, re-read on every read, validation on write, defaults filled in |
| 03 | secrets | the `secret` type, stored 0600 outside the settings file, never logged, never in telemetry; the redaction list and its test |
| 04 | the form | the host's published form — fields, current values, defaults, per-field errors — and the save call that validates and records |
| 05 | settings reach the addon | `AddonContext.settings`, `host_api` 2 with 1 still starting, the restart-on-change rule (D10), and the addon writing its own values back (D11, framed by F2) |
| 06 | the enable switch | recorded state, start and stop through the control channel, the helper not restarting a disabled plugin, `helper status` and the window telling disabled from quarantined |
| 07 | `addons remove` | stop, refuse when required by another plugin, and remove all of it — environment, manifest, settings and secret (D8) |
| 08 | the plugin page | the window's page: the list, the states, the five actions, the one read-only view they all draw from, and a drawing for each of D1's nine field types on every platform |
| 09 | monty's settings | monty declares its sources as a settings form and stops reading its own file (decision D9), proving the whole plan against a real plugin |
| 11 | wire the window | the entry point builds the window with every source filled from this machine's own roots — the process list, the plugin page, the core and plugin updates, Apply, telemetry and usage — the assertion that none of them is left `None`, and a window that still draws and still quits when any of them refuses |

**Order.** 01 → 02 → 04 are the spine. 03 needs 01. 05 needs 02 and plan 0001's runner. 06 needs
plan 0003 slice 05's control channel. 07 needs 01–02 for what it deletes and plan 0001's
resolution for what it refuses. 08 needs 04, 06, 07 and plan 0003 slice 07b. 09 needs 01–05 and
is worked in monty's own repository, against an installed host. 11 needs 08 and plan 0003 slice
18's control channel, and is what puts all of it on the screen.

## Decisions

Answered by the owner on 2026-09-19. Each entry gives the question, the answer, and what it
changed in this plan.

**D1 — the field types.** *Answer:* (a), all nine: `text`, `paragraph`, `number`, `switch`,
`choice`, `multiple-choice`, `path`, `secret` and `list of <type>`. The vocabulary is closed, so
a type missing from that list needs a host release; the answer buys a plugin author room now
rather than a release later. Each type is a widget the application must draw on macOS, Windows
and Linux, so slice 08 carries nine drawings, not five.

**D2 — conditional fields.** *Answer:* (a), one level, `equals` only. A field may name one other
field and one value.

**D3 — the host API version.** *Answer:* (a), `host_api` 2, and a plugin still declaring 1 starts
with an empty settings mapping. monty declares 1 today and keeps working.

*Sharpened while building slice 05:* a manifest declaring 1 is opened against **no declaration at
all**, even if it carries a `settings` section — so its mapping is empty, its `secret` raises for
every field and its `write_settings` refuses every field as one the plugin does not declare.
Settings arrive with the version that introduced them or not at all; an addon that gets half of
version 2 because of what it happened to declare would be a third contract nobody wrote down.
The host implements every version from 1 up to the current one (plan 0001, *What the host API
version means*).

**D4 — where values are recorded.** *Answer:* (a), one file per plugin: `plugins/<addon-id>.toml`
beside `config.toml` in the per-user config directory.

**D5 — a recorded value that no longer fits after a plugin update.** *Answer:* (b), **the plugin
is held disabled until the user fixes it**. The update applies; the host re-validates the recorded
values against the new declaration; a plugin whose values no longer fit does not start, is shown
as disabled with the reason and the offending fields marked, and starts again when the values are
corrected. Nothing falls back to a default quietly, and an update is never refused because of what
was configured.

**D6 — secrets.** *Answer:* (a), a file per secret, mode 0600, beside the Anytype key. The
operating system's keychain stays a later slice.

**D7 — is a newly installed plugin enabled?** *Answer:* (a), enabled — installing is the act of
wanting it. Taken plainly, without the exception the proposal carried: a plugin with a required
setting and no default is therefore installed **enabled**, starts, and reports that it cannot work
until it is configured. See follow-up F1, which is about whether that is what you want to see.

**D8 — removing a plugin: its settings and its secret.** *Answer:* (b), **remove both**. Removal
means removal: the environment, the recorded manifest, the settings file and the secret all go,
and reinstalling starts from the declaration's defaults.

**D9 — monty's own settings file.** *Answer:* (a), monty declares a settings form, reads
`context.settings`, and its own file is gone. Work in monty's repository, sequenced after slice
05.

**D10 — a value changed while the plugin is running.** *Answer:* (a), the host restarts that
plugin through the control channel, as an expected stop-and-start, so the restart policy does not
count it and the breaker sees nothing.

*Where it lives, and what "changed" means* — settled while building slice 05, in
`innytypes.helper.settings_watch`:

- **It is the helper's, and it is the existing restart.** The helper watches one entry per
  running plugin and asks the one restart policy for a restart, which sends one `RESTART` down
  the control channel. Nothing spawns, stops or signals anything here: a second restart path
  would be the thing plan 0003's D1 exists to prevent.
- **A change is a change to the values the plugin was handed**, not to the file's bytes or its
  modification time. Saving a form that records the same value again, or a write that only moves
  the `[written.<id>]` bookkeeping, restarts nothing — a restart is a visible interruption and
  needs a reason a person can point at. A value that *stopped* fitting the declaration has
  changed too: the plugin must not keep running on one the host would no longer hand it.
- **A plugin is never restarted for its own write.** The value a plugin recorded through
  `write_settings` is already in its hands, restarting it would throw away whatever it was in the
  middle of, and a plugin that writes on every start would restart for ever. Attribution (F2) is
  what tells the two apart: a change whose every field says `by = "<the plugin>"` is taken up
  silently, and a change the user made restarts it as usual. A field with no attribution at all —
  a file edited by hand — is not the plugin's own write.
- **An unreadable settings file is not a change.** A file caught mid-edit is logged, the plugin
  keeps running on what it has, and the next tick reads it again.
- Whether the plugin comes **back up** is the availability rule's business, not the watch's: a
  value that changed into one the declaration refuses holds the plugin disabled with the reason
  (D5).

**D11 — who may change settings.** *Answer:* (c), **the window, the CLI, and a plugin writing its
own values back**. This is the answer that most changes the design, and it is the one with a real
use behind it: a plugin that completes an authorisation at run time — an OAuth exchange, a device
pairing, a token refresh — has a value it must keep, and without this it would have to invent its
own store, which is exactly what this plan exists to end.

It therefore needs rules of its own, which follow-up F2 settles. What is already certain:

- a plugin writes **only its own** settings, through the host, bound to its id the way its
  emitter is — there is no argument anywhere that names another plugin;
- a write from a plugin is **validated against the same declaration** and refused the same way,
  so a plugin cannot record a value the user could not have typed;
- a `secret` field may be written this way and is never readable back, which is what makes the
  authorisation case work at all;
- the window shows what the plugin last wrote, so a value that changed under the user is visible
  rather than mysterious.

**D12 — does the page show plugins that are not installed?** *Answer:* (a), no: the page manages
what is installed. Browsing an index is the natural next step once an index exists.

## Follow-up decisions

The answers above raised two questions that were not on the list. The owner asked for the plan to
be built rather than to answer them ("dev and dont stop until all work items are done"), so each
is **settled by adopting the proposal**, recorded here so it can be overruled without archaeology.

**F1 — a plugin installed enabled that cannot work yet.** *Settled:* a plugin whose settings
declare a **required field with no default** is installed enabled, but is **held disabled with the
reason** until its form is valid — the same state, the same words and the same code path as D5.
"Held disabled: needs a folder to watch" is a sentence a person can act on; a plugin that starts
and fails looks broken instead of unconfigured. The switch turns itself on when the form is
complete, and the user can still disable it by hand afterwards, which is an ordinary disable.
*Affects:* slices 02, 06.

**F2 — the rules for a plugin writing its own settings.** *Settled:*

- every field declares `written_by: user | plugin | both`, defaulting to **`user`**;
- a plugin may write only its **own** settings, and only fields declared `plugin` or `both` — a
  write to a `user` field is refused by field, like any other invalid write;
- a plugin's write is **validated against the same declaration** as a person's, so a plugin
  cannot record a value the user could not have typed;
- **every write records who made it and when**, so the form can say "set by monty" beside a value
  the user did not type;
- a **disabled plugin is not running and cannot write at all**, which needs no rule of its own —
  there is nothing there to make the call;
- a `secret` field may be `plugin` or `both`, which is what makes the authorisation case work; it
  is still never readable back, by anyone.

*Sharpened while building slice 05:*

- **`written_by` is asked before the secret store is reached.** The rule belongs to the settings
  store and the file belongs to the secret store, so a plugin's write to a `secret` is judged by
  the first and only then given to the second — one implementation of "only its own, and only
  `plugin` or `both`", whichever kind of field it is applied to.
- **A secret records that it is set, not who set it.** The `[written.<id>]` table lives beside a
  value in the settings file, and a secret has no value there to live beside; what the form says
  about one is `secret_is_set`, as it always has. "Set by monty" is a sentence about a value the
  user can see.
- **"Never readable back" means never through `settings` or the form** — by the user, by the
  window, by telemetry, by a log. The plugin that owns it reads it through
  `AddonContext.secret`, which is the whole point of storing it: a token nothing can read is a
  token nothing can use.

*Affects:* slices 01, 02, 04, 05.

## Done

A slice is done when `docs/loop/verify.sh` is green in its worktree, its acceptance list is
satisfied, and an independent fresh-context checker agrees.

This plan is done when, with monty installed:

- the application's plugin page lists monty, shows it enabled and running, and shows its settings
  form drawn from what monty declares;
- typing a folder into that form records it, restarts monty, and monty watches that folder —
  with nothing configured anywhere but the host;
- an invalid value is refused by field, with the reason shown beside that field, and nothing is
  recorded;
- the enable switch stops monty and the helper does not restart it, and `helper status` says
  disabled rather than quarantined;
- removing monty stops it, removes its environment and refuses if another plugin requires it;
- no settings value, and no secret, appears in any telemetry report or any log.
