# Log — durable loop outcomes

## 2026-09-15 — anytype-mcp absorbed into the core

The `anytype-mcp` repository (planned as an addon) moved into the host as
`innytypes.anytype_mcp`, with its plan renumbered to 0002 and its WorkItems to `WI-0002-*`.
Restart-with-backoff moved out of its slice 03 into plan 0001 slice 07, so there is one restart
policy for every child kind. Its history is merged into this repository; the original
repository was deleted.

## 2026-09-15 — plan 0002 revised form approved; MCP host integration reordered

The owner approved plan 0002 as revised during the absorption (restart policy moved to plan
0001 slice 07; slice 05 is host integration rather than an addon contract). Plan 0001 slice 07
is now seeded as `WI-0001-07-process-supervision`, and `WI-0002-05-host-integration` depends on
it, so the MCP server cannot be wired into the host before the host's supervisor exists.

## 2026-09-17 — plan 0003 (InnyTypesHelper) approved; plans 0001 and 0002 amended

The owner answered all 27 decisions of plan 0003. The helper is a separate process started by a
single application icon; it starts Anytype and the host, owns every restart, updates the core and
the addons, and sends telemetry keyed by a machine hash detached from personal information.
Consequences for the approved plans: the host keeps spawning its children but restarts nothing
(plan 0001 slice 07, `WI-0001-07` rewritten); each addon gets its own environment and discovery
reads recorded manifests (plan 0001 slice 02, `WI-0001-02` rewritten); invariant 6 names the
helper as its one exception; plan 0002 points restart policy at plan 0003. Seven follow-up
decisions (F1–F7) are open in plan 0003. No WorkItems are seeded for plan 0003 yet.
