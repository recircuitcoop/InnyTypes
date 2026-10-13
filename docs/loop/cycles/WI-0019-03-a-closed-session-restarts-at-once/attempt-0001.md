---
type: cycle-record
work_item: WI-0019-03-a-closed-session-restarts-at-once
attempt: 0001
decision: done
timestamp: 2026-10-13 21:49:24Z
---

# Attempt 0001 for WI-0019-03-a-closed-session-restarts-at-once

**Decision:** done

## Summary

A session that closes over a protocol fault while the child lives restarts the child at once (backoff and breaker kept). Attempt 1 refuted: a fault in the handshake's last chunk left the service ready on a dead session for ~120 s; fixed by late-subscriber notification and a pre-ready check. Merged main (WI-0015-01) in-branch.

## Checker verdicts

- claude-subagent: pass — second verifier CONFIRMED every window incl. handshake chunk; first verifier REFUTED the handshake race
