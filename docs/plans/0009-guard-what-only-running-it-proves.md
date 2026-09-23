---
type: plan
title: Guard what only running the application proves
status: DONE
created: 2026-09-23
updated: 2026-09-23
---

# 0009 — Guard what only running the application proves

## Outcome

The questions a person actually asks of this application — does the MCP server start, does the
helper bring it back when it dies — are answered by named tests rather than by someone running
it and watching. The defects found while answering them by hand are fixed.

## Why this plan exists

On 2026-09-23 the owner asked those questions. Answering took a walkthrough, twenty commands
and one confidently wrong answer, because **the suite cannot see any of it**:

- anything needing a real Anytype is out of reach — the gate is hermetic by design, and that is
  right, but it means nothing detects that the committed tool surface has drifted;
- anything needing the real assembled helper-and-host pair is out of reach — `launcher.main` is
  `# pragma: no cover`, and every test helper builds the assembly itself;
- anything living in a plugin repository is out of reach from here.

Each gap has already shipped a defect: a control channel with no production caller, two
listeners racing for one socket, an application built with no restart policy. The pattern is
settled enough to plan against rather than rediscover.

## What is already true, and is not this plan's work

The MCP child **does** start, and the helper **does** bring it back — killed by hand it returned
in about sixty seconds and the endpoint recovered to 200 with 51 tools. Nothing here needs
building. What is missing is a guard, so the next regression is caught by the suite rather than
by a walkthrough.

## The defects

- **A lost update on `run-state.json`.** Immediately after startup the file held the host, the
  helper and the Anytype app but not the MCP child, while that child was running and serving;
  after a later restart the record was there. Both processes read-modify-write the same JSON.
  `os.replace` keeps the file from tearing; it does not keep one writer from dropping the
  other's record. The record is what lets the helper verify a child's identity before signalling
  it, so a lost one is a child the helper cannot safely stop.
- **A killed child leaves its grandchild behind.** The host tracks `npm exec`; the `node` process
  beneath it survived, was reparented to launchd, ignored a polite stop and needed to be killed.
  Plan 0001 says shutdown leaves no orphan behind.
- **A child that fails to start is invisible to the restart policy.** `ChildSupervisor.start`
  raises before writing a record, so nothing enters the running set, no exit is reported, and the
  helper is never told. A child that dies later is restartable; one that never started is not,
  and the only account of why is a line on the host's stdout.
- **A bundled host's output goes nowhere.** `cli.py` has no logger and `up` prints degradations
  to its own stdout. In a packaged application that is no destination at all, which is why a
  stale tool surface cost a walkthrough to diagnose instead of one sentence in the window.

## Acceptance

- A test drives the assembled helper and host, kills the MCP child, and asserts the policy brings
  it back and the endpoint serves again. It fails if the MCP child is excluded from the restart
  path, and it does not build the assembly itself.
- A test asserts a child that fails to start is reported to the helper rather than disappearing,
  and names what the helper is told.
- Two processes writing `run-state.json` at once leave both records present; a test writes from
  two processes and asserts neither is lost.
- Stopping the MCP child leaves no descendant behind; a test asserts the whole process group is
  gone.
- The host's degradations reach the helper over the control channel, and are visible in the
  window and in `innytypes helper status`, naming the component and the reason.
- No test in this plan spends a real second, opens a fixed user port, or needs Node or Anytype.
- `docs/loop/verify.sh` exits zero and prints `gate: GREEN`.

## Delivered

All five slices landed 2026-09-23. Slice 01 needed no production change: the behaviour was
already right and only unguarded. The rest repaired what the walkthrough exposed, and slice 05
closed the shape underneath all of it — five defects this year were `main` wiring something a
test wired differently, invisible because `main` is unreachable to the suite. Its wiring now
lives in `build_control_channel`, which a test calls, and every wire deleted turns a named test
red.

One thing worth keeping from slice 05's evidence: deleting a keyword is caught at construction,
which proves the signature and nothing about the assertions. The mis-wires that construct
cleanly — the exit reporter handed the start-failure closure, the degradation reporter handed a
no-op — are what prove the tests themselves bite.

## Slices

| # | slice | what lands |
|---|---|---|
| 01 | the child comes back, proved | the assembled crash-and-restart test, driving the real startup rather than a constructed one |
| 02 | a start that fails is still news | the failed start reported to the helper, and what it is told |
| 03 | one file, two writers | the run-state lost update, and the orphaned grandchild |
| 04 | the host says what is wrong | degradations over the control channel, into the window and `helper status` |

**Order:** 01 → 02 → 03 → 04. Slice 04 is the one that would have turned this walkthrough into
one sentence.

## Non-goals

- running a real Anytype, Node or Codex inside `docs/loop/verify.sh`;
- moving restart policy out of InnyTypesHelper;
- giving core children manifests or stability profiles — that is plan 0010;
- changing the tool-surface validation or its upgrade procedure.

## Rollback and compatibility

Every slice is additive. The run-state repair changes how the file is written, not its format, so
a helper and host of different versions still read each other's records. A degradation that
cannot reach the helper falls back to today's behaviour rather than failing the host.
