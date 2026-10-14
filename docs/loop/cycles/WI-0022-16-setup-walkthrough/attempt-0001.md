---
type: cycle-record
work_item: WI-0022-16-setup-walkthrough
attempt: 0001
decision: done
timestamp: 2026-10-14 11:08:59Z
---

# Attempt 0001 for WI-0022-16-setup-walkthrough

**Decision:** done

## Summary

Setup from Welcome to Ready: Welcome, Reports, Connect Anytype, Source folder, the starter's node forms (Step n of N), Ready with Try with a sample, Open Live, I'll build my own; the starter installed exactly once in every state and adopted if already made; Try with a sample waits for the folder source's declared first-scan status and a real run reaches Done; resumable; 0.2.1 migration kept

## Checker verdicts

- claude-subagent: pass — 253 tests, setup and frame e2e 9/9, concurrency and adoption probes

## Notes

Refuted once (starter reinstalled every second from a stored ready state; duplicate install after a timed-out create; shell read the folder package's seen.json). The folder status contract is now documented in packages/folder/README.md. Gate e2e failures were load timeouts outside the item.
