---
type: cycle-record
work_item: WI-0022-23-accessibility-and-dark-mode
attempt: 0001
decision: recover
timestamp: 2026-10-15 08:35:23Z
gate_mode: detailed
---

# Attempt 0001 for WI-0022-23-accessibility-and-dark-mode

**Decision:** recover

## Summary

Round 1 on 348b9dd: detailed gate GREEN (100/100 e2e, parity holds); fonts, CSP, dark mode, keyboard and reduced motion confirmed. Refuted on 'axe on every route and dialog': six app dialogs (flow rename, board remove tab, question Skip, packages unsigned, package Go back, update Go back) and Run history's search Clear button are never opened.

## Checker verdicts

- claude-subagent: fail — 6 of 10 dialogs unaudited

## Notes

font-src on APP_CSP only is now recorded in plan 0022 beside WI-0022-23.
