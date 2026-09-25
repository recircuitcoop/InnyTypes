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

# == app == The new application (plan 0018 §6), after the Python stages and in the
# plan's order. Same rule as above: `npm ci` installs exactly the committed
# package-lock.json and fails if it and the manifests disagree, and nothing after it
# installs anything. Each stage is an `npm run gate:*` script in the root package.json.
NPM=${NPM:-npm}

echo "== app: install (npm ci) =="
$NPM ci --no-audit --no-fund

echo "== app: types (tsc -b) =="
$NPM run --silent gate:types

echo "== app: lint (eslint, prettier --check) =="
$NPM run --silent gate:lint

echo "== app: architecture (depcruise, 600 lines, process.env) =="
$NPM run --silent gate:architecture

echo "== app: licences (OSI only, production dependencies) =="
$NPM run --silent gate:licences

echo "== app: unit + integration (vitest, coverage thresholds) =="
$NPM run --silent gate:unit

# TODO(WI-0018-05): conformance stage, `vitest run --project conformance` (spec C1-C15).
# Not run yet: there is no codec to test. Do not replace this line with an echo.

echo "== app: e2e (playwright _electron, dev build) =="
$NPM run --silent gate:e2e

# == parity == (plan 0018 §5). Until the cutover the old suite must be exactly the one
# docs/parity/old-tests.txt lists, so an old test added, renamed or removed stops here until
# the ledger is re-seeded. Then the ledger is checked against the vitest report gate:unit
# wrote above, in this run: a ported id that did not pass in it is refused.
echo "== parity: old suite against old-tests.txt (seed_ledger.py --check-old) =="
$UV run --no-sync python tools/parity/seed_ledger.py --check-old

echo "== parity: seeder tests =="
$UV run --no-sync pytest tools/parity -p no:cacheprovider --no-cov -o addopts=""

echo "== parity: ledger (tools/parity/check.ts, normal mode) =="
$NPM run --silent gate:parity

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
