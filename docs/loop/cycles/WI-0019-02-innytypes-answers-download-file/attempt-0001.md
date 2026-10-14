---
type: cycle-record
work_item: WI-0019-02-innytypes-answers-download-file
attempt: 0001
decision: done
timestamp: 2026-10-14 04:47:03Z
---

# Attempt 0001 for WI-0019-02-innytypes-answers-download-file

**Decision:** done

## Summary

InnyTypes answers API-download-file from Anytype's REST API instead of the MCP child: bounded while streaming, ids validated, redirects refused, resources/read logged; the child never sees the call.

## Checker verdicts

- claude-subagent: pass — second check after a dot-segment traversal refutation; all probes refused with no request sent

## Notes

First check refuted on dot-segment ids reaching other /content paths with the key; fixed in 6b29579 with a strict id charset and redirect: manual.
