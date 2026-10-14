---
type: cycle-record
work_item: WI-0021-03-fallback-tokens-and-pop-up-only
attempt: 0001
decision: done
timestamp: 2026-10-14 10:51:10Z
---

# Attempt 0001 for WI-0021-03-fallback-tokens-and-pop-up-only

**Decision:** done

## Summary

A widget that fails to load (3 s, missing or CSP-breaking component.js, throws while drawn) falls back to its form or a sentence and Skip; tokens.css and view-kit.css served by the shell under the byte-identical CSP; widget views are pop-up only, the Inbox shows Waiting for you + Answer

## Checker verdicts

- claude-subagent: pass — 54 unit tests, widget views and sandboxed pop-out e2e; editor-sync quit failures reproduced on the base commit under load, not this branch

## Notes

Open, non-blocking: while a widget loads (up to 3 s) Submit sends {} with no fields; a snapshot whose widget fails falls back silently. Gate e2e quit timeouts are load (they fail on the base too).
