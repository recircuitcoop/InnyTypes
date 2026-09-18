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
module is exercised without one, and the helper's end of it is plan 0003 slice 05.

**Nothing here spawns by itself either.** ``spawn`` and the clock are injected exactly as
:class:`innytypes.anytype_mcp.Supervisor` already takes them, which is what keeps the gate
hermetic on a machine with no Node and no Anytype. The Node child is not re-derived here at
all: the supervisor in :mod:`innytypes.anytype_mcp` owns its argv, its environment and its
health gate, and this module drives it rather than duplicating it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from platformdirs import user_runtime_path

from innytypes.addons.discovery import APPLICATION_NAME, InstalledAddon
from innytypes.addons.manifest import AddonManifest
from innytypes.addons.resolution import HeldBackAddon, resolve_start_order
from innytypes.anytype_mcp.logs import get_logger
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.events.channel import NO_ADDON_CHANNELS, AddonChannels

__all__ = [
    "ADDON_RUNNER_MODULE",
    "MCP_CHILD_ID",
    "RUN_STATE_FILENAME",
    "RUN_STATE_VERSION",
    "ChildError",
    "ChildExit",
    "ChildKind",
    "ChildProcess",
    "ChildRecord",
    "ChildSupervisor",
    "Command",
    "CommandName",
    "CommandResult",
    "ExitReporter",
    "RunStateError",
    "RunStateFile",
    "Spawn",
    "UnknownChildError",
    "addon_command",
    "addon_interpreter",
    "default_run_state_path",
    "default_spawn",
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


class ChildKind(StrEnum):
    """What a process in the run-state file is.

    The host only ever **writes** :data:`MCP` and :data:`ADDON`: they are its two kinds of
    child. The other two are the helper's — it spawns the host and the Anytype desktop app and
    writes their records into the same file — and they are named here so that reading the file
    never fails on a record this process did not write. The vocabulary is plan 0003's, with
    ``addon`` where that plan's prose says "plugin"; the rest of this repository says addon.
    """

    HOST = "host"
    MCP = "mcp"
    ADDON = "addon"
    ANYTYPE_APP = "anytype-app"


class ChildError(RuntimeError):
    """Raised when a child cannot be started, stopped or named."""


class UnknownChildError(ChildError):
    """Raised when a command names a child this host does not have.

    Named rather than folded into :class:`ChildError` because the helper's response differs: a
    child that cannot be started is a problem on this machine, a child that does not exist is
    a helper and a host that disagree about what is installed.
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


# The outbound half of the control channel: the host telling the helper that a child is gone.
# A callable, so the seam is trivial to inject and carries no transport of its own; plan 0003
# slice 05 builds the end that puts it on a socket.
ExitReporter = Callable[[ChildExit], None]


class CommandName(StrEnum):
    """What the helper can ask the host to do with a child.

    ``RESTART_GROUP`` is the stop-and-start of several children at once that a coordinated
    addon update needs (plan 0003 slice 13): every member is stopped before any is started, so
    a group that depends on itself is never half-old and half-new.
    """

    START = "start"
    STOP = "stop"
    RESTART = "restart"
    KILL = "kill"
    RESTART_GROUP = "restart-group"
    LIST = "list"


@dataclass(frozen=True)
class Command:
    """One instruction from the helper. ``group`` is used by ``RESTART_GROUP``, ``child_id``
    by everything but ``LIST``."""

    name: CommandName
    child_id: str | None = None
    group: tuple[str, ...] = ()


@dataclass(frozen=True)
class CommandResult:
    """What carrying out a command produced.

    ``children`` is every child the command left running that it touched — the new record for
    a start or a restart, every live child for a list, and nothing for a stop or a kill.
    """

    name: CommandName
    children: tuple[ChildRecord, ...] = ()


def default_run_state_path() -> Path:
    """Where the run-state file lives for this user, creating nothing.

    The per-user **runtime** directory rather than a config or data directory: the file
    describes processes that exist right now, and a runtime directory is the one the system is
    entitled to clear on a reboot — which is exactly the right thing to do to a list of
    processes that no longer exist.
    """
    return user_runtime_path(APPLICATION_NAME, appauthor=False) / RUN_STATE_FILENAME


class RunStateFile:
    """The shared list of live processes: JSON, one record per process, on disk.

    Shared with the helper, which writes the records for the processes it spawns (the host
    among them), so every change here is a **read-modify-write** touching only the record it
    names. It is replaced atomically with :func:`os.replace`, because a half-written run-state
    file is a list of processes nobody dares act on.
    """

    def __init__(self, path: Path | None = None) -> None:
        self._path = default_run_state_path() if path is None else path

    def records(self) -> tuple[ChildRecord, ...]:
        """Every record in the file, sorted by id, or :class:`RunStateError` if one is broken."""
        return tuple(
            sorted(
                (ChildRecord.from_document(document) for document in self._read()),
                key=lambda record: record.id,
            )
        )

    def write(self, record: ChildRecord) -> None:
        """Record one child, replacing any earlier record under the same id."""
        documents = [document for document in self._read() if document.get("id") != record.id]
        documents.append(record.to_document())
        self._replace(documents)

    def forget(self, child_id: str) -> None:
        """Remove one child's record. Forgetting what was never recorded is not an error."""
        documents = self._read()
        remaining = [document for document in documents if document.get("id") != child_id]
        if len(remaining) != len(documents):
            self._replace(remaining)

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
    reporter that stands in for the helper, and the addon channels — the event channel one
    addon's process is given when it is spawned, and released when it stops.

    ``mcp`` is ``None`` on a machine where the Anytype MCP server cannot be configured at
    all — no API key, so there is no configuration to build a supervisor from. Such a host
    **has no MCP child**: the id is absent from :attr:`start_order`, and a command naming it
    is refused like any other child this host does not have. That is the truthful answer,
    and it is a different sentence from "it is there and it failed to start", which is what
    an unreachable Anytype produces (plan 0002 slice 05).
    """

    def __init__(
        self,
        *,
        mcp: Supervisor | None,
        addons: Sequence[InstalledAddon],
        run_state: RunStateFile,
        report_exit: ExitReporter,
        spawn: Spawn = default_spawn,
        channels: AddonChannels = NO_ADDON_CHANNELS,
        clock: Callable[[], float] = time.time,
        environment: Mapping[str, str] | None = None,
        stop_timeout: float = 5.0,
    ) -> None:
        self._mcp = mcp
        self._run_state = run_state
        self._report_exit = report_exit
        self._spawn = spawn
        self._channels = channels
        self._clock = clock
        self._environment = dict(os.environ if environment is None else environment)
        self._stop_timeout = stop_timeout

        plan = resolve_start_order([addon.manifest for addon in addons])
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
        """Start every child that is not already running, in start order.

        A child that refuses to start — an unreachable Anytype, say — raises out of here
        rather than being skipped, because the caller, not this module, decides whether a host
        with no MCP server is a host worth having.
        """
        return tuple(
            self.start(child_id) for child_id in self._order if child_id not in self._running
        )

    def start(self, child_id: str) -> ChildRecord:
        """Spawn one child and record its identity."""
        self._require_known(child_id)
        if child_id in self._running:
            raise ChildError(f"{child_id} is already running; stop it before starting it again")

        argv: Sequence[str]
        process: ChildProcess

        # `_require_known` has already refused the MCP child on a host that has none, so the
        # `is not None` here is what says that to the type checker rather than a second check.
        mcp = self._mcp
        if child_id == MCP_CHILD_ID and mcp is not None:
            # Driven, not duplicated: the argv, the environment and the health gate in front
            # of the spawn are all `innytypes.anytype_mcp`'s, and the pinned package spec
            # reaches the injected spawn from there.
            argv = mcp.command()
            process = mcp.start()
        else:
            addon = self._addons[child_id]
            argv = addon_command(addon)
            process = self._spawn_addon(child_id, argv=argv, manifest=addon.manifest)

        record = ChildRecord(
            id=child_id,
            kind=_kind_of(child_id),
            pid=process.pid,
            started_at=self._clock(),
            executable=_resolve_executable(argv[0]),
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

        mcp = self._mcp
        if child_id == MCP_CHILD_ID and mcp is not None:
            # Its own supervisor escalates terminate to kill and clears its state.
            mcp.stop(timeout=self._stop_timeout)
        else:
            _stop_process(running.process, timeout=self._stop_timeout)

        return self._finish(child_id, expected=True).exit_code

    def kill(self, child_id: str) -> int | None:
        """Kill one child outright, with no polite stop first. Returns its exit code."""
        self._require_known(child_id)
        running = self._running.get(child_id)
        if running is None:
            return None

        running.process.kill()
        running.process.wait()
        mcp = self._mcp
        if child_id == MCP_CHILD_ID and mcp is not None:
            # The child is already gone; this is what clears the supervisor's own handle on
            # it, and it reports the death rather than terminating anything a second time.
            mcp.stop(timeout=self._stop_timeout)

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
            case CommandName.RESTART:
                return CommandResult(name=command.name, children=(self.restart(_named(command)),))
            case CommandName.STOP:
                self.stop(_named(command))
                return CommandResult(name=command.name)
            case CommandName.KILL:
                self.kill(_named(command))
                return CommandResult(name=command.name)

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
        """
        channel = self._channels.open(child_id, manifest)
        try:
            return self._spawn(argv, dict(self._environment), channel=channel)
        except BaseException:
            # A child that was never spawned must not leave a channel the host will wait on.
            self._channels.close(child_id)
            raise
        finally:
            if channel is not None:
                os.close(channel)

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
    """The path the OS will report for this child, as far as the host can know it.

    ``PATH`` is resolved here rather than left to the helper, because the helper compares this
    string against the executable it reads from the process table: `npx` is not a path and
    would never match. What cannot be resolved is recorded verbatim, which is honest about
    what was asked for.
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
