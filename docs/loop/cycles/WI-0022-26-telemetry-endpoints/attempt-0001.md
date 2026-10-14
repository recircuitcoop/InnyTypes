---
type: cycle-record
work_item: WI-0022-26-telemetry-endpoints
attempt: 0001
decision: done
timestamp: 2026-10-14 16:00:01Z
---

# Attempt 0001 for WI-0022-26-telemetry-endpoints

**Decision:** done

## Summary

Umami Cloud endpoint and website id baked into app/package.json's innytypes block and read by wireTelemetry; consent gates every post (main process, CSP unchanged); GlitchTip DSN empty and Reports says crash reports aren't sent yet; unit test: zero posts before consent, one /api/send event after. Gate GREEN on 6bd0f18.

## Checker verdicts

- claude-subagent: pass — each clause checked separately; no unrequested scope

## Notes

Owner live check: Umami Cloud's bot filter may drop events with the existing User-Agent innytypes/<version>; confirm events are counted on the live dashboard.
