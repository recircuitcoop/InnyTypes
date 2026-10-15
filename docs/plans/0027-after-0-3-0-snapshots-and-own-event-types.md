---
type: plan
title: After 0.3.0, snapshots, your own event types and new Anytype tools
status: PROPOSED
created: 2026-10-15
updated: 2026-10-15
---

# 0027 — After 0.3.0, snapshots and your own event types

Status: PROPOSED 2026-10-15. Scheduled by the owner for after the 0.3.0 release; not yet
designed or approved for building.

## Why

The 0.3.0 cutover (plan 0022, WI-0022-21) removed the old window's seven pages. Two things those
pages let a person do have no place in the new window. At the cutover review on 2026-10-15 the
owner accepted shipping 0.3.0 without them, on one condition each:

- **Opening snapshots.** "re-run is enough but it must be planned for post 0.3 release as an
  extra feature". InnyTypes still records a snapshot of each run's result, but nothing in the
  0.3.0 window lists or opens one, so a snapshot's actions (spec §8.3) cannot be pressed. Re-run
  in Run history covers starting a run again.
- **Your own event types.** "it can come later but it MUST be planned for post0.3 release". The
  old Events page created, versioned, fired and deleted `user.<name>.vN` event types. Plan 0022
  §N moves them into a flow: "Created event types become a source setting inside a flow
  (strategy brief §5); their runtime ops stay for the source's form."

Both are recorded in `docs/parity/owner-review.md`, the cutover batch, items 6 and 8.

## Goals

1. A person can find a run's recorded snapshot again and open it in its pop-out, where its
   actions work as spec §8.3 says (start a new run, or refuse with the reason).
2. A person can create, version, fire and delete their own event types from inside a flow, as a
   source's settings, using the runtime's event-type operations that 0.3.0 kept.

3. When the live Anytype MCP tool list only adds tools to the committed surface, the endpoint
   opens and serves every tool, the new ones included; General › Advanced names the added tools.
   A removed or changed tool still closes the endpoint with the mismatch named.

## Open questions for the owner

- Snapshots: where does a snapshot open from — a run's row in Run history, its card on Live, or
  both? Does a snapshot outlive the run it came from (run retention), or go with it?
- Event types: which source carries them — a dedicated "Your own event" source node in the
  palette, or a setting on the existing manual trigger? Who fires one — the person from the
  window, an AI app over the MCP endpoint, or both?

## Items

Not yet split into work items. Once the owner answers the questions above, this plan is
written out in full (decisions, contracts, work items with acceptance) and approved before any
building starts.
