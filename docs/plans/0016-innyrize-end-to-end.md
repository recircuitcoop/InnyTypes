---
type: plan
title: InnyTypes wires plugins together, and innyrize proves it end to end
status: TODO
created: 2026-09-24
updated: 2026-09-25
---

# 0016 — InnyTypes wires plugins together, and innyrize proves it end to end

## Outcome

The whole chain runs in the real application, and the log proves every step:

> the BOYA holds a new recording → monty emits `monty.new.v1` naming the file → **InnyTypes, and
> only InnyTypes, decides that this event feeds innyrize** and delivers it → innyrize diarizes →
> the chosen txt/json/srt lands in the output folder → innyrize emits `innyrize.diarized.v1`
> carrying that folder → InnyTypes accepts it.

innyrize is built in its own repository (`~/git/innyrize`, plan 0001 there). This plan is the
InnyTypes side. Its centre is a feature InnyTypes does not have yet: **runtime wiring**.

## The rule

The owner, 2026-09-25: *"innyrize does not manifest the events it reads because it creates
coupling between plugins. Instead InnyTypes runtime injects these events into running innyrize."*

- A consumer plugin never names another plugin's event kinds.
- A producer never knows who listens.
- The connection between them is **configuration held by InnyTypes**. That is the runtime's role,
  as the owner said in plan 0012: *"THIS IS EXACTLY THE ROLE OF INNYTYPES"*.

## What is true today (checked 2026-09-24/25, with evidence)

- **Subscriptions come only from the consumer's manifest.** `subscribes` is parsed once from the
  manifest (`addons/manifest.py:550`). The runner subscribes the plugin's handler to exactly
  those patterns (`addons/run.py:633`). There is no other way for a plugin to receive an event.
  This is the coupling the owner rejects.
- **The host's routing exists, but only in-process tests prove it.** The route is: plugin A emits,
  the host accepts it on A's channel, `EventBus.publish`, B's subscription queue, B's delivery
  thread, B's channel (`events/channel.py:197-208, 353-371`, `events/bus.py:260-295`).
  - `tests/test_event_transport.py` covers it with both ends in one test process (its own header
    at line 7: *"Nothing here opens a socket, a pipe or a subprocess"*).
  - `test_addon_runner.py:254` runs one addon in a thread.
  - `test_host_children.py`, `test_mcp_host_integration.py` and `test_addons_cli.py` use a
    `FakeProcess`.
  - **No test runs two real plugin processes with an event crossing from one to the other.**
    That is the owner's point 6, now proved.
- **Delivery is not logged.** The delivery path is `bus.py:153-186`, `delivery.py:68-71`,
  `transport.py:346-354` and `channel.py:305-371`. Its only log lines are `event accepted` and
  `event refused` on the way in (`channel.py:325, 370`), plus channel close and unreadable
  frames. Nothing says an event was *delivered to* a named plugin, so "InnyTypes fed innyrize"
  cannot be read from the log.
- **A slow subscriber is dropped for good.** Each subscriber's queue holds 128 events; on overflow
  it is dropped and `LISTENER_FAILED` is published (`bus.py:67, 283-294`). Nothing turns that
  into a notice the person sees.
- **The producer's event isn't built yet.** `monty.new.v1` (`{path, folder, size, modified_at,
  content_key}`, where `path` is the file) is planned in monty WI-0002-03, per the monty session on
  2026-09-25. `monty.copied.v1` is legacy and is being deleted. Nothing here uses it.

## Runtime wiring — the design to build

**A wire says:** *events of kind K feed plugin P, and the file (or other input) is in payload
field F.*

- **Where it lives.** It is InnyTypes' own configuration, not the plugin's settings file. It is
  shown and edited on the **consumer plugin's tab**, in a section "Fed by": a table of rows, each
  with an event kind and an input field.
  - The kind is a **choice among the kinds installed plugins declare in `emits`**, which the
    host already knows from their recorded manifests.
  - The field is text, defaulting to `path`.
  - The person picks from what exists, so there are no typos.
- **What the host does.** When it starts P, the host subscribes P's channel to P's wired kinds, in
  addition to anything in P's own manifest (the manifest route stays for compatibility). It also
  **tells P what it is fed**: the kind and field of each wire, through the same route that
  already tells an addon its settings path (plan 0012 slice 01). The runner then subscribes P's
  handler to those kinds, and P's context says which field to read for each kind.
- **Changing a wire** restarts P, the same way a settings change does, so the running process and
  the configuration never disagree.
- **Refused, by name:**
  - a wire from a plugin to its own kind (a loop);
  - a field name that isn't a valid identifier;
  - a wire to a plugin that isn't installed.

  A wire from a kind that no installed plugin emits is **kept but shown** as "nothing installed
  emits this", because the producer may be installed later.
- **Logged:**
  - wires are recorded at start (INFO), for example `innyrize is fed monty.new.v1 (field path)`;
  - each delivery is recorded (DEBUG): `event delivered: monty.new.v1 to innyrize`, field names
    only, like the other event lines.
- **Host API.** A plugin can be wired only if its manifest's `host_api` is at least the version
  that introduces wiring. An older plugin would silently ignore what it is fed, so offering it in
  the "Fed by" choice would be a lie.

## Paid tests

Everything in the gate uses fakes and never pays. The end-to-end run with real Mistral is one
test marked `live`. It skips without a key. The owner: *"when it is robust, it can be marked in a
special way so it is not run absolutely every time we run a test"*. So once it has passed
repeatedly, `addopts` deselects `live` by default, and it runs with `pytest -m live`. The marker
is registered, so a typo fails instead of silently deselecting.

## Slices

| # | Work item | What |
|---|---|---|
| 01 | `WI-0016-01-one-plugin-feeds-another-for-real` | **The owner's point 6.** A gate test with **two real plugin processes under a real host**: tiny plugin A emits, the host routes, tiny plugin B receives in its own process and emits its own kind, and every hop is read back from the log. Adds the `event delivered: K to P` DEBUG line. Break it and watch it fail by cutting the forwarding. Uses today's manifest route, so it proves the transport before wiring is built on it. |
| 02 | `WI-0016-02-innytypes-wires-plugins` | Runtime wiring as designed above: the configuration, the host subscribing and telling the plugin, the runner, restart on change, the refusals, the "Fed by" section on the tab, and the host_api gate. Proof: slice 01's two real processes again, with **no `subscribes` in B's manifest**, fed only by a wire. |
| 03 | `WI-0016-03-a-dropped-subscriber-is-seen` | Queue overflow drops a subscriber, and the person is told, once, by the same route as a refused event (plan 0012): a notice, `helper status`, and the tab. |
| 04 | `WI-0016-04-innyrize-installs-and-is-fed` | Install innyrize from `~/git/innyrize` into a real addon environment, with whodunnit from its local path and the bundled ffmpeg in place. Wire `monty.new.v1` (field `path`) to it. A fake producer's event reaches it, and `innyrize.diarized.v1` is emitted and accepted. Fake transcriber. |
| 05 | `WI-0016-05-the-chain-for-real` | The live chain. A `live`-marked test drives it with installed monty and innyrize and a short real recording. Then on the machine: plug in the BOYA holding a new recording, and read the log after a baseline for `monty.new.v1` emitted and accepted, delivered to innyrize, innyrize's job lines, and `innyrize.diarized.v1` emitted and accepted. The output folder holds the chosen formats. Real Mistral, once, with the owner's go-ahead. |

**Order:** 01, then 02, then 04. 03 can run alongside 02. 04 needs innyrize slices 01–04. 05 needs
04, monty WI-0002-03 (`monty.new.v1`), and the owner's output folder and key.

## Non-goals

- A mapping language beyond "which field holds the input". A plugin whose input needs more than
  one field is a later question.
- Changing a payload in flight: the host delivers the producer's payload unchanged.
- Checking payloads against the producer's schema in the host.
- Plan 0011's buttons, including monty's re-emit.

## Status

Rewritten 2026-09-25 after the owner's corrections, not started. It depends on innyrize plan 0001
and on monty WI-0002-03.
