---
type: cycle-record
work_item: WI-0023-01-inventory-of-wrapped-body-tools
attempt: 0001
decision: done
timestamp: 2026-10-14 04:17:26Z
---

# Attempt 0001 for WI-0023-01-inventory-of-wrapped-body-tools

**Decision:** done

## Summary

Inventory of the five pinned tools whose body the child mints (create-object, create-type, update-type, create-template, validate) recorded in plan 0023, with MINTED_BODY_TOOLS and a surface-pinned test for WI-0023-02.

## Checker verdicts

- claude-subagent: pass — all 51 tools checked per tool; hashes match tool_surface.json; parser rule confirmed

## Notes

Minor follow-ups: minted-body.test.ts:23 comment overstates parity with the parser; re-recording tool_surface.json now also requires retaking the inventory, documented only in minted-body.ts and plan 0023.
