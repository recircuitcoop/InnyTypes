---
type: plan
title: Delete the old application
status: APPROVED
created: 2026-10-09
updated: 2026-10-09
---

# 0026 — Delete the old application

Status: APPROVED, work item BLOCKED. Split out of [plan 0018](0018-the-new-application.md) on
2026-10-09, where it was WI-0018-32; approved with 0018 on 2026-09-25 and confirmed in plan 0022
D13 (*"still deletes it. Owner: yes."*). Nothing in it changed in the move.

**Goal:** the old Python application is deleted in one change, and the new application is the
only one: sudden, massive and correct.

## When

Only once every parity-ledger row and every proof is green on macOS, Linux and Windows. macOS,
Linux, the ledger and the farewell release are done (WI-0018-27, 28, 29, 31). Windows is
[plan 0025](0025-windows.md), so this plan waits on it.

## What it does

On branch `cutover/0017`, merged once:

- delete `src/innytypes`, `src/helper` and `tests/`;
- delete the Python host parts of `pyproject.toml`, `uv.lock` and the Briefcase config;
- delete the Python stages of `docs/loop/verify.sh`;
- keep `docs/parity/ledger.csv` and `old-tests.txt` as the record;
- `tools/parity/check.ts --final` passes with every proof passing on every target;
- README, CHANGELOG and `docs/anytype-mcp-connection.md` describe only the new app;
- version 1.0.0 is published to GitHub Releases, signed and minisigned.

The design is plan 0018 ("The cutover is one change") and its WI-0018-32 entry.

## Work item

| # | id | title | size | depends on |
|---|----|-------|------|------------|
| 1 | WI-0026-01-cutover | Delete the old application in one change (BLOCKED by WI-0025-01) | M | WI-0018-27, 28, 29, 31 (done); WI-0025-01 |
