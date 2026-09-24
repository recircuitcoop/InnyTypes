"""When the helper stops trying, and how a person starts it again.

The restart policy (:mod:`innytypes.helper.restart`) answers *when* a process comes back. This
module answers *whether it should any more*. A plugin that crashes on a corrupt file, an MCP
server that cannot reach an Anytype that will not come back, a host wedged by a bad update —
each of them would otherwise be restarted for as long as the machine is on, which is a loop
that burns a laptop and tells nobody anything.

**The rule is N interventions inside a window**, both configuration
(:class:`~innytypes.helper.config.BreakerSettings`, 5 in 10 minutes by default). An
intervention is any time the helper had to act: a crash it restarted, a stale process it
brought back, a kill for a resource breach. Counting inside a *window* rather than for all time
is what distinguishes "this is broken" from "this has had a bad day at some point since
Tuesday" — a process that fails once a week is not quarantined, and a process that fails five
times in a minute is.

**Quarantine is a state, not a punishment.** It records that the helper has stopped relaunching
something, so that a person can be told (slice 14 puts it in front of them) and can undo it
(`innytypes helper release <id>`). Nothing is deleted, nothing is killed on the way in: a
quarantined process that is still running keeps running.

**The host is the one special case, and it is special in a narrow way** (plan 0003, *The
restart breaker*). When the host itself is quarantined the helper does **not** shut down and
does **not** go quiet — it keeps ticking, keeps watching and keeps reporting, because a helper
that exits when the host is broken is a helper that cannot tell anyone the host is broken. The
only thing it stops doing is relaunching the host. For a plugin or the MCP server, the helper's
own operation is unaffected either way, which is the distinction the tests hold it to.

The clock is injected, as everywhere else in the helper, so a window is something a test moves
through rather than waits out.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from platformdirs import user_runtime_path

from innytypes.helper.config import BreakerSettings

__all__ = [
    "Breaker",
    "Intervention",
    "ProcessStatus",
    "QuarantineFile",
    "RunState",
    "default_quarantine_path",
]

# The host's own id, as it appears in the run-state file and every heartbeat. Named here
# because the breaker's one special case is about this process and no other.
HOST_ID = "innytypes"


class RunState(StrEnum):
    """What `innytypes helper status` says about one managed process."""

    RUNNING = "running"
    RESTARTING = "restarting"
    QUARANTINED = "quarantined"
    STOPPED = "stopped"


@dataclass(frozen=True)
class Intervention:
    """One time the helper had to act on a process, and why."""

    child_id: str
    at: float
    reason: str


@dataclass(frozen=True)
class ProcessStatus:
    """One line of `innytypes helper status`."""

    child_id: str
    state: RunState
    interventions: int
    last_reason: str | None = None
    last_exit_code: int | None = None

    @property
    def quarantined(self) -> bool:
        return self.state is RunState.QUARANTINED


def default_quarantine_path() -> Path:
    """Where quarantines are recorded for this user, creating nothing.

    Beside the run-state file, in the per-user **runtime** directory, and for the same reason:
    it describes the state of processes right now. A quarantine surviving a reboot would mean a
    machine that came back up refusing to start something for a reason nobody can see any more.
    """
    return user_runtime_path("innytypes", appauthor=False) / "quarantine.json"


@dataclass
class QuarantineFile:
    """The quarantines, on disk, so the CLI and the helper are talking about the same ones.

    The helper holds the counting in memory — a window is about the last ten minutes, which a
    restarted helper has no claim to know. But a *quarantine* has to outlive the moment: it is
    what `innytypes helper status` shows and what `release` clears, from a different process.
    """

    # Looked up by name when an instance is made, not bound when the class is: a test that
    # patches `default_quarantine_path` on this module has to move this default too.
    path: Path = field(default_factory=lambda: default_quarantine_path())

    def load(self) -> dict[str, str]:
        """Every quarantined id and the reason it was quarantined; empty when there is none."""
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError:
            # An unreadable file must not stop the helper watching; it means no quarantines
            # are known, which errs toward acting rather than toward refusing to act.
            return {}

        try:
            document = json.loads(text)
        except json.JSONDecodeError:
            return {}

        if not isinstance(document, dict):
            return {}
        return {str(key): str(value) for key, value in document.items()}

    def save(self, quarantines: dict[str, str]) -> None:
        """Replace the file atomically, with a scratch name of this process's own."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.new")
        temporary.write_text(json.dumps(quarantines, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)


@dataclass
class Breaker:
    """Counts what the helper had to do, and decides when it should stop doing it."""

    settings: BreakerSettings = field(default_factory=BreakerSettings)
    now: Callable[[], float] = time.monotonic
    # Where quarantines are recorded so another process can see and clear them. None keeps
    # them in memory only, which is what most tests want.
    store: QuarantineFile | None = None

    _interventions: dict[str, list[Intervention]] = field(default_factory=dict, init=False)
    _quarantined: dict[str, Intervention] = field(default_factory=dict, init=False)

    def record(self, child_id: str, *, reason: str) -> bool:
        """Note one intervention. Returns True when the helper may still act on this process.

        False means the process has just been quarantined, or already was: the caller must not
        restart it. Recording is deliberately the same call as asking — a caller that counted
        without asking, or asked without counting, is the bug this shape prevents.
        """
        if self.is_quarantined(child_id):
            return False

        moment = Intervention(child_id=child_id, at=self.now(), reason=reason)
        recent = self._recent(child_id)
        recent.append(moment)
        self._interventions[child_id] = recent

        if len(recent) >= self.settings.max_interventions:
            self._quarantined[child_id] = moment
            self._persist()
            return False

        return True

    def is_quarantined(self, child_id: str) -> bool:
        """Whether the helper has stopped relaunching this process."""
        return child_id in self._quarantined

    def may_restart(self, child_id: str) -> bool:
        """Whether a restart command for this process is allowed at all.

        The host's quarantine stops the host being relaunched and nothing else: the helper goes
        on watching and reporting. That is the whole of the special case.
        """
        return not self.is_quarantined(child_id)

    def release(self, child_id: str) -> bool:
        """Clear a quarantine so restarts may resume. Returns False when there was none.

        The counted interventions go with it. Releasing a process while its history still holds
        five failures would quarantine it again on the next hiccup, which is not what a person
        who typed `release` asked for.
        """
        if child_id not in self._quarantined:
            return False

        del self._quarantined[child_id]
        self._interventions.pop(child_id, None)
        self._persist()
        return True

    def interventions_for(self, child_id: str) -> tuple[Intervention, ...]:
        """The interventions still inside the window for one process."""
        return tuple(self._recent(child_id))

    def status(
        self,
        *,
        running: Iterable[str],
        restarting: Iterable[str] = (),
        exit_codes: dict[str, int | None] | None = None,
    ) -> tuple[ProcessStatus, ...]:
        """What every managed process is doing, quarantined ones included.

        ``running`` and ``restarting`` come from the host's own answer (`list`) and the restart
        policy's pending queue, so the state reported is the state the machine is in rather
        than something this module believes.
        """
        codes = exit_codes or {}
        running_ids = list(running)
        restarting_ids = list(restarting)

        known = list(dict.fromkeys([*running_ids, *restarting_ids, *self._quarantined]))
        statuses: list[ProcessStatus] = []

        for child_id in known:
            if self.is_quarantined(child_id):
                state = RunState.QUARANTINED
            elif child_id in restarting_ids:
                state = RunState.RESTARTING
            elif child_id in running_ids:
                state = RunState.RUNNING
            else:
                state = RunState.STOPPED

            last = self._quarantined.get(child_id) or (
                self._recent(child_id)[-1] if self._recent(child_id) else None
            )
            statuses.append(
                ProcessStatus(
                    child_id=child_id,
                    state=state,
                    interventions=len(self._recent(child_id)),
                    last_reason=last.reason if last else None,
                    last_exit_code=codes.get(child_id),
                )
            )

        return tuple(statuses)

    def _persist(self) -> None:
        """Write the quarantines out, when this breaker was given somewhere to write them."""
        if self.store is None:
            return
        self.store.save({child_id: moment.reason for child_id, moment in self._quarantined.items()})

    def _recent(self, child_id: str) -> list[Intervention]:
        """The interventions for one process that are still inside the window.

        Old ones are dropped on every read rather than on a timer: the window is a fact about
        when things happened, not a job someone has to remember to run.
        """
        cutoff = self.now() - self.settings.window
        return [
            intervention
            for intervention in self._interventions.get(child_id, [])
            if intervention.at > cutoff
        ]
