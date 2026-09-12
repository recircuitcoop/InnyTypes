#!/usr/bin/env bash
# Native stage gate for anytype-mcp (plan 0001). Runs in whatever tree it is invoked from.
#
# HERMETIC BY CONTRACT: this gate must pass from a clean clone with no manual steps. It
# does NOT require the Node MCP server to be installed, nor Anytype to be running — tests
# that would need either inject their dependency, or are marked needs_node / needs_anytype
# and skipped. It must never read a gitignored path (node_modules/ above all).
set -euo pipefail
cd "$(dirname "$0")/../.."

UV=${UV:-uv}

# --frozen: the committed uv.lock is the authority. A gate that silently re-resolves is a
# gate that cannot detect the drift this project exists to prevent (plan 0001, pinning).
echo "== uv sync --frozen =="
$UV sync --frozen

echo "== ruff =="
$UV run ruff check src tests

echo "== ruff format --check =="
$UV run ruff format --check src tests

echo "== mypy =="
$UV run mypy

echo "== pytest =="
$UV run pytest

echo "gate: GREEN"
