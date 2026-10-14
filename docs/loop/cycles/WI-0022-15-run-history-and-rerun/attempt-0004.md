---
type: cycle-record
work_item: WI-0022-15-run-history-and-rerun
attempt: 0004
decision: recover
timestamp: 2026-10-14 19:46:15Z
---

# Attempt 0004 for WI-0022-15-run-history-and-rerun

**Decision:** recover

## Summary

Round 4 on bc4e76d, gate GREEN: the bulk-delete race is fixed (markDeleted before cancel; r3 probe 3/3 per order; new run, bad ids, crash mid-batch, all held deleted all hold). Regression: the new #finish loop in node-process.ts:530-538 spins forever when admit() returns hold (outstanding >= bound after a replay readmit that ignores the bound: 64 awaiting, restart, one input before flows:started -> 65/64; answering one view loops synchronously).

## Checker verdicts

- claude-subagent: fail — probe hang64.probe.ts reproduces with production defaults; 15858e9 re-holds once and returns

## Notes

Fix: the loop moves past an input only when admit refused it because its run was deleted; a hold ends the loop. Minor, not failing: a throwing cancel leaves marked-deleted runs with their records until a retry.
