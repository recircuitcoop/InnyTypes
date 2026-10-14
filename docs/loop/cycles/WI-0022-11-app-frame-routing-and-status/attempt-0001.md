---
type: cycle-record
work_item: WI-0022-11-app-frame-routing-and-status
attempt: 0001
decision: done
timestamp: 2026-10-14 06:51:45Z
---

# Attempt 0001 for WI-0022-11-app-frame-routing-and-status

**Decision:** done

## Summary

App frame, routing and status: 0.2.1 users with flows land on Live (flows read from disk), quit dialog independent of Setup, escape test restored, crash-loop limit from the supervisor, strings key, band removal recorded for WI-21

## Checker verdicts

- claude-subagent: pass — 209 unit/integration and frame/supervision/editor-sync/event-types/generated-types e2e pass alone; gate failures were load

## Notes

Gate: one e2e per run timed out under 6 parallel gates (generated-types form, event-types delete count); both pass alone. Open: IBM Plex fonts do not load in the app window (page server serves top level only; CSP has no font-src) — for WI-0022-23.
