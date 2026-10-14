---
type: cycle-record
work_item: WI-0024-02-dataview-object-id-rewrite-and-refusal
attempt: 0003
decision: done
timestamp: 2026-10-14 07:16:29Z
---

# Attempt 0003 for WI-0024-02-dataview-object-id-rewrite-and-refusal

**Decision:** done

## Summary

Dataview shim: a type target is written as object_id (api_key, internal_key, type-<key>, object id), a collection forwarded, a Query or malformed target refused with nothing forwarded; create-object, create-template and patch-object blocks judged; composed before the unwrap shim

## Checker verdicts

- claude-subagent: pass — 57 tests, 29/32 fail with the shim bypassed, live shapes in the fakes, no unrequested scope

## Notes

Merge conflict with WI-0023-03's removal comment in mcp-dispatch.ts resolved by hand; dispatch tests pass on main. Owner: live render check, replace_subtree member, update_block.
