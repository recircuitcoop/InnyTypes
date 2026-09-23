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

**And a child that never started is not a crash either.** It arrives here as a
:class:`~innytypes.children.ChildStartFailure` rather than an exit, and
:meth:`RestartPolicy.child_failed_to_start` is where the policy says what it does about one.

**A plugin that is held back is never brought back** (plan 0004, *The enable switch*). That
is a stronger rule than "expected": an expected stop is one this application asked for, while
a disabled plugin must stay stopped however it died and however often. The question is
:data:`~innytypes.children.HoldsBack` — the user's switch, or settings that are incomplete —
and it is asked when a restart is decided *and* again when a due restart is about to be
issued, because a plugin can be switched off during its own backoff. Neither the attempt nor
a breach is counted against a plugin that was told not to run.

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

from innytypes.children import (
    ChildExit,
    ChildStartFailure,
    Command,
    CommandName,
    CommandResult,
    HoldsBack,
)
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


def _nothing_holds_it_back(child_id: str) -> str | None:
    """The answer when no enable switch is wired up: nothing is holding anything back."""
    return None


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
    # Whether anything holds this child back from running at all — the user's switch, or a
    # settings form that is not complete (plan 0004). The same question the host asks before
    # it spawns, asked here before a restart is decided, so the two cannot disagree. A policy
    # that is not about a plugin at all — the host watching the helper — carries none.
    holds_back: HoldsBack = _nothing_holds_it_back

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

    def child_failed_to_start(self, failure: ChildStartFailure) -> ScheduledRestart | None:
        """A child never started. **Nothing is scheduled**, and no attempt is counted.

        Always ``None``, and that is a decision rather than an omission, so here is the
        reasoning in the place a reader looking for it will be.

        A restart undoes a death. There is nothing to undo here: no process ran, and the
        thing that stopped it — Anytype not answering, a live MCP tool surface that no longer
        matches the committed one, an addon interpreter that is not on this machine — is
        still exactly as true a second later. Backoff is a wait for the world to change, and
        these are not conditions that change by waiting. Scheduling one anyway would spend
        the whole attempt budget re-running a health gate the host has already run, and would
        end in the terminal state having proved nothing that the first failure did not.

        **The silence this slice was written about is fixed by the report, not by a retry.**
        The helper is now told which child could not start and why, by name, over the same
        channel it hears exits on — instead of the reason existing only on the host's stdout.
        What starts the child afterwards is what starts it today: the user, the enable
        switch, or the next host start. None of those paths changes here.

        The return type matches :meth:`child_exited` so that the two are interchangeable to a
        caller that only forwards the decision — :class:`innytypes.helper.launcher.Application`
        does — and so that a later plan which decides some start failures *are* worth retrying
        has somewhere to say so.

        Nothing is recorded against the child either. :class:`RestartState` counts restart
        attempts and remembers the code a process died with, and a start that never produced
        a process has neither — writing one in would make ``attempts`` mean two things.
        """
        return None

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

        # Asked again here, and not only when the restart was scheduled: a plugin switched
        # off during its own backoff must not come back a second later because the decision
        # to bring it back was taken before the user's. A dropped attempt is not remembered —
        # switching the plugin on is what starts it, and that is the switch's own job.
        return tuple(
            self.restart(pending.child_id)
            for pending in due
            if self.holds_back(pending.child_id) is None
        )

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
        """Count one attempt and put it in the queue, or end the attempts for good.

        A child the user has switched off is never scheduled, and the attempt is not counted
        against it either: the helper did not fail to keep it running, it was told not to.
        Restarting it here would make the restart policy the thing that undoes the switch.
        """
        if self.holds_back(child_id) is not None:
            return None

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
