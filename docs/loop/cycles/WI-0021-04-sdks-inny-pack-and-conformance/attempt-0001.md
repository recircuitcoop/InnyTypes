---
type: cycle-record
work_item: WI-0021-04-sdks-inny-pack-and-conformance
attempt: 0001
decision: done
timestamp: 2026-10-14 14:56:57Z
---

# Attempt 0001 for WI-0021-04-sdks-inny-pack-and-conformance

**Decision:** done

## Summary

defineView (TS, @innytypes/node/view), Python present with a component and props, inny-pack compiles view schemas and refuses a missing widget script, C16-C19 and the sandbox probes in the widgetkit reorder pop-up; gate GREEN on a56bab7; fast-forwarded to main.

## Checker verdicts

- claude-subagent: pass — every criterion has an asserting test; no unrequested scope beyond the 4-line compileProblem accessor the plan needs

## Notes

Limit, not failing: the missing-script check keys on a declared props schema, so a type presenting a component without props is caught only at runtime (the page falls back).
