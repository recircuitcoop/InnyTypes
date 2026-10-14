---
type: cycle-record
work_item: WI-0022-21-cutover-old-pages
attempt: 0001
decision: recover
timestamp: 2026-10-14 22:29:51Z
---

# Attempt 0001 for WI-0022-21-cutover-old-pages

**Decision:** recover

## Summary

Round 1 on 8257113: pages, 31 AppApi calls and 22 IPC channels gone; frame band gone and the frame's box equals the 960x640 window; 149 ledger citations all resolve to listed tests, 11 rows listed for the owner; the editor-wait removal was correct. Refuted on acceptance 1: the suite still finds ~180 elements by role/text/label and ~120 by CSS, 15 added by this diff (plan 0022 §R: data-testid only).

## Checker verdicts

- claude-subagent: fail — counts by file: live 82, configuration 29, run-history 24, frame 7, updates 7, packages 7, gallery 5, general 5

## Notes

Also: created event types still say 'Fire it from the Events page'; the 11 undecided rows keep wi WI-0018-* so check.ts --wi WI-0022-22 will not find them; stale page names in 15 reason texts and 6 source comments; EventTypeChanges and PackageSources now dead; the plan 0013 e2e lost its held-back-notice assertions; owner-review item 9 does not say plainly that leaving a dirty canvas loses the edits.
