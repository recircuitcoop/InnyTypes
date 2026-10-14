---
type: cycle-record
work_item: WI-0024-01-where-dataview-blocks-are-written
attempt: 0001
decision: done
timestamp: 2026-10-13 22:39:25Z
---

# Attempt 0001 for WI-0024-01-where-dataview-blocks-are-written

**Decision:** done

## Summary

The dataview write path is Anytype's own API: insert_blocks/replace_subtree are ops inside API-patch-object, tools built at start from the live openapi.json; the pinned package and InnyTypes forward arguments unchanged. The only in-repo interception point is mcpDispatch's tools/call branch.

## Checker verdicts

- claude-subagent: pass — CONFIRMED all four claims against code incl. node_modules; minor citation slips
