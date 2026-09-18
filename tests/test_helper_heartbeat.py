"""The heartbeat protocol: the message, the socket and its permissions, and what is watched.

Everything here is hermetic (docs/loop/SKILL.md). The sockets are **real** Unix domain sockets
— the permissions are half the point of this slice, and a fake would assert nothing about them
— but every one of them lives in a throwaway directory this test made, never in the per-user
runtime directory the helper uses. The one test that touches
:func:`~innytypes.helper.heartbeat.default_socket_path` only compares paths.

No test sleeps and no test spawns a process. The clock is injected into the registry, so
"an hour later" is a number, and the listener is driven by the same :meth:`poll` the helper's
tick calls rather than by a thread of its own.
"""

from __future__ import annotations

import shutil
import socket
import stat
import tempfile
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest
from platformdirs import user_runtime_path

from innytypes.addons.manifest import StabilityProfile, parse_manifest
from innytypes.children import ChildKind
from innytypes.helper.config import APPLICATION_NAME, DEFAULT_MAX_CHILDREN, HelperNumbers
from innytypes.helper.heartbeat import (
    HEARTBEAT_SOCKET_NAME,
    MAX_DETAIL_BYTES,
    MAX_FRAME_BYTES,
    Heartbeat,
    HeartbeatError,
    HeartbeatListener,
    HeartbeatRegistry,
    HeartbeatSender,
    HeartbeatSocketError,
    ProcessState,
    decode_heartbeat,
    default_socket_path,
    encode_heartbeat,
)
from innytypes.helper.watch import Observation, Watchlist, resolve_profile

# A Unix domain socket path is limited to about 104 bytes on macOS, and pytest's `tmp_path` on
# this platform is most of that on its own. So the socket directory is short by construction,
# and `tmp_path` is used only when the result still fits.
_SOCKET_PATH_LIMIT = 100


class FakeClock:
    """The registry's clock as a number a test moves, so nothing here sleeps."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def socket_dir(tmp_path: Path) -> Iterator[Path]:
    """A directory to put real sockets in, short enough for the platform, removed afterwards."""
    if len(str(tmp_path / "h.sock")) <= _SOCKET_PATH_LIMIT:
        yield tmp_path
        return

    directory = Path(tempfile.mkdtemp(prefix="inny-"))
    try:
        yield directory
    finally:
        shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture
def socket_path(socket_dir: Path) -> Path:
    """The path of one real socket, in a directory this test owns."""
    return socket_dir / "h.sock"


def a_beat(**changes: object) -> Heartbeat:
    """A complete, valid heartbeat, with whatever one test needs changed."""
    beat = Heartbeat(
        id="whodunnit",
        kind=ChildKind.ADDON,
        pid=4321,
        started_at=1_758_150_000.0,
        version="1.2.3",
        state=ProcessState.READY,
        progress_at=1_758_150_030.0,
        detail={"queue_depth": 3},
    )
    return replace(beat, **changes)  # type: ignore[arg-type]


def collecting_listener(path: Path) -> tuple[HeartbeatListener, list[Heartbeat]]:
    """A listener whose sink is a list, for the tests that are about the socket itself."""
    received: list[Heartbeat] = []
    return HeartbeatListener(path, sink=received.append), received


# --- the message, and what it refuses ------------------------------------------------------


def test_a_complete_heartbeat_makes_the_round_trip() -> None:
    beat = a_beat()

    assert decode_heartbeat(encode_heartbeat(beat)) == beat


def test_a_heartbeat_frame_carries_no_newline_of_its_own() -> None:
    # The framing depends on it: a newline is the end of a frame, so a beat may not contain one.
    frame = encode_heartbeat(a_beat(version="1.0\nspoofed", detail={"note": "one\ntwo"}))

    assert "\n" not in frame


def test_a_beat_with_no_detail_leaves_the_field_out() -> None:
    frame = encode_heartbeat(a_beat(detail=None))

    assert "detail" not in frame
    assert decode_heartbeat(frame).detail is None


@pytest.mark.parametrize(
    "missing", ["id", "kind", "pid", "started_at", "version", "state", "progress_at"]
)
def test_a_heartbeat_missing_a_required_field_is_refused(missing: str) -> None:
    document = a_beat().to_document()
    del document[missing]

    with pytest.raises(HeartbeatError) as refusal:
        Heartbeat.from_document(document)

    assert missing in str(refusal.value)


def test_an_unknown_field_is_refused_by_name() -> None:
    document = a_beat().to_document()
    document["mood"] = "cheerful"

    with pytest.raises(HeartbeatError) as refusal:
        Heartbeat.from_document(document)

    assert "mood" in str(refusal.value)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("id", 7),
        ("version", None),
        ("kind", "plugin"),
        ("state", "confused"),
        ("pid", "4321"),
        ("pid", True),
        ("started_at", "now"),
        ("progress_at", True),
        ("detail", ["queue_depth", 3]),
    ],
)
def test_a_field_of_the_wrong_type_is_refused_by_name(field: str, value: object) -> None:
    document = a_beat().to_document()
    document[field] = value

    with pytest.raises(HeartbeatError) as refusal:
        Heartbeat.from_document(document)

    assert field in str(refusal.value)


def test_a_frame_that_is_not_json_is_refused() -> None:
    with pytest.raises(HeartbeatError):
        decode_heartbeat("{not json")


def test_a_frame_that_is_not_an_object_is_refused() -> None:
    with pytest.raises(HeartbeatError):
        decode_heartbeat("[1, 2, 3]")


def test_a_detail_json_cannot_write_is_refused() -> None:
    with pytest.raises(HeartbeatError) as refusal:
        a_beat(detail={"seen": {1, 2, 3}})

    assert "whodunnit" in str(refusal.value)


def test_a_detail_that_is_not_a_mapping_is_refused() -> None:
    with pytest.raises(HeartbeatError):
        a_beat(detail=["queue_depth", 3])


def test_a_detail_key_that_is_not_a_string_is_refused() -> None:
    with pytest.raises(HeartbeatError):
        a_beat(detail={1: "one"})


def test_a_detail_big_enough_to_be_content_is_refused() -> None:
    with pytest.raises(HeartbeatError) as refusal:
        a_beat(detail={"note": "x" * (MAX_DETAIL_BYTES + 1)})

    assert str(MAX_DETAIL_BYTES) in str(refusal.value)


@pytest.mark.parametrize(
    "changes",
    [
        {"id": ""},
        {"version": ""},
        {"pid": 0},
        {"pid": -1},
        {"started_at": -1.0},
        {"progress_at": float("nan")},
    ],
)
def test_a_beat_that_could_not_mean_anything_is_refused(changes: dict[str, object]) -> None:
    with pytest.raises(HeartbeatError):
        a_beat(**changes)


# --- the socket: where it lives, and who may read it ----------------------------------------


def test_the_socket_lives_in_the_per_user_runtime_directory() -> None:
    # Compared, never created: this is the one place naming the real path.
    assert default_socket_path() == (
        user_runtime_path(APPLICATION_NAME, appauthor=False) / HEARTBEAT_SOCKET_NAME
    )


def test_the_socket_and_its_directory_are_readable_by_the_owner_only(socket_path: Path) -> None:
    listener, _ = collecting_listener(socket_path)

    with listener:
        assert socket_path.is_socket()
        # The modes are literals on purpose. Comparing them against the module's own constants
        # would pass just as happily on the day somebody widened the constants.
        assert stat.S_IMODE(socket_path.stat().st_mode) == 0o600
        assert stat.S_IMODE(socket_path.parent.stat().st_mode) == 0o700


def test_opening_the_socket_creates_the_runtime_directory(socket_dir: Path) -> None:
    # A per-user runtime directory that the system cleared on reboot is the normal case, so
    # the listener makes its own — with the right mode, not the umask's.
    directory = socket_dir / "r"
    listener, _ = collecting_listener(directory / "h.sock")

    with listener:
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700


def test_closing_the_listener_removes_the_socket(socket_path: Path) -> None:
    listener, _ = collecting_listener(socket_path)
    listener.open()
    listener.close()

    assert not socket_path.exists()


def test_a_socket_another_helper_is_listening_on_is_refused(socket_path: Path) -> None:
    first, _ = collecting_listener(socket_path)
    second, _ = collecting_listener(socket_path)

    with first:
        with pytest.raises(HeartbeatSocketError) as refusal:
            second.open()

        assert "already listening" in str(refusal.value)


def test_a_socket_nobody_answers_is_replaced(socket_path: Path) -> None:
    # What a helper that was killed leaves behind: the path exists, nothing is listening.
    orphan = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    orphan.bind(str(socket_path))
    orphan.close()

    listener, received = collecting_listener(socket_path)
    with listener, HeartbeatSender(socket_path) as sender:
        sender.send(a_beat())
        listener.poll()

    assert [beat.id for beat in received] == ["whodunnit"]


def test_a_path_that_is_not_a_socket_is_refused_untouched(socket_path: Path) -> None:
    socket_path.write_text("not mine", encoding="utf-8")
    listener, _ = collecting_listener(socket_path)

    with pytest.raises(HeartbeatSocketError):
        listener.open()

    assert socket_path.read_text(encoding="utf-8") == "not mine"


def test_opening_a_listener_twice_is_refused(socket_path: Path) -> None:
    listener, _ = collecting_listener(socket_path)

    with listener, pytest.raises(HeartbeatSocketError):
        listener.open()


def test_polling_a_listener_that_is_not_open_is_refused(socket_path: Path) -> None:
    listener, _ = collecting_listener(socket_path)

    with pytest.raises(HeartbeatSocketError):
        listener.poll()


# --- the socket: what crosses it ------------------------------------------------------------


def test_a_beat_sent_over_the_socket_arrives_whole(socket_path: Path) -> None:
    listener, received = collecting_listener(socket_path)
    beat = a_beat()

    with listener, HeartbeatSender(socket_path) as sender:
        sender.send(beat)

        assert listener.poll() == 1

    assert received == [beat]


def test_several_processes_beat_over_their_own_connections(socket_path: Path) -> None:
    listener, received = collecting_listener(socket_path)

    with (
        listener,
        HeartbeatSender(socket_path) as host,
        HeartbeatSender(socket_path) as addon,
    ):
        host.send(a_beat(id="innytypes", kind=ChildKind.HOST))
        addon.send(a_beat(id="whodunnit"))

        assert listener.poll() == 2
        assert listener.open_connections == 2

    assert sorted(beat.id for beat in received) == ["innytypes", "whodunnit"]


def test_a_sender_reconnects_after_it_closes(socket_path: Path) -> None:
    listener, received = collecting_listener(socket_path)
    sender = HeartbeatSender(socket_path)

    with listener:
        sender.send(a_beat())
        sender.close()
        sender.send(a_beat(state=ProcessState.STOPPING))
        listener.poll()
        sender.close()

    assert [beat.state for beat in received] == [ProcessState.READY, ProcessState.STOPPING]


def test_a_peer_that_goes_away_is_forgotten(socket_path: Path) -> None:
    listener, received = collecting_listener(socket_path)

    with listener:
        with HeartbeatSender(socket_path) as sender:
            sender.send(a_beat())
            assert listener.poll() == 1

        # The sender has closed; the next poll sees the end of the stream, not a beat.
        assert listener.poll() == 0
        assert listener.open_connections == 0

    assert len(received) == 1


def test_a_half_written_frame_waits_for_the_rest(socket_path: Path) -> None:
    listener, received = collecting_listener(socket_path)
    frame = encode_heartbeat(a_beat()).encode("utf-8")

    with listener:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(socket_path))
        try:
            client.sendall(frame[:20])
            assert listener.poll() == 0

            client.sendall(frame[20:] + b"\n")
            assert listener.poll() == 1
        finally:
            client.close()

    assert received == [a_beat()]


def test_a_sender_with_no_helper_listening_is_told_so(socket_path: Path) -> None:
    with pytest.raises(HeartbeatSocketError) as refusal:
        HeartbeatSender(socket_path).send(a_beat())

    assert str(socket_path) in str(refusal.value)


def test_a_connection_that_dies_under_a_sender_is_reported(socket_path: Path) -> None:
    listener, _ = collecting_listener(socket_path)

    with listener:
        sender = HeartbeatSender(socket_path)
        sender.send(a_beat())

        # The connection dying under a running process is exactly what this path is for, and
        # closing the descriptor from underneath is how a test gets there without a signal.
        sender._connection.close()  # type: ignore[union-attr]  # noqa: SLF001

        with pytest.raises(HeartbeatSocketError):
            sender.send(a_beat())


def test_junk_on_the_wire_is_refused_and_the_process_keeps_beating(socket_path: Path) -> None:
    listener, received = collecting_listener(socket_path)

    with listener:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(socket_path))
        try:
            client.sendall(b"not a heartbeat\n")
            client.sendall(b"\xff\xfe not utf-8\n")
            client.sendall(encode_heartbeat(a_beat()).encode("utf-8") + b"\n")

            assert listener.poll() == 1
            assert listener.refusals == 2
            # Two bad frames cost the peer nothing: it is still connected and still heard.
            assert listener.open_connections == 1
        finally:
            client.close()

    assert [beat.id for beat in received] == ["whodunnit"]


def test_a_peer_that_never_ends_a_frame_is_dropped(socket_path: Path) -> None:
    listener, received = collecting_listener(socket_path)

    with listener:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(socket_path))
        try:
            # Written a chunk at a time with a poll between, because a socket buffer is
            # smaller than this and one big `sendall` would wait for a reader that is this
            # very test. The point is the same: bytes with no end of frame in sight.
            sent = 0
            while sent <= MAX_FRAME_BYTES:
                try:
                    client.sendall(b"x" * 1024)
                except BrokenPipeError:  # the listener dropped us mid-write, which is the point
                    break
                sent += 1024
                listener.poll()
                if listener.open_connections == 0:
                    break

            assert listener.refusals == 1
            assert listener.open_connections == 0
        finally:
            client.close()

    assert received == []


# --- the registry: the latest beat per id ---------------------------------------------------


def test_the_registry_keeps_the_latest_beat_and_when_it_arrived() -> None:
    clock = FakeClock()
    registry = HeartbeatRegistry(clock=clock)

    registry.record(a_beat(progress_at=1.0))
    clock.advance(30)
    latest = registry.record(a_beat(progress_at=31.0))

    assert registry.latest("whodunnit") == latest
    assert latest.received_at == 1_030.0
    assert latest.beat.progress_at == 31.0
    assert registry.ids() == ("whodunnit",)


def test_the_registry_knows_nothing_about_a_process_that_never_beat() -> None:
    assert HeartbeatRegistry().latest("monty") is None


def test_the_registry_reports_every_process_sorted_by_id() -> None:
    registry = HeartbeatRegistry(clock=FakeClock())
    registry.record(a_beat(id="whodunnit"))
    registry.record(a_beat(id="innytypes", kind=ChildKind.HOST))

    assert [record.beat.id for record in registry.records()] == ["innytypes", "whodunnit"]


def test_the_socket_fills_the_registry(socket_path: Path) -> None:
    clock = FakeClock()
    registry = HeartbeatRegistry(clock=clock)
    listener = HeartbeatListener(socket_path, sink=registry.record)

    with listener, HeartbeatSender(socket_path) as sender:
        sender.send(a_beat())
        listener.poll()

    received = registry.latest("whodunnit")
    assert received is not None
    assert received.received_at == clock.now


# --- the stability profile, and what a plugin that published none is watched against --------


def manifest_with(stability: dict[str, object] | None) -> StabilityProfile | None:
    """A parsed manifest's stability section, so the tests use the real parser."""
    document: dict[str, object] = {
        "id": "whodunnit",
        "version": "1.0.0",
        "host_api": 1,
        "requires": [],
        "emits": [],
        "subscribes": [],
    }
    if stability is not None:
        document["stability"] = stability
    return parse_manifest(document).stability


def test_a_partial_stability_section_is_filled_from_the_documented_defaults() -> None:
    profile = resolve_profile(
        manifest_with({"heartbeat_interval": 10}), defaults=HelperNumbers().defaults
    )

    assert profile.heartbeat_interval == 10
    assert profile.stale_after == 30  # three missed heartbeats
    assert profile.max_rss_mb == 1024
    assert profile.max_cpu_percent == 90
    assert profile.cpu_window == 120
    assert profile.max_open_files == 1024
    assert profile.max_children == DEFAULT_MAX_CHILDREN
    assert profile.breach_grace == 60
    assert profile.restartable is True


def test_the_helper_wide_child_limit_is_the_one_a_manifest_may_leave_open() -> None:
    defaults = replace(HelperNumbers().defaults, max_children=4)

    assert resolve_profile(manifest_with({}), defaults=defaults).max_children == 4
    assert resolve_profile(None, defaults=defaults).max_children == 4


def test_a_manifest_that_named_its_own_child_limit_keeps_it() -> None:
    defaults = replace(HelperNumbers().defaults, max_children=4)
    profile = resolve_profile(manifest_with({"max_children": 2}), defaults=defaults)

    assert profile.max_children == 2


def test_a_plugin_with_no_profile_is_watched_under_the_helper_wide_defaults() -> None:
    watchlist = Watchlist(registry=HeartbeatRegistry(clock=FakeClock()))
    policy = watchlist.watch("whodunnit", stability=manifest_with(None))

    assert policy.profile.max_rss_mb == watchlist.defaults.max_rss_mb
    assert policy.profile.max_cpu_percent == watchlist.defaults.max_cpu_percent
    assert policy.profile.max_open_files == watchlist.defaults.max_open_files
    assert policy.profile.breach_grace == watchlist.defaults.breach_grace
    assert policy.profile.restartable is True
    assert policy.promises_heartbeats is False


@pytest.mark.parametrize("elapsed", [0, 1, 60, 3_600, 86_400, 10**9])
def test_a_plugin_that_promised_no_heartbeats_is_never_judged_stale(elapsed: float) -> None:
    clock = FakeClock()
    registry = HeartbeatRegistry(clock=clock)
    watchlist = Watchlist(registry=registry)
    watchlist.watch("whodunnit", stability=manifest_with(None))
    registry.record(a_beat())

    clock.advance(elapsed)
    observation = watchlist.observe("whodunnit")

    # Silence is measured — it is a fact — but there is no deadline for it to pass, so no
    # judgement about staleness can be made about this process, however long it has been.
    assert observation.silent_for == elapsed
    assert observation.policy.stale_after is None
    assert observation.stale_deadline is None


def test_a_plugin_that_promised_heartbeats_has_a_deadline_to_miss() -> None:
    clock = FakeClock()
    registry = HeartbeatRegistry(clock=clock)
    watchlist = Watchlist(registry=registry)
    watchlist.watch("whodunnit", stability=manifest_with({"heartbeat_interval": 10}))
    received = registry.record(a_beat())

    clock.advance(3_600)
    observation = watchlist.observe("whodunnit")

    assert observation.stale_deadline == received.received_at + 30
    assert observation.policy.promises_heartbeats is True


def test_a_process_that_has_never_beaten_has_no_deadline_yet() -> None:
    watchlist = Watchlist(registry=HeartbeatRegistry(clock=FakeClock()))
    watchlist.watch("whodunnit", stability=manifest_with({"heartbeat_interval": 10}))

    observation = watchlist.observe("whodunnit")

    assert observation.latest is None
    assert observation.silent_for is None
    assert observation.stale_deadline is None


def test_a_beat_from_a_process_nobody_registered_is_still_watched() -> None:
    registry = HeartbeatRegistry(clock=FakeClock())
    watchlist = Watchlist(registry=registry)
    registry.record(a_beat(id="monty"))

    observations = watchlist.observations()

    assert [observation.process_id for observation in observations] == ["monty"]
    assert observations[0].policy.profile.max_children == DEFAULT_MAX_CHILDREN


def test_every_watched_process_is_reported_even_before_it_beats() -> None:
    registry = HeartbeatRegistry(clock=FakeClock())
    watchlist = Watchlist(registry=registry)
    watchlist.watch("whodunnit")
    registry.record(a_beat(id="innytypes", kind=ChildKind.HOST))

    assert [observation.process_id for observation in watchlist.observations()] == [
        "innytypes",
        "whodunnit",
    ]


# --- the plugin's own health check (D4) ------------------------------------------------------


def test_a_plugins_own_health_check_is_called_and_its_answer_observed() -> None:
    calls: list[str] = []

    def check() -> bool:
        calls.append("asked")
        return True

    watchlist = Watchlist(registry=HeartbeatRegistry(clock=FakeClock()))
    watchlist.watch("whodunnit", health_check=check)

    observation = watchlist.observe("whodunnit")

    assert calls == ["asked"]
    assert observation.health is True


def test_an_unhealthy_answer_is_carried_as_it_is() -> None:
    watchlist = Watchlist(registry=HeartbeatRegistry(clock=FakeClock()))
    watchlist.watch("whodunnit", health_check=lambda: False)

    assert watchlist.observe("whodunnit").health is False


def test_a_health_check_that_raises_is_not_healthy() -> None:
    def check() -> bool:
        raise RuntimeError("the index is on fire")

    watchlist = Watchlist(registry=HeartbeatRegistry(clock=FakeClock()))
    watchlist.watch("whodunnit", health_check=check)

    assert watchlist.observe("whodunnit").health is False


def test_a_plugin_with_no_health_check_is_not_judged_healthy_or_not() -> None:
    watchlist = Watchlist(registry=HeartbeatRegistry(clock=FakeClock()))
    watchlist.watch("whodunnit")

    observation = watchlist.observe("whodunnit")

    assert isinstance(observation, Observation)
    assert observation.health is None
