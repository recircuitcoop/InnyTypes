---
type: cycle-record
work_item: WI-0022-21-cutover-old-pages
attempt: 0003
decision: done
timestamp: 2026-10-15 03:05:53Z
---

# Attempt 0003 for WI-0022-21-cutover-old-pages

**Decision:** done

## Summary

Round 3 on c9ae09b confirmed, gate GREEN (93/93 e2e, parity: ledger holds, 2638 rows, 101 undecided for the owner). The seven old pages, 31 AppApi calls and 22 IPC channels are gone; the frame band is gone and the frame fills the 960x640 window; the e2e suite is rewritten around Setup, Live and Configuration and finds every element by data-testid, enforced by test/unit/e2e-finders.test.ts; 149 ledger rows cite the new spec titles; the cutover's retirements are batched for the owner in docs/parity/owner-review.md with their WI-0018 ids kept until WI-0022-22 reassigns them (check.ts accepts only those ids today).

## Checker verdicts

- claude-subagent: pass — round 1 refuted on non-testid finders, round 2 on wi ids the checker refuses, round 3 docs-only fix; gate GREEN once the machine load dropped under 40

## Notes

Gate runs at load 110-260 produced only load timeouts (different tests each run, all passing alone); the GREEN run was load-gated to start under 40. For WI-0022-22: widen check.ts's wi pattern to accept WI-0022-22 and reassign the 17 proposed rows. Two proofs dropped by design and listed for the owner: snapshot pop-outs, and refusing to unregister a package used by an unsaved canvas step. Playwright's per-test budget is 60 s; on a loaded machine that is what flakes.
