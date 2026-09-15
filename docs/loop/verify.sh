#!/usr/bin/env bash
# Native stage gate for innytypes (plan 0001).
#
# HERMETIC BY CONSTRUCTION. Everything this gate needs is committed, so a clean clone
# passes with no manual step — no pre-created venv, no optional extra to remember, no
# fixture that only exists in somebody's main checkout.
#
#   * `uv sync --frozen` builds the environment from the committed uv.lock and FAILS if
#     the lock and pyproject.toml disagree. A drifting transitive dependency is a red
#     gate here rather than a surprise in production (plan 0001, pinning rule 5).
#   * Every later command runs with `--no-sync`, so nothing can quietly re-resolve what
#     --frozen just pinned. A bare `uv run` is what let a sibling project build a venv
#     missing an extra and fail for reasons unrelated to any change.
#
# Exits non-zero on any failure; prints `gate: GREEN` only when everything passed.
set -euo pipefail
cd "$(dirname "$0")/../.."

UV=${UV:-uv}

echo "== uv sync --frozen =="
$UV sync --frozen

echo "== ruff =="
$UV run --no-sync ruff check src tests

echo "== ruff format --check =="
$UV run --no-sync ruff format --check src tests

echo "== mypy =="
$UV run --no-sync mypy

echo "== pytest =="
$UV run --no-sync pytest

# Subtraction report (plan 0019) — every other check in this gate tests for
# PRESENCE, so nothing here can ever ask whether code should still exist.
# Advisory by default: it prints findings and does not fail the gate. Opt into
# enforcement with --fail-on allow-lists (or all) once the existing findings
# have been read and disagreed with.
#
# Honest about its own reach, in both directions. A file this tool cannot parse
# is reported as a finding rather than raised, because raising made the
# 'advisory' default kill a passing gate under `set -euo pipefail`. And where
# loopify is not installed -- CI, another machine -- the guard below is simply
# false and this block does nothing at all: the report is a local convenience,
# never a gate your build depends on.
#
# NOT a bare `python`: a hermetic gate runs its tools inside the project's own
# frozen environment, where loop_engine is absent by design — so `python -c
# 'import loop_engine'` is false in exactly the repos that need this most, and
# the call would sit here looking installed while never once running. A check
# that reports a pass because it never ran is the failure this module exists to
# name, so the interpreter is named explicitly and is overridable.
LOOP_ENGINE_PY=${LOOP_ENGINE_PY:-$HOME/git/loopify/.venv/bin/python}
if [ -x "$LOOP_ENGINE_PY" ] && "$LOOP_ENGINE_PY" -c 'import loop_engine' >/dev/null 2>&1; then
  "$LOOP_ENGINE_PY" -m loop_engine.subtract --dir . --fail-on none
fi

echo "gate: GREEN"
