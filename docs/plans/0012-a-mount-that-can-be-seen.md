---
type: plan
title: A mount that can be seen — the plugin runs, the event fires, and somebody can tell
status: DONE
created: 2026-09-24
updated: 2026-09-24
---

# 0012 — A mount that can be seen

## Outcome

A declared recorder is plugged in, monty announces it, and a person can see that it happened.
No subscriber is required: the owner asked for proof the event fired, and a log is proof enough.

## The story, and where it stops today

> The BOYA mounts as an external device. monty fires `monty.mounted.v1`.

It stops three times, each independently fatal, traced on this machine on 2026-09-24:

**1. monty cannot start at all.** Its process exits 1 on every attempt and the breaker has
quarantined it — `notices.json` holds `process-quarantined / monty / exited with code 1`. The
failure is `ModuleNotFoundError: No module named 'platformdirs'`, and it is a regression of an
invariant this repository already has: *the contract layer has no third-party dependencies, so an
addon environment has nothing to collide with* (`WI-0001-08e`, marked done). An addon environment
is deliberately built with only the host wheel, the addon and the addon's own declared
dependencies — monty's holds exactly `innytypes`, `monty`, `psutil`.

`innytypes.addons.discovery` and `innytypes.addons.settings` honour that invariant by importing
`platformdirs` **inside** the functions that need it, saying so in comments. Importing the modules
therefore works in an addon environment; *calling* those functions does not. And
`innytypes.addons.run` calls one: it resolves the addon's own settings path at start. So the
addon process asks where its settings live, in an environment that cannot answer.

That is the bug. The host already knows where the addon's settings are — it validated them and it
spawned the process. The addon should be told, not left to work it out with a library it was
deliberately not given.

**2. The installed monty predates the feature, at two levels.** It was installed non-editably on
2026-09-19; the mount event landed on 2026-09-23. The installed package's `_report_mount` only
logs and never emits, and the host's recorded `manifest.json` from that install declares only
`monty.copied.v1`. That recorded manifest is what fills the host-side kind registry, so even a
freshly-linked monty emitting the new kind would be refused at the inbound boundary.

**3. A refused kind is invisible.** When the host receives a frame whose kind the addon's recorded
manifest never declared, the frame is dropped and a line is logged. The channel stays open,
nothing raises, nobody is told. For the owner's actual question — *did the event fire?* — that is
the worst possible answer: the difference between "nothing happened" and "something happened and
nobody was told" is exactly what cannot be seen.

## Not in the way, so nobody wastes time there

The BOYA is correctly declared, with a UUID, in the per-user `plugins/monty.toml`, so
`match_volume` would answer a clean UUID match. monty's enable switch is on. An empty
`destination` blocks copying, not announcing. And the host **does** start its children at boot —
`Host.start()` walks `start_order` and starts each one; a reading that said otherwise was wrong.

## Acceptance

- An addon process never resolves a per-user path for itself. It is told where its settings are,
  by the host that already knows.
- A test proves an addon environment containing only the host wheel, the addon and its declared
  dependencies can start an addon — the invariant is guarded rather than restated.
- `innytypes addons install` against a source whose manifest has changed re-records the manifest,
  so a newly declared kind is known to the host.
- An emitted event that the host refuses because its kind was never declared is **visible to a
  person**, naming the addon and the kind, in the same place the host's other degradations are
  seen. Silence is the defect.
- A successful emit leaves evidence a person can find, so "did it fire?" is answerable without a
  subscriber and without a debugger.
- The story runs on this machine: monty starts, the BOYA is recognised, and the mount is announced
  and seen.
- `docs/loop/verify.sh` exits zero and prints `gate: GREEN`.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | the addon is told where it lives | the host supplies the settings path; no per-user path resolved in an addon process; the empty-environment invariant guarded by a test |
| 02 | an install records what is installed | reinstalling from changed source re-records the manifest, so a new kind is known |
| 04 | logging is part of the API | a plugin is given a logger as it is given an emitter; a durable log all three processes reach; every event emitted, accepted or refused recorded at a deliberate level |
| 03 | a refusal is not silence | a refused kind reaches the person, and a successful emit leaves evidence |

**Order:** 01 → 02 → 04 → 03. Slice 01 unblocks everything; without it monty cannot run at all.
Slice 04 comes before 03 because 03 needs somewhere for evidence to land.

## There is nowhere for evidence to go

Traced 2026-09-24, and it is worse than the mount story. **No logging handler is configured
anywhere in either repository** — no `basicConfig`, no `addHandler`, no `FileHandler`, no
`dictConfig` in `src/`. So every logger writes to nothing: an INFO record is discarded by Python's
defaults before it reaches a stream, and a WARNING reaches the helper's stdio, which for an
application opened from the Finder is `launchd` and nobody. There is no log file on this machine.

monty's own success line for a clean UUID match is INFO, so it is discarded. The refusal that
happens today is a single WARNING at `events/channel.py:259`, on the host, with no handler behind
it. And an addon child's stdout and stderr are piped deliberately — so a plugin that prints cannot
corrupt the event stream — and then never drained, so they vanish when it exits.

The owner's instruction is that this is **a basic of the InnyTypes API**, not something each
plugin arranges for itself: a plugin is handed a logger the same way it is handed an emitter and
its settings. And while the application is in test mode the events themselves are what must be
logged — an event emitted, accepted, or refused with its reason — because that is the thing being
proved right now.

`children.py` already says this in a comment, about a different path with the same mechanism: *the
only account of why was a line on the host's own stdout, which a packaged application throws
away.* Two slices of plan 0009 worked around this by routing facts to the helper over the control
channel. Slice 04 gives those facts a destination instead.

## Non-goals

- adding `platformdirs`, or any dependency, to addon environments — that is the invariant this
  plan restores, not a cost it pays;
- a subscriber for `monty.mounted.v1` — the owner explicitly does not want one yet;
- changing how monty detects volumes, or introducing any operating system mount API;
- changing restart policy, the breaker or quarantine.

## Rollback and compatibility

Slice 01 changes what the host passes a child it spawns, so a host and an addon of different
versions must still agree: the addon keeps working when told nothing, falling back to today's
behaviour, and only the environment that cannot answer is spared the question.

## Delivered

All five slices landed on 2026-09-24: 01 `289651c`, 02 `7bd06ad`, 04 `767241e`, 05 `8c2fc14`,
and 03 in the commit after this section was written.

- **01:** the host tells an addon its settings path and secrets root. monty runs in an
  environment holding only `innytypes`, `monty` and `psutil`.
- **02:** install already recorded what it installed. The stale manifest was operational. Fixed:
  an install that could not read a manifest now names the addon and its source.
- **04:** InnyTypes has a log at `~/Library/Logs/innytypes/innytypes.log`, named by
  `innytypes logs`. Every event is recorded: emitted at DEBUG, accepted at INFO, refused at WARNING.
- **05:** the thread assertion counts every thread. `tests/home_guard.py` fails the gate on any
  write to the real home.
- **03:** a refused event reaches the person through the degradation path: a desktop
  notification, the notices file, `innytypes helper status` and the plugin's tab. It is reported
  once per plugin and kind, and cleared on reinstall.

**Proved on the machine with the real device.** The rebuilt app started at 16:17, with monty
reinstalled and a log baseline of 7016 bytes. The BOYA was plugged in and mounted at 16:26:42 as
`/Volumes/BOYA`: USB, external, UUID `A76BF8EB-…2745`. After the baseline the log gained:

```
2026-09-24 16:26:52,760 DEBUG     58310 innytypes.events.emitter: event emitted: monty.mounted.v1 by monty, fields ambiguous_mount_points, matched_on, mount_point, needs_confirmation, source_id, volume_name
2026-09-24 16:26:52,761 INFO      58142 innytypes.events.channel: event accepted: monty.mounted.v1 from monty
```

That is one event, and no refusal. **What the log could not say:** which drive, and that it matched on
UUID. monty's own line saying so is written to a logger the application log does not collect.
Seeded as plan 0014.
