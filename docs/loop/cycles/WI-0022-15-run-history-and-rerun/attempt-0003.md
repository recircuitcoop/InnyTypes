---
type: cycle-record
work_item: WI-0022-15-run-history-and-rerun
attempt: 0003
decision: recover
timestamp: 2026-10-14 19:12:57Z
---

# Attempt 0003 for WI-0022-15-run-history-and-rerun

**Decision:** recover

## Summary

Round 3 on 15858e9, gate GREEN: single delete, restart, late input and the one-transaction deletion all hold. Bulk delete still races when runs are cancelled oldest-first: cancelling r1 (awaiting) frees its place under the bound, #finish admits held r2 before deleteRuns has written it to deleted_runs, so r2 is journaled, sent and in 2 of 5 runs shown to the person.

## Checker verdicts

- claude-subagent: fail — reproduced with the real node process at bound 1, deleteMany [r1, r2]; RunHistoryScreen sends ids in click order so the UI can produce it

## Notes

Fix shape: mark every run in the batch deleted (and fail its held inputs) before cancelling any journaled input, so admission after a freed place sees the deleted mark.
