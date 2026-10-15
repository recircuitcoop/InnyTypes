---
type: cycle-record
work_item: WI-0022-23-accessibility-and-dark-mode
attempt: 0002
decision: done
timestamp: 2026-10-15 08:54:20Z
gate_mode: quick
---

# Attempt 0002 for WI-0022-23-accessibility-and-dark-mode

**Decision:** done

## Summary

axe on every route and all ten dialogs in light and dark, failing on serious or critical; every icon-only control named by a strings.ts line; keyboard paths through Setup, Flows menus and the Delete dialog; reduced motion stops transitions and animations; dark mode matches the tokens with 4.5:1 text contrast; the app window loads IBM Plex (fonts served on inny-app:// only, font-src 'self' on APP_CSP only, VIEW_CSP byte-identical to §8.5.5). Detailed gate GREEN on 348b9dd (round 1); round 2 test-only, quick gate GREEN on 1e3c5e8.

## Checker verdicts

- claude-subagent: pass (round 2) — six missing dialogs and the search Clear button now audited; fixture move is a pure move

## Notes

Moderate finding left: page-has-heading-one on Live and Configuration. Pop-outs keep the system font until spec §8.5.5 gains font-src. The full detailed gate runs on main before the release (WI-0022-24).
