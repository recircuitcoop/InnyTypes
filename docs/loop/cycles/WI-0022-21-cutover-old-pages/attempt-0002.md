---
type: cycle-record
work_item: WI-0022-21-cutover-old-pages
attempt: 0002
decision: recover
timestamp: 2026-10-15 00:14:10Z
---

# Attempt 0002 for WI-0022-21-cutover-old-pages

**Decision:** recover

## Summary

Round 2 on 02742bb: the e2e suite is testid-only with a rule (e2e-finders.test.ts) that scans every spec; 149 ledger citations resolve; created-source help, dead modules, plan-0013 assertions, stale names, owner wording and redeploy budgets all done. Refuted on one thing: tools/parity/check.ts accepts only wi WI-0018-NN, so the 17 rows re-tagged WI-0022-22 (at my instruction) make the parity stage refuse them.

## Checker verdicts

- claude-subagent: fail — node tools/parity/check.ts prints 17 REFUSED rows and exits 1 regardless of reports

## Notes

Fix: restore the rows' original WI-0018-* ids; widening the checker to accept WI-0022-22 belongs to WI-0022-22, whose acceptance needs it. Verifier's weak spots in the finder rule (prefix-only Node-RED match, /* lines blanked, evaluate() not scanned) let nothing through today.
