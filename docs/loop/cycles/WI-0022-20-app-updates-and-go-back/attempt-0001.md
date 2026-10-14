---
type: cycle-record
work_item: WI-0022-20-app-updates-and-go-back
attempt: 0001
decision: done
timestamp: 2026-10-14 11:39:54Z
---

# Attempt 0001 for WI-0022-20-app-updates-and-go-back

**Decision:** done

## Summary

InnyTypes' own updates in General: state pushed, Check now, Quit and update, Go back within 7 days verified exactly like an update, the crash-loop offer never automatic; electron-updater bound to the minisign-verified version, files, sha512 and size before any download; feed and downgrade restored after any Go back; trust variables ignored in a packaged build; 0.3.0 records only itself

## Checker verdicts

- claude-subagent: pass — 212 tests, updates e2e 4/4, 14 hostile manifests refused, electron-updater 6.8.9 source checked; isPackaged not spoofable, fuses on

## Notes

Security fixes by security-executor after a refutation. Owner decisions: 0.3.0 first self-aware version; packaged-app trust proven by packaged-smoke (todo rows for WI-0022-24). Open, minor: the inactive-updater path shows ready without a download (dev/e2e only); a stale comment says .deb is never updated by the installer class.
