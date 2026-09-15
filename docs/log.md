# Log — durable loop outcomes

## 2026-09-15 — anytype-mcp absorbed into the core

The `anytype-mcp` repository (planned as an addon) moved into the host as
`innytypes.anytype_mcp`, with its plan renumbered to 0002 and its WorkItems to `WI-0002-*`.
Restart-with-backoff moved out of its slice 03 into plan 0001 slice 07, so there is one restart
policy for every child kind. Its history is merged into this repository; the original
repository was deleted.
