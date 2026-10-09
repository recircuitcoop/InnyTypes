---
type: plan
title: Windows
status: APPROVED
created: 2026-10-09
updated: 2026-10-09
---

# 0025 — Windows

Status: APPROVED, work item BLOCKED. Split out of [plan 0018](0018-the-new-application.md) on
2026-10-09, where it was WI-0018-30; approved with 0018 on 2026-09-25. Nothing in it changed in
the move.

**Goal:** the new application builds, installs and passes every proof on Windows x64, so that the
old application can be deleted ([plan 0026](0026-delete-the-old-application.md)).

## Why it is its own plan

Plan 0017 requires every proof to pass on macOS, Linux **and** Windows before the cutover. macOS
and Linux are done (WI-0018-28, WI-0018-29). No Windows machine or VM exists, so this is the only
part of 0018 that could not be finished.

## What it covers

Windows is where the spike expected trouble: paths, SIGKILL emulation, Job Objects, `python.exe`.

- **30a:** NSIS x64 build; node processes in a Job Object so they die with the runtime (today
  `app/src/adapters/process/process-tree.ts` reports `BLOCKED(WI-0025-01)` and ends only the
  process); `python.exe` and `{python}` substitution; `realDir` separators; conformance C1 to C15.
- **30b:** every plan 0018 §5.4 proof on windows-x64 with evidence, plus code signing if the owner
  provides a certificate.
- Self-update on Windows (`app/src/shell/update.ts` returns null there today).

The design is plan 0018 §5.4 and its WI-0018-30 entry; this plan does not restate it.

## Work item

| # | id | title | size | depends on |
|---|----|-------|------|------------|
| 1 | WI-0025-01-windows | Windows build, conformance and proofs (BLOCKED: no Windows machine or VM) | L | WI-0018-27 (done) |

## Unblocking

A Windows x64 machine or VM the loop can build and run on. That is the owner's to provide.
