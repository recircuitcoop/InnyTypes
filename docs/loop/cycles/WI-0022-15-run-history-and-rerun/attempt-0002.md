---
type: cycle-record
work_item: WI-0022-15-run-history-and-rerun
attempt: 0002
decision: recover
timestamp: 2026-10-14 18:46:33Z
---

# Attempt 0002 for WI-0022-15-run-history-and-rerun

**Decision:** recover

## Summary

Round 2 on 582d82a, gate GREEN: four of five defects fixed and tested (re-run lineage, bulk cap = page, Open in Anytype via openExternal, caption from rerun_of_started_at). Delete still misses inputs held at the instance's queue bound (spec 7.6): cancelRun walks only the journal, so a held input of a deleted run is admitted and presented later; RunTables.#deleted is memory-only, so after a restart the re-presented question records the deleted run again.

## Checker verdicts

- claude-subagent: fail — reproduced with the real node process at bound 1: cancelRun('r2') returned 0, r2's held input was presented after delete

## Notes

Journal version bump 1->2 in this branch; watch for a collision with 0022-19 (merge preview shows one conflict, in app/test/unit/app-api-v2.test.ts).
