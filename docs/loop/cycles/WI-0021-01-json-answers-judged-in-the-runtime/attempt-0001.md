---
type: cycle-record
work_item: WI-0021-01-json-answers-judged-in-the-runtime
attempt: 0001
decision: recover
timestamp: 2026-10-14 06:59:09Z
---

# Attempt 0001 for WI-0021-01-json-answers-judged-in-the-runtime

**Decision:** recover

## Summary

Verifier refuted: 16 KiB string limit counts UTF-16 units, not bytes

## Checker verdicts

- claude-subagent: fail — one judgement, size, depth, keys, refusals hold

## Notes

Fix sent: count UTF-8 bytes; keep answer keys out of the log; refuse non-plain objects; say format is not enforced.
