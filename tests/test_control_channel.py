"""The control channel, with both ends in this test and nothing spawned, opened or slept on.

The helper and the host are two processes in production. Here they are two objects and one
real ``AF_UNIX`` socket under ``tmp_path``: the helper's :class:`ControlListener` owns the
socket exactly as it does on a real machine, the host's :class:`HelperLink` connects to it, and
the commands are carried out by a **real** :class:`~innytypes.children.ChildSupervisor` whose
only fake is the spawn. So what is asserted below is the wire, the framing, the permissions and
the refusals, not a mock of them.

Three things this file refuses to do, because each of them would hide the defect this slice
exists to fix:

* **No process is spawned.** The supervisor's `spawn` hands back a :class:`FakeProcess`, and
  the host's end of the channel is this test's own thread.
* **No real user socket.** Every path is under ``tmp_path``; the per-user runtime directory is
  never touched.
* **No sleeping.** The deadline that makes an unanswered command a *named* failure is proved
  against a connection that answers ``None`` at once — a test that waited out a real timeout
  would be a test that passes slowly whether or not the deadline exists. The connection that
  never answers also fails the run after a handful of reads, so an implementation that ignored
  the deadline goes red rather than hanging.
"""

from __future__ import annotations

import logging
import os
import shutil
import socket
import stat
import tempfile
import threading
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from platformdirs import user_runtime_path

from innytypes import HOST_API_VERSION
from innytypes.addons.discovery import ENVIRONMENT_DIRNAME, MANIFEST_FILENAME, InstalledAddon
from innytypes.addons.manifest import AddonManifest, parse_manifest
from innytypes.children import (
    ChildExit,
    ChildKind,
    ChildRecord,
    ChildSupervisor,
    Command,
    CommandName,
    CommandResult,
    RunStateFile,
)
from innytypes.helper.breaker import HOST_ID
from innytypes.helper.config import APPLICATION_NAME
from innytypes.helper.control import (
    CONTROL_SOCKET_NAME,
    CommandRefusedError,
    ControlLinkError,
    ControlListener,
    ControlProtocolError,
    ControlSocketError,
    HelperLink,
    HostLink,
    HostNotRunningError,
    HostSilentError,
    SocketConnection,
    connect_to_helper,
    default_control_socket_path,
    encode_exit,
    encode_hello,
    encode_result,
    recorded_host_pid,
)
from innytypes.helper.heartbeat import RUNTIME_DIR_MODE, SOCKET_MODE
from innytypes.helper.restart import RestartPolicy, ScheduledRestart

# How long a blocking wait may go unreleased before this test calls the run broken. Nothing
# that passes ever waits this long: every wait below is released by the test's own next action.
TIMEOUT = 10.0

# The clock the supervisor records start times against — counting, not passing.
FIRST_TICK = 1_700_000_000.0

# A Unix domain socket path is limited to about 104 bytes on macOS, and pytest's `tmp_path` on
# this platform is most of that on its own — the same constraint the heartbeat socket's tests
# already work around, and worked around the same way.
_SOCKET_PATH_LIMIT = 100


class FakeProcess:
    """Enough of a ``Popen`` for a child to be started, stopped, killed and to die on its own."""

    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode

    def crash(self, exit_code: int = 17) -> None:
        """The child dies on its own, which is what the host notices on its next poll."""
        self.returncode = exit_code


class FakeClock:
    """A clock that counts instead of passing, so a start time is a fact a test can name."""

    def __init__(self) -> None:
        self.readings = 0

    def __call__(self) -> float:
        reading = FIRST_TICK + self.readings
        self.readings += 1
        return reading


def manifest(addon_id: str) -> AddonManifest:
    """One parsed manifest, so no test invents a shape the grammar would refuse."""
    return parse_manifest(
        {
            "id": addon_id,
            "version": "1.0.0",
            "host_api": HOST_API_VERSION,
            "requires": [],
            "emits": [],
            "subscribes": [],
        }
    )


def installed(root: Path, addon_manifest: AddonManifest) -> InstalledAddon:
    """One addon as discovery would report it, without anything being written to disk."""
    addon_root = root / addon_manifest.id
    return InstalledAddon(
        id=addon_manifest.id,
        manifest=addon_manifest,
        root=addon_root,
        environment=addon_root / ENVIRONMENT_DIRNAME,
        manifest_path=addon_root / MANIFEST_FILENAME,
    )


@pytest.fixture
def socket_dir(tmp_path: Path) -> Iterator[Path]:
    """A directory to put real sockets in, short enough for the platform, removed afterwards."""
    if len(str(tmp_path / "c.sock")) <= _SOCKET_PATH_LIMIT:
        yield tmp_path
        return

    directory = Path(tempfile.mkdtemp(prefix="inny-"))
    try:
        yield directory
    finally:
        shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture
def socket_path(socket_dir: Path) -> Path:
    """The path of one real control socket, in a directory this test owns."""
    return socket_dir / "c.sock"


def dial(path: Path) -> SocketConnection:
    """One raw connection to the helper's socket, for the peers that are not a whole host."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(str(path))
    return SocketConnection(sock)


@dataclass
class Wire:
    """Both ends of the control channel, plus everything a test needs to assert about them."""

    path: Path
    listener: ControlListener
    policy: RestartPolicy
    supervisor: ChildSupervisor
    host: HelperLink
    # Every exit report that reached the helper, in the order it arrived.
    exits: list[ChildExit] = field(default_factory=list)
    # What the restart policy decided about each of them.
    decisions: list[ScheduledRestart | None] = field(default_factory=list)
    processes: dict[int, FakeProcess] = field(default_factory=dict)
    spawns: list[list[str]] = field(default_factory=list)
    _serving: threading.Thread | None = None

    def serve(self) -> None:
        """Run the host's reader thread, which is what a host process does with its link."""
        self._serving = threading.Thread(target=self.host.serve, name="host-control", daemon=True)
        self._serving.start()

    def process_for(self, child_id: str) -> FakeProcess:
        """The fake process behind one live child."""
        record = next(record for record in self.supervisor.running() if record.id == child_id)
        return self.processes[record.pid]

    def join_serving(self) -> None:
        """Wait for the host's reader thread to end, which closing the helper's end does."""
        if self._serving is not None:
            self._serving.join(timeout=TIMEOUT)
            assert not self._serving.is_alive(), "the host's reader thread never ended"

    def stop_serving(self) -> None:
        """Close the helper's end, which is what ends the host's reader thread."""
        self.listener.close()
        self.join_serving()
        self.host.close()


@pytest.fixture
def wire(tmp_path: Path, socket_path: Path) -> Iterator[Wire]:
    """A connected helper and host: one socket, one verified peer, two real halves."""
    path = socket_path
    processes: dict[int, FakeProcess] = {}
    spawns: list[list[str]] = []
    exits: list[ChildExit] = []
    decisions: list[ScheduledRestart | None] = []
    policies: list[RestartPolicy] = []

    def report(exit_report: ChildExit) -> None:
        """What the helper does with an exit: record it, and hand it to the one policy."""
        exits.append(exit_report)
        decisions.append(policies[0].child_exited(exit_report))

    listener = ControlListener(
        path,
        report_exit=report,
        host_pid=os.getpid,
        timeout=TIMEOUT,
    )
    listener.open()
    policy = RestartPolicy(channel=listener)
    policies.append(policy)

    def spawn(
        argv: Sequence[str], env: dict[str, str], *, channel: int | None = None
    ) -> FakeProcess:
        spawns.append(list(argv))
        # Process IDs that could not collide with this test runner's own.
        process = FakeProcess(pid=90_000 + len(spawns))
        processes[process.pid] = process
        return process

    supervisors: list[ChildSupervisor] = []

    def execute(command: Command) -> CommandResult:
        return supervisors[0].execute(command)

    host = HelperLink(dial(path), execute=execute)
    host.announce()

    supervisor = ChildSupervisor(
        mcp=None,
        addons=[installed(tmp_path, manifest("alpha")), installed(tmp_path, manifest("beta"))],
        run_state=RunStateFile(tmp_path / "run-state.json"),
        report_exit=host.report_exit,
        spawn=spawn,  # type: ignore[arg-type]
        clock=FakeClock(),
        environment={"PATH": "/nonexistent"},
    )
    supervisors.append(supervisor)

    # The hello is read here, so every test below starts with a host that is connected.
    listener.poll()
    assert listener.host is not None, "the host this helper started was not accepted"

    open_wire = Wire(
        path=path,
        listener=listener,
        policy=policy,
        supervisor=supervisor,
        host=host,
        exits=exits,
        decisions=decisions,
        processes=processes,
        spawns=spawns,
    )
    yield open_wire
    open_wire.stop_serving()


# --- every command reaches the host, is carried out, and is answered -------------------------


def test_start_reaches_the_host_and_answers_with_the_child_it_started(wire: Wire) -> None:
    wire.serve()

    result = wire.policy.start("alpha")

    assert result.name is CommandName.START
    assert [record.id for record in result.children] == ["alpha"]
    assert [record.id for record in wire.supervisor.running()] == ["alpha"]
    # The answer is the host's own record, not something the helper made up on this side.
    assert result.children[0].pid == wire.process_for("alpha").pid


def test_list_answers_with_every_child_the_host_is_running(wire: Wire) -> None:
    wire.serve()
    wire.policy.start("alpha")
    wire.policy.start("beta")

    result = wire.policy.list_children()

    assert result.name is CommandName.LIST
    assert [record.id for record in result.children] == ["alpha", "beta"]


def test_stop_reaches_the_host_and_the_child_is_gone(wire: Wire) -> None:
    wire.serve()
    wire.policy.start("alpha")
    process = wire.process_for("alpha")

    result = wire.policy.stop("alpha")

    assert result.name is CommandName.STOP
    assert result.children == ()
    assert process.terminated
    assert wire.supervisor.running() == ()


def test_restart_reaches_the_host_and_replaces_the_process(wire: Wire) -> None:
    wire.serve()
    wire.policy.start("alpha")
    first = wire.process_for("alpha")

    result = wire.policy.restart("alpha")

    assert result.name is CommandName.RESTART
    assert first.terminated
    assert result.children[0].pid != first.pid
    assert result.children[0].pid == wire.process_for("alpha").pid


def test_kill_reaches_the_host_and_the_child_is_killed_rather_than_asked(wire: Wire) -> None:
    wire.serve()
    wire.policy.start("alpha")
    process = wire.process_for("alpha")

    result = wire.policy.kill("alpha")

    assert result.name is CommandName.KILL
    assert process.killed
    assert not process.terminated


def test_restart_group_stops_every_member_before_starting_any_of_them(wire: Wire) -> None:
    wire.serve()
    wire.policy.start("alpha")
    wire.policy.start("beta")
    before = [wire.process_for("alpha").pid, wire.process_for("beta").pid]

    result = wire.policy.restart_group(("alpha", "beta"))

    assert result.name is CommandName.RESTART_GROUP
    assert [record.id for record in result.children] == ["alpha", "beta"]
    assert [record.pid for record in result.children] != before
    assert all(wire.processes[pid].terminated for pid in before)


def test_a_command_naming_a_child_the_host_does_not_have_is_refused_by_name(wire: Wire) -> None:
    """A refusal crosses the wire as a refusal. Silence would look like a host that is stale."""
    wire.serve()

    with pytest.raises(CommandRefusedError, match="whodunnit"):
        wire.policy.start("whodunnit")

    # And the channel is still usable afterwards: a disagreement is not a broken connection.
    assert wire.policy.list_children().children == ()


# --- the three ways this fails, each named rather than hung ----------------------------------


def test_a_command_with_no_host_connected_is_refused_and_nothing_is_sent(
    socket_path: Path,
) -> None:
    listener = ControlListener(
        socket_path,
        report_exit=lambda _: None,
        host_pid=os.getpid,
    )
    with listener:
        policy = RestartPolicy(channel=listener)

        with pytest.raises(HostNotRunningError, match="no host is connected"):
            policy.start("alpha")


def test_a_connection_that_drops_mid_command_is_told_apart_from_a_host_that_is_silent(
    socket_path: Path,
) -> None:
    """The host takes the command and goes. That is a dropped link, not silence.

    The difference matters because the two say different things about the world: a command on
    a dropped connection may still have been carried out by a host that is now gone, and a
    command on a live connection that is not answered is a host that has stopped working.
    """
    path = socket_path
    listener = ControlListener(path, report_exit=lambda _: None, host_pid=os.getpid)
    with listener:
        peer = dial(path)
        peer.send(encode_hello(os.getpid()))
        listener.poll()
        assert listener.host is not None

        def take_it_and_go() -> None:
            assert peer.receive(timeout=TIMEOUT) is not None, "the command never arrived"
            peer.close()

        rude = threading.Thread(target=take_it_and_go, name="rude-host", daemon=True)
        rude.start()

        policy = RestartPolicy(channel=listener)
        with pytest.raises(ControlLinkError):
            policy.start("alpha")

        rude.join(timeout=TIMEOUT)
        # A connection that dropped is not a host any more, so the next command says so
        # plainly instead of writing into a socket nobody holds.
        with pytest.raises(HostNotRunningError):
            policy.start("alpha")


class ScriptedConnection:
    """A connection that answers with the frames a test queued, and then stops answering.

    It fails the run after a handful of empty reads rather than answering ``None`` for ever,
    so an implementation that ignored its deadline goes red here instead of hanging the gate.
    """

    def __init__(self, frames: Sequence[str] = ()) -> None:
        self.frames = list(frames)
        self.sent: list[str] = []
        self.empty_reads = 0

    def send(self, frame: str) -> None:
        self.sent.append(frame)

    def receive(self, timeout: float | None) -> str | None:
        if self.frames:
            return self.frames.pop(0)
        self.empty_reads += 1
        assert self.empty_reads <= 5, "the deadline was ignored: this connection never answers"
        return None

    def close(self) -> None:
        pass


def test_a_command_the_host_never_answers_is_named_silence_and_makes_it_stale() -> None:
    """Plan 0003: *the host does not answer a command → the helper treats the host as stale*."""
    connection = ScriptedConnection()
    link = HostLink(connection=connection, report_exit=lambda _: None, timeout=5.0)
    policy = RestartPolicy(channel=link)

    with pytest.raises(HostSilentError, match="stale"):
        policy.restart("alpha")

    # The command did go out — this is silence, not a host that was never reached.
    assert connection.sent, "the command was never put on the wire"

    # And what the helper does about it is the stale path the policy already owns.
    scheduled = policy.child_stale(HOST_ID)
    assert scheduled is not None
    assert scheduled.reason == "stale"


def test_an_answer_that_arrives_too_late_is_not_handed_back_as_the_next_one() -> None:
    """What the request number is for: a late answer belongs to a command nobody is waiting on.

    Without it, the answer to the command the helper gave up on would be read as the answer to
    the next one — and the helper would be told a plugin had started when what it heard was a
    stale reply about a different command entirely.
    """
    connection = ScriptedConnection()
    link = HostLink(connection=connection, report_exit=lambda _: None, timeout=5.0)

    with pytest.raises(HostSilentError):
        link.send(Command(name=CommandName.START, child_id="alpha"))

    # The host answers the first command now, far too late, and then the second one.
    connection.frames = [
        encode_result(1, CommandResult(name=CommandName.START)),
        encode_result(2, CommandResult(name=CommandName.LIST)),
    ]
    assert link.send(Command(name=CommandName.LIST)).name is CommandName.LIST


# --- owner-only, and only the host this helper started ---------------------------------------


def test_the_control_socket_is_owner_only_in_an_owner_only_directory(socket_dir: Path) -> None:
    runtime = socket_dir / "r"
    # Deliberately created world-readable first: the listener must not inherit that.
    runtime.mkdir(mode=0o755)

    listener = ControlListener(runtime / "c.sock", report_exit=lambda _: None, host_pid=os.getpid)
    with listener:
        assert stat.S_IMODE(listener.path.stat().st_mode) == SOCKET_MODE
        assert stat.S_IMODE(runtime.stat().st_mode) == RUNTIME_DIR_MODE


def test_a_peer_that_is_not_the_host_this_helper_started_is_refused(socket_path: Path) -> None:
    path = socket_path
    listener = ControlListener(path, report_exit=lambda _: None, host_pid=lambda: 4321)
    with listener:
        stranger = dial(path)
        stranger.send(encode_hello(os.getpid()))

        listener.poll()

        assert listener.host is None
        assert listener.refusals == 1
        with pytest.raises(HostNotRunningError):
            listener.send(Command(name=CommandName.LIST))

        # The host this helper *did* start is accepted on the same socket, which is what makes
        # the refusal above a check rather than a socket that accepts nobody.
        ours = dial(path)
        ours.send(encode_hello(4321))
        listener.poll()
        assert listener.host is not None
        ours.close()
        stranger.close()


def test_a_peer_whose_first_frame_is_not_a_hello_is_refused(socket_path: Path) -> None:
    path = socket_path
    listener = ControlListener(path, report_exit=lambda _: None, host_pid=os.getpid)
    with listener:
        peer = dial(path)
        peer.send(
            encode_exit(
                ChildExit(id="alpha", kind=ChildKind.ADDON, pid=1, exit_code=0, expected=False)
            )
        )

        listener.poll()

        assert listener.host is None
        assert listener.refusals == 1
        peer.close()


def test_the_helper_refuses_every_peer_while_it_does_not_know_which_host_is_its_own(
    socket_path: Path,
) -> None:
    """A helper that has lost its own host record takes nobody's word for it."""
    path = socket_path
    listener = ControlListener(path, report_exit=lambda _: None, host_pid=lambda: None)
    with listener:
        peer = dial(path)
        peer.send(encode_hello(os.getpid()))

        listener.poll()

        assert listener.host is None
        assert listener.refusals == 1
        peer.close()


def test_the_socket_path_is_the_per_user_runtime_directory_beside_the_heartbeat() -> None:
    """Named, not created: this is the one test that looks at the real per-user path."""
    assert default_control_socket_path() == (
        user_runtime_path(APPLICATION_NAME, appauthor=False) / CONTROL_SOCKET_NAME
    )


def test_a_path_that_is_not_a_socket_is_refused_rather_than_replaced(socket_path: Path) -> None:
    path = socket_path
    path.write_text("something a person put here")

    listener = ControlListener(path, report_exit=lambda _: None, host_pid=os.getpid)
    with pytest.raises(ControlSocketError, match="not a socket"):
        listener.open()

    assert path.read_text() == "something a person put here"


def test_a_second_helper_will_not_take_a_socket_another_one_is_listening_on(
    socket_path: Path,
) -> None:
    path = socket_path
    first = ControlListener(path, report_exit=lambda _: None, host_pid=os.getpid)
    with first:
        second = ControlListener(path, report_exit=lambda _: None, host_pid=os.getpid)
        with pytest.raises(ControlSocketError, match="another helper"):
            second.open()


def test_no_helper_listening_is_what_the_host_is_told_when_it_connects(tmp_path: Path) -> None:
    with pytest.raises(ControlSocketError, match="no helper is listening"):
        connect_to_helper(
            execute=lambda command: CommandResult(name=command.name),
            path=tmp_path / "nothing.sock",
        )


def test_the_expected_host_is_the_one_in_the_run_state_file(tmp_path: Path) -> None:
    """Read on every question, because the helper rewrites it every time it starts a host."""
    run_state = RunStateFile(tmp_path / "run-state.json")
    pid_of_the_host = recorded_host_pid(run_state)

    assert pid_of_the_host() is None

    run_state.write(
        ChildRecord(
            id=HOST_ID,
            kind=ChildKind.HOST,
            pid=5150,
            started_at=FIRST_TICK,
            executable="/usr/bin/python3",
            parent_pid=1,
        )
    )
    assert pid_of_the_host() == 5150

    run_state.write(
        ChildRecord(
            id=HOST_ID,
            kind=ChildKind.HOST,
            pid=5151,
            started_at=FIRST_TICK,
            executable="/usr/bin/python3",
            parent_pid=1,
        )
    )
    assert pid_of_the_host() == 5151


# --- every child exit reaches the helper's restart policy over the same connection -----------


def test_a_child_that_crashes_reaches_the_restart_policy_without_anything_being_polled(
    wire: Wire,
) -> None:
    """The host notices, writes it on the wire, and the helper's policy schedules the return."""
    wire.serve()
    wire.policy.start("alpha")
    wire.process_for("alpha").crash(exit_code=17)

    # The host's own supervise loop is what notices a child that died; nothing here reads a
    # file, and the helper is told over the connection it already has.
    wire.supervisor.poll()
    assert wire.listener.poll() == 1

    assert [report.id for report in wire.exits] == ["alpha"]
    assert wire.exits[0].exit_code == 17
    assert wire.exits[0].expected is False
    assert wire.decisions[0] is not None
    assert wire.policy.state("alpha").attempts == 1


def test_a_stop_the_host_asked_for_is_still_expected_when_it_reaches_the_helper(
    wire: Wire,
) -> None:
    """The exit rides ahead of the answer on the same wire, and keeps its one load-bearing bit.

    ``expected`` is what stops a deliberate stop from being undone by the restart policy. It is
    set by the host, inside the stop the helper asked for, and it has to survive the crossing.
    """
    wire.serve()
    wire.policy.start("alpha")

    wire.policy.stop("alpha")

    assert [report.id for report in wire.exits] == ["alpha"]
    assert wire.exits[0].expected is True
    assert wire.exits[0].kind is ChildKind.ADDON
    # Nothing is scheduled: the helper does not undo a stop it asked for.
    assert wire.decisions == [None]
    assert wire.policy.pending == ()


def test_an_exit_the_host_reports_with_no_helper_left_does_not_break_the_stop(
    wire: Wire,
) -> None:
    """What the host does when the helper goes away: it notices, and keeps its children.

    An exception out of the exit report would turn "nobody heard that the plugin stopped" into
    "the plugin could not be stopped", inside the supervisor's own stop path.
    """
    wire.serve()
    wire.policy.start("alpha")
    process = wire.process_for("alpha")

    wire.listener.close()
    # The host's reader thread ends on its own when the helper's end closes — that is how the
    # host finds out, without polling anything.
    wire.join_serving()
    assert not wire.host.alive

    wire.supervisor.stop("alpha")

    assert process.terminated
    assert wire.exits == []


# --- the frames themselves --------------------------------------------------------------


def test_a_host_that_talks_nonsense_is_dropped_rather_than_read_out_of_step(
    socket_path: Path,
) -> None:
    """A frame this channel does not speak leaves the stream out of step; the peer goes."""
    path = socket_path
    listener = ControlListener(path, report_exit=lambda _: None, host_pid=os.getpid)
    with listener:
        peer = dial(path)
        peer.send(encode_hello(os.getpid()))
        listener.poll()
        assert listener.host is not None

        peer.send('{"type": "cheerio"}')
        assert listener.poll() == 0

        assert listener.host is None
        with pytest.raises(HostNotRunningError):
            listener.send(Command(name=CommandName.LIST))
        peer.close()


def test_a_command_the_host_cannot_answer_does_not_end_its_reader() -> None:
    """A host that died because a command raised would be worse than the disagreement."""
    calls: list[Command] = []

    def explode(command: Command) -> CommandResult:
        calls.append(command)
        raise RuntimeError("the machine is on fire")

    helper_end, host_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    host = HelperLink(SocketConnection(host_end), execute=explode, pid=4321)
    helper = HostLink(
        connection=SocketConnection(helper_end), report_exit=lambda _: None, timeout=1.0
    )

    serving = threading.Thread(target=host.serve, name="host-control", daemon=True)
    serving.start()
    try:
        with pytest.raises(CommandRefusedError, match="the machine is on fire"):
            helper.send(Command(name=CommandName.LIST))

        # Still serving: the second command is answered the same way rather than lost.
        with pytest.raises(CommandRefusedError):
            helper.send(Command(name=CommandName.LIST))
        assert len(calls) == 2
    finally:
        helper.close()
        serving.join(timeout=TIMEOUT)
        host.close()


def test_an_exit_report_survives_the_crossing_unchanged() -> None:
    """Every field the restart policy reads is the one the host wrote, including a missing code."""
    reported: list[ChildExit] = []
    original = ChildExit(
        id="alpha", kind=ChildKind.ADDON, pid=90_001, exit_code=None, expected=True
    )
    link = HostLink(
        connection=ScriptedConnection([encode_exit(original)]),
        report_exit=reported.append,
        timeout=1.0,
    )

    assert link.pump() == 1
    assert reported == [original]


def nothing_to_do(command: Command) -> CommandResult:
    """A host that carries out nothing, for the tests that are about the wire itself."""
    return CommandResult(name=command.name)


def test_the_host_connects_through_the_helpers_socket_and_is_accepted(socket_path: Path) -> None:
    """The production pair: the helper's listener and `connect_to_helper`, one command across."""
    listener = ControlListener(socket_path, report_exit=lambda _: None, host_pid=os.getpid)
    with listener:
        host = connect_to_helper(execute=nothing_to_do, path=socket_path)
        serving = threading.Thread(target=host.serve, name="host-control", daemon=True)
        serving.start()
        try:
            assert listener.send(Command(name=CommandName.LIST)).name is CommandName.LIST
        finally:
            listener.close()
            serving.join(timeout=TIMEOUT)
            host.close()

        assert not serving.is_alive(), "the host kept serving a helper that had gone"


def test_a_socket_nobody_answers_is_replaced(socket_path: Path) -> None:
    """A leftover from a helper that died is not a reason this one cannot start."""
    orphan = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    orphan.bind(str(socket_path))
    orphan.close()

    listener = ControlListener(socket_path, report_exit=lambda _: None, host_pid=os.getpid)
    with listener:
        peer = dial(socket_path)
        peer.send(encode_hello(os.getpid()))
        listener.poll()
        assert listener.host is not None
        peer.close()


def test_closing_the_listener_removes_the_socket(socket_path: Path) -> None:
    listener = ControlListener(socket_path, report_exit=lambda _: None, host_pid=os.getpid)
    listener.open()
    assert socket_path.is_socket()

    listener.close()

    assert not socket_path.exists()


def test_a_new_host_replaces_the_connection_of_the_one_before_it(socket_path: Path) -> None:
    """The helper restarted the host; the old connection belongs to a process that is gone."""
    whose_host = [111]
    listener = ControlListener(
        socket_path, report_exit=lambda _: None, host_pid=lambda: whose_host[0]
    )
    with listener:
        old = dial(socket_path)
        old.send(encode_hello(111))
        listener.poll()
        first = listener.host
        assert first is not None

        whose_host[0] = 222
        new = dial(socket_path)
        new.send(encode_hello(222))
        listener.poll()

        assert listener.host is not None
        assert listener.host is not first
        with pytest.raises(ControlLinkError):
            old.receive(timeout=0.0)
        new.close()


@pytest.mark.parametrize(
    ("frame", "complaint"),
    [
        ("not json at all", "is JSON"),
        ("[1, 2]", "JSON object"),
        ('{"type": 7}', "must be text"),
        ('{"type": "cheerio"}', "does not speak"),
        ('{"type": "hello", "pid": 1}', "not something a host says"),
        (
            '{"type": "exit", "id": "a", "kind": "gremlin", "pid": 1, "exit_code": 0,'
            ' "expected": false}',
            "kind of managed process",
        ),
        (
            '{"type": "exit", "id": "a", "kind": "addon", "pid": 1, "exit_code": "nine",'
            ' "expected": false}',
            "whole number or nothing",
        ),
        (
            '{"type": "exit", "id": "a", "kind": "addon", "pid": 1, "exit_code": 0}',
            "never guessed at",
        ),
        (
            '{"type": "exit", "kind": "addon", "pid": 1, "exit_code": 0, "expected": false}',
            "missing id",
        ),
        (
            '{"type": "exit", "id": "a", "kind": "addon", "pid": "one", "exit_code": 0,'
            ' "expected": false}',
            "whole number",
        ),
    ],
)
def test_a_frame_the_helper_cannot_read_is_refused_by_name(frame: str, complaint: str) -> None:
    """Every refusal names the field. A frame read past would be a fact quietly invented."""
    link = HostLink(connection=ScriptedConnection([frame]), report_exit=lambda _: None, timeout=1.0)

    with pytest.raises(ControlProtocolError, match=complaint):
        link.pump()


@pytest.mark.parametrize(
    ("frame", "complaint"),
    [
        ('{"type": "result", "name": "list"}', "missing request"),
        ('{"type": "result", "request": 1, "name": "fly"}', "not a command name"),
        (
            '{"type": "result", "request": 1, "name": "list", "children": "alpha"}',
            "list of records",
        ),
        (
            '{"type": "result", "request": 1, "name": "list", "children": ["alpha"]}',
            "records, and one is",
        ),
        (
            '{"type": "result", "request": 1, "name": "list", "children": [{"id": "a"}]}',
            "not a child record",
        ),
    ],
)
def test_an_answer_the_helper_cannot_read_is_refused_by_name(frame: str, complaint: str) -> None:
    link = HostLink(connection=ScriptedConnection([frame]), report_exit=lambda _: None, timeout=1.0)

    with pytest.raises(ControlProtocolError, match=complaint):
        link.send(Command(name=CommandName.LIST))


@pytest.mark.parametrize(
    ("frame", "complaint"),
    [
        ('{"type": "result", "request": 1, "name": "list"}', "not a command"),
        ('{"type": "command", "request": 1, "name": "levitate"}', "not a command this host"),
        (
            '{"type": "command", "request": 1, "name": "start", "child_id": 7}',
            "child_id is the child's name",
        ),
        (
            '{"type": "command", "request": 1, "name": "restart-group", "group": "alpha"}',
            "list of child names",
        ),
    ],
)
def test_a_command_the_host_cannot_read_ends_its_reader_rather_than_being_guessed_at(
    frame: str, complaint: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Out of step is out of step: the host stops serving rather than reading the next frame."""
    caplog.set_level(logging.ERROR)
    link = HelperLink(ScriptedConnection([frame]), execute=nothing_to_do)

    assert link.serve_one() is False
    assert not link.alive
    assert complaint in caplog.text


def test_a_listener_that_is_not_open_says_so_rather_than_answering(socket_path: Path) -> None:
    listener = ControlListener(socket_path, report_exit=lambda _: None, host_pid=os.getpid)

    with pytest.raises(ControlSocketError, match="is not open"):
        listener.poll()

    with listener, pytest.raises(ControlSocketError, match="already open"):
        listener.open()


def test_a_peer_that_goes_before_it_says_who_it_is_is_dropped(socket_path: Path) -> None:
    listener = ControlListener(socket_path, report_exit=lambda _: None, host_pid=os.getpid)
    with listener:
        dial(socket_path).close()

        assert listener.poll() == 0

        assert listener.host is None


def test_a_host_link_that_has_been_closed_serves_nothing_more() -> None:
    link = HelperLink(ScriptedConnection(), execute=nothing_to_do)
    link.close()

    assert link.serve_one() is False


def test_a_run_state_file_that_cannot_be_read_names_no_host_at_all(tmp_path: Path) -> None:
    """A helper that has lost track of its own host takes nobody's word for which one it is."""
    broken = tmp_path / "run-state.json"
    broken.write_text("{ not json", encoding="utf-8")

    assert recorded_host_pid(RunStateFile(broken))() is None


def test_a_peer_that_never_ends_a_frame_is_cut_off_rather_than_buffered_for_ever() -> None:
    """The bound that stops one end growing the other's memory without sending anything."""
    one, other = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    connection = SocketConnection(one, max_frame_bytes=16)
    try:
        other.sendall(b"a" * 32)

        with pytest.raises(ControlProtocolError, match="no end of frame"):
            connection.receive(timeout=0.0)
    finally:
        connection.close()
        other.close()


def test_a_frame_that_is_not_utf_8_is_refused_rather_than_guessed_at() -> None:
    one, other = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    connection = SocketConnection(one)
    try:
        other.sendall(b"\xff\xfe\n")

        with pytest.raises(ControlProtocolError, match="UTF-8"):
            connection.receive(timeout=0.0)
    finally:
        connection.close()
        other.close()


class GoneConnection(ScriptedConnection):
    """A connection whose far end has gone, which is what every write finds out."""

    def send(self, frame: str) -> None:
        raise ControlLinkError("the helper is gone")


def test_an_exit_nobody_is_left_to_hear_is_logged_rather_than_raised() -> None:
    """Inside the supervisor's own stop path, so a raise here would fail the stop itself."""
    link = HelperLink(GoneConnection(), execute=nothing_to_do)

    link.report_exit(
        ChildExit(id="alpha", kind=ChildKind.ADDON, pid=90_001, exit_code=0, expected=True)
    )

    assert not link.alive
