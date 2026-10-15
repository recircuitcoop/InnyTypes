---
type: cycle-record
work_item: WI-0022-28-the-endpoint-host-in-general
attempt: 0001
decision: done
timestamp: 2026-10-15 08:15:28Z
gate_mode: quick
---

# Attempt 0001 for WI-0022-28-the-endpoint-host-in-general

**Decision:** done

## Summary

Configuration › General › AI apps offers the host beside the port with one Change; the runtime's checkedAddress refuses a non-loopback host before anything moves, worded by the screen; the stored address wins at the next start. Quick gate GREEN on 73428e5; general.e2e.ts 5/5.

## Checker verdicts

- claude-subagent: pass — every clause asserted; loopback-only proven against 0.0.0.0, ::, LAN and hostnames

## Notes

For WI-0022-22: port the 2 host rows to the new tests; ux-writing.md:259 still says 'Change port' and has no host or refusal line, so general.changePort stays unused in strings.ts; the new strings are marked // decided though that mark means WI-0022-10 decided them.
