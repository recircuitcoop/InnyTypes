---
type: plan
title: The MCP service is a core plugin, and says how it should be watched
status: APPROVED
created: 2026-09-23
updated: 2026-09-23
---

# 0010 — The MCP service is a core plugin

## Outcome

The Anytype MCP child declares how it should be watched, the way every plugin does, and the
helper watches it against its own numbers rather than against defaults meant for strangers. The
cadence that supervision runs at becomes the user's setting rather than a constant in the loop.

## Why

A plugin **implements** nothing for monitoring: the helper watches it from outside, through the
process table. What a plugin does is **declare** — an optional `[stability]` section naming
`heartbeat_interval`, `stale_after`, `max_rss_mb`, `max_cpu_percent`, `cpu_window`,
`max_open_files`, `max_children`, `breach_grace` and `restartable`. That surface is real and
honoured: `PublishedProfiles` reads the manifest, `resolve_profile` merges it with
`[helper.defaults]`, and the watch enforces all of it. Tests cover a plugin raising a limit,
naming its own stale window, asking for a longer grace, and refusing ever to be relaunched.

The one field with no default is `heartbeat_interval`, and the parser says exactly why: *an addon
that never promised heartbeats is watched for liveness, phantoms and resources, and is never
judged stale.*

And then, from `src/innytypes/helper/detection.py`:

> `# manifest for a plugin, and nothing at all for the host, the MCP server and Anytype.`

Core children have no manifest. So the profile lookup answers `None` for them and they inherit
the helper-wide defaults in silence. For the child this application most depends on:

- **it can never be judged stale.** A wedged Node process that holds its pipes open and answers
  nothing is invisible to staleness detection — and that is precisely how an MCP server talking
  to a desktop application fails. Today it is noticed only when the process is *gone*;
- **it is watched against generic numbers** — 1024 MB, 90% CPU, 1024 open files — chosen for
  "any plugin", not for a pinned Node child whose appetite is known;
- **`restartable` is true by omission** rather than by decision.

Liveness is the weakest of the three mechanisms the helper already has, and it is the only one
the MCP child gets.

## What a core child declares

The MCP child gains a manifest of the same shape a plugin's install records, published by the
host rather than discovered in an environment — it is not installed, and inventing an install for
it would be worse than the gap. The profile lookup stops being "a manifest for a plugin and
nothing for the rest" and becomes one question with one answer for every managed process.

Its declared numbers are this plan's decisions to make and to justify in the work item:
a heartbeat promise if and only if the child can honestly make one, limits sized to a Node
process rather than to a plugin, and an explicit `restartable`.

**The heartbeat is decided: the child promises one, and the host keeps it.** The owner settled
this on 2026-09-23. The Node child knows nothing of InnyTypes heartbeats and will not be taught
any, but the host holds the only MCP session to it and MCP defines `ping`, so the host beats on
the child's behalf - recording a beat **only** for a ping the child answered, never for a process
that merely exists. A beat therefore means the child answered MCP at that moment, which is
strictly more than liveness proves and is exactly what staleness is for. The design is written
into plan 0002, *The child promises a heartbeat, and the host keeps it*; this plan's slice 02
implements it and declares the interval.

## The cadence is the user's

`run_supervision` sleeps `interval()` between passes, and the interval is already an injected
callable — the mechanism exists, the value is not the user's. It becomes a `config.toml` setting
with a default of **ten seconds**, alongside the other helper numbers.

Ten seconds is the decision, and it has a cost worth stating: the slower the cadence, the longer
a crash goes unnoticed. The walkthrough saw about sixty seconds from kill to return, and a person
watching a window wants that shorter. Ten seconds is the compromise between noticing quickly and
sampling the process table of a machine somebody is trying to work on.

## Acceptance

- One profile lookup answers for every managed process — the host, the MCP child, Anytype and
  every plugin — with no branch on which kind of child it is.
- The MCP child is watched against its own declared limits; a test asserts a breach of one of its
  numbers is judged against that number and not against the helper-wide default.
- The MCP child's staleness behaviour is whatever this plan decided and the work item justified:
  if it promises a heartbeat, a silent child is judged stale and acted on; if it does not, a test
  asserts it is never judged stale, so the absence is a decision rather than an oversight.
- A core child's declaration cannot be edited by a user, and is not confused with an installed
  plugin's: `innytypes addons list` does not list it, and a command naming it as an addon is
  refused as it is today.
- The supervision interval is a `config.toml` setting defaulting to ten seconds; the running loop
  uses it; an absent setting behaves exactly as today.
- A test asserts the loop sleeps the configured interval, without spending a real second.
- `docs/loop/verify.sh` exits zero and prints `gate: GREEN`.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | one lookup for every process | the profile question answered for core children as well as plugins, with no caller branching on kind |
| 02 | the MCP child says its numbers | the declared profile, its limits, and the heartbeat decision with its justification |
| 03 | the cadence is a setting | the supervision interval in `config.toml`, defaulting to ten seconds |

**Order:** 01 → 02 → 03.

## Non-goals

- making core children installable, removable or updatable as plugins;
- showing core children in the plugin page or the addons list;
- a heartbeat protocol the Node child would have to implement — anything it cannot honestly send
  is not declared;
- changing restart policy, the breaker or quarantine;
- the assembled crash-and-restart test, which is plan 0009 slice 01.

## Rollback and compatibility

The declaration is additive: a helper reading no profile for a core child behaves exactly as it
does today, which is what makes slice 01 safe to land before slice 02 decides the numbers. The
interval setting is absent by default and falls back to the present value.
