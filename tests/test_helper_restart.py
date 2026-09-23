"""The single restart policy, and the commands it sends the host.

Every test here drives a fake host that behaves the way the real one does in the one respect
that matters: it reports exits and never restarts anything on its own. The clock is injected,
so the five-attempt backoff sequence is asserted in full without a test waiting thirty-one
seconds for it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from innytypes.children import (
    ChildExit,
    ChildKind,
    ChildStartFailure,
    Command,
    CommandName,
    CommandResult,
)
from innytypes.helper.config import RestartSettings
from innytypes.helper.restart import RestartPolicy


class FakeClock:
    """A clock a test moves by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class FakeHost:
    """A host that carries out commands and NEVER restarts a child by itself.

    That second half is the point: if a test sees a child come back, the helper is what
    brought it back.
    """

    commands: list[Command] = field(default_factory=list)
    running: list[str] = field(default_factory=lambda: ["monty"])

    def send(self, command: Command) -> CommandResult:
        self.commands.append(command)
        match command.name:
            case CommandName.STOP | CommandName.KILL:
                if command.child_id in self.running:
                    self.running.remove(command.child_id)
            case CommandName.START | CommandName.RESTART:
                if command.child_id not in self.running:
                    self.running.append(command.child_id)
        return CommandResult(name=command.name)

    @property
    def names(self) -> list[CommandName]:
        return [command.name for command in self.commands]

    @property
    def restarted(self) -> list[str | None]:
        return [
            command.child_id for command in self.commands if command.name is CommandName.RESTART
        ]


def exit_of(child_id: str = "monty", *, code: int | None = 1, expected: bool = False) -> ChildExit:
    return ChildExit(
        id=child_id,
        kind=ChildKind.ADDON,
        pid=4242,
        exit_code=code,
        expected=expected,
    )


def failed_start_of(
    child_id: str = "monty", *, reason: str = "no interpreter"
) -> ChildStartFailure:
    return ChildStartFailure(id=child_id, kind=ChildKind.ADDON, reason=reason)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def host() -> FakeHost:
    return FakeHost()


def policy_with(
    host: FakeHost,
    clock: FakeClock,
    *,
    max_attempts: int = 3,
    backoff: tuple[float, ...] = (1.0, 2.0, 4.0),
) -> RestartPolicy:
    return RestartPolicy(
        channel=host,
        settings=RestartSettings(max_attempts=max_attempts, backoff=backoff),
        now=clock,
    )


def test_a_child_that_never_started_is_not_restarted_and_costs_no_attempt(
    host: FakeHost, clock: FakeClock
) -> None:
    """The policy's deliberate answer: nothing is scheduled, and nothing is spent.

    A restart undoes a death, and nothing died. The conditions that stop a start — an
    unreachable Anytype, a tool surface that no longer matches, a missing interpreter — do
    not change by waiting, so a backoff would re-run the same failing gate until the attempts
    ran out and then declare the child terminal on evidence the first failure already gave.

    Both halves matter. No command goes out, however far the clock is moved; and the attempt
    budget is untouched, so a child that *does* later crash still gets its full three tries
    rather than arriving at the policy already part-way to terminal.
    """
    policy = policy_with(host, clock)

    assert policy.child_failed_to_start(failed_start_of()) is None

    clock.advance(10_000.0)
    assert policy.tick() == ()
    assert host.commands == []
    assert policy.pending == ()

    state = policy.state("monty")
    assert state.attempts == 0
    assert state.terminal is False
    assert state.last_exit_code is None


def test_a_failed_start_and_a_crash_are_answered_differently(
    host: FakeHost, clock: FakeClock
) -> None:
    """The distinction the acceptance asks for, asserted as a difference rather than a claim.

    The same child, the same policy, the same clock: the exit is scheduled and issued, and
    the failed start is not. If the two ever collapsed into one answer, one of these two
    assertions would have to change.
    """
    policy = policy_with(host, clock)

    assert policy.child_failed_to_start(failed_start_of()) is None
    assert policy.child_exited(exit_of()) is not None

    clock.advance(1.0)
    policy.tick()

    assert host.restarted == ["monty"]
    assert policy.state("monty").attempts == 1


def test_a_child_that_failed_to_start_can_still_be_restarted_when_it_later_crashes(
    host: FakeHost, clock: FakeClock
) -> None:
    """A failed start is not a sentence on the child: nothing about it is remembered.

    Staged the way the machine actually behaves — Anytype is not running, the child fails to
    start, the user starts Anytype, the child runs, and later it crashes. The crash gets the
    ordinary first attempt at the ordinary first delay.
    """
    policy = policy_with(host, clock, max_attempts=1, backoff=(5.0,))

    for _ in range(4):
        policy.child_failed_to_start(failed_start_of(reason="Anytype's local API did not answer"))

    scheduled = policy.child_exited(exit_of())

    assert scheduled is not None
    assert scheduled.attempt == 1
    assert scheduled.due_at - clock.now == 5.0


def test_a_child_that_exits_is_restarted_after_its_backoff(
    host: FakeHost, clock: FakeClock
) -> None:
    policy = policy_with(host, clock)

    scheduled = policy.child_exited(exit_of())

    assert scheduled is not None
    assert scheduled.attempt == 1
    # Nothing happens until the delay has actually passed.
    assert policy.tick() == ()
    assert host.restarted == []

    clock.advance(1.0)
    policy.tick()

    assert host.restarted == ["monty"]


def test_the_delays_are_the_configured_sequence_and_strictly_increase(
    host: FakeHost, clock: FakeClock
) -> None:
    policy = policy_with(host, clock, max_attempts=5, backoff=(1.0, 2.0, 4.0, 8.0, 16.0))

    delays: list[float] = []
    for _ in range(5):
        scheduled = policy.child_exited(exit_of())
        assert scheduled is not None
        delays.append(scheduled.due_at - clock.now)
        clock.advance(delays[-1])
        policy.tick()

    assert delays == [1.0, 2.0, 4.0, 8.0, 16.0]
    assert all(later > earlier for earlier, later in zip(delays, delays[1:], strict=False))
    assert host.restarted == ["monty"] * 5


def test_the_delays_come_from_configuration_not_from_a_literal(
    host: FakeHost, clock: FakeClock
) -> None:
    policy = policy_with(host, clock, max_attempts=2, backoff=(0.25, 90.0))

    first = policy.child_exited(exit_of())
    assert first is not None
    assert first.due_at - clock.now == 0.25
    clock.advance(0.25)
    policy.tick()

    second = policy.child_exited(exit_of())
    assert second is not None
    assert second.due_at - clock.now == 90.0


def test_the_last_delay_repeats_when_the_attempts_outlast_the_list(
    host: FakeHost, clock: FakeClock
) -> None:
    policy = policy_with(host, clock, max_attempts=4, backoff=(1.0, 5.0))

    delays: list[float] = []
    for _ in range(4):
        scheduled = policy.child_exited(exit_of())
        assert scheduled is not None
        delays.append(scheduled.due_at - clock.now)
        clock.advance(delays[-1])
        policy.tick()

    assert delays == [1.0, 5.0, 5.0, 5.0]


def test_attempts_are_capped_and_the_last_exit_code_is_recorded(
    host: FakeHost, clock: FakeClock
) -> None:
    policy = policy_with(host, clock, max_attempts=3, backoff=(1.0, 1.0, 1.0))

    for _ in range(3):
        policy.child_exited(exit_of(code=17))
        clock.advance(1.0)
        policy.tick()

    assert host.restarted == ["monty"] * 3
    assert policy.state("monty").attempts == 3
    assert not policy.state("monty").terminal

    # The fourth exit is the one that exhausts the policy.
    assert policy.child_exited(exit_of(code=23)) is None

    state = policy.state("monty")
    assert state.terminal
    assert state.last_exit_code == 23


def test_a_terminal_child_is_never_restarted_again_however_often_it_dies(
    host: FakeHost, clock: FakeClock
) -> None:
    policy = policy_with(host, clock, max_attempts=1, backoff=(1.0,))

    policy.child_exited(exit_of(code=9))
    clock.advance(1.0)
    policy.tick()
    assert host.restarted == ["monty"]

    policy.child_exited(exit_of(code=9))
    assert policy.state("monty").terminal

    for _ in range(5):
        assert policy.child_exited(exit_of(code=9)) is None
        clock.advance(100.0)
        assert policy.tick() == ()

    assert host.restarted == ["monty"]
    assert policy.state("monty").last_exit_code == 9


def test_a_stop_the_host_was_asked_for_is_not_a_restart(host: FakeHost, clock: FakeClock) -> None:
    policy = policy_with(host, clock)

    assert policy.child_exited(exit_of(code=0, expected=True)) is None

    clock.advance(1000.0)

    assert policy.tick() == ()
    assert host.restarted == []
    assert policy.state("monty").attempts == 0


def test_the_helper_is_what_restarts_a_child_the_host_only_reported(
    host: FakeHost, clock: FakeClock
) -> None:
    """The host reports an exit and does nothing else; the follow-up command comes from here."""
    policy = policy_with(host, clock)

    host.running.remove("monty")
    policy.child_exited(exit_of())

    assert host.commands == []  # reporting an exit sends nothing by itself

    clock.advance(1.0)
    policy.tick()

    assert host.names == [CommandName.RESTART]
    assert host.running == ["monty"]


def test_a_stale_child_is_brought_back_by_the_same_policy(host: FakeHost, clock: FakeClock) -> None:
    policy = policy_with(host, clock)

    scheduled = policy.child_stale("monty")

    assert scheduled is not None
    assert scheduled.reason == "stale"
    clock.advance(1.0)
    policy.tick()
    assert host.restarted == ["monty"]


def test_a_child_stopped_for_a_breach_counts_like_any_other_attempt(
    host: FakeHost, clock: FakeClock
) -> None:
    policy = policy_with(host, clock, max_attempts=2, backoff=(1.0, 2.0))

    policy.child_stopped_for_breach("monty")
    clock.advance(1.0)
    policy.tick()
    policy.child_stopped_for_breach("monty")

    assert policy.state("monty").attempts == 2
    assert policy.child_stopped_for_breach("monty") is None
    assert policy.state("monty").terminal


def test_two_children_are_counted_apart(host: FakeHost, clock: FakeClock) -> None:
    policy = policy_with(host, clock, max_attempts=1, backoff=(1.0,))

    policy.child_exited(exit_of("monty"))
    policy.child_exited(exit_of("whodunnit"))
    clock.advance(1.0)
    policy.tick()

    assert sorted(host.restarted) == ["monty", "whodunnit"]
    assert policy.state("monty").attempts == 1
    assert policy.state("whodunnit").attempts == 1

    policy.child_exited(exit_of("monty"))
    assert policy.state("monty").terminal
    assert not policy.state("whodunnit").terminal


def test_a_restart_waits_only_its_own_delay(host: FakeHost, clock: FakeClock) -> None:
    policy = policy_with(host, clock, max_attempts=2, backoff=(1.0, 30.0))

    policy.child_exited(exit_of("monty"))
    clock.advance(1.0)
    policy.tick()
    policy.child_exited(exit_of("monty"))
    policy.child_exited(exit_of("whodunnit"))

    clock.advance(1.0)
    policy.tick()

    # whodunnit's first attempt is due; monty's second waits out its longer delay.
    assert host.restarted == ["monty", "whodunnit"]
    assert [scheduled.child_id for scheduled in policy.pending] == ["monty"]


@pytest.mark.parametrize(
    ("call", "expected"),
    [
        (lambda policy: policy.start("monty"), CommandName.START),
        (lambda policy: policy.stop("monty"), CommandName.STOP),
        (lambda policy: policy.restart("monty"), CommandName.RESTART),
        (lambda policy: policy.kill("monty"), CommandName.KILL),
        (lambda policy: policy.list_children(), CommandName.LIST),
    ],
)
def test_each_command_reaches_the_host_and_is_reported_back(
    host: FakeHost, clock: FakeClock, call, expected: CommandName
) -> None:
    policy = policy_with(host, clock)

    result = call(policy)

    assert host.names == [expected]
    assert result.name is expected


def test_a_group_restart_names_every_member(host: FakeHost, clock: FakeClock) -> None:
    policy = policy_with(host, clock)

    result = policy.restart_group(("monty", "whodunnit"))

    assert host.commands[0].group == ("monty", "whodunnit")
    assert result.name is CommandName.RESTART_GROUP


def test_the_policy_never_sleeps(host: FakeHost, clock: FakeClock, monkeypatch) -> None:
    """A helper that sleeps out a backoff is a helper watching nothing while it waits."""
    import innytypes.helper.restart as restart_module

    def forbidden(_seconds: float) -> None:  # pragma: no cover - the test fails if it runs
        raise AssertionError("the restart policy slept")

    monkeypatch.setattr(restart_module.time, "sleep", forbidden)

    policy = policy_with(host, clock)
    policy.child_exited(exit_of())
    clock.advance(1.0)
    policy.tick()

    assert host.restarted == ["monty"]
