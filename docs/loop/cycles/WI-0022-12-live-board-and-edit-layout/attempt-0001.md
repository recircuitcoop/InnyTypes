---
type: cycle-record
work_item: WI-0022-12-live-board-and-edit-layout
attempt: 0001
decision: done
timestamp: 2026-10-14 09:39:53Z
---

# Attempt 0001 for WI-0022-12-live-board-and-edit-layout

**Decision:** done

## Summary

Live: one board per flow kept in boards.json and reconciled on read; Edit layout with its bar, Add tab, Tab name and Remove tab (dialog, last-tab refusal), Hidden (n), sizes S/M/L, keyboard move and resize, drag; a once-only New on the board line; the last good board kept through refused reads; focus returned only on a kept change

## Checker verdicts

- claude-subagent: pass — 146 unit tests, live.e2e 5/5, focus probes (keyboard, in-flight, refused-then-kept, Done)

## Notes

Four refutations (fresh line not once-only; focus theft on refresh; Edit layout lost on a refused read; focus return after a refused move). ux-writing deviations recorded. Mouse-driven move ends focus on body (not required). Merged after 0022-14/18: Frame.tsx comment and imports resolved by hand.
