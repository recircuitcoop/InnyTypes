---
type: cycle-record
work_item: WI-0022-24-release-0-3-0
attempt: 0001
decision: done
timestamp: 2026-10-15 18:34:34Z
gate_mode: detailed
---

# Attempt 0001 for WI-0022-24-release-0-3-0

**Decision:** done

## Summary

0.3.0: version, CHANGELOG and INSTALL.md; e2e cleanup race fixed (wait for every process the app started); Anytype tool surface re-recorded (API-publish-chat-status); window layout fixed (the page could scroll and draw in a strip); Set up ChatGPT (WI-0022-30). Detailed gate GREEN on 64b127f (2431 unit, 80 conformance, 105 e2e, parity holds); 4a77d35 adds testids and wording only. Both DMGs built ad-hoc signed as 0.2.1; the packaged arm64 build was installed over a 0.2.1 profile with a flow in a scratch home: it recorded itself as 0.3.0, offered no Go back and no crash-loop offer, the flow survived. The owner runs the final build on their own Mac.

## Checker verdicts

- claude-subagent: pass (round 3) — docs true, DMGs verified, surface and layout fixes proven

## Notes

Open for the next release: updateRepo and updatePublicKey in app/package.json are placeholders, so 0.3.0 cannot find its next release and Go back can't be proven until they are set. General › AI apps shows empty Address and Port while the endpoint is not served. packaged-smoke.e2e cannot attach Playwright to a packaged build, and its scratch() does not set INNYTYPES_ANYTYPE_APP=none.
