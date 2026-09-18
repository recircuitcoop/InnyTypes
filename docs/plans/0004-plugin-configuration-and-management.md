---
type: plan
title: Plugin configuration, the enable switch, and the page that manages plugins
status: DRAFT
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

Proposed vocabulary (decision D1 settles the final list):

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
  declaration — because the plugin updated and its schema changed — is reported, not guessed
  (decision D5).

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
- **Its environment goes.** Its settings, and its secret if it has one, are kept or removed by
  decision D8.
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
| 05 | settings reach the addon | `AddonContext.settings`, `host_api` 2, and what happens to a running addon when a value changes (decision D10) |
| 06 | the enable switch | recorded state, start and stop through the control channel, the helper not restarting a disabled plugin, `helper status` and the window telling disabled from quarantined |
| 07 | `addons remove` | stop, refuse when required by another plugin, remove the recorded installation, and the settings/secret decision (D8) |
| 08 | the plugin page | the window's page: the list, the states, the five actions, and the one read-only view they all draw from |
| 09 | monty's settings | monty declares its sources as a settings form and stops reading its own file (decision D9), proving the whole plan against a real plugin |

**Order.** 01 → 02 → 04 are the spine. 03 needs 01. 05 needs 02 and plan 0001's runner. 06 needs
plan 0003 slice 05's control channel. 07 needs 01–02 for what it deletes and plan 0001's
resolution for what it refuses. 08 needs 04, 06, 07 and plan 0003 slice 07b. 09 needs 01–05 and
is worked in monty's own repository, against an installed host.

## Decisions for the owner

Every one of these is open, and each changes what gets built.

**D1 — the field types.** *At stake:* the vocabulary is closed, so what is missing cannot be
added by a plugin author without a host release. *Options:* (a) the nine types in the table
above; (b) a smaller set — text, number, switch, choice, path — and add types when a plugin
actually needs one; (c) a larger set with dates, colours, durations and tables.
*Proposal:* (b), starting small. Every type is a widget the application must draw on three
platforms, and an unused type is a drawing bug waiting to be found by the first person who uses
it. `secret` and `path` join the five because monty and the MCP key need them.

**D2 — conditional fields (`shown_when`).** *Options:* (a) yes, one level, equals only; (b) no —
a plugin that needs this splits its settings into groups instead; (c) a full expression language.
*Proposal:* (a). (c) is a language nobody asked for; (b) makes common cases ugly.

**D3 — the host API version.** Adding `settings` to the context changes the addon contract.
*Options:* (a) `host_api` 2, and a plugin declaring 1 still starts, with an empty settings
mapping; (b) `host_api` 2 required for every plugin, with 1 refused.
*Proposal:* (a). monty exists and declares 1; refusing it would mean this plan breaks the only
plugin there is.

**D4 — where values are recorded.** *Options:* (a) one file per plugin under the config
directory, `plugins/<id>.toml`; (b) a `[plugins.<id>.settings]` table inside `config.toml`;
(c) one `plugins.toml` for all of them. *Proposal:* (a).

**D5 — a recorded value that no longer fits after a plugin update.** *Options:* (a) the plugin
still starts, the offending fields fall back to their defaults, and the user is told what was
dropped; (b) the plugin is held disabled until the user fixes it; (c) the update is refused
before it applies if recorded values would not survive it.
*Proposal:* (c) where it can be checked before applying — it is the only one where nothing is
lost and nothing runs on values its author never saw — falling back to (b), which is loud, rather
than (a), which is quiet.

**D6 — secrets.** *Options:* (a) a file per secret, 0600, beside the Anytype key; (b) the
operating system's keychain, per platform; (c) no `secret` type at all — a plugin that needs a
credential reads it from the environment itself.
*Proposal:* (a) for the MVP, because it works the same on all three platforms and matches what
plan 0002 already does. (b) is better and is a later slice.

**D7 — is a newly installed plugin enabled?** *Options:* (a) enabled, because installing is the
act of wanting it; (b) disabled, so it cannot run before it is configured.
*Proposal:* (a), unless its settings declare a required field with no default, in which case it
installs **disabled with a reason** — a plugin that cannot work yet should not be started and
then be seen to fail.

**D8 — removing a plugin: what happens to its settings and its secret?** *Options:* (a) keep
both, so reinstalling restores what was configured, and offer `--purge`; (b) remove both, so
removal means removal; (c) keep settings, remove the secret.
*Proposal:* (c). A settings file is small, harmless and useful on reinstall; a credential left
behind for something no longer installed is a liability.

**D9 — monty's own settings file.** *Options:* (a) monty declares a settings form and reads
`context.settings`, and its own file is gone; (b) both, with the host's values winning; (c) monty
keeps its file, and this plan only covers plugins written later.
*Proposal:* (a). Two places to configure one thing is the problem this plan exists to end.
It is work in monty's repository, sequenced after slice 05.

**D10 — a value changed while the plugin is running.** *Options:* (a) the host restarts that
plugin through the control channel, as an expected stop-and-start; (b) the new values are
delivered as an event and the plugin applies them live; (c) nothing until the next start, and the
window says "restart to apply".
*Proposal:* (a). It reuses machinery that exists and is the only option where a plugin author has
nothing to get wrong. (b) is a second contract every plugin must implement correctly.

**D11 — who may change settings.** *Options:* (a) the application window and the CLI, both
through the host; (b) the window only; (c) the window, the CLI, and a plugin writing its own
values back. *Proposal:* (a). (c) would mean a plugin can change what the user chose.

**D12 — does the page show plugins that are not installed?** *Options:* (a) no: the page manages
what is installed, and adding one is a command with a source; (b) yes: it browses the owner's
plugin index, which is where "add" would come from for a person who is not a plugin author.
*Proposal:* (a) for the MVP, noting (b) as the natural next step once an index exists.

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
