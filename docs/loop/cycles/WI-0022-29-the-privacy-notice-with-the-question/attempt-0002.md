---
type: cycle-record
work_item: WI-0022-29-the-privacy-notice-with-the-question
attempt: 0002
decision: done
timestamp: 2026-10-15 08:40:49Z
gate_mode: quick
---

# Attempt 0002 for WI-0022-29-the-privacy-notice-with-the-question

**Decision:** done

## Summary

Setup's Reports step and General › Reports (while unanswered) show the full privacy notice, every line a strings.ts key, every factual sentence checked true against the telemetry code or the owner's facts: Umami Cloud as processor, the IP address and derived location disclosed, signed packages named and unsigned counted, 6 months retention (Hobby plan), Re:Circuit Cooperative at privacy@recircu.it. The old unused notice text is removed. Quick gate GREEN on 8a96c50.

## Checker verdicts

- claude-subagent: pass (round 2) — claim-by-claim table all true; unit test asserts the notice against the code's own values

## Notes

For WI-0022-24: docs/INSTALL.md:49 still quotes the 0.2.x 'Send anonymous usage and crash reports' question. Known stale: the gallery design sample says 'Sending anonymous crash reports.'
