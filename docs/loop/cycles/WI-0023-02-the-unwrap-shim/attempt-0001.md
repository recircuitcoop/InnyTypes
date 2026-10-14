---
type: cycle-record
work_item: WI-0023-02-the-unwrap-shim
attempt: 0001
decision: done
timestamp: 2026-10-14 05:02:12Z
---

# Attempt 0001 for WI-0023-02-the-unwrap-shim

**Decision:** done

## Summary

InnyTypes unwraps the body argument the pinned child mints for the five inventoried tools before forwarding; a wire test with the real child against a fake API shows the document arrives with no body key. The live Anytype answer is the owner's check (acceptance rewritten as for plan 0024).

## Checker verdicts

- claude-subagent: pass — mechanism confirmed in the shipped bundle; mutation fails 8/12; collision refusal prevents body.space_id overriding the call's space

## Notes

Merged with WI-0019-02 by hand in mcp-dispatch.ts (download answered first, then the unwrap). Main's gate after the merge: all stages green up to e2e; event-types.e2e quit-and-discard timed out under six parallel gates and passed alone. Open for the owner: header params (If-Match, Idempotency-Key) still land in the body; upstream patch.
