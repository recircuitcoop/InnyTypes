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

### What a plugin gets

`AddonContext` (plan 0001, the runner) gains `settings: Mapping[str, object]` — the recorded
values, already validated against the declaration, with defaults filled in. A plugin therefore
never parses a settings file, never validates, and never has to handle a missing key.

It also gains a way to **write its own settings back** (D11), bound to its own id, validated
against its own declaration and refused the same way a person's entry is. That is what lets a
plugin keep what an authorisation gave it — a token, a paired device — without inventing a store
of its own. Follow-up F2 settles which fields it may write and what the window shows about it.

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

### Secrets

A `secret` field is the one type whose value does **not** go in the plugin's settings file. It
goes where the Anytype API key goes: a file of its own, mode 0600, outside the tree, never in a
log, never in a `repr`, never in telemetry (decision D6). The form shows whether a secret is set,
never what it is.

**Telemetry may never carry a settings value of any type.** The redaction function's *never sent*
list gains plugin settings, and its test gains a case that plants one.

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

## What the application is told, in one place

The host exposes one read-only view the window draws from, and one call per action. The view
holds, per plugin: identity, source, enabled, run state, pending update, the settings form (with
values and errors), and whether it can be removed. The window never composes this from three
different modules, and never reads a manifest, a lock or an environment itself.

## The gate stays hermetic

Nothing new here needs a network, a process or a real installation:

- The settings declaration is parsed and validated as data, like the rest of the manifest.
- The store is a file under `tmp_path`.
- The enable switch and removal drive an **injected control channel** and an **injected
  installer**, exactly as the existing install and update slices do.
- Secrets are written to `tmp_path` and asserted at mode 0600, with the same
  canary-that-can-fail pattern the key tests use.

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

**Order.** 01 → 02 → 04 are the spine. 03 needs 01. 05 needs 02 and plan 0001's runner. 06 needs
plan 0003 slice 05's control channel. 07 needs 01–02 for what it deletes and plan 0001's
resolution for what it refuses. 08 needs 04, 06, 07 and plan 0003 slice 07b. 09 needs 01–05 and
is worked in monty's own repository, against an installed host.

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
