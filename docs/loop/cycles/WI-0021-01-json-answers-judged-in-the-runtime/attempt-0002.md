---
type: cycle-record
work_item: WI-0021-01-json-answers-judged-in-the-runtime
attempt: 0002
decision: done
timestamp: 2026-10-14 07:50:59Z
---

# Attempt 0002 for WI-0021-01-json-answers-judged-in-the-runtime

**Decision:** done

## Summary

View answers are JSON, judged once in the runtime for pop-out, in-app and snapshot presses: bounds (64 KiB, depth 8, 1000 keys, 16 KiB UTF-8 strings, forbidden keys, plain JSON only), the type's answer schema or the default flat shape; a dismissal forwards only its marker; sanitizeValues gone; spec 2.4, 2.6, 8.2.2, 8.5.7 updated

## Checker verdicts

- claude-subagent: pass — 101 targeted tests, probes on dismissal spellings, byte limits and every route to a node; no unrequested scope

## Notes

Gate GREEN on 1890b7e. Minor, open: the 16 KiB string limit does not apply to object keys; array items do not count toward the 1000-key limit (the 64 KiB total still holds).
