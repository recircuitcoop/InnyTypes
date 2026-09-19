"""The addon runner, and the channel the host opens for it — both ends, in one process.

**Nothing here spawns a process, and nothing here sleeps.** The addon is a class defined in this
file, started through an injected entry-point loader that answers for an environment nobody
created. The connection is a real ``AF_UNIX`` socketpair — the production connection exactly,
:class:`~innytypes.events.transport.StreamConnection` over it on both sides — which is a pair of
descriptors in this process with no port, no service and no child behind it. Every wait below is
a blocking read released by this test's own next action; the socket timeouts are failure guards,
and nothing that passes ever reaches one.

The defect this covers is a module that did not exist. `children.addon_command` spawned
``python -m innytypes.addons.run``, every test injected a fake spawn, and so nothing ever
imported the module the real argv names. The first test ties the two together by identity, so
renaming one without the other is red rather than merely wrong. The second half of the same
defect is a host that built no bus at all: `test_build_host_wires_every_addon_it_spawns_to_one_bus`
is the one that fails if the wiring is taken back out.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import signal
import socket
import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import IO, cast

import pytest

from innytypes import HOST_API_VERSION
from innytypes.addons.discovery import InstalledAddon, discover_addons
from innytypes.addons.install import ENTRY_POINT_GROUP
from innytypes.addons.manifest import parse_kind, parse_manifest
from innytypes.addons.run import (
    FAILED_EXIT_CODE,
    RUNTIME_ENTRY_POINT_GROUP,
    Addon,
    AddonContext,
    main,
    no_settings,
    run,
)
from innytypes.anytype_mcp.config import ConfigError
from innytypes.children import (
    ADDON_RUNNER_MODULE,
    ChildKind,
    ChildProcess,
    ChildSupervisor,
    RunStateFile,
    addon_command,
)
from innytypes.events.bus import ADDON_FAILED, EventBus
from innytypes.events.channel import SocketPairChannels
from innytypes.events.delivery import ThreadedDelivery
from innytypes.events.emitter import Event, KindRegistry, UnregisteredKindError
from innytypes.events.transport import Connection, StreamConnection, frame_event, unframe_event
from innytypes.host import build_host

# How long a blocking read may go unanswered before the test calls the run broken. Nothing that
# passes waits this long: every read below is released by the next thing this test does.
TIMEOUT = 10.0

RECORDED = parse_kind("monty.recorded.v1")
UNDECLARED = parse_kind("monty.undeclared.v1")
TRANSCRIBED = parse_kind("whodunnit.transcribed.v1")


# --- the addon this suite runs, and the environment it pretends to be installed in ------------


def manifest_document(
    addon_id: str = "monty",
    *,
    emits: Sequence[str] = ("monty.recorded.v1",),
    subscribes: Sequence[str] = ("whodunnit.transcribed.v1",),
) -> dict[str, object]:
    """One addon's manifest, as its entry point returns it."""
    return {
        "id": addon_id,
        "version": "1.4.0",
        "host_api": HOST_API_VERSION,
        "requires": [],
        "emits": list(emits),
        "subscribes": list(subscribes),
    }


class FakeAddon:
    """The addon: it records the context it was started with and what it was handed."""

    def __init__(self, context: AddonContext) -> None:
        self.context = context
        self.received: list[Event] = []
        self.arrived = threading.Event()
        self.stopped = False

    def handle(self, event: Event) -> None:
        self.received.append(event)
        self.arrived.set()

    def stop(self) -> None:
        self.stopped = True

    def wait_for_event(self) -> Event:
        """The next event this addon is handed, or a failure rather than a hung test."""
        assert self.arrived.wait(timeout=TIMEOUT), "the addon was handed no event"
        self.arrived.clear()
        return self.received[-1]


class RefusingToStop(FakeAddon):
    """An addon whose shutdown does not work."""

    def stop(self) -> None:
        raise RuntimeError("the recorder is still writing")


def refuse_to_start(context: AddonContext) -> Addon:
    """An entry point that raises, the way a broken addon's does."""
    raise RuntimeError("no microphone")


class FakeEnvironment:
    """The entry points of an addon environment that was never created.

    The loader is the seam: it answers ``(group, name)`` with no package on disk, and it records
    every question, which is how the entry point contract itself is asserted rather than assumed.
    """

    def __init__(
        self,
        *,
        document: Mapping[str, object] | None = None,
        factory: object | None = None,
        manifest_export: object | None = None,
    ) -> None:
        self.document = manifest_document() if document is None else document
        self.factory: object = self._start if factory is None else factory
        # What the manifest entry point *is*, for the environments where it is not a callable
        # returning a document at all.
        self.manifest_export: object = (
            (lambda: self.document) if manifest_export is None else manifest_export
        )
        self.asked: list[tuple[str, str]] = []
        self.addon: FakeAddon | None = None
        # Set the moment the addon exists, so a test on another thread can tell that the
        # runner is past its entry points without looking for it repeatedly.
        self.started = threading.Event()

    def load(self, group: str, name: str) -> object:
        self.asked.append((group, name))
        if group == ENTRY_POINT_GROUP:
            return self.manifest_export
        if group == RUNTIME_ENTRY_POINT_GROUP:
            return self.factory
        raise AssertionError(f"the runner asked for an entry point group nobody exports: {group}")

    def _start(self, context: AddonContext) -> Addon:
        self.addon = FakeAddon(context)
        self.started.set()
        return self.addon


# --- the connection: a real socketpair, both ends in this process -----------------------------


def connection_over(sock: socket.socket) -> Connection:
    """One end of a socketpair, wrapped as the host and the runner both wrap it."""
    sock.settimeout(TIMEOUT)
    stream = cast(IO[bytes], sock.makefile("rwb"))
    # The stream owns the descriptor from here, exactly as it does in production.
    sock.close()
    return StreamConnection(reader=stream, writer=stream)


@dataclass
class Channel:
    """Both ends of one addon's channel, with this test holding the host's."""

    host: Connection
    addon: Connection

    def close(self) -> None:
        self.host.close()
        self.addon.close()


@pytest.fixture
def channel() -> Iterator[Channel]:
    host_end, addon_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    open_channel = Channel(host=connection_over(host_end), addon=connection_over(addon_end))
    yield open_channel
    open_channel.close()


@dataclass
class RunningAddon:
    """One addon runner, on a thread, with the host's end of its channel in this test."""

    environment: FakeEnvironment
    channel: Channel
    thread: threading.Thread
    exit_codes: list[int]

    @property
    def addon(self) -> FakeAddon:
        """The addon the runner started, waited for rather than raced against."""
        assert self.environment.started.wait(timeout=TIMEOUT), "the addon was never started"
        assert self.environment.addon is not None
        return self.environment.addon

    def send(self, kind: str, payload: Mapping[str, object] | None = None) -> None:
        """Publish one event to the addon, as the host end of its channel does."""
        event = Event(kind=parse_kind(kind), payload={} if payload is None else payload)
        self.channel.host.send(frame_event(event))

    def receive(self) -> Event:
        """The next event the addon sent the host."""
        frame = self.channel.host.receive()
        assert frame is not None
        return unframe_event(frame)

    def stop_from_the_host(self) -> int:
        """Close the host's end, which is what a stop looks like from inside the addon."""
        self.channel.host.close()
        self.thread.join(timeout=TIMEOUT)
        assert not self.thread.is_alive(), "the runner did not stop when its channel closed"
        return self.exit_codes[0]


StartAddon = Callable[..., RunningAddon]


@pytest.fixture
def start_addon(channel: Channel) -> Iterator[StartAddon]:
    """Start the runner on a thread, against an addon defined in this file."""
    started: list[RunningAddon] = []

    def _start(
        environment: FakeEnvironment | None = None,
        addon_id: str = "monty",
    ) -> RunningAddon:
        run_environment = FakeEnvironment() if environment is None else environment
        exit_codes: list[int] = []

        def _run() -> None:
            exit_codes.append(run(addon_id, connection=channel.addon, load=run_environment.load))

        thread = threading.Thread(target=_run, name="addon-runner", daemon=True)
        thread.start()
        running = RunningAddon(
            environment=run_environment,
            channel=channel,
            thread=thread,
            exit_codes=exit_codes,
        )
        started.append(running)
        return running

    yield _start

    for running in started:
        channel.host.close()
        running.thread.join(timeout=TIMEOUT)


# --- the defect itself: the module the host spawns ---------------------------------------------


def test_the_module_the_host_spawns_is_the_module_that_exists() -> None:
    """The argv, the constant and the importable module are one string.

    This is the test the slice exists for. `children.addon_command` spawned
    `python -m innytypes.addons.run` while no such module existed, and every other test in the
    suite injected a fake spawn, so nothing ever found out. Renaming either side alone is red.
    """
    assert importlib.util.find_spec(ADDON_RUNNER_MODULE) is not None

    module = importlib.import_module(ADDON_RUNNER_MODULE)
    # Identity, not a spelling that happens to match: the module answers to the name the host
    # spawns it under, and it has the entry point `-m` calls.
    assert module.__name__ == ADDON_RUNNER_MODULE
    assert callable(module.main)


def test_the_spawned_argv_runs_that_module_with_the_addon_id(tmp_path: Path) -> None:
    """The whole command line: the addon's own interpreter, the runner, the addon's id."""
    addon = installed_addon(tmp_path, "monty")

    argv = addon_command(addon)

    assert argv[1:] == ("-m", ADDON_RUNNER_MODULE, "monty")
    assert argv[0].endswith(("bin/python", "Scripts\\python.exe"))


# --- what the runner does with the addon it loads ------------------------------------------------


def test_the_runner_starts_the_addon_from_the_entry_points_of_its_own_environment(
    start_addon: StartAddon,
) -> None:
    """Both entry points, both named after the addon's id, and the context it is handed."""
    environment = FakeEnvironment()
    running = start_addon(environment)
    # The addon is running once it has been handed an event, which cannot happen before both
    # of its entry points have been read.
    running.send("whodunnit.transcribed.v1", {"text": "hello"})
    running.addon.wait_for_event()

    assert environment.asked == [
        (ENTRY_POINT_GROUP, "monty"),
        (RUNTIME_ENTRY_POINT_GROUP, "monty"),
    ]
    assert running.addon.context.id == "monty"
    assert running.addon.context.manifest.id == "monty"
    assert running.addon.context.manifest.emits == (RECORDED,)


def test_the_emitter_the_addon_is_handed_is_bound_to_its_own_id(
    start_addon: StartAddon,
) -> None:
    """Bound, and carrying the kinds its manifest registered — those and nothing else."""
    running = start_addon()
    running.send("whodunnit.transcribed.v1")
    running.addon.wait_for_event()

    emitter = running.addon.context.emitter

    assert emitter.addon_id == "monty"
    # Registered by the manifest the runner read, so this one goes, and it comes out of the
    # channel as a frame the host can read.
    emitter.emit(RECORDED, {"seconds": 12})
    assert str(running.receive().kind) == "monty.recorded.v1"

    # A kind of its own that its manifest never declared: refused, because the registry the
    # runner built for it holds exactly what `emits` listed.
    with pytest.raises(UnregisteredKindError):
        emitter.emit(UNDECLARED, {})


def test_the_addon_is_subscribed_to_what_its_manifest_declares_and_to_nothing_else(
    start_addon: StartAddon,
) -> None:
    """The subscription is the manifest's, so an addon has one declaration of what it hears."""
    running = start_addon()

    # Not subscribed: `monty`'s manifest asks for `whodunnit.transcribed.v1` only.
    running.send("summarize.written.v1", {"text": "ignored"})
    running.send("whodunnit.transcribed.v1", {"text": "heard"})

    event = running.addon.wait_for_event()

    assert str(event.kind) == "whodunnit.transcribed.v1"
    # The unsubscribed kind went down the same stream first, and frames arrive in order, so it
    # was matched away rather than merely late.
    assert [str(received.kind) for received in running.addon.received] == [
        "whodunnit.transcribed.v1"
    ]


def test_a_frame_the_addon_cannot_read_does_not_take_the_addon_down(
    start_addon: StartAddon,
) -> None:
    """One unreadable frame is a bug to report, not a reason to lose every later event."""
    running = start_addon()

    running.channel.host.send("this is not a frame")
    running.send("whodunnit.transcribed.v1", {"text": "still here"})

    assert running.addon.wait_for_event().payload == {"text": "still here"}


# --- an addon that cannot start --------------------------------------------------------------


@pytest.mark.parametrize(
    ("environment", "expected"),
    [
        pytest.param(
            FakeEnvironment(factory=refuse_to_start),
            "no microphone",
            id="the entry point raises",
        ),
        pytest.param(
            FakeEnvironment(factory="not a callable at all"),
            "is not callable",
            id="the entry point is not callable",
        ),
        pytest.param(
            FakeEnvironment(
                document=manifest_document(
                    "whodunnit", emits=("whodunnit.transcribed.v1",), subscribes=()
                )
            ),
            "one identity",
            id="the manifest claims another addon's id",
        ),
        pytest.param(
            FakeEnvironment(document={"id": "monty"}),
            "missing required field",
            id="the manifest does not validate",
        ),
        pytest.param(
            FakeEnvironment(manifest_export="not a callable at all"),
            "is not callable",
            id="the manifest entry point is not callable",
        ),
        pytest.param(
            FakeEnvironment(manifest_export=lambda: ["not", "a", "document"]),
            "not a manifest document",
            id="the manifest entry point returns something else",
        ),
    ],
)
def test_an_addon_that_cannot_start_reports_the_reason_and_exits_non_zero(
    channel: Channel,
    environment: FakeEnvironment,
    expected: str,
) -> None:
    """Reported, and non-zero — never a process that sits there having failed.

    A child that fails silently is the one thing a supervisor cannot tell from a healthy addon
    with nothing to say, so the reason goes to the host on the channel it already has and the
    exit code says the process is finished with.
    """
    exit_code = run("monty", connection=channel.addon, load=environment.load)

    assert exit_code == FAILED_EXIT_CODE

    reported = receive_event(channel.host)
    assert reported.kind == ADDON_FAILED
    assert reported.payload["addon"] == "monty"
    assert expected in str(reported.payload["reason"])


def test_an_addon_that_will_not_stop_cleanly_exits_non_zero(channel: Channel) -> None:
    """A `stop` that raises is a shutdown that did not happen, and the exit code says so."""
    environment = FakeEnvironment(factory=RefusingToStop)
    exit_codes: list[int] = []
    thread = threading.Thread(
        target=lambda: exit_codes.append(
            run("monty", connection=channel.addon, load=environment.load)
        ),
        daemon=True,
    )
    thread.start()

    channel.host.close()
    thread.join(timeout=TIMEOUT)

    assert exit_codes == [FAILED_EXIT_CODE]


# --- the boundary, from the host's side --------------------------------------------------------


def test_a_kind_the_addon_does_not_own_is_refused_at_the_boundary(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A frame is bytes, so the host end checks what an emitter's binding would have promised.

    The forged frame is written straight onto the channel, which is the only way to send one:
    the addon's own emitter refuses another addon's kind before anything is framed at all.
    """
    assert_refused_at_the_boundary(
        forged=Event(kind=TRANSCRIBED, payload={"text": "forged"}),
        expected="not a kind it may emit",
        caplog=caplog,
    )


def test_a_kind_no_manifest_declared_is_refused_at_the_boundary(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The emitter's second rule, checked again where a binding cannot carry it."""
    assert_refused_at_the_boundary(
        forged=Event(kind=UNDECLARED, payload={}),
        expected="no manifest declared",
        caplog=caplog,
    )


def assert_refused_at_the_boundary(
    *,
    forged: Event,
    expected: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Send one frame the peer may not send, then one it may, and read what reached the bus.

    Frames arrive in order on one stream, so the second one arriving while the first never does
    is the refusal itself — no log line required to believe it, though the reason is there too.
    """
    bus = EventBus()
    kinds = KindRegistry()
    kinds.register(ADDON_FAILED)
    channels = SocketPairChannels(bus=bus, kinds=kinds)
    manifest = parse_manifest(manifest_document())

    arrived: list[Event] = []
    heard = threading.Event()

    def collect(event: Event) -> None:
        arrived.append(event)
        heard.set()

    delivery = ThreadedDelivery()
    delivery.run(
        bus.subscribe(
            subscriber="listener",
            patterns=[forged.kind, RECORDED],
            handler=collect,
        )
    )

    child = connection_over(socket.socket(fileno=channels.open("monty", manifest)))
    try:
        with caplog.at_level("WARNING"):
            child.send(frame_event(forged))
            child.send(frame_event(Event(kind=RECORDED, payload={"seconds": 3})))
            assert heard.wait(timeout=TIMEOUT), "nothing at all reached the host's bus"

        assert [str(event.kind) for event in arrived] == ["monty.recorded.v1"]
        assert expected in caplog.text
    finally:
        delivery.close()
        child.close()
        channels.close("monty")


# --- a stop from the host -----------------------------------------------------------------------


def test_a_stop_from_the_host_shuts_the_addon_down_cleanly(start_addon: StartAddon) -> None:
    """The channel closing is the stop: the addon's own `stop` runs and the process exits 0."""
    running = start_addon()
    running.send("whodunnit.transcribed.v1")
    running.addon.wait_for_event()

    exit_code = running.stop_from_the_host()

    assert running.addon.stopped
    assert exit_code == 0


def test_stopping_an_addon_closes_its_channel_and_forgets_its_run_state(tmp_path: Path) -> None:
    """The host's half of the same stop: no channel left open, no record left behind.

    A record that outlives its process is the phantom the helper's identity check exists to
    catch, and a channel that outlives it is a socket the next host will try to open.
    """
    addon = installed_addon(tmp_path, "monty")
    run_state = RunStateFile(tmp_path / "run-state.json")
    channels = SocketPairChannels(bus=EventBus(), kinds=KindRegistry())
    channels_given: list[int | None] = []

    def spawn(
        argv: Sequence[str],
        env: dict[str, str],
        *,
        channel: int | None = None,
    ) -> ChildProcess:
        channels_given.append(channel)
        return FakeProcess(pid=70_001)

    supervisor = ChildSupervisor(
        mcp=None,
        addons=[addon],
        run_state=run_state,
        report_exit=lambda exit_report: None,
        spawn=spawn,
        channels=channels,
    )

    record = supervisor.start("monty")

    assert record.kind is ChildKind.ADDON
    # The child really was handed a descriptor, which is the whole point of opening one.
    assert len(channels_given) == 1
    assert channels_given[0] is not None
    assert channels.peers() == ("monty",)
    assert [written.id for written in run_state.records()] == ["monty"]

    supervisor.stop("monty")

    assert channels.peers() == ()
    assert run_state.records() == ()


# --- the wiring that was missing: a host whose bus is connected to something ---------------------


def test_build_host_wires_every_addon_it_spawns_to_one_bus(tmp_path: Path) -> None:
    """The second half of the defect: in production nothing built a bus at all.

    `build_host` is the only place the host is assembled, so it is the only place this can be
    asserted. The channels are the real ones — a socketpair per addon — and the spawn is the
    fake every other host test uses, which is what keeps this hermetic.
    """
    record_manifest(tmp_path, manifest_document("monty"))
    channels_given: list[int | None] = []

    def spawn(
        argv: Sequence[str],
        env: dict[str, str],
        *,
        channel: int | None = None,
    ) -> ChildProcess:
        channels_given.append(channel)
        return FakeProcess(pid=70_100 + len(channels_given))

    def no_mcp() -> object:
        raise ConfigError("no API key on this machine")

    host = build_host(
        addons_root=tmp_path,
        mcp=no_mcp,  # type: ignore[arg-type]
        spawn=spawn,
        run_state=RunStateFile(tmp_path / "run-state.json"),
    )
    try:
        report = host.start()

        assert [record.id for record in report.started] == ["monty"]
        # Spawned with a channel, which is the descriptor the runner reads on the far side.
        assert len(channels_given) == 1
        assert channels_given[0] is not None
        # Subscribed on the host's one bus, under its own id, so a drop names the addon.
        subscribers = [subscription.subscriber for subscription in host.events.subscriptions()]
        assert subscribers == ["monty"]
        # And its declared kinds are the host's too, which is what lets the boundary refuse a
        # kind no manifest declared.
        assert host.kinds.is_registered(RECORDED)
        assert host.kinds.is_registered(ADDON_FAILED)
    finally:
        host.shutdown()


# --- the process entry point ----------------------------------------------------------------------


def test_the_process_entry_point_reads_its_channel_from_standard_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """fd 0 is the channel, and a failure on it is reported there rather than to nobody.

    Nothing is installed in this interpreter under the name `monty`, so the entry point lookup
    is what fails — which is exactly the failure a host would see from an addon whose
    environment was built wrong, and it comes back over the channel the host gave it.
    """
    host_end, child_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    host = connection_over(host_end)
    monkeypatch.setattr("sys.stdin", _StandardInput(child_end.detach()))

    previous = signal.getsignal(signal.SIGTERM)
    try:
        exit_code = main(["monty"])
    finally:
        # A signal handler outlives the test that installed it; this one does not.
        signal.signal(signal.SIGTERM, previous)

    assert exit_code == FAILED_EXIT_CODE

    reported = receive_event(host)
    assert reported.kind == ADDON_FAILED
    assert "entry point" in str(reported.payload["reason"])
    host.close()


def test_a_terminate_from_the_host_stops_the_addon_cleanly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The whole production stop path, in one process: fd 0, `SIGTERM`, a clean exit.

    `ChildSupervisor.stop` terminates a child, so `SIGTERM` is how a stop really arrives. The
    signal is sent from a second thread once the addon has been handed an event, which is proof
    that the runner is inside its serve loop rather than still starting up.
    """
    host_end, child_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    host = connection_over(host_end)
    monkeypatch.setattr("sys.stdin", _StandardInput(child_end.detach()))
    environment = FakeEnvironment()

    def terminate_once_it_is_serving() -> None:
        if environment.started.wait(timeout=TIMEOUT):
            host.send(frame_event(Event(kind=TRANSCRIBED, payload={"text": "hello"})))
            assert environment.addon is not None
            environment.addon.arrived.wait(timeout=TIMEOUT)
        # Sent even if the runner never got there, because a blocking read nobody ends is a
        # hung gate rather than a failed test.
        os.kill(os.getpid(), signal.SIGTERM)

    previous = signal.getsignal(signal.SIGTERM)
    terminator = threading.Thread(target=terminate_once_it_is_serving, daemon=True)
    try:
        # In force until `main` installs its own, so a signal sent a moment early cannot end
        # this test run.
        signal.signal(signal.SIGTERM, lambda number, frame: None)
        terminator.start()
        # The signal lands on this thread, inside the blocking read `main` is sitting in.
        # `settings=no_settings` because this is the one entry point that would otherwise
        # open this user's real config directory, and the gate reads nothing outside itself.
        exit_code = main(["monty"], load=environment.load, settings=no_settings)
    finally:
        # Joined before the handler is put back, or a signal still to come would reach the
        # default disposition and take this test run with it.
        terminator.join(timeout=TIMEOUT)
        signal.signal(signal.SIGTERM, previous)
        host.close()

    assert exit_code == 0
    assert environment.addon is not None
    assert environment.addon.stopped


def test_a_terminate_that_lands_while_the_addon_is_starting_is_still_a_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A signal during startup ends the process, and does not report a failure that never was.

    The signal is sent from inside the manifest entry point, so it lands on the main thread
    before the addon exists — the one window where a stop is not a shutdown of anything.
    """
    host_end, child_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    host = connection_over(host_end)
    monkeypatch.setattr("sys.stdin", _StandardInput(child_end.detach()))

    def terminate_then_answer() -> Mapping[str, object]:
        os.kill(os.getpid(), signal.SIGTERM)
        return manifest_document()

    environment = FakeEnvironment(manifest_export=terminate_then_answer)
    previous = signal.getsignal(signal.SIGTERM)
    try:
        exit_code = main(["monty"], load=environment.load)
    finally:
        signal.signal(signal.SIGTERM, previous)

    assert exit_code == 0
    assert environment.addon is None
    host.close()


def test_the_runner_reads_one_entry_point_of_each_name_and_refuses_any_other_number(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An addon has one manifest and one runtime; two of either is unreasonable to guess at."""
    runner = importlib.import_module(ADDON_RUNNER_MODULE)
    exported: list[_FakeEntryPoint] = []
    monkeypatch.setattr(runner, "entry_points", lambda group: list(exported))

    with pytest.raises(runner.AddonRunError, match="exports no"):
        runner.load_entry_point(RUNTIME_ENTRY_POINT_GROUP, "monty")

    exported.append(_FakeEntryPoint("monty", "the addon's runtime"))
    assert runner.load_entry_point(RUNTIME_ENTRY_POINT_GROUP, "monty") == "the addon's runtime"

    exported.append(_FakeEntryPoint("monty", "a second runtime"))
    with pytest.raises(runner.AddonRunError, match="exports 2"):
        runner.load_entry_point(RUNTIME_ENTRY_POINT_GROUP, "monty")


def test_the_process_entry_point_refuses_standard_input_that_is_not_a_channel(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Started by hand, it says what starts it rather than failing somewhere obscure."""
    monkeypatch.setattr("sys.stdin", _ClosedStandardInput())

    assert main(["monty"]) == FAILED_EXIT_CODE
    assert "started by the host" in capsys.readouterr().err


def test_the_process_entry_point_takes_exactly_one_addon_id(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """One argument, the addon's id: the argv `children.addon_command` builds."""
    assert main([]) == FAILED_EXIT_CODE
    assert "usage:" in capsys.readouterr().err


# --- the plainest of fixtures ---------------------------------------------------------------------


@dataclass
class FakeProcess:
    """Enough of a process for the supervisor, and no process at all."""

    pid: int
    returncode: int | None = None

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        return 0 if self.returncode is None else self.returncode


@dataclass(frozen=True)
class _FakeEntryPoint:
    """One entry point of an environment that was never installed."""

    name: str
    exported: object

    def load(self) -> object:
        return self.exported


class _StandardInput:
    """A standard input whose descriptor is the child end of a socketpair."""

    def __init__(self, descriptor: int) -> None:
        self._descriptor = descriptor

    def fileno(self) -> int:
        return self._descriptor


class _ClosedStandardInput:
    """A standard input with no descriptor, as a process started by hand can have."""

    def fileno(self) -> int:
        raise OSError("this stream has no descriptor")


def receive_event(connection: Connection) -> Event:
    """The next event on one connection, or a failure rather than a `None` to unpack."""
    frame = connection.receive()
    assert frame is not None, "nothing arrived on the connection"
    return unframe_event(frame)


def record_manifest(root: Path, document: Mapping[str, object]) -> Path:
    """Write one addon's environment and recorded manifest, as `addons install` does."""
    directory = root / str(document["id"])
    (directory / "env" / "bin").mkdir(parents=True)
    (directory / "manifest.json").write_text(json.dumps(document), encoding="utf-8")
    return directory


def installed_addon(root: Path, addon_id: str) -> InstalledAddon:
    """One installed addon, discovered the way the host discovers it."""
    record_manifest(root, manifest_document(addon_id))
    discovered = discover_addons(root)
    assert [found.id for found in discovered.installed] == [addon_id]
    return discovered.installed[0]
