"""The host's own children — spawned, stopped, recorded, reported. Never restarted here.

The host has exactly two kinds of child: the Node MCP server and one process per addon. It
stays their **parent** because it talks to them through their pipes and the event bus, and a
process spawned by anybody else would leave the host with no pipe to it. The Anytype desktop
app is **not** one of them any more — InnyTypesHelper starts that (plan 0003).

Four choices here are load-bearing.

**There is no restart loop in this module, and that absence is the design.** Who *spawns* a
process and who *decides to restart* it are separate questions (plan 0003, owner decision D1):
spawning is the host's because it holds the pipes, deciding is the helper's because there must
be exactly one restart policy in the application — one backoff, one attempt count, one
breaker. So a child that exits is **reported** to the helper, with its exit code, and then
nothing happens until a command arrives. A second restart loop here would not merely duplicate
the helper's: it would disagree with it, on the one day both were running.

**Every spawn is written down, and the record is what makes a later kill safe.** The most
dangerous thing the helper can do is signal a process whose ID was reused by an unrelated
program, so a record carries **process ID, start time and executable path**, and the helper
re-reads all three from the OS before it signals anything (plan 0003, *Phantom detection*). The
record is removed the moment the child stops, because a record that outlives its process is
exactly the phantom the check exists to catch. The file is shared with the helper, which writes
the records for the processes *it* spawns, so every write here is a read-modify-write that
leaves other writers' records alone.

**The helper's commands come in through one method.** :meth:`ChildSupervisor.execute` is the
inbound half of the control channel, and :data:`ExitReporter` — the callable the supervisor is
built with — is the outbound half. Neither is a socket: the channel itself is injected, so this
module is exercised without one. The crossing between the two processes is
:mod:`innytypes.helper.control`, which calls the one and is handed to the other.

**Nothing here spawns by itself either.** ``spawn`` and the clock are injected exactly as
:class:`innytypes.anytype_mcp.Supervisor` already takes them, which is what keeps the gate
hermetic on a machine with no Node and no Anytype. The Node child is not re-derived here at
all: the supervisor in :mod:`innytypes.anytype_mcp` owns its argv, its environment and its
health gate, and this module drives it rather than duplicating it.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol, cast

from platformdirs import user_runtime_path

from innytypes import logs
from innytypes.addons.discovery import APPLICATION_NAME, InstalledAddon
from innytypes.addons.manifest import AddonManifest
from innytypes.addons.resolution import HeldBackAddon, resolve_start_order
from innytypes.addons.secrets import SECRETS_ROOT_VARIABLE, default_secrets_root
from innytypes.addons.settings import SETTINGS_PATH_VARIABLE, default_settings_path
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.events.channel import NO_ADDON_CHANNELS, AddonChannels
from innytypes.logs import get_logger

__all__ = [
    "process_image",
    "ADDON_RUNNER_MODULE",
    "CHILD_STDERR_LEVEL",
    "CHILD_STDOUT_LEVEL",
    "MAX_CHILD_OUTPUT_LINE",
    "MCP_CHILD_ID",
    "RUN_STATE_FILENAME",
    "RUN_STATE_LOCK_POLL",
    "RUN_STATE_LOCK_TIMEOUT",
    "RUN_STATE_VERSION",
    "START_TIME_TOLERANCE",
    "AddonLocations",
    "ChildError",
    "ChildExit",
    "ChildKind",
    "ChildProcess",
    "ChildRecord",
    "ChildStartFailure",
    "ChildSupervisor",
    "Command",
    "CommandName",
    "CommandResult",
    "Degradation",
    "DegradationReporter",
    "Descendant",
    "DisabledChildError",
    "ExitReporter",
    "HoldsBack",
    "ProcessTree",
    "RunStateError",
    "RunStateFile",
    "Spawn",
    "StartFailureReporter",
    "SystemProcessTree",
    "TreeProcess",
    "UnknownChildError",
    "addon_command",
    "addon_interpreter",
    "default_addon_locations",
    "default_run_state_path",
    "default_spawn",
    "log_start_failure",
    "record_child_output",
]

log = get_logger(__name__)

# The id the MCP child answers to, everywhere: in the run-state file, in an exit report and in
# a command from the helper. It is the same string plan 0003 gives that process in a heartbeat,
# because one process with two names is a process the two plans cannot talk about together.
MCP_CHILD_ID = "innytypes.anytype_mcp"

# How an addon process is started. The module is the host's own, and `innytypes` is installed
# in every addon environment at exactly the host's version (plan 0001, *Each addon has its own
# environment*), so this entry point exists in an addon's interpreter by construction — which
# is the point: the host never imports addon code, the runner does, inside the addon's own
# environment. The runner is `innytypes.addons.run`; this module names it rather than importing
# it, because nothing of it runs on this side of the process boundary.
ADDON_RUNNER_MODULE = "innytypes.addons.run"

# The run-state file. Version 1 of its format is documented in plan 0003, *Phantom detection*;
# the helper reads what this module writes.
RUN_STATE_FILENAME = "run-state.json"
RUN_STATE_VERSION = 1

# The lock every read-modify-write of that file is held under, and how long a writer waits for
# it. Five seconds is enormous next to the work it guards — read a few hundred bytes, add one
# record, replace the file — and it is bounded on purpose: a writer that cannot have the lock
# writes without it rather than holding up a startup (see :meth:`RunStateFile._exclusive`).
RUN_STATE_LOCK_TIMEOUT = 5.0
# How often a waiting writer looks again. Short, because every tick of it is one process
# waiting on the other during the startup burst, which is the only moment both ever write.
RUN_STATE_LOCK_POLL = 0.002
# The lock is taken on a sidecar file, never on the run-state file itself: that one is replaced
# wholesale by :func:`os.replace`, so a lock held on it is a lock on a file nobody else will
# open again. The sidecar is created once and never replaced, so every writer locks one object.
RUN_STATE_LOCK_SUFFIX = ".lock"

# How far a start time read from the OS may sit from the start time written into a record and
# still be the same process. The two are not produced by the same act — the OS notes when the
# process began, the writer reads the wall clock once the spawn call has returned — so exact
# equality would never match and the check would fail safe into never acting at all, which is
# a check that has quietly stopped existing. Seconds of room cost nothing, because a match
# also requires the executable path to be identical. It lives here, beside the record whose
# field it is about, and :mod:`innytypes.helper.processes` compares against this same number:
# a second copy of it is a second answer to "is this still our process".
START_TIME_TOLERANCE = 2.0


class ChildKind(StrEnum):
    """What a process in the run-state file is.

    The host only ever **writes** :data:`MCP` and :data:`ADDON`: they are its two kinds of
    child. The other three are the helper's — it spawns the host and the Anytype desktop app,
    and records **itself** as well — and they are named here so that reading the file never
    fails on a record this process did not write. The vocabulary is plan 0003's, with
    ``addon`` where that plan's prose says "plugin"; the rest of this repository says addon.

    :data:`HELPER` is there so that ``innytypes quit --force`` can stop every InnyTypes process
    by its verified identity from a process that is neither the helper nor the host (plan 0003,
    *Turning InnyTypes off*). A helper missing from this file would be the one process a forced
    quit could not reach, which is the one process that has to be reachable.
    """

    HOST = "host"
    MCP = "mcp"
    ADDON = "addon"
    ANYTYPE_APP = "anytype-app"
    HELPER = "helper"


class ChildError(RuntimeError):
    """Raised when a child cannot be started, stopped or named."""


class UnknownChildError(ChildError):
    """Raised when a command names a child this host does not have.

    Named rather than folded into :class:`ChildError` because the helper's response differs: a
    child that cannot be started is a problem on this machine, a child that does not exist is
    a helper and a host that disagree about what is installed.
    """


class DisabledChildError(ChildError):
    """Raised when something asks the host to start a child that is held back.

    The user switched it off, or its settings are not complete — :data:`HoldsBack` says which,
    and the message carries that word. Named rather than folded into :class:`ChildError`
    because the answer is neither a repair nor a reinstall: the child exists, it is installed,
    and it starts the moment nothing holds it back (plan 0004, *The enable switch*).
    """


class RunStateError(RuntimeError):
    """Raised when the run-state file cannot be read or written."""


class ChildProcess(Protocol):
    """The part of a spawned process this module uses, and nothing more.

    A protocol rather than ``subprocess.Popen`` so a test can hand the supervisor a process
    that exits when the test says so. ``Popen`` satisfies it as it stands.
    """

    @property
    def pid(self) -> int:
        """The process ID the OS gave this child."""
        ...

    def poll(self) -> int | None:
        """Its exit code if it has exited, ``None`` if it is still running."""
        ...

    def terminate(self) -> None:
        """Ask it to stop."""
        ...

    def kill(self) -> None:
        """Make it stop."""
        ...

    def wait(self, timeout: float | None = None) -> int:
        """Block until it exits, raising ``subprocess.TimeoutExpired`` if it will not."""
        ...


class Spawn(Protocol):
    """argv and environment in, a handle out — the shape `innytypes.anytype_mcp` injects too.

    ``channel`` is the one addition an addon needs: the file descriptor of the child's end of
    its event channel (:mod:`innytypes.events.channel`), which the child inherits as its
    standard input. It is keyword-only and defaults to nothing, because the MCP child has no
    such channel and a caller that has none should not have to say so.
    """

    def __call__(
        self,
        argv: Sequence[str],
        env: dict[str, str],
        *,
        channel: int | None = None,
    ) -> ChildProcess:
        """Launch one child."""
        ...


def default_spawn(
    argv: Sequence[str],
    env: dict[str, str],
    *,
    channel: int | None = None,
) -> subprocess.Popen[bytes]:
    """Launch an addon with stdio pipes, which is how the host talks to its children.

    Public because :mod:`innytypes.host` names it as the default it passes down. A host that
    wrote its own would be a second answer to how a child of this application is launched.

    The event channel arrives as **standard input** when there is one. Every process inherits
    fd 0 by construction, so the handoff needs no `pass_fds` bookkeeping and no environment
    variable naming a descriptor; standard output and standard error stay ordinary pipes, so
    an addon that prints cannot corrupt the event stream.
    """
    return subprocess.Popen(
        list(argv),
        env=env,
        stdin=subprocess.PIPE if channel is None else channel,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


# What a child's own printed output is recorded as. Standard output is INFO because a plugin
# printing there is telling somebody something; standard error is WARNING because that channel
# has an agreed meaning — a process writes to it when something is wrong — and a plugin using
# it for ordinary chatter is misusing a channel, which is itself worth seeing.
CHILD_STDOUT_LEVEL = logging.INFO
CHILD_STDERR_LEVEL = logging.WARNING

# How much of one printed line is kept. A plugin that prints a megabyte of JSON per line must
# not be able to rotate the whole log away in a second; the rest of the line is dropped and the
# record says so.
MAX_CHILD_OUTPUT_LINE = 2000


def record_child_output(child_id: str, process: ChildProcess) -> tuple[threading.Thread, ...]:
    """Read one child's standard output and standard error into the log until it exits.

    :func:`default_spawn` pipes both of them deliberately, so that an addon which prints cannot
    corrupt the event stream on fd 0 — and, until plan 0012 slice 04, nothing ever read them.
    That is two failures in one: what a plugin printed was thrown away when it exited, and a
    plugin that printed more than the pipe buffer holds blocked on its next write for ever.

    A thread per stream, daemon, ending at end of file — which is when the child's process
    exits and the kernel closes its end. There is nothing to join and nothing to stop: a
    supervisor's shutdown is not delayed by a reader that is already returning.

    The streams are reached with ``getattr`` rather than declared on
    :class:`ChildProcess`. A child handed to a supervisor by a test is a stand-in for the parts
    of ``Popen`` the supervisor uses, and this is not one of them: a fake with no pipes has
    nothing to drain, which is the truth rather than a special case.
    """
    threads: list[threading.Thread] = []
    for channel, level in (("stdout", CHILD_STDOUT_LEVEL), ("stderr", CHILD_STDERR_LEVEL)):
        stream = getattr(process, channel, None)
        if stream is None:
            continue
        thread = threading.Thread(
            target=_drain_into_the_log,
            args=(child_id, channel, stream, level),
            name=f"innytypes-{channel}-{child_id}",
            daemon=True,
        )
        thread.start()
        threads.append(thread)
    return tuple(threads)


def _drain_into_the_log(child_id: str, channel: str, stream: Iterable[bytes], level: int) -> None:
    """One stream, line by line, until it ends. Never raises at the thread that started it."""
    try:
        for line in stream:
            text = line.decode("utf-8", errors="replace").rstrip("\r\n")
            if not text:
                continue
            if len(text) > MAX_CHILD_OUTPUT_LINE:
                text = f"{text[:MAX_CHILD_OUTPUT_LINE]}… (line truncated)"
            # Through this module's logger, so the credential redactor applies to what a
            # plugin printed exactly as it applies to what the host wrote.
            log.log(level, "%s %s: %s", child_id, channel, text)
    except (OSError, ValueError):
        # The pipe died with the process that owned it. There is nothing left to read and
        # nothing to report that the child's exit will not report better.
        return


def process_image(pid: int) -> str | None:
    """The executable the OS reports for a running process, or None when it cannot say.

    The launched path and the reported image are **not the same string** for a wrapper. `npx`
    is a Node script: launch `/opt/homebrew/bin/npx` and the process table reports the `node`
    binary, so a record holding the launched path could never match — the helper would forget
    the MCP child as a phantom and would never be able to stop it. Recording what the OS says
    keeps the helper's three-fact comparison exact instead of loosening it to accommodate one
    child kind.

    Imported here rather than at module scope: the host spawns children on machines where the
    process table is not the interesting part, and a failure to read it must degrade to the
    launched path rather than stop a child from starting.
    """
    try:
        import psutil

        return str(psutil.Process(pid).exe())
    except Exception:
        # Any failure at all — no psutil, no permission, a process that exited between the
        # spawn and this call — means the host records what it launched instead. A record that
        # cannot be verified is forgotten by the helper, which is the safe direction.
        return None


@dataclass(frozen=True)
class ChildRecord:
    """One live child's identity, as the run-state file carries it.

    ``pid``, ``started_at`` and ``executable`` are the three facts the helper re-reads from the
    OS before it signals anything: all three must still match, or the record is a phantom and
    is forgotten rather than signalled. ``parent_pid`` is what makes an **orphan** visible — a
    record whose process is alive but whose parent is not. The parent's own full identity is
    its own record in the same file, written by whoever spawned *it*.
    """

    id: str
    kind: ChildKind
    pid: int
    started_at: float
    executable: str
    parent_pid: int

    def to_document(self) -> dict[str, object]:
        """This record as the JSON object the run-state file holds."""
        return {
            "id": self.id,
            "kind": str(self.kind),
            "pid": self.pid,
            "started_at": self.started_at,
            "executable": self.executable,
            "parent_pid": self.parent_pid,
        }

    @classmethod
    def from_document(cls, document: Mapping[str, object]) -> ChildRecord:
        """One record read back, or :class:`RunStateError` naming what was wrong with it."""
        try:
            return cls(
                id=_text(document, "id"),
                kind=ChildKind(_text(document, "kind")),
                pid=_whole_number(document, "pid"),
                started_at=_number(document, "started_at"),
                executable=_text(document, "executable"),
                parent_pid=_whole_number(document, "parent_pid"),
            )
        except ValueError as error:
            raise RunStateError(f"a run-state record is malformed: {error}") from error


@dataclass(frozen=True)
class ChildExit:
    """One child that is no longer running, as the helper is told about it.

    ``expected`` is True when the host itself stopped the child, which is how the helper tells
    "I asked for this" from "this one died". It is never a judgement about *whether* to
    restart: that decision is the helper's alone.
    """

    id: str
    kind: ChildKind
    pid: int
    exit_code: int | None
    expected: bool


@dataclass(frozen=True)
class ChildStartFailure:
    """One child that **never started**, as the helper is told about it.

    Deliberately not a :class:`ChildExit` with an empty pid. A child that exited is a process
    that existed, ran, and stopped; a child that failed to start left no process behind, so
    there is no process id to name, no exit code to read and nothing to clean up. The helper's
    restart policy has to tell the two apart before it decides anything
    (:meth:`innytypes.helper.restart.RestartPolicy.child_failed_to_start`), and a shared type
    with half its fields blank is exactly how that distinction gets lost.

    ``reason`` is the failure's own message, unedited — `the Anytype MCP child could not
    initialize: live Anytype MCP tools differ from the committed surface: added=[...]` is the
    sentence that actually mattered on the day this was written, and it is the only part of
    the report a person can act on.
    """

    id: str
    kind: ChildKind
    reason: str


@dataclass(frozen=True)
class Degradation:
    """One part of the host that is **not** running, and the reason in full.

    ``component`` is the child id the missing part would have had, so a reader can match it
    against the run-state file and against what the helper was told; ``reason`` is the
    message of the failure, unedited, because the fix is in it.

    **Wider than a child, which is why it lives here rather than in
    :mod:`innytypes.host`.** Not every part of the host that can be missing is a process the
    child supervisor owns: the MCP HTTP endpoint is the host's own listener, and the control
    channel is the host's end of a socket. Those have no :class:`ChildRecord` and no
    :class:`ChildStartFailure`, and they still have to be able to reach the helper. This
    module is where the two processes' shared vocabulary lives — it is what
    :mod:`innytypes.helper.control` imports and what :mod:`innytypes.host` builds on — so a
    type both ends put on the wire belongs in it. :mod:`innytypes.host` re-exports it, which
    is where every caller still names it from.
    """

    component: str
    reason: str
    # The event kind refused, when this is **not** a missing part at all but an addon sending
    # a kind its recorded manifest never declared (plan 0012, slice 03). ``component`` is then
    # that addon's id. It travels the same wire as a missing part because the helper already
    # shows what arrives there to a person; it is marked so the helper can say *refused* rather
    # than *running without*, which about a plugin that is running would be untrue.
    event: str = ""


@dataclass(frozen=True)
class Descendant:
    """One process running beneath a child of this host, read while that child was still alive.

    The host's children are not always the processes that do the work. `npx` is a launcher:
    what actually serves MCP is the `node` process underneath it, and killing only what the
    host tracks leaves that one alive, reparented to init, holding the socket the next host
    will try to open. Plan 0001 says a shutdown leaves no orphan behind, so the host has to
    know what is under a child **before** it stops it — afterwards the link is gone, because
    an orphan's parent is init and init's children are everybody's.

    ``started_at`` is carried for the same reason :class:`ChildRecord` carries one: between
    reading this list and signalling anything, a process ID can be released and handed to an
    unrelated program, and this application does not signal a process it cannot still
    recognise. Unlike a record's, both sides of that comparison come from the OS, so it is
    compared exactly rather than within :data:`START_TIME_TOLERANCE`.
    """

    pid: int
    started_at: float


class TreeProcess(Protocol):
    """The part of one OS process the descendant sweep reads and acts on, and nothing more.

    A protocol rather than ``psutil.Process`` for the reason
    :class:`innytypes.helper.processes.ProcessSnapshot` is one: it is what lets the gate
    assert the whole escalation — a polite stop, a bounded wait, then a kill — with no
    process anywhere to kill. ``psutil.Process`` satisfies it as it stands.
    """

    @property
    def pid(self) -> int:
        """The process ID the OS gave it."""
        ...

    def create_time(self) -> float:
        """When the OS says it started."""
        ...

    def exe(self) -> str:
        """The executable the OS reports for it."""
        ...

    def ppid(self) -> int:
        """The process ID of its parent."""
        ...

    def children(self, recursive: bool = ...) -> Sequence[TreeProcess]:
        """Everything beneath it — recursively, which is the only depth that means anything."""
        ...

    def terminate(self) -> None:
        """Ask it to stop."""
        ...

    def kill(self) -> None:
        """Make it stop."""
        ...


class ProcessTree(Protocol):
    """Everything running beneath one child, and the one thing the host does about it.

    Two methods rather than one because the two happen at two different moments and that
    ordering is the whole point: :meth:`descendants` has to be asked **while the child is
    still running**, and :meth:`stop` only afterwards.
    """

    def descendants(self, record: ChildRecord) -> tuple[Descendant, ...]:
        """Every process beneath this child right now."""
        ...

    def stop(self, descendants: Sequence[Descendant], *, timeout: float) -> tuple[Descendant, ...]:
        """End all of these, politely and then forcibly, answering with the ones still there."""
        ...


# How the real process tree is reached, and how it is waited on: injected into
# :class:`SystemProcessTree` so the escalation can be asserted without a process. `Lookup`
# answers ``None`` for a process ID the OS will not describe, which covers "no such process",
# "a zombie" and "another user's, and we may not look" — all three mean the same thing here.
# `Wait` is given processes and a timeout and answers the ones **still running** when it
# returns, which is `psutil.wait_procs` with its first half dropped.
Lookup = Callable[[int], "TreeProcess | None"]
Wait = Callable[[Sequence[TreeProcess], float], Sequence[TreeProcess]]


def _psutil_process(pid: int) -> TreeProcess | None:
    """One process as ``psutil`` describes it, or ``None`` when it will not describe it.

    Imported inside the function for the reason :func:`process_image` is: nothing in the gate
    reads the real process table, and a module-wide import would make every test that never
    calls it pay for the library.
    """
    import psutil

    if pid < 1:
        # Not a process this module will ask about: on POSIX these numbers address process
        # *groups*, and `psutil` would answer for the one at 0.
        return None

    try:
        return psutil.Process(pid)
    except (psutil.Error, OSError) as error:
        log.debug("the process table would not describe process %s: %s", pid, error)
        return None


def _psutil_wait(processes: Sequence[TreeProcess], timeout: float) -> Sequence[TreeProcess]:
    """Wait for these to go, answering with the ones that did not."""
    import psutil

    _gone, alive = psutil.wait_procs(cast(list[psutil.Process], list(processes)), timeout=timeout)
    return alive


class SystemProcessTree:
    """The real process tree of this machine, read and ended through ``psutil``.

    One class for macOS, Linux and Windows. That is not a convenience: process **groups**,
    which are the obvious POSIX answer, do not exist on Windows at all, and a job object,
    which is the Windows answer, does not exist anywhere else. Asking the process table what
    is underneath a process is the one question all three platforms answer the same way, and
    this repository already reads that table through `psutil` for the helper's identity check.

    **Nothing is enumerated until the tracked child has been confirmed to still be itself.**
    The rule :mod:`innytypes.helper.processes` applies before every signal is applied here one
    level up: the process a sweep starts from must still match its record on all three facts,
    and must still be a child of the host that recorded it, or the processes underneath it are
    somebody else's and this host has no business ending them. A record that cannot be
    verified yields an empty list, which is the same safe direction the helper takes.
    """

    def __init__(self, *, lookup: Lookup = _psutil_process, wait: Wait = _psutil_wait) -> None:
        self._lookup = lookup
        self._wait = wait

    def descendants(self, record: ChildRecord) -> tuple[Descendant, ...]:
        """Every process beneath this child — once the child is confirmed to be this record."""
        process = self._lookup(record.pid)
        if process is None or not self._is_the_recorded_child(process, record):
            log.debug(
                "not reading what is beneath %s (process %s): it is not the recorded process",
                record.id,
                record.pid,
            )
            return ()

        try:
            return tuple(
                Descendant(pid=child.pid, started_at=child.create_time())
                for child in process.children(recursive=True)
            )
        except Exception as error:
            # Every failure means the same thing — this host cannot say what is underneath
            # that child — and the answer to all of them is to sweep nothing. `psutil`'s own
            # errors derive from `Exception` rather than `OSError`, and this module does not
            # import it, so this is the only clause that can name them all.
            log.debug(
                "what is beneath %s (process %s) could not be read: %s",
                record.id,
                record.pid,
                error,
            )
            return ()

    def stop(self, descendants: Sequence[Descendant], *, timeout: float) -> tuple[Descendant, ...]:
        """Terminate all of these, wait ``timeout``, kill whatever ignored it, and report.

        The same escalation :func:`_stop_process` gives a tracked child, and within the same
        timeout: a grandchild that ignores a polite stop is exactly the one this exists for —
        on the day this was written the `node` process beneath `npx` did precisely that.
        """
        found = {
            descendant.pid: process
            for descendant in descendants
            if (process := self._still_there(descendant)) is not None
        }
        if not found:
            return ()

        for process in found.values():
            self._end(process, kill=False)

        alive = self._wait(list(found.values()), timeout)
        if not alive:
            return ()

        for process in alive:
            log.warning("process %s ignored the polite stop; killing it", process.pid)
            self._end(process, kill=True)

        refused = {process.pid for process in self._wait(list(alive), timeout)}
        return tuple(descendant for descendant in descendants if descendant.pid in refused)

    def _still_there(self, descendant: Descendant) -> TreeProcess | None:
        """The process this descendant names, if that ID still belongs to it."""
        process = self._lookup(descendant.pid)
        if process is None:
            return None

        try:
            # Exact, unlike a record's: both of these numbers were read from the OS, so there
            # is no spawn-shaped gap between them to make room for.
            return process if process.create_time() == descendant.started_at else None
        except Exception:
            return None

    @staticmethod
    def _end(process: TreeProcess, *, kill: bool) -> None:
        """Signal one process, treating a process that has already gone as a success."""
        try:
            process.kill() if kill else process.terminate()
        except Exception as error:
            # It exited between the look and the signal, or it is not ours to signal. Either
            # way there is nothing further to do to it.
            log.debug("process %s could not be signalled: %s", process.pid, error)

    @staticmethod
    def _is_the_recorded_child(process: TreeProcess, record: ChildRecord) -> bool:
        """Whether this really is the process the record names, and this host's child at that.

        The record's three facts, and then one more. The parent is compared as well because a
        host sweeping a process tree is sweeping **its own**: a process that matches on every
        other count but hangs off somebody else is not a child this host spawned, and its
        descendants are not this host's to end.
        """
        try:
            return (
                abs(process.create_time() - record.started_at) <= START_TIME_TOLERANCE
                and process.exe() == record.executable
                and process.ppid() == record.parent_pid
            )
        except Exception:
            return False


# Why a child must not be started right now, in one word — `disabled` when the user switched
# it off, `held-disabled` when its settings are incomplete or no longer fit — or ``None`` when
# nothing stands in its way (plan 0004, *The enable switch*). One question with one answer,
# asked by the host before it spawns and by the helper before it restarts, so the two cannot
# come to different conclusions. The words are
# :class:`~innytypes.addons.settings.PluginAvailability`'s, and
# :class:`innytypes.helper.enablement.StartGate` is what production answers it with.
HoldsBack = Callable[[str], str | None]


# Where one addon's per-user files are, as environment entries its own process reads: an addon
# id in, the variables :func:`innytypes.addons.run.user_settings` looks for out. A seam for the
# same reason every other path here is one — so no test resolves this developer's real config
# directory — and :func:`default_addon_locations` is what production answers it with.
AddonLocations = Callable[[str], Mapping[str, str]]


# The outbound half of the control channel: the host telling the helper that a child is gone.
# A callable, so the seam is trivial to inject and carries no transport of its own. The one
# that puts it on a socket is :meth:`innytypes.helper.control.HelperLink.report_exit`.
ExitReporter = Callable[[ChildExit], None]


# The other half of that outbound direction: the host telling the helper that a child **never
# started**. A second callable rather than a second meaning for the one above, because the two
# carry different facts and the helper answers them differently — see :class:`ChildStartFailure`.
# The one that puts it on a socket is
# :meth:`innytypes.helper.control.HelperLink.report_start_failure`.
StartFailureReporter = Callable[[ChildStartFailure], None]


# The third of that outbound direction: the host telling the helper what it came up **without**
# (:class:`Degradation`). The whole set at once rather than one at a time, and that shape is
# load-bearing — see :meth:`innytypes.helper.control.HelperLink.report_degradations`, which is
# what puts it on a socket, and :class:`innytypes.helper.supervision.HostDegradations`, which
# is what holds it.
DegradationReporter = Callable[[Sequence["Degradation"]], None]


def log_start_failure(failure: ChildStartFailure) -> None:
    """Where a failed start goes when nothing is listening for it.

    The default for every seam that takes a :data:`StartFailureReporter`, and deliberately
    not a no-op: this whole slice exists because a child that could not start was reported
    to nobody, and a default that dropped the report would recreate that in the one assembly
    somebody forgot to wire. A line in the log is a weak destination; silence is none.
    """
    log.warning("%s did not start: %s; nothing is listening for that", failure.id, failure.reason)


class CommandName(StrEnum):
    """What the helper can ask the host to do.

    ``RESTART_GROUP`` is the stop-and-start of several children at once that a coordinated
    addon update needs (plan 0003 slice 13): every member is stopped before any is started, so
    a group that depends on itself is never half-old and half-new.

    ``START_ALL`` names no child: it starts whatever should be running and is not, in the
    resolver's order. That is what the enable switch asks for (plan 0004), because *where* a
    plugin starts is the host's answer — naming one child would start it out of its place,
    ahead of something it subscribes to.

    ``SET_ENDPOINT`` is the one name here that is **not about a child** (plan 0008). The MCP
    endpoint is the host's own listener, and the person who has to move it is looking at the
    helper's panel, so the request crosses the one channel the two processes already have
    rather than a second one built for it. It is answered by
    :meth:`innytypes.host.Host.execute`, which owns both the children and that listener;
    :meth:`ChildSupervisor.execute` refuses it by name, because a supervisor handed it
    directly is a wiring mistake rather than a command to guess at.
    """

    START = "start"
    START_ALL = "start-all"
    STOP = "stop"
    RESTART = "restart"
    KILL = "kill"
    RESTART_GROUP = "restart-group"
    LIST = "list"
    SET_ENDPOINT = "set-endpoint"


@dataclass(frozen=True)
class Command:
    """One instruction from the helper. ``group`` is used by ``RESTART_GROUP``, ``child_id``
    by everything but ``LIST`` and ``SET_ENDPOINT``.

    ``endpoint`` is the address ``SET_ENDPOINT`` asks the host to serve, and nothing else
    uses it. One field holding both halves rather than two optional ones, because an address
    is one thing: a host and a port that could arrive independently could arrive disagreeing.
    """

    name: CommandName
    child_id: str | None = None
    group: tuple[str, ...] = ()
    endpoint: tuple[str, int] | None = None


@dataclass(frozen=True)
class CommandResult:
    """What carrying out a command produced.

    ``children`` is every child the command left running that it touched — the new record for
    a start or a restart, every live child for a list, and nothing for a stop or a kill.

    ``endpoint`` is the URL now being served, and only ``SET_ENDPOINT`` answers with one. It
    is the address as the host found it after binding, never the address that was asked for:
    the helper must be told what *is*, not what it requested.

    ``endpoint_moved`` tells the two successes apart, and only ``SET_ENDPOINT`` sets it: true
    when the listener actually moved, false when the host was already serving the address it
    was asked for and did nothing. Both are successes and both answer with the same URL, but
    only one of them invalidates every client configured with the old address — so a panel
    that could not tell them apart would have to warn about that on every save, including the
    saves that changed nothing.
    """

    name: CommandName
    children: tuple[ChildRecord, ...] = ()
    endpoint: str | None = None
    endpoint_moved: bool = False


def default_run_state_path() -> Path:
    """Where the run-state file lives for this user, creating nothing.

    The per-user **runtime** directory rather than a config or data directory: the file
    describes processes that exist right now, and a runtime directory is the one the system is
    entitled to clear on a reboot — which is exactly the right thing to do to a list of
    processes that no longer exist.
    """
    return user_runtime_path(APPLICATION_NAME, appauthor=False) / RUN_STATE_FILENAME


def _take_exclusive_lock(handle: int) -> bool:
    """Take the OS's exclusive lock on an open file, or answer False if somebody holds it.

    Two primitives for one meaning, because the three platforms this application ships on
    have no single call between them. POSIX — macOS and Linux — has ``flock``; Windows has no
    such thing and locks a byte range instead, through ``msvcrt.locking``. Both are advisory
    **between users of this same call**, which is all that is needed here: the only two
    writers of the run-state file are the helper and the host, and both of them are this code.

    Non-blocking on both, deliberately. The blocking forms have no deadline at all on POSIX
    and a fixed ten-second one on Windows, and neither is a wait this application may be made
    to take: the waiting belongs to the caller, against a deadline the caller owns.
    """
    if sys.platform == "win32":  # pragma: no cover - the POSIX arm is what this gate runs
        import msvcrt

        try:
            # One byte from the current position, which is nothing anybody reads: the region
            # is a token, not a range of the file's contents. Windows allows a lock past the
            # end of a file, so the sidecar never needs to have anything written into it.
            msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
        except OSError:
            return False
        return True

    import fcntl

    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    return True


def _release_exclusive_lock(handle: int) -> None:
    """Give the lock back. Closing the file would too, but only as a side effect."""
    if sys.platform == "win32":  # pragma: no cover - the POSIX arm is what this gate runs
        import msvcrt

        msvcrt.locking(handle, msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(handle, fcntl.LOCK_UN)


class RunStateFile:
    """The shared list of live processes: JSON, one record per process, on disk.

    Shared with the helper, which writes the records for the processes it spawns (the host
    among them), so every change here is a **read-modify-write** touching only the record it
    names. It is replaced atomically with :func:`os.replace`, because a half-written run-state
    file is a list of processes nobody dares act on — and every read-modify-write is held
    under an exclusive lock, because :func:`os.replace` says nothing at all about two writers
    that each read the same file and each write their own version of it back.
    """

    def __init__(
        self,
        path: Path | None = None,
        *,
        lock_timeout: float = RUN_STATE_LOCK_TIMEOUT,
    ) -> None:
        self._path = default_run_state_path() if path is None else path
        self._lock_path = self._path.parent / f".{self._path.name}{RUN_STATE_LOCK_SUFFIX}"
        self._lock_timeout = lock_timeout

    def records(self) -> tuple[ChildRecord, ...]:
        """Every record in the file, sorted by id, or :class:`RunStateError` if one is broken.

        Unlocked on purpose. A reader sees the file exactly as some writer left it whole,
        because every write lands with :func:`os.replace`; what the lock is for is the gap
        between a *read* and the *write* that depends on it, and a reader has no such gap.
        """
        return tuple(
            sorted(
                (ChildRecord.from_document(document) for document in self._read()),
                key=lambda record: record.id,
            )
        )

    def write(self, record: ChildRecord) -> None:
        """Record one child, replacing any earlier record under the same id."""
        with self._exclusive():
            documents = [document for document in self._read() if document.get("id") != record.id]
            documents.append(record.to_document())
            self._replace(documents)

    def forget(self, child_id: str) -> None:
        """Remove one child's record. Forgetting what was never recorded is not an error."""
        with self._exclusive():
            documents = self._read()
            remaining = [document for document in documents if document.get("id") != child_id]
            if len(remaining) != len(documents):
                self._replace(remaining)

    @contextmanager
    def _exclusive(self) -> Iterator[None]:
        """Hold this file against the other writer for one whole read-modify-write.

        **Why a lock at all.** :func:`os.replace` makes the file appear whole or not at all.
        It does nothing about the other failure: two writers each read the same file, each add
        their own record, and each write the whole thing back — and the one that writes second
        has no trace of the first one's record in what it writes. The helper and the host do
        exactly that, to this file, and the startup burst is the one moment both of them do.
        The record lost that way is what lets the helper verify a child's identity before it
        signals anything, so a lost record is a child the helper can never safely stop, and a
        process nobody can account for is the phantom the identity check exists to catch.

        **Why a sidecar file.** The run-state file is replaced wholesale, so a lock held on it
        is held on something that has stopped being the file the next writer will open. The
        sidecar is created once and never replaced, so every writer locks the same object.

        **What happens when the lock cannot be taken.** The write goes ahead without it, with
        a warning naming the file. That is exactly today's behaviour, and it is the right way
        to fail: a filesystem whose locks do not work, or a writer that has wedged while
        holding one, must not be able to stop this application from starting. A lost record is
        recoverable — the next write puts one back — and a startup that hangs is not.
        """
        taken = False
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            handle = os.open(self._lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        except OSError as error:
            # A directory that cannot be made or a lock file that cannot be opened is a
            # problem `_replace` is about to report properly, with the path in the message.
            # Refusing the write here would only replace that sentence with a worse one.
            log.warning("the run-state lock at %s could not be opened: %s", self._lock_path, error)
            yield
            return

        try:
            taken = self._wait_for_lock(handle)
            if not taken:
                log.warning(
                    "the run-state lock at %s was still held after %ss; writing %s without it, "
                    "so a record written by the other process at this moment may be lost",
                    self._lock_path,
                    self._lock_timeout,
                    self._path,
                )
            yield
        finally:
            if taken:
                _release_exclusive_lock(handle)
            os.close(handle)

    def _wait_for_lock(self, handle: int) -> bool:
        """Try for the lock until the deadline, answering whether it was ever taken.

        A deadline rather than a blocking call: see :meth:`_exclusive` for why this must be
        something the application can give up on.
        """
        deadline = time.monotonic() + self._lock_timeout
        while True:
            if _take_exclusive_lock(handle):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(RUN_STATE_LOCK_POLL)

    def _read(self) -> list[dict[str, object]]:
        """Every record document in the file, raw. A file that is not there yet is empty."""
        try:
            raw = self._path.read_bytes()
        except FileNotFoundError:
            # Nothing has been spawned yet. That is the normal first call, not a failure, and
            # certainly not a reason to create the file.
            return []
        except OSError as error:
            raise RunStateError(
                f"the run-state file at {self._path} could not be read: {error}"
            ) from error

        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise RunStateError(
                f"the run-state file at {self._path} is not UTF-8 JSON: {error}"
            ) from error

        records = document.get("records") if isinstance(document, dict) else None
        if not isinstance(records, list) or not all(isinstance(entry, dict) for entry in records):
            raise RunStateError(
                f"the run-state file at {self._path} is not a run-state document: it holds a "
                "`records` list of objects, one per live process"
            )

        return list(records)

    def _replace(self, documents: list[dict[str, object]]) -> None:
        """Write the whole file again, atomically, sorted so a diff of it reads."""
        document = {
            "version": RUN_STATE_VERSION,
            "records": sorted(documents, key=lambda entry: str(entry.get("id", ""))),
        }
        # The process ID is in the temporary name because the helper writes this same file:
        # two writers must never share a scratch file, however briefly.
        temporary = self._path.parent / f".{self._path.name}.{os.getpid()}.tmp"

        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(
                json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            os.replace(temporary, self._path)
        except OSError as error:
            raise RunStateError(
                f"the run-state file at {self._path} could not be written: {error}"
            ) from error


def addon_interpreter(environment: Path) -> Path:
    """The Python inside one addon's own environment."""
    if os.name == "nt":
        return environment / "Scripts" / "python.exe"
    return environment / "bin" / "python"


def addon_command(addon: InstalledAddon) -> tuple[str, ...]:
    """The argv that starts one addon: its own interpreter, running the host's runner.

    The addon's environment rather than the host's, because an addon's dependencies must never
    be able to break the host's (plan 0001). The runner is host code and the addon's id is its
    argument, which is what keeps the host from ever importing an addon: the import happens on
    the far side of a process boundary, in the environment that addon was installed into.
    """
    return (
        str(addon_interpreter(addon.environment)),
        "-m",
        ADDON_RUNNER_MODULE,
        addon.id,
    )


def default_addon_locations(addon_id: str) -> Mapping[str, str]:
    """Where this user's files for one addon are, as the variables its process reads.

    **The host answers this, because the addon's process cannot.** An addon environment holds
    `innytypes`, the addon and the addon's own dependencies and nothing else (plan 0001), so
    :func:`~innytypes.addons.settings.default_settings_path` — which needs `platformdirs` —
    raises there. The host has the library, has already validated the values in that file,
    and is the thing that spawns the process, so it is the one place the question has an
    answer at all. Sent in the environment rather than in the argv: an addon installed before
    this existed ignores a variable it does not read, where an extra argument would make its
    runner print usage and exit.

    Every entry is bound to one addon id, which is the same shape the whole contract has:
    there is nothing here another addon's id could be passed through.

    The log is the exception that proves the rule: it is the one location here that is **not**
    the addon's own, because there is one application log and all three processes write to it
    (plan 0012, slice 04). The level travels with it so that a child is exactly as verbose as
    the host that started it, rather than as verbose as its own default happens to be.
    """
    return {
        SETTINGS_PATH_VARIABLE: str(default_settings_path(addon_id)),
        SECRETS_ROOT_VARIABLE: str(default_secrets_root()),
        # Through the module, not a name imported at the top of this file: a test redirects
        # this machine's log by patching the module attribute, and a bound name would ignore it
        # and write into somebody's real log directory during the gate.
        logs.LOG_PATH_VARIABLE: str(logs.default_log_path()),
        logs.LOG_LEVEL_VARIABLE: logging.getLevelName(logs.current_level()),
    }


def _nothing_holds_it_back(child_id: str) -> str | None:
    """The answer when no enable switch is wired up: nothing is holding anything back.

    A host built without one starts what it is given, which is what every caller that
    predates plan 0004 — and every test that is about something else — means.
    """
    return None


@dataclass(frozen=True)
class _Running:
    """One child the host has started and has not yet seen exit."""

    record: ChildRecord
    process: ChildProcess


class ChildSupervisor:
    """Every child of the host: what starts, in what order, and what the helper is told.

    Built with the addons discovery found — this resolves their start order itself, so the
    order children are spawned in is the resolver's answer rather than a caller's list — and
    with the :class:`~innytypes.anytype_mcp.Supervisor` that owns the Node child. Everything
    that touches the outside world is injected: the spawn, the clock, the run-state file, the
    two reporters that stand in for the helper, and the addon channels — the event channel one
    addon's process is given when it is spawned, and released when it stops.

    Both reporters are required, and neither has a default. A default on either would let an
    assembly that forgot the wire keep working while dropping what it was built to carry, and
    it would read to the next person as permission to leave it out. Where an absence is real
    rather than forgotten — a host started in a terminal, which has no helper to report to at
    all — it is :func:`~innytypes.host.build_host` that names it, with
    :func:`log_start_failure` beside :func:`~innytypes.host._log_child_exit`. That is a
    default that says something true; one here would only hide a missing argument.

    There are **two** reporters because a child has two ways of not running, and they are not
    the same news. ``report_exit`` carries a process that existed and is gone; and
    ``report_start_failure`` carries one that was never there — a spawn that raised, an
    unreachable Anytype, a live MCP tool surface that no longer matches the committed one.
    Until that second seam existed, :meth:`start` simply raised and the only account of why
    was a line on the host's own stdout, which a packaged application throws away.

    ``mcp`` is ``None`` on a machine where the Anytype MCP server cannot be configured at
    all — no API key, so there is no configuration to build a supervisor from. Such a host
    **has no MCP child**: the id is absent from :attr:`start_order`, and a command naming it
    is refused like any other child this host does not have. That is the truthful answer,
    and it is a different sentence from "it is there and it failed to start", which is what
    an unreachable Anytype produces (plan 0002 slice 05).

    ``holds_back`` is :data:`HoldsBack`: the one question this module asks about whether a
    child may run at all. It is injected because the answers live in files this module has
    never read — the user's switch in the helper's `config.toml`, the plugin's settings in
    its own file (plan 0004) — and it is asked **at the moment of starting** rather than
    remembered, so a switch flipped while the host runs is obeyed without the host being
    rebuilt. A child it holds back is **still a child of this host**: it keeps its place in
    :attr:`start_order`, so it starts where the resolver put it the moment nothing holds it
    back any more. It is simply not spawned — :meth:`start_all` walks past it, and
    :meth:`start` refuses it by name.
    """

    def __init__(
        self,
        *,
        mcp: Supervisor | None,
        addons: Sequence[InstalledAddon],
        run_state: RunStateFile,
        report_exit: ExitReporter,
        report_start_failure: StartFailureReporter,
        spawn: Spawn = default_spawn,
        channels: AddonChannels = NO_ADDON_CHANNELS,
        clock: Callable[[], float] = time.time,
        environment: Mapping[str, str] | None = None,
        locations: AddonLocations = default_addon_locations,
        stop_timeout: float = 5.0,
        image_of: Callable[[int], str | None] = process_image,
        holds_back: HoldsBack = _nothing_holds_it_back,
        process_tree: ProcessTree | None = None,
    ) -> None:
        self._mcp = mcp
        self._run_state = run_state
        self._report_exit = report_exit
        self._report_start_failure = report_start_failure
        self._spawn = spawn
        self._channels = channels
        self._clock = clock
        self._environment = dict(os.environ if environment is None else environment)
        self._locations = locations
        self._stop_timeout = stop_timeout
        self._image_of = image_of
        self._holds_back = holds_back
        self._process_tree = SystemProcessTree() if process_tree is None else process_tree

        plan = resolve_start_order(
            [addon.manifest for addon in addons],
            # Asked once, here, because *this* is the question the plan answers: an addon
            # that requires an addon which is not going to start is held back, and being
            # held back is a decision about the whole graph rather than about one child.
            not_starting={
                addon.id: word for addon in addons if (word := holds_back(addon.id)) is not None
            },
        )
        self._addons = {addon.id: addon for addon in addons}
        self._held_back = plan.held_back
        # The MCP child first: it is core, and an addon that wants Anytype through it should
        # not have to wait for a resolver edge it cannot declare — no addon may name the host.
        # A host with no MCP configuration has no such child to order at all.
        self._order = plan.order if mcp is None else (MCP_CHILD_ID, *plan.order)
        self._running: dict[str, _Running] = {}

    @property
    def start_order(self) -> tuple[str, ...]:
        """Every child this host can start, in the order it starts them."""
        return self._order

    @property
    def held_back(self) -> tuple[HeldBackAddon, ...]:
        """The addons that will not be started, and why. They are never spawned."""
        return self._held_back

    def running(self) -> tuple[ChildRecord, ...]:
        """Every live child's identity, in start order. This is what ``list`` answers."""
        return tuple(
            self._running[child_id].record for child_id in self._order if child_id in self._running
        )

    def start_all(self) -> tuple[ChildRecord, ...]:
        """Start every child that is not already running and not held back, in start order.

        A child that refuses to start — an unreachable Anytype, say — raises out of here
        rather than being skipped, because the caller, not this module, decides whether a host
        with no MCP server is a host worth having. A child the user switched off is skipped
        in silence: there is nothing wrong with it and nobody to tell.
        """
        return tuple(
            self.start(child_id)
            for child_id in self._order
            if child_id not in self._running and self._holds_back(child_id) is None
        )

    def start(self, child_id: str) -> ChildRecord:
        """Spawn one child and record its identity, unless something holds it back.

        A spawn that fails is reported to the helper before it is raised — see the comment
        at that point for why both, and why a child the user switched off is not reported
        that way.
        """
        self._require_known(child_id)
        if child_id in self._running:
            raise ChildError(f"{child_id} is already running; stop it before starting it again")

        held_back = self._holds_back(child_id)
        if held_back is not None:
            # The one place a process is created, so the one place "disabled means not
            # started" can be made true whatever asked. The helper's policy already declines
            # to ask (`innytypes.helper.restart`); this is what makes a stale command, or a
            # switch flipped between the asking and the spawning, harmless.
            #
            # Raised from **above** the start-failure report below, and that placement is the
            # decision: a child that is switched off did not fail to start. Reporting it as a
            # failure would be a second vocabulary for what the host already says in its own
            # `held` list, and it would tell the helper something is wrong when nothing is.
            raise DisabledChildError(f"{child_id} is {held_back}, so it is not started")

        argv: Sequence[str]
        process: ChildProcess

        # `_require_known` has already refused the MCP child on a host that has none, so the
        # `is not None` here is what says that to the type checker rather than a second check.
        mcp = self._mcp
        try:
            if child_id == MCP_CHILD_ID and mcp is not None:
                # Driven, not duplicated: the argv, the environment and the health gate in
                # front of the spawn are all `innytypes.anytype_mcp`'s, and the pinned package
                # spec reaches the injected spawn from there.
                argv = mcp.command()
                process = mcp.start()
            else:
                addon = self._addons[child_id]
                argv = addon_command(addon)
                process = self._spawn_addon(child_id, argv=argv, manifest=addon.manifest)
        except Exception as error:
            # **A start that fails is still news.** Reported and then re-raised, both: the
            # caller still decides whether a host without this child is a host worth having
            # (:meth:`innytypes.host.Host.start` does, and its degradation is unchanged), and
            # the helper is told the same fact over its own channel rather than being left to
            # infer it from a child that never appears.
            #
            # Nothing has been written down at this point — no entry in `self._running`, no
            # run-state record — which is the other half of what is reported: a child that
            # failed to start is **not** recorded as running, so nothing later tries to stop,
            # signal or identify a process that does not exist.
            self._report_start_failure(
                ChildStartFailure(id=child_id, kind=_kind_of(child_id), reason=str(error))
            )
            raise

        record = ChildRecord(
            id=child_id,
            kind=_kind_of(child_id),
            pid=process.pid,
            started_at=self._clock(),
            # What the OS reports, falling back to what was launched: the two differ for a
            # wrapper such as `npx`, and the helper compares against the former.
            executable=self._image_of(process.pid) or _resolve_executable(argv[0]),
            # The host is the parent, which is what makes one of its children an orphan the
            # moment the host is gone.
            parent_pid=os.getpid(),
        )

        self._running[child_id] = _Running(record=record, process=process)
        # Written before anything else can go wrong with this child: a process that exists
        # without a record is the one thing nobody can clean up safely.
        self._run_state.write(record)
        log.info("started %s as process %s", child_id, record.pid)
        return record

    def stop(self, child_id: str) -> int | None:
        """Stop one child politely, killing it if it will not go. Returns its exit code."""
        self._require_known(child_id)
        running = self._running.get(child_id)
        if running is None:
            return None

        # Read first, and that ordering is the fix: once the tracked process is gone its own
        # children are reparented to init, and nothing then connects them to this host.
        descendants = self._process_tree.descendants(running.record)

        mcp = self._mcp
        if child_id == MCP_CHILD_ID and mcp is not None:
            # Its own supervisor escalates terminate to kill and clears its state.
            mcp.stop(timeout=self._stop_timeout)
        else:
            _stop_process(running.process, timeout=self._stop_timeout)

        self._end_descendants(child_id, descendants)
        return self._finish(child_id, expected=True).exit_code

    def kill(self, child_id: str) -> int | None:
        """Kill one child outright, with no polite stop first. Returns its exit code."""
        self._require_known(child_id)
        running = self._running.get(child_id)
        if running is None:
            return None

        descendants = self._process_tree.descendants(running.record)

        running.process.kill()
        running.process.wait()
        mcp = self._mcp
        if child_id == MCP_CHILD_ID and mcp is not None:
            # The child is already gone; this is what clears the supervisor's own handle on
            # it, and it reports the death rather than terminating anything a second time.
            mcp.stop(timeout=self._stop_timeout)

        self._end_descendants(child_id, descendants)
        return self._finish(child_id, expected=True).exit_code

    def restart(self, child_id: str) -> ChildRecord:
        """Stop one child and start it again — **only** when the helper asks for it.

        This is the one and only way a child of the host comes back, and it is reached from
        :meth:`execute`, never from :meth:`poll`. A child that exits on its own stays dead
        here until the helper's restart policy decides otherwise.
        """
        self._require_known(child_id)
        self.stop(child_id)
        return self.start(child_id)

    def restart_group(self, child_ids: Iterable[str]) -> tuple[ChildRecord, ...]:
        """Stop a group of children, then start them again in start order.

        Every member is stopped before any is started. Restarting them one at a time would
        run a just-started member against the old version of the sibling it depends on, which
        is precisely what a coordinated update of several addons is trying to avoid.
        """
        wanted = set(child_ids)
        unknown = sorted(wanted - set(self._order))
        if unknown:
            raise UnknownChildError(
                f"this host has no child called {', '.join(repr(name) for name in unknown)}; "
                f"it has {', '.join(self._order)}"
            )

        members = [child_id for child_id in self._order if child_id in wanted]
        for child_id in reversed(members):
            self.stop(child_id)
        return tuple(self.start(child_id) for child_id in members)

    def poll(self) -> tuple[ChildExit, ...]:
        """Report every child that has exited on its own. **Starts nothing.**

        This is the whole of the host's response to a child dying: notice it, forget its
        record, tell the helper its exit code. Adding a spawn to this method would be the
        second restart policy in the application (plan 0003, D1), and it would disagree with
        the first one on the day both ran.
        """
        exits = [
            self._finish(child_id, expected=False)
            for child_id, running in list(self._running.items())
            if running.process.poll() is not None
        ]
        return tuple(exits)

    def shutdown(self) -> None:
        """Stop every running child, in reverse start order, leaving no orphan behind.

        Reverse order so a subscriber goes before the publisher it reads, and a kill follows
        every terminate that is ignored: a child the host leaves running is a child nothing
        owns, holding a socket the next host will try to open.
        """
        for child_id in reversed(self._order):
            if child_id in self._running:
                self.stop(child_id)

    def execute(self, command: Command) -> CommandResult:
        """Carry out one of the helper's commands. The inbound half of the control channel."""
        match command.name:
            case CommandName.LIST:
                return CommandResult(name=command.name, children=self.running())
            case CommandName.RESTART_GROUP:
                return CommandResult(name=command.name, children=self.restart_group(command.group))
            case CommandName.START:
                return CommandResult(name=command.name, children=(self.start(_named(command)),))
            case CommandName.START_ALL:
                return CommandResult(name=command.name, children=self.start_all())
            case CommandName.RESTART:
                return CommandResult(name=command.name, children=(self.restart(_named(command)),))
            case CommandName.STOP:
                self.stop(_named(command))
                return CommandResult(name=command.name)
            case CommandName.KILL:
                self.kill(_named(command))
                return CommandResult(name=command.name)
            case CommandName.SET_ENDPOINT:
                # Not a child, so not this object's to carry out. The link the host hands
                # the helper is wired to :meth:`innytypes.host.Host.execute`, which owns the
                # listener as well as these children and answers this one itself. Refused by
                # name rather than quietly answered with nothing, because a supervisor asked
                # this directly is a mis-wiring somebody has to see.
                raise UnknownChildError(
                    "the MCP endpoint is not a child of this host, so the child supervisor "
                    "cannot move it; innytypes.host.Host.execute answers set-endpoint"
                )

    def _spawn_addon(
        self,
        child_id: str,
        *,
        argv: Sequence[str],
        manifest: AddonManifest,
    ) -> ChildProcess:
        """Open this addon's event channel, spawn it, and hand the channel over.

        The host's copy of the child's descriptor is closed as soon as the spawn has it, and
        that is not tidiness: while the host still holds a writer for the child's end, a child
        that has died never looks gone, because its socket still has somebody on it.

        The environment carries this addon's own per-user locations
        (:func:`default_addon_locations`), which is why it is built here rather than shared:
        every addon is told where **its** files are and is told nothing about anybody else's.
        """
        channel = self._channels.open(child_id, manifest)
        environment = {**self._environment, **self._locations(child_id)}
        try:
            process = self._spawn(argv, environment, channel=channel)
            # The pipes `default_spawn` opens are read from here on. Until plan 0012 slice 04
            # they were opened and never drained, so a plugin's own output was discarded when
            # it exited — and, worse, a plugin that printed enough to fill the pipe buffer
            # would block on its next `print` for ever, with nothing in the process table to
            # say why.
            record_child_output(child_id, process)
            return process
        except BaseException:
            # A child that was never spawned must not leave a channel the host will wait on.
            self._channels.close(child_id)
            raise
        finally:
            if channel is not None:
                os.close(channel)

    def _end_descendants(self, child_id: str, descendants: Sequence[Descendant]) -> None:
        """End whatever this child left running beneath it.

        The host tracks `npx exec @anyproto/anytype-mcp`; the process that actually serves
        MCP is the `node` one underneath it. Stopping only what is tracked left that one
        alive — reparented to launchd, ignoring a polite stop, holding the port the next host
        would try to bind. :meth:`shutdown` promises no orphan is left behind and
        :meth:`stop` is what it promises it through, so this is where that promise is kept.
        """
        if not descendants:
            return

        log.info("stopping %s process(es) left running beneath %s", len(descendants), child_id)
        for survivor in self._process_tree.stop(descendants, timeout=self._stop_timeout):
            # Kept as a log line rather than raised: the child this host tracks *has* stopped,
            # and a shutdown that refused to finish because one grandchild would not die is a
            # shutdown the user cannot rely on. What is left is a fact about this machine, and
            # hiding it would be the worse of the two.
            log.error(
                "process %s is still running beneath %s after a forced kill",
                survivor.pid,
                child_id,
            )

    def _require_known(self, child_id: str) -> None:
        """Refuse a child this host does not have, by name."""
        if child_id not in self._order:
            raise UnknownChildError(
                f"this host has no child called {child_id!r}; it has {', '.join(self._order)}"
            )

    def _finish(self, child_id: str, *, expected: bool) -> ChildExit:
        """Forget one child that is no longer running, and tell the helper.

        Forgetting comes first. A record left behind after the process is gone is the phantom
        plan 0003's identity check exists to catch, and the window in which one exists should
        be as close to nothing as it can be.
        """
        running = self._running.pop(child_id)
        if child_id == MCP_CHILD_ID and self._mcp is not None and not expected:
            self._mcp.child_exited()
        self._run_state.forget(child_id)
        # The channel goes with the process it belonged to. Closing one the MCP child never
        # had is not an error — the supervisor has one kind of child that has a channel, and
        # asking here which kind this is would be a second place that knows.
        self._channels.close(child_id)

        exit_report = ChildExit(
            id=child_id,
            kind=running.record.kind,
            pid=running.record.pid,
            exit_code=running.process.poll(),
            expected=expected,
        )
        log.info(
            "%s (process %s) exited with code %s",
            child_id,
            exit_report.pid,
            exit_report.exit_code,
        )
        self._report_exit(exit_report)
        return exit_report


def _named(command: Command) -> str:
    """The child a command names, or a refusal saying it named none."""
    if command.child_id is None:
        raise ChildError(f"a {command.name} command names the child it acts on")
    return command.child_id


def _kind_of(child_id: str) -> ChildKind:
    """Which of the two kinds of child this is."""
    return ChildKind.MCP if child_id == MCP_CHILD_ID else ChildKind.ADDON


def _stop_process(process: ChildProcess, *, timeout: float) -> None:
    """Terminate one process, and kill it if it does not go.

    A child that ignores terminate would otherwise hold up the whole shutdown, and a shutdown
    that can be refused by one wedged addon is a shutdown the user cannot rely on.
    """
    if process.poll() is not None:
        return

    process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def _resolve_executable(name: str) -> str:
    """The path this child was launched from, as far as the host can know it.

    ``PATH`` is resolved here rather than left to the helper, because the helper compares this
    string against the executable it reads from the process table, and `npx` is not a path.
    What cannot be resolved is recorded verbatim, which is honest about what was asked for.

    This is only the fallback. What is recorded is what the OS *reports* for the process once
    it exists — see :func:`process_image`.
    """
    resolved = shutil.which(name)
    return name if resolved is None else resolved


def _text(document: Mapping[str, object], field: str) -> str:
    value = document.get(field)
    if not isinstance(value, str):
        raise ValueError(f"`{field}` is a string, got {type(value).__name__}")
    return value


def _number(document: Mapping[str, object], field: str) -> float:
    value = document.get(field)
    # `bool` is excluded with the same care the event payload checker takes: it is a subclass
    # of `int`, and `True` is not a moment in time.
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"`{field}` is a number, got {type(value).__name__}")
    return float(value)


def _whole_number(document: Mapping[str, object], field: str) -> int:
    value = document.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"`{field}` is a whole number, got {type(value).__name__}")
    return value
