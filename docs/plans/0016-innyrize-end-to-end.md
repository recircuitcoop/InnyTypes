---
type: plan
title: innyrize in InnyTypes, proved end to end
status: TODO
created: 2026-09-24
updated: 2026-09-24
---

# 0016 — innyrize in InnyTypes, proved end to end

## Outcome

The whole chain runs in the real application, and the log proves each step:

> the BOYA mounts → monty copies a recording and emits `monty.copied.v1` → InnyTypes delivers it to
> innyrize → innyrize diarizes it → the chosen txt/json/srt lands in the output folder →
> innyrize emits `innyrize.diarized.v1` carrying that folder → InnyTypes accepts it.

innyrize itself is built in its own repository (`~/git/innyrize`, plan 0001 there). This plan is
the InnyTypes side: whatever the platform lacks for one plugin to feed another, the proof in the
gate, and the proof on the machine.

## What is already true (checked 2026-09-24)

- Subscribing exists: a manifest's `subscribes` can list exact kinds or prefixes
  (`events/bus.py:114, 360`). The runner subscribes the plugin to them, and the host's transport
  forwards matching events down the plugin's channel (`addons/run.py:633`,
  `events/transport.py:279`, `events/channel.py:305`).
- A subscription whose publisher is missing is a quiet inbox, not a failure
  (`addons/resolution.py:17-22`).
- Each subscriber gets a bounded queue of 128. On overflow, the subscriber is **dropped for good**
  and `LISTENER_FAILED` is published (`events/bus.py:67, 283-294`).
- The host checks a payload is JSON and that its kind is declared. It never checks an emitter's
  schema.

## What is in the way

1. **Never proved across two real plugin processes.** The closest test
   (`tests/test_addon_runner.py:346`) uses a real socket, but both ends run in one process. The
   route from plugin A's process through the host to plugin B's process has never run in the gate.
   This project has found a build-but-not-connected defect four times. This is the fifth place to
   look.
2. **Delivery is not in the log.** The log says an event was *emitted* and *accepted*. Nothing says
   it was *delivered* to innyrize, so "InnyTypes fed innyrize" cannot be read from it. Add a DEBUG
   line per delivery to each subscribing plugin: `event delivered: <kind> to <addon>`. Field names
   only, like the others.
3. **A dropped subscriber must be seen.** If innyrize is ever dropped (queue overflow), that has to
   reach the person the way a refused event does since plan 0012: a notice, `helper status`, and the
   plugin's tab. Today it is an event on the bus that nothing turns into a notice. The slice checks
   this and, if it is so, connects it through the same degradation path.
4. **monty copies nothing on this machine.** The owner's `monty.toml` has `destination = ""`, which
   blocks copying, so `monty.copied.v1` never fires. For the machine proof, the owner chooses a
   destination folder. This plan does not edit the owner's config on its own.

## Decisions

- **"What event innyrize feeds on" stays two-level** (see innyrize plan 0001): the manifest declares
  the kinds innyrize can read, and a setting chooses among them.
  - **Not chosen:** letting a *setting* change a plugin's subscriptions at runtime. It would
    mean the recorded manifest no longer tells the whole truth about what a plugin listens to,
    and plan 0012 made the recorded manifest the thing refusals are judged by. If the owner wants
    it, it is its own plan.
- **The gate never pays Mistral.** The automated proof uses a fake emitter plugin and a fake
  transcriber seam in innyrize. The one live paid run is on the machine, with the owner's go-ahead
  for one short recording.

## Slices

| # | Work item | What |
|---|---|---|
| 01 | `WI-0016-01-one-plugin-feeds-another` | A gate test with two real plugin processes under a real host. A tiny emitter plugin emits a kind, and a tiny subscriber plugin receives it and emits its own. Both lines are read back from the log. Also adds the `event delivered` line. Break it and watch it fail by cutting the forwarding. |
| 02 | `WI-0016-02-a-dropped-subscriber-is-seen` | Queue overflow drops a subscriber, and the person is told (notice, `helper status`, tab), reported once. If this already works, prove it and change nothing. |
| 03 | `WI-0016-03-innyrize-installs-and-runs` | Install innyrize from `~/git/innyrize` into a real addon environment, with whodunnit resolved from its local path. The host starts it, its settings reach it, and its manifest is recorded with `innyrize.diarized.v1`. |
| 04 | `WI-0016-04-the-chain-on-the-machine` | With the owner-chosen monty destination and innyrize output folder: plug in the BOYA and read the log after a baseline. `monty.copied.v1` emitted and accepted, then delivered to innyrize, then innyrize's job lines, then `innyrize.diarized.v1` emitted and accepted. The folder holds the chosen format. One short recording, paid, with the owner's go-ahead. |

**Order:** 01 and 02 can start now. 03 needs innyrize slices 01–03. 04 needs everything, plus the
owner's two folder choices and the go-ahead to pay.

## Non-goals

- Changing monty, beyond the owner setting its destination.
- Summaries, speaker repair, grouping multi-part recordings (innyrize non-goals).
- Checking payloads against the emitter's schema in the host.

## Status

Seeded 2026-09-24 on the owner's request, not started. It depends on innyrize plan 0001.
