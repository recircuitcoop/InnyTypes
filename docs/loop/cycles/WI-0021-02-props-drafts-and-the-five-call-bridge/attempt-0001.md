---
type: cycle-record
work_item: WI-0021-02-props-drafts-and-the-five-call-bridge
attempt: 0001
decision: done
timestamp: 2026-10-14 09:24:52Z
---

# Attempt 0001 for WI-0021-02-props-drafts-and-the-five-call-bridge

**Decision:** done

## Summary

Component props declared (action views only), judged once at present by bounds and the declared schema, journaled and returned after restart; drafts kept within bounds, cleared on submit or dismiss, never sent to the node; the five-call bridge (get, submit, action, draft, setValid); Continue · Later · Skip this step only where a component is drawn, Continue drawn from the last validity; spec 2.4, 2.6, 4.5, 8.1, 8.2.1, 8.5.6, 10.2

## Checker verdicts

- claude-subagent: pass — 129 unit tests, Chromium probes on setValid timing, toggles and non-booleans; no unrequested scope

## Notes

Gate GREEN on 1f37e37 after two refutations (dead Continue in the Inbox; setValid lost during draw). For WI-0021-03: a component whose connectedCallback throws leaves Continue disabled.
