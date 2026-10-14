---
type: cycle-record
work_item: WI-0022-15-run-history-and-rerun
attempt: 0001
decision: recover
timestamp: 2026-10-14 15:38:24Z
---

# Attempt 0001 for WI-0022-15-run-history-and-rerun

**Decision:** recover

## Summary

Gate GREEN on a2cb3c4 but the verifier refuted: delete leaves awaiting inputs open, plain Re-run of a Re-run-from run starts at the wrong step, bulk >100 gives a retry sentence, the row menu lacks Open in Anytype, the Re-run caption depends on loaded rows.

## Checker verdicts

- claude-subagent: fail — five Section E / design-system defects, reproduced by probe

## Notes

Fix in main.ts belongs outside main.ts (plan section N: main.ts only constructs). Drop the duplicate RerunTargets shape in registration.ts.
