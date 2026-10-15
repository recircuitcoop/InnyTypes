---
type: cycle-record
work_item: WI-0022-27-a-blocked-update-is-not-offered-again
attempt: 0001
decision: done
timestamp: 2026-10-15 07:34:39Z
gate_mode: detailed
---

# Attempt 0001 for WI-0022-27-a-blocked-update-is-not-offered-again

**Decision:** done

## Summary

Confirmed on 26b1959, gate GREEN (94/94 e2e, parity: ledger holds, 2638 rows, 100 undecided). After a package update fails its check, is rolled back and blocked, General › Packages shows 'Update to <v> held back' with the rollback reason and no Update control, across a restart, until a different version is listed; checkFacet reads a failed line as blocked and latestAsked lets it win over the board's own check; a block whose record cannot be read says 'Held back: <reason>.' without claiming a rollback; the ledger row test_a_blocked_update_is_shown_with_its_reason_and_no_apply is ported to the new e2e case; owner-review item 11 says fixed.

## Checker verdicts

- claude-subagent: pass — fix confirmed on ed5f5c4 and on the merge with the cutover; GREEN only on the sixth full run, under load 24 with the other session idle

## Notes

Three test-only commits rode along (declared): configuration.e2e.ts REDEPLOY_MS 20->60 s, quit-question.e2e.ts editor-load poll 10->30 s, gallery.e2e.ts setTheme keeps the theme until it holds and waits for colour transitions (from WI-0022-23). Five earlier full runs failed only on e2e timeouts or that gallery race at machine load 50-260 from another session's gates and two stuck apps; every failing test passed alone. Quick gate (loopify plan 0023) landed on main meanwhile; rounds no longer pay for the full run.
