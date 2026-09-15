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
