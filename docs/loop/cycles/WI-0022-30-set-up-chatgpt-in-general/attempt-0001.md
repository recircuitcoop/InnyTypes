---
type: cycle-record
work_item: WI-0022-30-set-up-chatgpt-in-general
attempt: 0001
decision: done
timestamp: 2026-10-15 18:34:33Z
gate_mode: detailed
---

# Attempt 0001 for WI-0022-30-set-up-chatgpt-in-general

**Decision:** done

## Summary

Configuration › General › AI apps has Set up ChatGPT: ChatGPT's own Settings › MCP servers › Add server steps, Copy address (the served URL) and Copy token (read by the main process at the press, never shown, logged or kept). INSTALL.md 7.4 gives the same in-app steps; the terminal/launchctl route is gone. Owner: 'it should be a process inside the chatgpt application'.

## Checker verdicts

- claude-subagent: pass (round 3) — every element has a testid, the e2e asserts each step and both copies, the token never appears in page, output or log

## Notes

Follow-up for after 0.3.0: the app window allows window.open for non-Anytype links and child windows may inherit the preload; a window opened from the Node-RED editor might reach mcpToken (nothing new: local code can read the token file).
