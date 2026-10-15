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
# Gate mode (loopify plan 0023). The loop engine runs this gate with:
#   LOOP_GATE_MODE     quick | detailed. Unset or empty means detailed: a gate run by
#                      hand or by CI is the full gate. Any other value is detailed too.
#   LOOP_GATE_CHANGED  path of a file listing the changed repo-relative paths, one per line.
#   LOOP_GATE_BASE     the ref that list was diffed against; vitest's --changed uses it.
# It prints exactly one `gate-mode:` line so the engine reports which run really happened.
# Quick runs the checks the changed paths map to (below); detailed runs every stage. The
# engine escalates to detailed on its own when the change touches this script, a lockfile,
# a dependency manifest, or the manifest's `gate.detailed_when` globs (docs/loop/loop.yaml).
#
# Portable to macOS bash 3.2: no mapfile, no associative arrays, and arrays are expanded
# with the ${a[@]+"${a[@]}"} idiom (a bare "${a[@]}" of an empty array is an
# unbound-variable error under `set -u` there).
#
# Exits non-zero on any failure; prints `gate: GREEN` only when everything passed.
set -euo pipefail
cd "$(dirname "$0")/../.."

UV=${UV:-uv}
NPM=${NPM:-npm}

mode=detailed
if [ "${LOOP_GATE_MODE:-}" = "quick" ]; then
  if [ -n "${LOOP_GATE_CHANGED:-}" ] && [ -f "${LOOP_GATE_CHANGED}" ]; then
    mode=quick
  else
    # Quick without a readable change list cannot know what changed. Run in full and
    # say so, rather than guess at a subset.
    echo "quick requested but LOOP_GATE_CHANGED is not a readable file: running in full"
  fi
fi
echo "gate-mode: $mode"

if [ "$mode" = "quick" ]; then
  # == quick == Only what the changed paths map to. Quick is never vacuous: every quick
  # run type-checks the whole app (tsc -b over the app, both SDKs and every package) and
  # lint-checks the old Python app, so a change that breaks a type or an import anywhere
  # fails even when it maps to no test. What quick does NOT run — the full vitest suite
  # with its coverage thresholds, e2e specs the change did not touch, parity — the
  # detailed run before integration does.
  #
  #   src/innytypes, tests, pyproject.toml  -> the old Python app's stages, in full (a
  #                                            changed module may be imported by any test)
  #   sdk/python                            -> the SDK's own stages, in full
  #   app, sdk/ts, packages, tools          -> tsc, eslint + prettier on the changed files,
  #                                            architecture, vitest --changed (the tests that
  #                                            import a changed file), conformance when the
  #                                            protocol surface changed, and the changed e2e
  #                                            specs (after a build) plus the finder rule
  #   anything prettier formats             -> prettier --check on those files
  py=0; sdkpy=0; app=0; conformance=0; e2e_changed=0
  lint_files=()
  prettier_files=()
  e2e_specs=()
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    case "$path" in
      src/innytypes/*|tests/*|pyproject.toml) py=1 ;;
      sdk/python/*) sdkpy=1 ;;
    esac
    case "$path" in
      app/*|sdk/ts/*|packages/*|tools/*) app=1 ;;
    esac
    case "$path" in
      app/src/domain/*|sdk/*|packages/*|app/test/conformance/*|docs/specs/*) conformance=1 ;;
    esac
    case "$path" in
      app/test/e2e/*) e2e_changed=1 ;;
    esac
    case "$path" in
      app/test/e2e/*.e2e.ts) e2e_specs+=("${path#app/}") ;;
    esac
    case "$path" in
      *.ts|*.tsx|*.mjs|*.cjs|*.js) [ -f "$path" ] && lint_files+=("$path") ;;
    esac
    case "$path" in
      *.ts|*.tsx|*.mjs|*.cjs|*.js|*.json|*.md|*.yaml|*.yml|*.css|*.html)
        [ -f "$path" ] && prettier_files+=("$path") ;;
    esac
  done < "$LOOP_GATE_CHANGED"

  echo "== quick: ruff (old Python app) =="
  $UV run --no-sync ruff check src tests

  if [ "$py" = 1 ]; then
    echo "== quick: ruff format --check =="
    $UV run --no-sync ruff format --check src tests
    echo "== quick: mypy =="
    $UV run --no-sync mypy
    echo "== quick: pytest =="
    $UV run --no-sync pytest
  fi

  echo "== quick: app types (tsc -b) =="
  $NPM run --silent gate:types

  if [ "${#lint_files[@]}" -gt 0 ]; then
    echo "== quick: eslint on the changed files =="
    npx eslint ${lint_files[@]+"${lint_files[@]}"}
  fi
  if [ "${#prettier_files[@]}" -gt 0 ]; then
    echo "== quick: prettier --check on the changed files =="
    npx prettier --check ${prettier_files[@]+"${prettier_files[@]}"}
  fi

  if [ "$app" = 1 ]; then
    echo "== quick: app architecture (depcruise, 600 lines, process.env) =="
    $NPM run --silent gate:architecture
    echo "== quick: vitest --changed ${LOOP_GATE_BASE:-main} (unit + integration) =="
    # --passWithNoTests: a changed file no test imports is not a failure here; the detailed
    # run's whole suite and coverage thresholds are what judge untested code.
    (cd app && npx vitest run --project unit --project integration --passWithNoTests --changed "${LOOP_GATE_BASE:-main}")
    if [ "$conformance" = 1 ]; then
      echo "== quick: app conformance (vitest --project conformance, spec 12.2) =="
      $NPM run --silent gate:conformance
    fi
    if [ "$e2e_changed" = 1 ]; then
      echo "== quick: the e2e finder rule (test/unit/e2e-finders.test.ts) =="
      (cd app && npx vitest run test/unit/e2e-finders.test.ts)
    fi
    if [ "${#e2e_specs[@]}" -gt 0 ]; then
      echo "== quick: the changed e2e specs (playwright _electron, dev build) =="
      (cd app && $NPM run --silent build && npx playwright test ${e2e_specs[@]+"${e2e_specs[@]}"})
    fi
  fi

  if [ "$sdkpy" = 1 ]; then
    (
      cd sdk/python
      echo "== quick: sdk/python ruff, format, mypy --strict, pytest =="
      $UV run --no-sync ruff check src tests
      $UV run --no-sync ruff format --check src tests
      $UV run --no-sync mypy
      $UV run --no-sync pytest --cov --cov-fail-under=90
    )
  fi

  echo "gate: GREEN"
  exit 0
fi

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

echo "== app: conformance (vitest --project conformance, spec 12.2) =="
$NPM run --silent gate:conformance

echo "== app: e2e (playwright _electron, dev build) =="
$NPM run --silent gate:e2e

# == sdk/python == The Python node SDK (innytypes-node, WI-0018-26): its own project, its own
# committed uv.lock, checked the same hermetic way as the root project above. A subshell (not
# --project, which points uv at another project's pyproject.toml without changing the actual
# working directory) so `ruff`/`mypy`'s relative paths, and sdk/python's own pyproject.toml
# config, resolve the way they do when run from sdk/python directly -- and the repo root's cwd
# is untouched once the subshell exits. The JUnit report is what lets the parity ledger below
# name a pytest-sdk: id (tools/parity/check.ts's own convention for it).
(
  cd sdk/python
  echo "== sdk/python: uv sync --frozen =="
  $UV sync --frozen

  echo "== sdk/python: ruff =="
  $UV run --no-sync ruff check src tests

  echo "== sdk/python: ruff format --check =="
  $UV run --no-sync ruff format --check src tests

  echo "== sdk/python: mypy --strict =="
  $UV run --no-sync mypy

  echo "== sdk/python: pytest --cov --cov-fail-under=90 =="
  $UV run --no-sync pytest --cov --cov-fail-under=90 --junitxml=../../.gate/pytest-sdk.xml
)

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
