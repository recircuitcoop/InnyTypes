---
type: cycle-record
work_item: WI-0022-25-folder-source-package
attempt: 0003
decision: done
timestamp: 2026-10-14 08:02:09Z
---

# Attempt 0003 for WI-0022-25-folder-source-package

**Decision:** done

## Summary

The folder source package: one setting (folder), a fixed 2 s quiet period, one created event per new file with its text when it fits a frame, recorded only after a successful emit, a persisted record across restarts, honest limits (a)-(g) in D18; the starter template uses it

## Checker verdicts

- claude-subagent: pass — 67 tests, real-process probes at the frame boundary, 42 files per scan, repeated emit failures, restart; no unrequested scope

## Notes

Gate GREEN on af4a420 after four refutations. Open (g): TS SDK async stdout loses emitted-but-unflushed events on SIGKILL; needs an SDK flush.
