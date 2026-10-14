---
type: cycle-record
work_item: WI-0020-01-media-audio-in-the-contract
attempt: 0001
decision: recover
timestamp: 2026-10-14 06:37:47Z
---

# Attempt 0001 for WI-0020-01-media-audio-in-the-contract

**Decision:** recover

## Summary

Verifier refuted: package-origin audio files draw a Listen button but the inny-view scheme allow-list does not serve mp3/ogg/wav (404)

## Checker verdicts

- claude-subagent: fail — file-origin audio never served; data: URIs, image-wins, CSP, size limit all hold

## Notes

Fix sent: add audio types to CONTENT_TYPES with a scheme-handler test.
