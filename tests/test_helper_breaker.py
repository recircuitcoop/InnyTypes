"""The breaker: when the helper gives up, what it still does afterwards, and how to undo it.

The clock is injected everywhere here — a ten-minute window is something these tests move
through, never wait out.
"""

from __future__ import annotations

import json

import pytest
from click.testing import CliRunner

from innytypes.cli import cli
from innytypes.helper.breaker import HOST_ID, Breaker, QuarantineFile, RunState
from innytypes.helper.config import BreakerSettings


class FakeClock:
    def __init__(self) -> None:
        self.now = 500.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


def breaker_with(clock: FakeClock, *, max_interventions: int = 5, window: float = 600.0) -> Breaker:
    return Breaker(
        settings=BreakerSettings(max_interventions=max_interventions, window=window),
        now=clock,
    )


def test_n_interventions_inside_the_window_quarantine_the_process(clock: FakeClock) -> None:
    breaker = breaker_with(clock)

    allowed = [breaker.record("monty", reason="exited with code 1") for _ in range(5)]

    # The first four leave the helper free to act; the fifth is the one that stops it.
    assert allowed == [True, True, True, True, False]
    assert breaker.is_quarantined("monty")
    assert not breaker.may_restart("monty")


def test_a_further_event_after_quarantine_produces_no_restart(clock: FakeClock) -> None:
    breaker = breaker_with(clock)
    for _ in range(5):
        breaker.record("monty", reason="stale")

    clock.advance(1.0)

    assert breaker.record("monty", reason="exited with code 9") is False
    assert breaker.may_restart("monty") is False


def test_interventions_spread_wider_than_the_window_never_quarantine(clock: FakeClock) -> None:
    breaker = breaker_with(clock, max_interventions=5, window=600.0)

    for _ in range(20):
        assert breaker.record("monty", reason="exited with code 1") is True
        # Each failure is a window apart, so no two are ever counted together.
        clock.advance(601.0)

    assert not breaker.is_quarantined("monty")
    # Every earlier failure has slid out of the window; none of them is counted any more.
    assert breaker.interventions_for("monty") == ()


def test_the_window_drops_old_interventions_as_it_slides(clock: FakeClock) -> None:
    breaker = breaker_with(clock, max_interventions=3, window=100.0)

    breaker.record("monty", reason="one")
    clock.advance(60.0)
    breaker.record("monty", reason="two")
    clock.advance(60.0)  # the first is now outside the window

    assert len(breaker.interventions_for("monty")) == 1
    assert breaker.record("monty", reason="three") is True
    assert not breaker.is_quarantined("monty")


def test_two_processes_are_counted_apart(clock: FakeClock) -> None:
    breaker = breaker_with(clock, max_interventions=2)

    breaker.record("monty", reason="exited")
    breaker.record("monty", reason="exited")
    breaker.record("whodunnit", reason="exited")

    assert breaker.is_quarantined("monty")
    assert not breaker.is_quarantined("whodunnit")
    assert breaker.may_restart("whodunnit")


def test_a_quarantined_host_stops_being_relaunched_and_nothing_else(clock: FakeClock) -> None:
    """The helper keeps running and keeps reporting; it only stops relaunching the host."""
    breaker = breaker_with(clock, max_interventions=2)

    breaker.record(HOST_ID, reason="exited with code 1")
    breaker.record(HOST_ID, reason="exited with code 1")

    assert breaker.is_quarantined(HOST_ID)
    assert breaker.may_restart(HOST_ID) is False

    # Still watching: the host appears in status, and every other process is untouched.
    statuses = {status.child_id: status for status in breaker.status(running=["monty"])}
    assert statuses[HOST_ID].state is RunState.QUARANTINED
    assert statuses["monty"].state is RunState.RUNNING
    assert breaker.may_restart("monty")


def test_a_quarantined_plugin_leaves_the_host_alone(clock: FakeClock) -> None:
    breaker = breaker_with(clock, max_interventions=1)

    breaker.record("monty", reason="stale")

    assert breaker.is_quarantined("monty")
    assert breaker.may_restart(HOST_ID)
    assert breaker.may_restart("innytypes.anytype_mcp")


def test_a_quarantined_mcp_server_leaves_the_host_alone(clock: FakeClock) -> None:
    breaker = breaker_with(clock, max_interventions=1)

    breaker.record("innytypes.anytype_mcp", reason="exited with code 1")

    assert breaker.is_quarantined("innytypes.anytype_mcp")
    assert breaker.may_restart(HOST_ID)


def test_release_clears_the_quarantine_and_lets_a_restart_happen_again(clock: FakeClock) -> None:
    breaker = breaker_with(clock, max_interventions=2)
    breaker.record("monty", reason="exited")
    breaker.record("monty", reason="exited")

    assert breaker.is_quarantined("monty")

    assert breaker.release("monty") is True

    assert not breaker.is_quarantined("monty")
    assert breaker.may_restart("monty")
    # The next qualifying event is acted on rather than refused.
    assert breaker.record("monty", reason="exited") is True


def test_release_forgets_the_counted_history_too(clock: FakeClock) -> None:
    """Otherwise the next hiccup re-quarantines instantly, which is not what release means."""
    breaker = breaker_with(clock, max_interventions=3)
    for _ in range(3):
        breaker.record("monty", reason="exited")

    breaker.release("monty")

    assert breaker.interventions_for("monty") == ()
    assert breaker.record("monty", reason="exited") is True
    assert not breaker.is_quarantined("monty")


def test_releasing_something_that_was_not_quarantined_says_so(clock: FakeClock) -> None:
    breaker = breaker_with(clock)

    assert breaker.release("monty") is False


def test_status_reports_every_process_including_a_quarantined_one(clock: FakeClock) -> None:
    breaker = breaker_with(clock, max_interventions=1)
    breaker.record("whodunnit", reason="exited with code 3")

    statuses = {
        status.child_id: status
        for status in breaker.status(
            running=["monty", "innytypes.anytype_mcp"],
            restarting=["innytypes.anytype_mcp"],
            exit_codes={"whodunnit": 3},
        )
    }

    assert statuses["monty"].state is RunState.RUNNING
    assert statuses["innytypes.anytype_mcp"].state is RunState.RESTARTING
    assert statuses["whodunnit"].state is RunState.QUARANTINED
    assert statuses["whodunnit"].quarantined
    assert statuses["whodunnit"].last_reason == "exited with code 3"
    assert statuses["whodunnit"].last_exit_code == 3


def test_status_counts_only_the_interventions_still_inside_the_window(clock: FakeClock) -> None:
    breaker = breaker_with(clock, max_interventions=5, window=100.0)
    breaker.record("monty", reason="exited")
    clock.advance(101.0)

    (status,) = breaker.status(running=["monty"])

    assert status.interventions == 0
    assert status.state is RunState.RUNNING


def test_helper_status_prints_every_process_and_its_state(tmp_path) -> None:
    quarantine = tmp_path / "quarantine.json"
    QuarantineFile(path=quarantine).save({"whodunnit": "exited with code 3"})
    run_state = tmp_path / "run-state.json"
    run_state.write_text(
        json.dumps(
            {
                "version": 1,
                "records": [
                    {
                        "id": "monty",
                        "kind": "addon",
                        "pid": 4242,
                        "started_at": 1000.0,
                        "executable": "/usr/bin/python3",
                        "parent_pid": 4000,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    result = CliRunner().invoke(
        cli,
        ["helper", "status", "--run-state", str(run_state), "--quarantine", str(quarantine)],
    )

    assert result.exit_code == 0, result.output
    assert "monty: running" in result.output
    assert "whodunnit: quarantined" in result.output
    assert "exited with code 3" in result.output


def test_helper_status_says_so_when_there_is_nothing_to_report(tmp_path) -> None:
    result = CliRunner().invoke(
        cli,
        [
            "helper",
            "status",
            "--run-state",
            str(tmp_path / "absent.json"),
            "--quarantine",
            str(tmp_path / "absent-quarantine.json"),
        ],
    )

    assert result.exit_code == 0, result.output
    assert "Nothing is running" in result.output


def test_helper_release_clears_the_quarantine_file(tmp_path) -> None:
    quarantine = tmp_path / "quarantine.json"
    QuarantineFile(path=quarantine).save({"monty": "stale"})

    result = CliRunner().invoke(
        cli, ["helper", "release", "monty", "--quarantine", str(quarantine)]
    )

    assert result.exit_code == 0, result.output
    assert QuarantineFile(path=quarantine).load() == {}


def test_helper_release_reports_when_there_was_nothing_to_release(tmp_path) -> None:
    result = CliRunner().invoke(
        cli,
        ["helper", "release", "monty", "--quarantine", str(tmp_path / "quarantine.json")],
    )

    assert result.exit_code == 0, result.output
    assert "not quarantined" in result.output
