---
type: cycle-record
work_item: WI-0024-02-dataview-object-id-rewrite-and-refusal
attempt: 0001
decision: recover
timestamp: 2026-10-14 06:38:02Z
---

# Attempt 0001 for WI-0024-02-dataview-object-id-rewrite-and-refusal

**Decision:** recover

## Summary

Verifier refuted: object_id null skips the shim, so a Query source is forwarded and a type-<internal_key> source escapes conversion

## Checker verdicts

- claude-subagent: fail — null object_id bypass; live shapes, conversions, api_key rewrite and dispatch order hold

## Notes

Fix sent: null/empty object_id treated as absent, other non-strings refused; clearer source refusal messages.
