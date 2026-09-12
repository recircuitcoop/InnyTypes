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

echo "gate: GREEN"
