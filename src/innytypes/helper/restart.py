"""The one restart policy in the application, and the channel it speaks to the host through.

Every restart decision in innytypes is made here (plan 0003, D1). The host spawns the MCP
server and the plugins because it holds their pipes, but it never decides to start one again:
it reports an exit and waits to be told. So this module owns two things that belong together —
**when** a process should come back, and **how** that instruction reaches the host.

**Deciding is separate from spawning.** `RestartPolicy` is handed exits (from the host's
`ExitReporter`), stale verdicts and breach stops (from :mod:`innytypes.helper.detection`), and
turns them into commands on a :class:`ControlChannel`. Nothing here touches a process, a pipe
or a signal: the host is the only thing that spawns, and
:class:`~innytypes.helper.processes.ManagedProcesses` is the only thing that signals.

**Backoff is a schedule, not a sleep.** A restart that waits by sleeping would stop the
helper's tick, and a helper that is asleep is watching nothing. So a restart is *scheduled*:
the policy records when the attempt is due, and :meth:`RestartPolicy.tick` issues the ones
whose time has come. That is also what makes the delays testable — a test moves an injected
clock and asserts the exact sequence, rather than waiting sixteen real seconds for the fifth
attempt.

**An expected exit is not a crash.** The host marks the exits it asked for, and those never
count toward the policy — otherwise every deliberate stop, every group restart during a plugin
update and every quit would look like a failure and be undone.

**Attempts end somewhere.** After `helper.restart.max_attempts` the process enters a terminal
state that records the last exit code and stops being restarted, however many times it is
reported again. Terminal is a fact this module records, not a punishment it hands out: the
breaker and quarantine (slice 06) read it and decide what the user is told.

The delay list is a rate rather than an ending: when the attempts outlast
`helper.restart.backoff`, the last delay repeats, which is the rule
:class:`~innytypes.helper.config.RestartSettings` documents and this module applies.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from innytypes.children import ChildExit, Command, CommandName, CommandResult
from innytypes.helper.config import RestartSettings

__all__ = [
    "ControlChannel",
    "RestartPolicy",
    "RestartState",
    "ScheduledRestart",
]


class ControlChannel(Protocol):
    """How the helper asks the host to do something to one of its children.

    One method, because the host's own inbound half
    (:meth:`innytypes.children.ChildSupervisor.execute`) is already one method. In production
    the two ends sit in different processes with a socket between them; in a test the fake host
    *is* the channel. Neither the policy nor the host has to know which.
    """

    def send(self, command: Command) -> CommandResult:
        """Carry out one command and report what it produced."""
        ...


@dataclass(frozen=True)
class ScheduledRestart:
    """A restart the policy has decided on, waiting for its backoff to run out."""

    child_id: str
    attempt: int
    due_at: float
    reason: str


@dataclass(frozen=True)
class RestartState:
    """What the policy knows about one child.

    ``terminal`` means the attempts are exhausted; ``last_exit_code`` is the code the child
    last died with, which is the one thing a person needs to be told when it is given up on.
    """

    child_id: str
    attempts: int = 0
    terminal: bool = False
    last_exit_code: int | None = None


@dataclass
class RestartPolicy:
    """The single restart policy: it decides, the host spawns.

    ``settings`` carries the numbers (attempt count, delays) so neither lives as a literal
    here. ``now`` is the helper's monotonic clock, injected, so a test can move time without
    spending it.
    """

    channel: ControlChannel
    settings: RestartSettings = field(default_factory=RestartSettings)
    now: Callable[[], float] = time.monotonic

    _states: dict[str, RestartState] = field(default_factory=dict, init=False)
    _pending: list[ScheduledRestart] = field(default_factory=list, init=False)

    # ── what the helper reports into the policy ───────────────────────────────────────────

    def child_exited(self, exit_report: ChildExit) -> ScheduledRestart | None:
        """A child is gone. Schedule its return, unless the host asked for it or it is done.

        Returns the scheduled attempt, or None when nothing will be attempted — a deliberate
        stop, or a child whose attempts are already exhausted.
        """
        state = self.state(exit_report.id)

        if exit_report.expected:
            # The host stopped it because something asked the host to. Undoing that here is
            # how a quit turns into a restart loop.
            return None

        state = RestartState(
            child_id=state.child_id,
            attempts=state.attempts,
            terminal=state.terminal,
            last_exit_code=exit_report.exit_code,
        )
        self._states[state.child_id] = state

        if state.terminal:
            return None

        return self._schedule(state.child_id, reason=f"exited with code {exit_report.exit_code}")

    def child_stale(self, child_id: str) -> ScheduledRestart | None:
        """A child is alive but has stopped making progress (slice 04 judged it, not this).

        Stopping it is the detection module's identity-checked path; bringing it back is here,
        so there is still exactly one place that decides a process should run again.
        """
        if self.state(child_id).terminal:
            return None
        return self._schedule(child_id, reason="stale")

    def child_stopped_for_breach(self, child_id: str) -> ScheduledRestart | None:
        """A child was killed for staying over a limit, and may come back if it is restartable.

        The caller decides whether the profile allows it (``restartable``); the policy decides
        when, and counts the attempt like any other.
        """
        if self.state(child_id).terminal:
            return None
        return self._schedule(child_id, reason="stopped for a resource breach")

    # ── what the helper's tick drives ─────────────────────────────────────────────────────

    def tick(self) -> tuple[CommandResult, ...]:
        """Issue every restart whose backoff has run out. Called from the helper's own tick."""
        now = self.now()
        due = [pending for pending in self._pending if pending.due_at <= now]
        self._pending = [pending for pending in self._pending if pending.due_at > now]

        return tuple(self.restart(pending.child_id) for pending in due)

    @property
    def pending(self) -> tuple[ScheduledRestart, ...]:
        """The restarts waiting for their delay, soonest first."""
        return tuple(sorted(self._pending, key=lambda scheduled: scheduled.due_at))

    def state(self, child_id: str) -> RestartState:
        """What the policy knows about one child, including one it has never seen."""
        return self._states.get(child_id, RestartState(child_id=child_id))

    # ── the control channel ───────────────────────────────────────────────────────────────

    def start(self, child_id: str) -> CommandResult:
        """Ask the host to start a child."""
        return self.channel.send(Command(name=CommandName.START, child_id=child_id))

    def stop(self, child_id: str) -> CommandResult:
        """Ask the host to stop a child politely."""
        return self.channel.send(Command(name=CommandName.STOP, child_id=child_id))

    def restart(self, child_id: str) -> CommandResult:
        """Ask the host to restart a child."""
        return self.channel.send(Command(name=CommandName.RESTART, child_id=child_id))

    def kill(self, child_id: str) -> CommandResult:
        """Ask the host to kill a child that will not stop."""
        return self.channel.send(Command(name=CommandName.KILL, child_id=child_id))

    def restart_group(self, group: tuple[str, ...]) -> CommandResult:
        """Ask the host to stop every member of a group before starting any of them."""
        return self.channel.send(Command(name=CommandName.RESTART_GROUP, group=group))

    def list_children(self) -> CommandResult:
        """Ask the host what it is currently running."""
        return self.channel.send(Command(name=CommandName.LIST))

    # ── the policy itself ─────────────────────────────────────────────────────────────────

    def _schedule(self, child_id: str, *, reason: str) -> ScheduledRestart | None:
        """Count one attempt and put it in the queue, or end the attempts for good."""
        state = self.state(child_id)
        attempt = state.attempts + 1

        if attempt > self.settings.max_attempts:
            # Exhausted: record it once, and stop deciding about this child. What the user is
            # told, and how a quarantine is lifted, is the breaker's business (slice 06).
            self._states[child_id] = RestartState(
                child_id=child_id,
                attempts=state.attempts,
                terminal=True,
                last_exit_code=state.last_exit_code,
            )
            return None

        self._states[child_id] = RestartState(
            child_id=child_id,
            attempts=attempt,
            terminal=False,
            last_exit_code=state.last_exit_code,
        )

        scheduled = ScheduledRestart(
            child_id=child_id,
            attempt=attempt,
            due_at=self.now() + self._delay_for(attempt),
            reason=reason,
        )
        self._pending.append(scheduled)
        return scheduled

    def _delay_for(self, attempt: int) -> float:
        """The delay before ``attempt``, with the last entry repeating past the list's end.

        A short `backoff` list is a rate to settle at, not a silent end to the policy — the
        attempt count is the only thing that ends it.
        """
        delays = self.settings.backoff
        if not delays:
            return 0.0
        return delays[min(attempt, len(delays)) - 1]
