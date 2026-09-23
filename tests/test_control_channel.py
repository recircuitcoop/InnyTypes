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

The last section is the exception to the first sentence, and the reason this file exists in
two halves. Everything above drives both ends over a connection **this test made**, which is
exactly how `WI-0003-18` could pass honestly while nothing in the shipped application joined
the two: the helper opened its socket and the host it started dialled nothing. Those tests are
about the protocol and they still are. The section headed *the assembled channel* is about the
join: it runs the real `innytypes up` — the command the helper starts the host with — hands it
nothing to connect through, and asserts that it finds the helper by itself (plan 0008, slice
03). The socket both ends meet on is still not this machine's own: `conftest.control_socket_
path` gives every test one of its own, and both ends read it through the same function they
read in production.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import stat
import tempfile
import threading
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from functools import partial
from itertools import count
from pathlib import Path

import pytest
from click.testing import CliRunner, Result
from platformdirs import user_runtime_path

from innytypes import HOST_API_VERSION
from innytypes.addons.discovery import ENVIRONMENT_DIRNAME, MANIFEST_FILENAME, InstalledAddon
from innytypes.addons.manifest import AddonManifest, parse_manifest
from innytypes.anytype_mcp.config import ConfigError
from innytypes.anytype_mcp.supervisor import Supervisor
from innytypes.children import (
    MCP_CHILD_ID,
    ChildExit,
    ChildKind,
    ChildRecord,
    ChildStartFailure,
    ChildSupervisor,
    Command,
    CommandName,
    CommandResult,
    ExitReporter,
    RunStateFile,
    StartFailureReporter,
)
from innytypes.cli import CONTROL_CHANNEL_ID, BuildHost, CliContext, cli
from innytypes.helper.breaker import HOST_ID, Breaker, QuarantineFile
from innytypes.helper.config import (
    APPLICATION_NAME,
    BreakerSettings,
    HelperSettings,
    McpEndpoint,
    RestartSettings,
)
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
    encode_start_failure,
    recorded_host_pid,
)
from innytypes.helper.heartbeat import RUNTIME_DIR_MODE, SOCKET_MODE
from innytypes.helper.launcher import (
    Application,
    EndpointChange,
    EndpointOutcome,
    InstanceLock,
    QuitFile,
    move_endpoint,
)
from innytypes.helper.notification import NoticeFile, NoticeKind, RecordingNotifier
from innytypes.helper.processes import ManagedProcesses, ProcessFacts, SystemProcessTable
from innytypes.helper.restart import RestartPolicy, ScheduledRestart
from innytypes.helper.supervision import Pass, SupervisionTick, build_supervision
from innytypes.helper.update import UpdateError
from innytypes.host import Host, build_host
from test_anytype_mcp_gateway import free_port

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
        report_start_failure=lambda _: None,
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
        report_start_failure=lambda _: None,
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
        report_start_failure=lambda _: None,
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
    listener = ControlListener(
        path, report_exit=lambda _: None, report_start_failure=lambda _: None, host_pid=os.getpid
    )
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
    link = HostLink(
        connection=connection,
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        timeout=5.0,
    )
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
    link = HostLink(
        connection=connection,
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        timeout=5.0,
    )

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

    listener = ControlListener(
        runtime / "c.sock",
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        host_pid=os.getpid,
    )
    with listener:
        assert stat.S_IMODE(listener.path.stat().st_mode) == SOCKET_MODE
        assert stat.S_IMODE(runtime.stat().st_mode) == RUNTIME_DIR_MODE


def test_a_peer_that_is_not_the_host_this_helper_started_is_refused(socket_path: Path) -> None:
    path = socket_path
    listener = ControlListener(
        path, report_exit=lambda _: None, report_start_failure=lambda _: None, host_pid=lambda: 4321
    )
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
    listener = ControlListener(
        path, report_exit=lambda _: None, report_start_failure=lambda _: None, host_pid=os.getpid
    )
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
    listener = ControlListener(
        path, report_exit=lambda _: None, report_start_failure=lambda _: None, host_pid=lambda: None
    )
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

    listener = ControlListener(
        path, report_exit=lambda _: None, report_start_failure=lambda _: None, host_pid=os.getpid
    )
    with pytest.raises(ControlSocketError, match="not a socket"):
        listener.open()

    assert path.read_text() == "something a person put here"


def test_a_second_helper_will_not_take_a_socket_another_one_is_listening_on(
    socket_path: Path,
) -> None:
    path = socket_path
    first = ControlListener(
        path, report_exit=lambda _: None, report_start_failure=lambda _: None, host_pid=os.getpid
    )
    with first:
        second = ControlListener(
            path,
            report_exit=lambda _: None,
            report_start_failure=lambda _: None,
            host_pid=os.getpid,
        )
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
    listener = ControlListener(
        path, report_exit=lambda _: None, report_start_failure=lambda _: None, host_pid=os.getpid
    )
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
        connection=SocketConnection(helper_end),
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        timeout=1.0,
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
        report_start_failure=lambda _: None,
        timeout=1.0,
    )

    assert link.pump() == 1
    assert reported == [original]


def test_a_start_failure_survives_the_crossing_unchanged() -> None:
    """A child that never started reaches the helper with the child named and the reason whole.

    The reason is the whole point of the frame: it is the failure's own sentence, and it is
    what a person acts on. A crossing that truncated it, or that delivered the report to the
    exit reporter instead, would leave the helper knowing something happened and not what.
    """
    failures: list[ChildStartFailure] = []
    exits: list[ChildExit] = []
    original = ChildStartFailure(
        id=MCP_CHILD_ID,
        kind=ChildKind.MCP,
        reason=(
            "the Anytype MCP child could not initialize: live Anytype MCP tools differ from "
            "the committed surface: added=['chats'], removed=[], changed=['search']"
        ),
    )
    link = HostLink(
        connection=ScriptedConnection([encode_start_failure(original)]),
        report_exit=exits.append,
        report_start_failure=failures.append,
        timeout=1.0,
    )

    assert link.pump() == 1
    assert failures == [original]
    # The other reporter heard nothing: this is not an exit, and the two are not interchangeable.
    assert exits == []


def test_the_two_reports_reach_two_different_reporters() -> None:
    """One connection, two kinds of news, and the helper can tell them apart without parsing.

    Both frames arrive on the same wire in the same pump, and each is delivered to the
    reporter for its own fact. A single reporter taking both would make the restart policy
    read a message to find out whether a process ever existed.
    """
    failures: list[ChildStartFailure] = []
    exits: list[ChildExit] = []
    link = HostLink(
        connection=ScriptedConnection(
            [
                encode_exit(
                    ChildExit(
                        id="alpha", kind=ChildKind.ADDON, pid=90_001, exit_code=1, expected=False
                    )
                ),
                encode_start_failure(
                    ChildStartFailure(id="beta", kind=ChildKind.ADDON, reason="no interpreter")
                ),
            ]
        ),
        report_exit=exits.append,
        report_start_failure=failures.append,
        timeout=1.0,
    )

    assert link.pump() == 2
    assert [report.id for report in exits] == ["alpha"]
    assert [failure.id for failure in failures] == ["beta"]


def test_a_start_failure_frame_with_no_reason_is_refused() -> None:
    """The reason is not optional, because a report without one is the silence this replaced."""
    link = HostLink(
        connection=ScriptedConnection(
            [json.dumps({"type": "start-failed", "id": "alpha", "kind": "addon"})]
        ),
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        timeout=1.0,
    )

    with pytest.raises(ControlProtocolError, match="missing reason"):
        link.pump()


def test_a_start_failure_crosses_the_real_socket_to_the_helper(socket_path: Path) -> None:
    """The production pair, end to end: the host's reporter, the socket, the helper's.

    Not a :class:`ScriptedConnection`: this is
    :meth:`~innytypes.helper.control.HelperLink.report_start_failure` writing to a real
    ``AF_UNIX`` stream that the helper's own listener accepted and verified, which is the
    path the shipped application uses.
    """
    failures: list[ChildStartFailure] = []
    listener = ControlListener(
        socket_path,
        report_exit=lambda _: None,
        report_start_failure=failures.append,
        host_pid=os.getpid,
    )
    with listener:
        host = connect_to_helper(execute=nothing_to_do, path=socket_path)
        try:
            listener.poll()
            assert listener.host is not None, "the host never reached the helper"

            host.report_start_failure(
                ChildStartFailure(
                    id=MCP_CHILD_ID,
                    kind=ChildKind.MCP,
                    reason="Anytype's local API did not answer",
                )
            )
            assert listener.poll() == 1
        finally:
            host.close()

    assert [failure.id for failure in failures] == [MCP_CHILD_ID]
    assert failures[0].reason == "Anytype's local API did not answer"


def nothing_to_do(command: Command) -> CommandResult:
    """A host that carries out nothing, for the tests that are about the wire itself."""
    return CommandResult(name=command.name)


def test_the_host_connects_through_the_helpers_socket_and_is_accepted(socket_path: Path) -> None:
    """The production pair: the helper's listener and `connect_to_helper`, one command across."""
    listener = ControlListener(
        socket_path,
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        host_pid=os.getpid,
    )
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

    listener = ControlListener(
        socket_path,
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        host_pid=os.getpid,
    )
    with listener:
        peer = dial(socket_path)
        peer.send(encode_hello(os.getpid()))
        listener.poll()
        assert listener.host is not None
        peer.close()


def test_closing_the_listener_removes_the_socket(socket_path: Path) -> None:
    listener = ControlListener(
        socket_path,
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        host_pid=os.getpid,
    )
    listener.open()
    assert socket_path.is_socket()

    listener.close()

    assert not socket_path.exists()


def test_a_new_host_replaces_the_connection_of_the_one_before_it(socket_path: Path) -> None:
    """The helper restarted the host; the old connection belongs to a process that is gone."""
    whose_host = [111]
    listener = ControlListener(
        socket_path,
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        host_pid=lambda: whose_host[0],
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
    link = HostLink(
        connection=ScriptedConnection([frame]),
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        timeout=1.0,
    )

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
    link = HostLink(
        connection=ScriptedConnection([frame]),
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        timeout=1.0,
    )

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
    listener = ControlListener(
        socket_path,
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        host_pid=os.getpid,
    )

    with pytest.raises(ControlSocketError, match="is not open"):
        listener.poll()

    with listener, pytest.raises(ControlSocketError, match="already open"):
        listener.open()


def test_a_peer_that_goes_before_it_says_who_it_is_is_dropped(socket_path: Path) -> None:
    listener = ControlListener(
        socket_path,
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        host_pid=os.getpid,
    )
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


def test_a_failed_start_nobody_is_left_to_hear_is_logged_rather_than_raised() -> None:
    """Inside the supervisor's own start path, where a raise would replace the real failure.

    The caller is about to be handed the reason the child could not start. Raising here would
    substitute for it the entirely unrelated fact that nobody heard about it.
    """
    link = HelperLink(GoneConnection(), execute=nothing_to_do)

    link.report_start_failure(
        ChildStartFailure(id="alpha", kind=ChildKind.ADDON, reason="no interpreter")
    )

    assert not link.alive


# --- the assembled channel: what `innytypes up` connects to, by itself -----------------------


def record_addon(root: Path, addon_id: str) -> None:
    """One installed addon on disk, exactly as discovery expects to find it.

    Written out rather than handed over as an :class:`InstalledAddon`, because the host below
    is the production :func:`~innytypes.host.build_host` and that one discovers what is on
    disk. Nothing is installed: this is what `innytypes addons install` leaves behind.
    """
    addon_root = root / addon_id
    (addon_root / ENVIRONMENT_DIRNAME).mkdir(parents=True, exist_ok=True)
    (addon_root / MANIFEST_FILENAME).write_text(
        json.dumps(
            {
                "id": addon_id,
                "version": "1.0.0",
                "host_api": HOST_API_VERSION,
                "requires": [],
                "emits": [],
                "subscribes": [],
            }
        ),
        encoding="utf-8",
    )


def run_up_with(
    *,
    build: BuildHost,
    addons_root: Path,
    drive: Callable[[ChildSupervisor], None],
) -> Result:
    """Run the real `innytypes up`, with ``drive`` in the place of its wait.

    The two seams `up` already had — how it builds its host, and how it waits on it — and
    **not** a third one for the control channel: connecting to the helper is `up`'s own, so a
    test that supplied the connection would prove nothing about the product. ``drive`` runs
    while the host is up, connected and serving, which is the only moment there is to look.
    """
    context = CliContext(addons_root=addons_root, host=build, supervise=drive)
    return CliRunner().invoke(cli, ["up"], obj=context, catch_exceptions=False)


class MovableClock:
    """A clock a test moves by hand, for the backoff the restart policy waits out."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class Assembled:
    """The helper and the host `innytypes up` brought up, and what passed between them."""

    listener: ControlListener
    policy: RestartPolicy
    clock: MovableClock
    settings: HelperSettings
    addons_root: Path
    processes: dict[int, FakeProcess]
    spawns: list[list[str]]
    exits: list[ChildExit]
    decisions: list[ScheduledRestart | None]
    children: ChildSupervisor | None = None
    # The tick `build_supervision` assembled, for the runs that asked for the production
    # helper rather than a hand-built listener and policy. ``None`` for the rest.
    supervision: SupervisionTick | None = None
    output: str = ""
    exit_code: int = 0

    def pass_once(self) -> Pass:
        """One supervision pass, exactly as the helper's loop makes it."""
        assert self.supervision is not None, "this run was not assembled with a real helper"
        return self.supervision.pass_once()

    def accept(self) -> None:
        """Take the connection the host made on its way up. Asserts that it made one."""
        self.listener.poll()
        assert self.listener.host is not None, "the host `up` started never reached the helper"

    def process_for(self, child_id: str) -> FakeProcess:
        """The fake process behind one live child of the assembled host."""
        assert self.children is not None
        record = next(record for record in self.children.running() if record.id == child_id)
        return self.processes[record.pid]


Drive = Callable[[Assembled], None]
Assemble = Callable[..., Assembled]


def write_helper_settings(
    path: Path,
    *,
    restart: RestartSettings | None = None,
    breaker: BreakerSettings | None = None,
) -> None:
    """The helper's numbers in the file it reads them from, rather than in an argument.

    `build_supervision` takes its numbers from `config.toml`, because that is where the user
    puts them. A test that wants a two-attempt policy or a one-strike breaker out of the
    production assembly has to say so in the same place.
    """
    lines: list[str] = []
    if restart is not None:
        delays = ", ".join(str(delay) for delay in restart.backoff)
        lines += [
            "[helper.restart]",
            f"max_attempts = {restart.max_attempts}",
            f"backoff = [{delays}]",
        ]
    if breaker is not None:
        lines += [
            "[helper.breaker]",
            f"max_interventions = {breaker.max_interventions}",
            f"window = {breaker.window}",
        ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


@dataclass
class NoApplications:
    """A machine with nothing else running on it, for the application's Anytype question."""

    def find(self, executable: str) -> ProcessFacts | None:
        return None


def production_helper(
    *,
    listener: ControlListener,
    settings: HelperSettings,
    run_state_path: Path,
    root: Path,
    tmp_path: Path,
    runtime_directory: Path,
    monkeypatch: pytest.MonkeyPatch,
    decide: Callable[[Callable[[ChildExit], ScheduledRestart | None]], None],
    decide_start_failure: (
        Callable[[Callable[[ChildStartFailure], ScheduledRestart | None]], None] | None
    ) = None,
    unsupervised: str = "",
) -> SupervisionTick:
    """The helper side as the application really assembles it, with its roots moved here.

    Everything below the two production calls is redirection, not substitution: the real
    :class:`~innytypes.helper.launcher.Application`, the real
    :func:`~innytypes.helper.supervision.build_supervision`, the real
    :class:`~innytypes.helper.restart.RestartPolicy` and the real
    :class:`~innytypes.helper.breaker.Breaker` are what run. What is moved is where they read
    and write — the quarantines, the notices, the heartbeat socket, the addons root and the
    staging directory — because a gate that wrote into the per-user runtime directory would
    be a gate that reported on whoever ran it last.

    Two things are stubbed rather than moved. The notifier, because the assertion below is
    about what the helper *records*, and a macOS notification during a gate is noise nobody
    asked for. And the release signing key, refused so that the update check is the ``None``
    every unpackaged installation already gets — reaching a release server from a test is the
    one thing this must never do.
    """
    from innytypes.helper import heartbeat as heartbeat_module
    from innytypes.helper import supervision as supervision_module

    staging = tmp_path / "staging"
    # The class, not the path function behind it. `QuarantineFile.path` and `NoticeFile.path`
    # are dataclass fields whose ``default_factory`` captured the function **object** when the
    # class was defined, so rebinding the name in its module changes nothing and the writes
    # land in the real per-user runtime directory. Binding the path into the constructor is
    # the only redirection these two honour.
    monkeypatch.setattr(
        supervision_module,
        "QuarantineFile",
        partial(QuarantineFile, path=tmp_path / "quarantine.json"),
    )
    monkeypatch.setattr(
        supervision_module, "NoticeFile", partial(NoticeFile, path=tmp_path / "notices.json")
    )
    beats_path = runtime_directory / f"beats-{next(_beat_socket_names)}.sock"
    monkeypatch.setattr(heartbeat_module, "default_socket_path", lambda: beats_path)
    monkeypatch.setattr(supervision_module, "default_addons_root", lambda: root)
    monkeypatch.setattr(supervision_module, "default_core_staging_path", lambda: staging)
    monkeypatch.setattr(supervision_module, "notifier_for", lambda *_, **__: RecordingNotifier())
    monkeypatch.setattr(
        supervision_module,
        "load_installed_public_key",
        _no_signing_key,
    )

    run_state = RunStateFile(run_state_path)
    processes = ManagedProcesses(run_state=run_state, table=SystemProcessTable())
    application = Application(
        lock=InstanceLock(path=tmp_path / "helper.lock", processes=processes),
        processes=processes,
        run_state=run_state,
        quits=QuitFile(path=tmp_path / "quit.json"),
        applications=NoApplications(),
        host_command=("/nonexistent", "-m", "innytypes", "up"),
        anytype_executable=None,
    )
    # The order `main` uses, and the order that matters: the application is holding the policy
    # before anything can report an exit to it.
    supervision = build_supervision(
        application=application,
        processes=processes,
        settings=settings,
        link=listener,
        unsupervised=unsupervised,
    )
    decide(application.child_exited)
    if decide_start_failure is not None:
        # The other thing `main` hands the listener. Optional only because most callers are
        # about exits; a caller that asks for it gets the shipped application's own method,
        # never a policy this fixture wired up itself.
        decide_start_failure(application.child_failed_to_start)
    return supervision


def _no_signing_key(*_: object, **__: object) -> bytes:
    """An installation with no release signing key, which is every unpackaged one."""
    raise UpdateError("this installation ships no release signing key")


# One heartbeat socket per assembled helper. The runtime directory is shared for the session
# — a socket path is too short to put under `tmp_path` — so a fixed name would make the
# second helper in a run refuse the path the first one is still holding.
_beat_socket_names = count(1)


@pytest.fixture
def assemble(
    tmp_path: Path, runtime_directory: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Assemble]:
    """Bring up a helper and the host `innytypes up` builds, and drive them while both live.

    Everything that reaches outside this process is a fake the *host* already takes: the
    spawn, the clock, the run-state file, the settings file and the absent Anytype key. The
    connection between the two processes is the one thing not supplied, because it is the one
    thing under test.

    ``supervised`` chooses which helper is on the other end. Without it the helper is this
    file's own listener and restart policy, which is what every test written for the protocol
    wants. With it the helper is the one the application really assembles — a real
    :class:`~innytypes.helper.launcher.Application` and
    :func:`~innytypes.helper.supervision.build_supervision` — because a hand-built helper
    proves nothing about whether the shipped one is wired to hear anything.
    """
    listeners: list[ControlListener] = []
    ticks: list[SupervisionTick] = []

    def _assemble(
        drive: Drive,
        *,
        listening: bool = True,
        addons: Sequence[str] = ("alpha", "beta"),
        restart: RestartSettings | None = None,
        breaker: BreakerSettings | None = None,
        supervised: bool = False,
        unsupervised: str = "",
    ) -> Assembled:
        processes: dict[int, FakeProcess] = {}
        spawns: list[list[str]] = []
        exits: list[ChildExit] = []
        decisions: list[ScheduledRestart | None] = []
        # What decides an exit: the bare policy, or — when the production helper is asked for
        # — the application, which is what the shipped control listener reports to.
        deciders: list[Callable[[ChildExit], ScheduledRestart | None]] = []

        def report(exit_report: ChildExit) -> None:
            """What the helper does with an exit: record it, and hand it to the one policy."""
            exits.append(exit_report)
            decisions.append(deciders[0](exit_report))

        root = tmp_path / "addons"
        root.mkdir(exist_ok=True)
        for addon_id in addons:
            record_addon(root, addon_id)

        settings = HelperSettings(tmp_path / "config.toml")
        if restart is not None or breaker is not None:
            write_helper_settings(settings.path, restart=restart, breaker=breaker)

        run_state_path = tmp_path / "run-state.json"

        # No path: the helper binds what `default_control_socket_path` answers, which is the
        # same function the host dials. That the two meet is the whole point of this section.
        listener = ControlListener(
            report_exit=report,
            report_start_failure=lambda _: None,
            host_pid=os.getpid,
            timeout=TIMEOUT,
        )
        listeners.append(listener)
        if listening:
            listener.open()

        clock = MovableClock()
        supervision: SupervisionTick | None = None
        if supervised:
            supervision = production_helper(
                listener=listener,
                settings=settings,
                run_state_path=run_state_path,
                root=root,
                tmp_path=tmp_path,
                runtime_directory=runtime_directory,
                monkeypatch=monkeypatch,
                decide=deciders.append,
                unsupervised=unsupervised,
            )
            ticks.append(supervision)
            policy = supervision.policy
        else:
            policy = RestartPolicy(
                channel=listener,
                settings=RestartSettings() if restart is None else restart,
                now=clock,
            )
            deciders.append(policy.child_exited)

        def spawn(
            argv: Sequence[str], env: dict[str, str], *, channel: int | None = None
        ) -> FakeProcess:
            spawns.append(list(argv))
            # Process IDs that could not collide with this test runner's own.
            process = FakeProcess(pid=90_000 + len(spawns))
            processes[process.pid] = process
            return process

        def no_anytype_key() -> Supervisor:
            """A machine with no API key, which is how a host ends up with no MCP child."""
            raise ConfigError("this host has no Anytype API key")

        def build(
            addons_root: Path | None,
            report_exit: ExitReporter,
            report_start_failure: StartFailureReporter,
        ) -> Host:
            # The production assembly, with the seams it already has pointed at this test's
            # fakes — including the ones `up` decides: where a child's exit, and the news that
            # one never started, go.
            return build_host(
                addons_root=addons_root,
                mcp=no_anytype_key,
                spawn=spawn,  # type: ignore[arg-type]
                run_state=RunStateFile(run_state_path),
                report_exit=report_exit,
                report_start_failure=report_start_failure,
                clock=FakeClock(),
                environment={"PATH": "/nonexistent"},
                holds_back=lambda child_id: None,
                settings=settings,
            )

        assembled = Assembled(
            listener=listener,
            policy=policy,
            supervision=supervision,
            clock=clock,
            settings=settings,
            addons_root=root,
            processes=processes,
            spawns=spawns,
            exits=exits,
            decisions=decisions,
        )

        def supervise(children: ChildSupervisor) -> None:
            assembled.children = children
            drive(assembled)

        result = run_up_with(build=build, addons_root=root, drive=supervise)
        assembled.output = result.output
        assembled.exit_code = result.exit_code
        return assembled

    yield _assemble

    for open_listener in listeners:
        open_listener.close()
    for tick in ticks:
        if tick.beats is not None:
            tick.beats.close()


def test_the_host_up_starts_finds_the_helper_without_being_handed_a_connection(
    assemble: Assemble,
) -> None:
    """Acceptance 1: the join itself, through the command the helper starts the host with.

    Nothing in this test dials, connects or hands over a socket. `up` is invoked with the two
    seams it already had, and the assertion is that the helper's listener — which was told no
    path either — has a **verified** host on it: one that announced a process id matching the
    host this helper started, and was not refused.
    """
    seen: list[bool] = []

    def drive(assembled: Assembled) -> None:
        assembled.listener.poll()
        seen.append(assembled.listener.host is not None)

    assembled = assemble(drive)

    assert seen == [True], "the host `up` started never connected to the helper's socket"
    assert assembled.exit_code == 0, assembled.output
    assert assembled.listener.refusals == 0
    # And nothing was said about an absent helper, because there was one.
    assert "not connected" not in assembled.output


def test_a_host_started_without_a_helper_runs_and_names_the_absence(
    assemble: Assemble, control_socket_path: Path
) -> None:
    """Acceptance 1, the other half: no helper is a named condition, not a failure.

    A host somebody started in a terminal has nothing to answer to. It starts its children,
    reports their exits to the person watching, exits zero — and says in one line that it is
    commanded by nobody, because a host whose commands reach nothing while looking healthy is
    the defect this slice exists to end.
    """
    assembled = assemble(lambda _: None, listening=False)

    assert assembled.exit_code == 0, assembled.output
    assert f"  not connected {CONTROL_CHANNEL_ID}: " in assembled.output
    assert "no helper is listening" in assembled.output
    assert str(control_socket_path) in assembled.output
    # It ran: both addons were started, which is what a host with no helper still does.
    assert [argv[-1] for argv in assembled.spawns] == ["alpha", "beta"]


def test_every_command_plan_0003_defines_reaches_the_assembled_host_and_is_answered(
    assemble: Assemble,
) -> None:
    """Acceptance 2: the six commands, against the production assembly rather than a fixture.

    Each of these has been passing since plan 0003 slice 18 over a connection the test made
    itself, and each of them reached nothing in the shipped application. What is different
    here is only where the host came from: `innytypes up` built it, dialled the helper and
    started the reader, and these commands travel that wire.
    """
    answers: dict[str, CommandResult] = {}
    facts: dict[str, object] = {}

    def drive(assembled: Assembled) -> None:
        assembled.accept()
        policy = assembled.policy

        # `up` has already started both addons, so `list` is the first thing to ask.
        answers["list"] = policy.list_children()

        answers["stop"] = policy.stop("beta")
        facts["after-stop"] = [record.id for record in policy.list_children().children]

        answers["start"] = policy.start("beta")
        facts["after-start"] = [record.id for record in policy.list_children().children]

        before_restart = assembled.process_for("alpha").pid
        answers["restart"] = policy.restart("alpha")
        facts["restarted-onto-a-new-process"] = assembled.process_for("alpha").pid != before_restart

        doomed = assembled.process_for("alpha")
        answers["kill"] = policy.kill("alpha")
        facts["killed-rather-than-asked"] = doomed.killed and not doomed.terminated

        policy.start("alpha")
        before_group = {name: assembled.process_for(name).pid for name in ("alpha", "beta")}
        answers["restart-group"] = policy.restart_group(("alpha", "beta"))
        facts["group-replaced"] = all(
            assembled.process_for(name).pid != pid for name, pid in before_group.items()
        )

    assembled = assemble(drive)

    assert assembled.exit_code == 0, assembled.output
    assert [record.id for record in answers["list"].children] == ["alpha", "beta"]
    assert answers["stop"].name is CommandName.STOP
    assert facts["after-stop"] == ["alpha"]
    assert answers["start"].name is CommandName.START
    assert [record.id for record in answers["start"].children] == ["beta"]
    assert facts["after-start"] == ["alpha", "beta"]
    assert answers["restart"].name is CommandName.RESTART
    assert facts["restarted-onto-a-new-process"] is True
    assert answers["kill"].name is CommandName.KILL
    assert facts["killed-rather-than-asked"] is True
    assert answers["restart-group"].name is CommandName.RESTART_GROUP
    assert [record.id for record in answers["restart-group"].children] == ["alpha", "beta"]
    assert facts["group-replaced"] is True


def test_a_crash_reaches_the_helpers_restart_policy_over_the_assembled_channel(
    assemble: Assemble,
) -> None:
    """Acceptance 3: the host noticed, and the helper's policy heard about it — over the wire.

    Nothing here reads the run-state file. The host's own poll notices the child is gone, the
    exit goes out on the connection `up` made, and the helper's next poll hands it to the one
    thing that decides what to do about it.
    """

    def drive(assembled: Assembled) -> None:
        assembled.accept()
        # Running because `up` started it, which is the state a helper finds a host in.
        assembled.process_for("alpha").crash(exit_code=17)

        assert assembled.children is not None
        assembled.children.poll()
        assert assembled.listener.poll() == 1, "the exit never crossed the assembled channel"

    assembled = assemble(drive)

    assert [report.id for report in assembled.exits] == ["alpha"]
    assert assembled.exits[0].exit_code == 17
    assert assembled.exits[0].expected is False
    assert assembled.decisions[0] is not None
    assert assembled.policy.state("alpha").attempts == 1


def test_a_stop_the_helper_asked_for_is_still_expected_when_it_arrives(
    assemble: Assemble,
) -> None:
    """Acceptance 3, the other half: the bit that stops a deliberate stop being undone.

    ``expected`` is set by the host inside the stop the helper asked for, rides ahead of that
    stop's answer on the same connection, and has to survive the crossing — otherwise the
    restart policy brings back every plugin the user just switched off.
    """

    def drive(assembled: Assembled) -> None:
        assembled.accept()
        assembled.policy.stop("alpha")

    assembled = assemble(drive)

    assert [report.id for report in assembled.exits] == ["alpha"]
    assert assembled.exits[0].expected is True
    assert assembled.exits[0].kind is ChildKind.ADDON
    # Nothing was scheduled: the helper does not undo a stop it asked for.
    assert assembled.decisions == [None]
    assert assembled.policy.pending == ()


def test_the_restart_policy_the_breaker_and_quarantine_are_unchanged_by_the_assembly(
    assemble: Assemble, tmp_path: Path
) -> None:
    """Acceptance 4: `tests/test_helper_restart.py`'s own sequence, over the assembled path.

    The backoff, the cap and the terminal verdict are asserted here exactly as that file
    asserts them against its fake host — same settings, same counted attempts, same clock
    moved by hand rather than waited out. If joining the two processes had changed a restart
    decision, the two files would now disagree about the same sequence of events.

    The breaker is the same story from the other side: it counts interventions and quarantines
    at its threshold, and the assembled channel is not one of its inputs. It is driven here as
    :class:`~innytypes.helper.supervision.SupervisionTick` drives it, and the quarantine is
    read back off the file another process would read it from.
    """
    restarts: list[int] = []

    def drive(assembled: Assembled) -> None:
        assembled.accept()
        policy = assembled.policy

        for attempt, delay in ((1, 1.0), (2, 2.0)):
            assembled.process_for("alpha").crash(exit_code=9)
            assert assembled.children is not None
            assembled.children.poll()
            assembled.listener.poll()

            scheduled = assembled.decisions[-1]
            assert scheduled is not None
            assert scheduled.attempt == attempt
            assert scheduled.due_at - assembled.clock.now == delay
            # Nothing happens until the delay has actually passed.
            assert policy.tick() == ()

            assembled.clock.advance(delay)
            assert len(policy.tick()) == 1
            restarts.append(assembled.process_for("alpha").pid)

        # The attempts are spent: the next crash is not scheduled at all.
        assembled.process_for("alpha").crash(exit_code=9)
        assert assembled.children is not None
        assembled.children.poll()
        assembled.listener.poll()

    assembled = assemble(drive, restart=RestartSettings(max_attempts=2, backoff=(1.0, 2.0)))

    assert assembled.exit_code == 0, assembled.output
    assert len(restarts) == 2, "the policy's restarts never reached the assembled host"
    assert len(set(restarts)) == 2, "a restart handed back the process that had died"
    assert assembled.decisions[-1] is None
    assert assembled.policy.state("alpha").terminal is True
    assert assembled.policy.state("alpha").last_exit_code == 9

    # And the breaker, whose inputs the assembly never touches: two interventions at a
    # threshold of two, quarantined, refused a restart, and written where `innytypes helper
    # status` reads it.
    store = QuarantineFile(path=tmp_path / "quarantine.json")
    breaker = Breaker(settings=BreakerSettings(max_interventions=2), store=store)
    assert breaker.record("alpha", reason="it keeps dying") is True
    assert breaker.record("alpha", reason="it keeps dying") is False
    assert breaker.is_quarantined("alpha")
    assert breaker.may_restart("alpha") is False
    assert "alpha" in store.load()
    assert breaker.release("alpha") is True
    assert breaker.may_restart("alpha") is True


def nothing_answers_on(port: int) -> bool:
    """True when a connection to this loopback port is refused — nothing is listening there."""
    with socket.socket(socket.AF_INET) as probe:
        probe.settimeout(1.0)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def test_a_change_asked_of_a_host_with_no_gateway_is_refused_and_starts_no_listener(
    assemble: Assemble,
) -> None:
    """Acceptance 8: the child was never validated, so the answer is that, and nothing binds.

    The assembled host here has no Anytype API key, so it has no MCP child, no validated
    session, and no listener at all. Opening one on request would look helpful and be wrong:
    the address would accept a client's connection and be able to answer nothing through it,
    which reads to that client as a broken service rather than as an InnyTypes that is not
    ready (plan 0007). So the reason is named and no port is taken.
    """
    port = free_port()
    outcome: list[EndpointChange] = []
    answered: list[bool] = []

    def drive(assembled: Assembled) -> None:
        assembled.accept()
        outcome.append(
            move_endpoint(assembled.listener, "127.0.0.1", port, settings=assembled.settings)
        )
        answered.append(not nothing_answers_on(port))

    assembled = assemble(drive)

    (change,) = outcome
    assert change.outcome is EndpointOutcome.REFUSED
    assert change.served is False
    assert change.url == ""
    assert "never validated" in (change.reason or "")
    assert answered == [False], "a request for an endpoint put a listener up"
    # And the refusal stored nothing: the setting is still absent, variables and all.
    assert assembled.settings.mcp == McpEndpoint()


def test_a_set_endpoint_that_names_no_address_is_refused_rather_than_guessed_at(
    assemble: Assemble,
) -> None:
    """The one shape of this command the host cannot act on, answered like any other refusal.

    An address is the whole of what this command carries, so a frame without one is a
    disagreement between the two ends rather than a request with a sensible default — and
    the default a host might reach for is the endpoint somebody is trying to move away from.
    """
    refusals: list[str] = []

    def drive(assembled: Assembled) -> None:
        assembled.accept()
        with pytest.raises(CommandRefusedError) as refused:
            assembled.listener.send(Command(name=CommandName.SET_ENDPOINT))
        refusals.append(str(refused.value))
        # And the channel is still usable: a disagreement is not a broken connection.
        children = assembled.policy.list_children().children
        assert [record.id for record in children] == ["alpha", "beta"]

    assemble(drive)

    assert "carries none" in refusals[0]


def test_an_endpoint_change_with_no_host_connected_is_named_rather_than_waited_out(
    socket_path: Path, tmp_path: Path
) -> None:
    """Acceptance 10, for the new command: the channel's existing failure behaviour, kept.

    Nothing is sent, so nothing was half-done, and the caller is told which of this channel's
    three failures it is looking at rather than left waiting on a deadline. The stored setting
    is untouched for the same reason a refused bind leaves it untouched: it is only ever
    written to record an address a host has confirmed it is serving.
    """
    settings = HelperSettings(tmp_path / "config.toml")
    listener = ControlListener(
        socket_path,
        report_exit=lambda _: None,
        report_start_failure=lambda _: None,
        host_pid=os.getpid,
    )
    with listener:
        change = move_endpoint(listener, "127.0.0.1", 31011, settings=settings)

    assert change.outcome is EndpointOutcome.REFUSED
    assert "no host is connected" in (change.reason or "")
    assert settings.mcp == McpEndpoint()


# --- the helper the application really assembles --------------------------------------------


def test_a_crash_reaches_the_restart_policy_of_the_helper_the_application_assembles(
    assemble: Assemble,
) -> None:
    """Acceptance 3 against the shipped helper, rather than one this file wired by hand.

    The test above it proves the *channel* carries an exit. It cannot prove the application
    hears one, because it supplies the listener and the policy itself and joins them with a
    line of its own — and that line is precisely what the product was missing. In the shipped
    helper the exit had two more hops to make and failed both: the listener the supervision
    polled was a **second** one, refused the socket path and never opened, and the
    application had been given no restart policy at all, so an exit that did arrive was
    accepted and dropped.

    So here nothing is joined by hand. `build_supervision` is asked for the helper, exactly as
    `main` asks for it, and the only thing handed in is the one control listener — which is
    the fix. The assertion is the whole chain in one pass: the host noticed, the exit crossed
    the wire, the listener read it, the application judged it, and the policy scheduled the
    restart.
    """

    def drive(assembled: Assembled) -> None:
        assembled.accept()
        assembled.process_for("alpha").crash(exit_code=17)

        assert assembled.children is not None
        assembled.children.poll()

        # The supervision's own pass, not a bare `listener.poll()`: the loop is what runs in
        # production, and the loop is what was reporting `exits=0` forever.
        report = assembled.pass_once()

        assert report.exits == 1, "the supervision pass heard nothing the host reported"
        assert [failure.step for failure in report.failures] == [], (
            f"a pass that should be clean named failures: {report.failures}"
        )

    assembled = assemble(drive, supervised=True)

    assert assembled.exit_code == 0, assembled.output
    assert [report.id for report in assembled.exits] == ["alpha"]
    assert assembled.exits[0].exit_code == 17
    assert assembled.exits[0].expected is False
    # The application acted on it: a restart is scheduled, and it is the policy the
    # supervision issues from that is holding it.
    assert assembled.decisions[0] is not None
    assert assembled.policy.state("alpha").attempts == 1
    assert [pending.child_id for pending in assembled.policy.pending] == ["alpha"]


def test_a_stop_the_assembled_helper_asked_for_is_not_undone_by_its_own_policy(
    assemble: Assemble,
) -> None:
    """Acceptance 3's other half, through the same assembly: expected survives the crossing.

    Worth repeating here rather than trusting the hand-wired version of it, because the
    assembled path has one thing the hand-wired one does not: the breaker, which
    `build_supervision` gives the application along with the policy. A breaker that counted a
    deliberate stop as an intervention would quarantine plugins for being switched off.
    """

    def drive(assembled: Assembled) -> None:
        assembled.accept()
        # The exit rides ahead of the stop's own answer on the same connection, so it has
        # already been read and judged by the time `stop` returns. The pass that follows is
        # here to prove the application did not reconsider it on a schedule.
        assembled.policy.stop("alpha")
        assert assembled.pass_once().issued == ()

    assembled = assemble(drive, supervised=True)

    assert [report.id for report in assembled.exits] == ["alpha"]
    assert assembled.exits[0].expected is True
    assert assembled.decisions == [None]
    assert assembled.policy.pending == ()


def test_an_unexpected_exit_counts_into_the_breaker_the_application_was_given(
    assemble: Assemble,
) -> None:
    """The other half of what `supervise` hands over, asserted where it can fail.

    `build_supervision` builds a :class:`~innytypes.helper.breaker.Breaker` and a
    :class:`~innytypes.helper.breaker.QuarantineFile` inline, so a test that merely watches
    them count would pass with the control channel deleted entirely — it would be watching
    the breaker, not the assembly. What makes this one evidence is that the counting is
    reached **only** through the application: the exit crosses the wire, the application is
    the thing that decides to count it, and the application counts into the breaker only if
    it was handed one.

    So the allowance is one intervention, and a single crash has to spend it. If the
    application was given no breaker the crash is simply restarted, which is the assertion
    below going red.
    """

    def drive(assembled: Assembled) -> None:
        assembled.accept()
        assembled.process_for("alpha").crash(exit_code=9)

        assert assembled.children is not None
        assembled.children.poll()
        report = assembled.pass_once()

        assert report.exits == 1
        assert assembled.supervision is not None
        breaker = assembled.supervision.breaker
        assert breaker.is_quarantined("alpha") is True, (
            "the crash never reached a breaker, so the application was given none"
        )
        # A quarantined process is not brought back, by this pass or any later one.
        assert report.issued == ()
        assert assembled.policy.pending == ()

        # And it is on disk, which is where `innytypes helper status` and the next pass's
        # notices both read it from — the same file another process would clear it in.
        assert assembled.supervision.quarantines is not None
        assert list(assembled.supervision.quarantines.load()) == ["alpha"]
        told = {notice.kind for notice in assembled.pass_once().notices}
        assert NoticeKind.PROCESS_QUARANTINED in told

    assembled = assemble(
        drive, supervised=True, breaker=BreakerSettings(max_interventions=1, window=600.0)
    )

    assert assembled.exit_code == 0, assembled.output
    # Nothing was scheduled: the breaker refused before the policy was ever asked.
    assert assembled.decisions == [None]


def test_the_assembled_helper_runs_out_of_attempts_exactly_as_its_settings_say(
    assemble: Assemble,
) -> None:
    """Acceptance 4 through the assembly: the numbers come from `config.toml` and are obeyed.

    Two attempts, then a terminal verdict — the same sequence `tests/test_helper_restart.py`
    asserts against its own fake, driven here through the production helper and the real host.
    A restart that was scheduled but never issued would leave `attempts` climbing and nothing
    coming back, so both are asserted.
    """
    restarted: list[int] = []

    def drive(assembled: Assembled) -> None:
        assembled.accept()

        for attempt in (1, 2):
            assembled.process_for("alpha").crash(exit_code=9)
            assert assembled.children is not None
            assembled.children.poll()

            # One pass hears the exit, schedules the restart and — with this test's zero
            # backoff — issues it, in that order, which is the order `pass_once` documents.
            report = assembled.pass_once()
            assert report.exits == 1
            assert assembled.policy.state("alpha").attempts == attempt
            assert len(report.issued) == 1, f"attempt {attempt} was scheduled and never issued"
            restarted.append(assembled.process_for("alpha").pid)

        assembled.process_for("alpha").crash(exit_code=9)
        assert assembled.children is not None
        assembled.children.poll()
        assert assembled.pass_once().issued == ()

    assembled = assemble(
        drive,
        supervised=True,
        restart=RestartSettings(max_attempts=2, backoff=(0.0,)),
    )

    assert assembled.exit_code == 0, assembled.output
    assert len(set(restarted)) == 2, "a restart handed back the process that had died"
    assert assembled.decisions[-1] is None
    assert assembled.policy.state("alpha").terminal is True


def test_a_helper_that_could_not_open_its_socket_says_so_instead_of_failing_every_tick(
    assemble: Assemble,
) -> None:
    """What the swallowed failure is replaced by: a condition, said once, in the usual place.

    The old shape handed the tick a listener that had never opened. Every pass polled it,
    every pass raised, every pass logged the same line and recovered — for the life of the
    application, at a person who is not reading logs. A helper that cannot hear its host is
    not supervising anything, and that is exactly the kind of thing `innytypes helper status`
    exists to print.

    So the tick is told there is no channel and stops reading what is not there, and the
    reason becomes a notice like any other. The pass is clean: no failures, and no exits,
    because there is genuinely nothing to hear.
    """
    reason = "another helper is already listening on the control socket"

    assembled = assemble(lambda _: None, supervised=True, listening=False, unsupervised=reason)
    assert assembled.supervision is not None
    tick = assembled.supervision

    # The tick was built with no channel to poll, which is the state the field already
    # documents — rather than with a listener that never opened and raises on every read.
    assert tick.link is None
    assert tick.unsupervised == reason

    report = tick.pass_once()

    assert report.failures == (), f"polling a channel that is not there: {report.failures}"
    assert report.exits == 0
    named = [notice for notice in report.notices if notice.kind is NoticeKind.NOT_SUPERVISING]
    assert [notice.detail for notice in named] == [reason]
    assert [notice.kind for notice in report.announced] == [NoticeKind.NOT_SUPERVISING]
    # And it is said once, not once per tick: the second pass tells the user nothing new.
    assert tick.pass_once().announced == ()
