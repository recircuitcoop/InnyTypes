"""Seed the parity ledger from the old test suite, and hold the suite to it (plan 0018 §5.2).

Two jobs, one source of truth: the ids pytest collects from ``tests/``.

* ``seed_ledger.py`` writes ``docs/parity/old-tests.txt`` (every old node id, one per line,
  sorted) and ``docs/parity/ledger.csv`` (one row per id, sorted by ``old_id``, with the
  sha256 of ``old-tests.txt`` in its header comment). A row the ledger already holds is kept
  exactly as it is, so re-seeding never undoes a decision; a new id gets an ``undecided`` row;
  a row whose id is no longer collected is dropped and named on stderr.
* ``seed_ledger.py --check-old`` writes nothing. It collects again and fails when the ids
  differ from ``old-tests.txt`` in either direction, which is how an old test that was added,
  renamed or removed without the ledger following is stopped at the gate. Re-seeding is the
  way to make the ledger follow.

``behaviour`` is the test's docstring summary (the lines up to the first blank line, joined),
or, when it has no docstring, its name turned into words. ``wi`` comes from the file map of
§5.2; a file the map does not name gets an empty ``wi`` and is listed on stderr.

Collection runs ``pytest --collect-only -q --no-cov -o addopts=""`` with this interpreter,
which is the one ``uv run --no-sync`` chose: the repository's ``addopts`` turns coverage on,
and the ids must come out plain.
"""

# A command-line tool: what it finds is printed, like the CLI's own output.
# ruff: noqa: T201

from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import io
import re
import subprocess
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PARITY = REPO / "docs" / "parity"
OLD_TESTS = PARITY / "old-tests.txt"
LEDGER = PARITY / "ledger.csv"

# The columns of §5.1, in order. check.ts refuses a ledger whose header differs.
COLUMNS = (
    "old_id",
    "old_file",
    "behaviour",
    "fate",
    "new_ids",
    "reason_code",
    "reason",
    "owner_ack",
    "wi",
)

# The header comment that carries the sha256 of old-tests.txt. check.ts reads the same line.
SHA_COMMENT = "# old-tests.txt sha256: "

# §5.2: the work item that decides each old test file, keyed by the file's stem without
# ``test_``. helper_launcher is split between two items and is handled by LAUNCHER_SPLIT.
WI_BY_FILE: Mapping[str, str] = {
    **dict.fromkeys(("package", "contract_layer", "home_guard"), "01"),
    **dict.fromkeys(
        (
            "control_channel",
            "helper_restart",
            "helper_breaker",
            "helper_tick",
            "helper_detection",
            "helper_heartbeat",
            "helper_process_identity",
        ),
        "03",
    ),
    "logging": "04",
    **dict.fromkeys(
        ("host_children", "addon_runner", "event_bus", "event_emitter", "event_transport"), "05"
    ),
    **dict.fromkeys(("no_secrets", "plugin_secrets"), "06"),
    **dict.fromkeys(("addon_discovery", "addon_resolution"), "08"),
    **dict.fromkeys(
        (
            "addon_manifest",
            "addon_settings",
            "addon_settings_runtime",
            "settings_form",
            "settings_store",
            "table_declaration",
            "table_form",
            "table_store",
        ),
        "09",
    ),
    **dict.fromkeys(
        (
            "application_window",
            "toolkit_desktop",
            "window_wiring",
            "tab_model",
            "application_tab",
            "plugin_tab",
            "table_drawing",
            "plugin_page",
            "plugin_lists",
        ),
        "11",
    ),
    "plugin_catalogue": "14",
    "plugin_environments": "15",
    **dict.fromkeys(("addons_cli", "addons_remove", "enable_switch"), "16"),
    **dict.fromkeys(("plugin_version_check", "plugin_update_apply"), "17"),
    **dict.fromkeys(
        (
            "anytype_client",
            "anytype_mcp_config",
            "anytype_mcp_health",
            "anytype_mcp_keys",
            "anytype_mcp_session",
            "anytype_mcp_supervisor",
            "anytype_mcp_tool_surface",
            "pinning",
            "mcp_child_identity",
            "mcp_host_integration",
        ),
        "18",
    ),
    **dict.fromkeys(("anytype_mcp_gateway", "independent_client_connection"), "19"),
    **dict.fromkeys(("macos", "linux_support", "helper_notification", "helper_windows"), "21"),
    "helper_telemetry": "22",
    "bundle": "23",
    **dict.fromkeys(("helper_core_update", "helper_update_check"), "24"),
    "helper_config": "25",
}

# §5.2 gives helper_launcher's lock, quit and closing tests to WI-03 and the rest to WI-21.
# The seeder can only read the test's name, so it goes by the words in it; the person deciding
# a row may move it.
LAUNCHER_FILE = "helper_launcher"
LAUNCHER_SPLIT = re.compile(r"lock|quit|second_launch|clos")


@dataclass(frozen=True)
class Row:
    """One ledger row, every field a string as it is written to the CSV."""

    old_id: str
    old_file: str
    behaviour: str
    fate: str
    new_ids: str
    reason_code: str
    reason: str
    owner_ack: str
    wi: str

    def as_list(self) -> list[str]:
        return [getattr(self, column) for column in COLUMNS]


# --- collection ------------------------------------------------------------------------------


def collect(repo: Path = REPO) -> list[str]:
    """Every node id pytest collects from the repository's ``testpaths``, sorted.

    The ids are the lines before the first blank line of ``-q`` collect output; anything
    after it is the summary and, if there are any, the warnings. A collection error is a
    failure here, never a shorter list.
    """
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "--no-cov", "-o", "addopts="],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(
            f"pytest collection failed (exit {result.returncode}):\n{result.stdout}{result.stderr}"
        )
    ids: list[str] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            break
        ids.append(line)
    return sorted(ids)


def sha256_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def old_tests_text(ids: Iterable[str]) -> str:
    return "".join(f"{node_id}\n" for node_id in ids)


def read_old_tests(path: Path = OLD_TESTS) -> list[str]:
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line]


# --- behaviour and work item -----------------------------------------------------------------


def summary(docstring: str) -> str:
    """The docstring's first paragraph on one line: the summary, even when it wraps."""
    paragraph: list[str] = []
    for line in docstring.strip().splitlines():
        if not line.strip():
            break
        paragraph.append(line.strip())
    return " ".join(paragraph)


def name_to_words(function: str) -> str:
    """``test_a_quit_stops_things`` becomes ``A quit stops things.``"""
    words = function.removeprefix("test_").replace("_", " ").strip()
    return f"{words[:1].upper()}{words[1:]}." if words else function


def docstrings(source: str) -> dict[str, str]:
    """Docstring summaries of a module's test functions, keyed as in a node id (``Cls::fn``)."""
    found: dict[str, str] = {}

    def visit(body: Sequence[ast.stmt], prefix: str) -> None:
        for node in body:
            if isinstance(node, ast.ClassDef):
                visit(node.body, f"{prefix}{node.name}::")
            elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                docstring = ast.get_docstring(node)
                if docstring:
                    found[f"{prefix}{node.name}"] = summary(docstring)

    visit(ast.parse(source).body, "")
    return found


def split_id(node_id: str) -> tuple[str, str]:
    """``tests/test_x.py::Cls::test_y[p]`` becomes ``("tests/test_x.py", "Cls::test_y")``."""
    old_file, _, rest = node_id.partition("::")
    return old_file, rest.split("[", 1)[0]


def work_item(old_file: str, function: str) -> str:
    """The §5.2 work item for a test, as ``WI-0018-NN``, or empty when the map names none."""
    stem = Path(old_file).stem.removeprefix("test_")
    if stem == LAUNCHER_FILE:
        number = "03" if LAUNCHER_SPLIT.search(function.rsplit("::", 1)[-1]) else "21"
    else:
        number = WI_BY_FILE.get(stem, "")
    return f"WI-0018-{number}" if number else ""


def seed_row(node_id: str, behaviours: Mapping[str, str]) -> Row:
    old_file, function = split_id(node_id)
    behaviour = behaviours.get(function) or name_to_words(function.rsplit("::", 1)[-1])
    return Row(
        old_id=node_id,
        old_file=old_file,
        behaviour=behaviour,
        fate="undecided",
        new_ids="",
        reason_code="",
        reason="",
        owner_ack="",
        wi=work_item(old_file, function),
    )


# --- the ledger file -------------------------------------------------------------------------


def read_ledger(path: Path = LEDGER) -> dict[str, Row]:
    """The ledger's rows by ``old_id``; comment lines above the header are skipped."""
    lines = [
        line
        for line in path.read_text(encoding="utf-8").splitlines(keepends=True)
        if not line.startswith("#")
    ]
    reader = csv.reader(io.StringIO("".join(lines)))
    header = next(reader)
    if tuple(header) != COLUMNS:
        raise SystemExit(f"{path}: header is {header}, expected {list(COLUMNS)}")
    return {fields[0]: Row(*fields) for fields in reader if fields}


def ledger_text(rows: Iterable[Row], old_tests_sha256: str) -> str:
    out = io.StringIO()
    out.write(f"{SHA_COMMENT}{old_tests_sha256}\n")
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(COLUMNS)
    for row in sorted(rows, key=lambda row: row.old_id):
        writer.writerow(row.as_list())
    return out.getvalue()


@dataclass(frozen=True)
class SeedResult:
    added: list[str]
    dropped: list[Row]
    unmapped_files: list[str]


def seed(ids: Sequence[str], repo: Path = REPO, parity: Path = PARITY) -> SeedResult:
    """Write old-tests.txt and ledger.csv for ``ids``, keeping every row the ledger holds."""
    ledger_path = parity / "ledger.csv"
    existing = read_ledger(ledger_path) if ledger_path.exists() else {}

    behaviours_by_file: dict[str, dict[str, str]] = {}
    rows: list[Row] = []
    added: list[str] = []
    for node_id in ids:
        if node_id in existing:
            rows.append(existing[node_id])
            continue
        old_file = split_id(node_id)[0]
        if old_file not in behaviours_by_file:
            behaviours_by_file[old_file] = docstrings((repo / old_file).read_text(encoding="utf-8"))
        rows.append(seed_row(node_id, behaviours_by_file[old_file]))
        added.append(node_id)

    kept = set(ids)
    dropped = [row for old_id, row in existing.items() if old_id not in kept]
    unmapped = sorted({row.old_file for row in rows if not row.wi})

    text = old_tests_text(ids)
    parity.mkdir(parents=True, exist_ok=True)
    (parity / "old-tests.txt").write_text(text, encoding="utf-8")
    ledger_path.write_text(ledger_text(rows, sha256_of(text)), encoding="utf-8")
    return SeedResult(added=added, dropped=dropped, unmapped_files=unmapped)


def check_old(collected: Sequence[str], listed: Sequence[str]) -> list[str]:
    """What stops the gate: ids collected but not listed, and ids listed but not collected."""
    collected_set, listed_set = set(collected), set(listed)
    problems = [
        f"collected, not in old-tests.txt: {node_id}"
        for node_id in sorted(collected_set - listed_set)
    ]
    problems += [
        f"in old-tests.txt, no longer collected: {node_id}"
        for node_id in sorted(listed_set - collected_set)
    ]
    return problems


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument(
        "--check-old",
        action="store_true",
        help="write nothing; fail if the collected ids differ from old-tests.txt",
    )
    args = parser.parse_args(argv)

    collected = collect()

    if args.check_old:
        problems = check_old(collected, read_old_tests())
        for problem in problems:
            print(problem, file=sys.stderr)
        if problems:
            print(
                f"parity: the old suite and old-tests.txt disagree on {len(problems)} id(s); "
                "re-run tools/parity/seed_ledger.py and decide the new rows",
                file=sys.stderr,
            )
            return 1
        print(f"parity: old suite matches old-tests.txt ({len(collected)} ids)")
        return 0

    result = seed(collected)
    for row in result.dropped:
        print(f"dropped (no longer collected, fate was {row.fate}): {row.old_id}", file=sys.stderr)
    for old_file in result.unmapped_files:
        print(f"no work item in the §5.2 map: {old_file}", file=sys.stderr)
    print(
        f"parity: {len(collected)} ids, {len(result.added)} new rows, {len(result.dropped)} dropped"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
