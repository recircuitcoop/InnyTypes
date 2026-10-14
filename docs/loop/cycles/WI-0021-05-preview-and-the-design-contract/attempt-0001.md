---
type: cycle-record
work_item: WI-0021-05-preview-and-the-design-contract
attempt: 0001
decision: done
timestamp: 2026-10-14 15:32:59Z
---

# Attempt 0001 for WI-0021-05-preview-and-the-design-contract

**Decision:** done

## Summary

Develop > Preview a view… (unpackaged or INNY_DEV=1, per plan 0021 §9) opens the widgetkit reorder in the real sandbox with sample props from the props schema's examples and logs the answer it would send; design-system.md rows per plan 0021 §10; Penpot question-popout gains Form=Widget; gate GREEN on 3d41e02.

## Checker verdicts

- claude-subagent: pass — all three criteria evidenced; spec §2.4 element-name convention flagged for the owner, not failing

## Notes

Owner to see: spec §2.4 now says the widget element is <package>-<type id> and sample props are the props schema's first example. Minor: the preview does not check the answer against the answer schema; the Penpot Widget variant shows Continue enabled though a widget's Continue starts disabled.
