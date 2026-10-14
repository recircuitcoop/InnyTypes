---
type: cycle-record
work_item: WI-0020-03-sdks-and-conformance
attempt: 0001
decision: done
timestamp: 2026-10-14 08:22:30Z
---

# Attempt 0001 for WI-0020-03-sdks-and-conformance

**Decision:** done

## Summary

Both SDKs type the audio media item (ImageItem, AudioItem, MediaItem; media one item or a list); conformance C24 drives both SDKs to present image, labelled data: sample, package .ogg and a 600 KiB sample, all received intact; spec 12.2 names C24

## Checker verdicts

- claude-subagent: pass — C24 fails when an SDK drops or alters media; echo copy byte-identical; no unrequested scope

## Notes

Gate GREEN on 347bbec (a run before was killed by a maker's pkill; re-run clean).
