"""The seeder and --check-old, against a throwaway repository of their own.

Not under ``tests/``: everything there is an old-app test and a row of the ledger, and these
would change the very count they check. The gate runs them from its parity stage.
"""

from __future__ import annotations

import csv
import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import seed_ledger  # noqa: E402

OLD_FILE = '''
import pytest


def test_documented():
    """A documented test says what it shows.

    The rest of the docstring is not the behaviour.
    """


def test_a_summary_that_wraps():
    """A summary long enough to wrap
    onto a second line is joined back into one sentence.
    """


def test_undocumented_things_turn_into_words():
    pass


@pytest.mark.parametrize("case", ["one", "two"])
def test_each_case(case):
    """Every case shares the function's behaviour."""


class TestGrouped:
    def test_in_a_class(self):
        """A method's docstring is found through its class."""
'''


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_logging.py").write_text(OLD_FILE, encoding="utf-8")
    (tmp_path / "tests" / "test_nobody_maps.py").write_text(
        "def test_orphan():\n    pass\n", encoding="utf-8"
    )
    # The repository's own addopts turn coverage on; the seeder must override them.
    (tmp_path / "pytest.ini").write_text(
        "[pytest]\ntestpaths = tests\naddopts = -q --cov=nothing --cov-report=term-missing\n",
        encoding="utf-8",
    )
    return tmp_path


def rows(parity: Path) -> list[dict[str, str]]:
    lines = [line for line in (parity / "ledger.csv").read_text(encoding="utf-8").splitlines(True)]
    return list(csv.DictReader(line for line in lines if not line.startswith("#")))


def test_collect_returns_the_exact_node_ids_with_parameters(repo: Path) -> None:
    assert seed_ledger.collect(repo) == [
        "tests/test_logging.py::TestGrouped::test_in_a_class",
        "tests/test_logging.py::test_a_summary_that_wraps",
        "tests/test_logging.py::test_documented",
        "tests/test_logging.py::test_each_case[one]",
        "tests/test_logging.py::test_each_case[two]",
        "tests/test_logging.py::test_undocumented_things_turn_into_words",
        "tests/test_nobody_maps.py::test_orphan",
    ]


def test_a_collection_error_is_a_failure_not_a_shorter_list(repo: Path) -> None:
    (repo / "tests" / "test_broken.py").write_text("import nothing_by_this_name\n")

    with pytest.raises(SystemExit, match="pytest collection failed"):
        seed_ledger.collect(repo)


def test_seeding_writes_old_tests_and_an_undecided_row_per_id(repo: Path) -> None:
    parity = repo / "docs" / "parity"
    ids = seed_ledger.collect(repo)

    result = seed_ledger.seed(ids, repo=repo, parity=parity)

    text = (parity / "old-tests.txt").read_text(encoding="utf-8")
    assert text.splitlines() == ids
    header = (parity / "ledger.csv").read_text(encoding="utf-8").splitlines()[0]
    assert header == f"# old-tests.txt sha256: {hashlib.sha256(text.encode()).hexdigest()}"

    seeded = {row["old_id"]: row for row in rows(parity)}
    assert list(seeded) == ids
    assert {row["fate"] for row in seeded.values()} == {"undecided"}
    assert seeded["tests/test_logging.py::test_documented"] == {
        "old_id": "tests/test_logging.py::test_documented",
        "old_file": "tests/test_logging.py",
        "behaviour": "A documented test says what it shows.",
        "fate": "undecided",
        "new_ids": "",
        "reason_code": "",
        "reason": "",
        "owner_ack": "",
        "wi": "WI-0018-04",
    }
    assert seeded["tests/test_logging.py::test_a_summary_that_wraps"]["behaviour"] == (
        "A summary long enough to wrap onto a second line is joined back into one sentence."
    )
    assert seeded["tests/test_logging.py::test_undocumented_things_turn_into_words"][
        "behaviour"
    ] == ("Undocumented things turn into words.")
    assert seeded["tests/test_logging.py::test_each_case[two]"]["behaviour"] == (
        "Every case shares the function's behaviour."
    )
    assert seeded["tests/test_logging.py::TestGrouped::test_in_a_class"]["behaviour"] == (
        "A method's docstring is found through its class."
    )
    assert seeded["tests/test_nobody_maps.py::test_orphan"]["wi"] == ""
    assert result.unmapped_files == ["tests/test_nobody_maps.py"]


def test_re_seeding_keeps_every_decision_adds_new_ids_and_drops_vanished_ones(
    repo: Path,
) -> None:
    parity = repo / "docs" / "parity"
    seed_ledger.seed(seed_ledger.collect(repo), repo=repo, parity=parity)
    ledger = parity / "ledger.csv"
    decided = ledger.read_text(encoding="utf-8").replace(
        "tests/test_logging.py::test_documented,tests/test_logging.py,"
        "A documented test says what it shows.,undecided,,,,,",
        "tests/test_logging.py::test_documented,tests/test_logging.py,"
        "Edited by the person deciding.,retired,,python-internal,Why.,,",
    )
    ledger.write_text(decided, encoding="utf-8")
    (repo / "tests" / "test_nobody_maps.py").write_text("def test_renamed():\n    pass\n")

    result = seed_ledger.seed(seed_ledger.collect(repo), repo=repo, parity=parity)

    seeded = {row["old_id"]: row for row in rows(parity)}
    assert seeded["tests/test_logging.py::test_documented"]["behaviour"] == (
        "Edited by the person deciding."
    )
    assert seeded["tests/test_logging.py::test_documented"]["fate"] == "retired"
    assert result.added == ["tests/test_nobody_maps.py::test_renamed"]
    assert [row.old_id for row in result.dropped] == ["tests/test_nobody_maps.py::test_orphan"]
    assert "tests/test_nobody_maps.py::test_orphan" not in seeded


def test_check_old_names_an_added_a_removed_and_a_renamed_test() -> None:
    listed = [
        "tests/test_x.py::test_kept",
        "tests/test_x.py::test_old_name",
        "tests/test_x.py::test_gone",
    ]
    collected = [
        "tests/test_x.py::test_kept",
        "tests/test_x.py::test_new_name",
        "tests/test_x.py::test_added",
    ]

    assert seed_ledger.check_old(collected, listed) == [
        "collected, not in old-tests.txt: tests/test_x.py::test_added",
        "collected, not in old-tests.txt: tests/test_x.py::test_new_name",
        "in old-tests.txt, no longer collected: tests/test_x.py::test_gone",
        "in old-tests.txt, no longer collected: tests/test_x.py::test_old_name",
    ]
    assert seed_ledger.check_old(listed, listed) == []


@pytest.mark.parametrize(
    ("function", "wi"),
    [
        ("test_a_second_launch_brings_the_window_forward_and_starts_nothing", "WI-0018-03"),
        ("test_an_unreadable_lock_is_taken_over_rather_than_obeyed", "WI-0018-03"),
        ("test_force_quit_never_signals_a_stale_record", "WI-0018-03"),
        ("test_launch_at_login_is_off_by_default", "WI-0018-21"),
        ("test_anytype_is_adopted_when_it_is_already_running", "WI-0018-21"),
    ],
)
def test_helper_launcher_is_split_between_wi_03_and_wi_21(function: str, wi: str) -> None:
    assert seed_ledger.work_item("tests/test_helper_launcher.py", function) == wi


def test_every_file_the_map_names_gets_its_work_item() -> None:
    assert seed_ledger.work_item("tests/test_anytype_mcp_gateway.py", "test_x") == "WI-0018-19"
    assert seed_ledger.work_item("tests/test_package.py", "test_x") == "WI-0018-01"
    assert seed_ledger.work_item("tests/test_helper_config.py", "test_x") == "WI-0018-25"
