---
type: cycle-record
work_item: WI-0022-13-run-cards-questions-and-notifications
attempt: 0001
decision: done
timestamp: 2026-10-14 12:04:37Z
---

# Attempt 0001 for WI-0022-13-run-cards-questions-and-notifications

**Decision:** done

## Summary

Run cards in every state from real run records (Copying, Safe to unplug on phase copied, step lines, questions with Answer, failed, done), inline questions, Later and Skip, notifications with buttons bound per run, the start notification stopping after five good runs, the dock badge counting waiting questions; the Question pop-out drawn with tokens.css under the byte-identical CSP, reconciled with WI-0021-02/03's widget rules

## Checker verdicts

- claude-subagent: pass — 319 tests, live e2e 9/9, app-pages e2e 5/5, production view.js has no probe; copy-race orderings probed

## Notes

Merged twice with main (WI-0021-02/03 view page; WI-0022-20 shell/main.ts); final gate GREEN on 5b774e1 after the merge and two small fixes (doubled comment; phase written only when the fold accepts it). Open: no Retry on failed cards (WI-0022-15); run watch makes three run.list calls per signal and keeps every seen run id (minor).
