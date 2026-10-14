---
type: cycle-record
work_item: WI-0022-15-run-history-and-rerun
attempt: 0005
decision: done
timestamp: 2026-10-14 20:28:37Z
---

# Attempt 0005 for WI-0022-15-run-history-and-rerun

**Decision:** done

## Summary

Round 5 on a40835c confirmed: Run history with filters, search, selection, Re-run (from the source event through any lineage), Re-run from a step, bulk Re-run and Delete capped at the page (100), Delete that marks the batch deleted first, cancels journaled and held inputs, survives restart and refuses late inputs; Open in Anytype through openExternal; the caption from the run's own record. Journal migration 1->2 (rerun_of_started_at, deleted_runs).

## Checker verdicts

- claude-subagent: pass — hang gone (hang64 returns with 64 outstanding 1 held), 13 delete scenarios x3 pass, nextHeld skip proven, 176/176 unit+integration, 4/4 e2e; three gate e2e failures judged load flakes (whole files rerun twice at load 45-50: 26/26)

## Notes

Gate on a40835c: every non-e2e stage GREEN twice; the e2e stage had 2 load-timeout failures per run in different tests (general, configuration, editor-sync), each passing alone and in whole-file reruns; machine load 50-57 from contactsd/spotlightknowledged/another session. Minor, open: nextHeld's skip writes no log line; a batch delete's 'inputs in hand cancelled' count is low; a re-held input goes to the back of the held list (base behaviour).
