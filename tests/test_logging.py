"""Logging: that there is somewhere for a record to go, and that no credential reaches it.

Two halves, in the order they became true.

**The redaction half** (plan 0002). The useful thing to print when the MCP child dies is the
environment it was launched with, and that environment is exactly where the API key lives. So
the supervisor does print it, and the first section here is what keeps that safe. The last test
of that section unhooks the redactor and asserts the key *does* escape — an acceptance check
that cannot fail proves nothing, and this one can.

**The destination half** (plan 0012, slice 04). Until then the redactor was guarding a pipe with
no water in it: nothing in either repository configured a handler, so every record this package
produced was discarded before it reached any stream, and there was no log file on any machine.
The second section is about the file — that three real processes reach one of them, that an
event emitted, accepted or refused is written down distinguishably, that a plugin is handed a
logger rather than left to arrange one, that what a plugin prints is drained rather than lost,
and that the file cannot grow without limit.

**Nothing here writes to the real per-user log.** `tests/conftest.py` redirects
:func:`innytypes.logs.default_log_path` and sets the two variables a spawned child reads; the
last test of this file is the one that would notice if that ever stopped being true.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Mapping
from io import BytesIO
from pathlib import Path
from typing import IO, cast

import pytest
from click.testing import CliRunner

from conftest import FAKE_KEY, SupervisorHarness
from innytypes import HOST_API_VERSION, logs
from innytypes.addons.discovery import InstalledAddon, discover_addons
from innytypes.addons.install import ENTRY_POINT_GROUP
from innytypes.addons.manifest import parse_kind, parse_manifest
from innytypes.addons.run import Addon, AddonContext, run
from innytypes.addons.settings import SETTINGS_PATH_VARIABLE
from innytypes.anytype_mcp import supervisor as supervisor_module
from innytypes.anytype_mcp.config import ServerConfig
from innytypes.children import (
    CHILD_STDERR_LEVEL,
    CHILD_STDOUT_LEVEL,
    ChildSupervisor,
    RunStateFile,
    default_addon_locations,
    record_child_output,
)
from innytypes.cli import cli
from innytypes.events.bus import EventBus
from innytypes.events.channel import SocketPairChannels
from innytypes.events.emitter import Event, KindRegistry
from innytypes.events.transport import (
    Connection,
    PeerGoneError,
    StreamConnection,
    frame_event,
)
from innytypes.helper.config import HelperConfigError, HelperSettings, LoggingSettings

MakeSupervisor = Callable[..., SupervisorHarness]

# The repository root, which a spawned process needs as its working directory the way the
# contract-layer probes do.
REPO = Path(__file__).resolve().parents[1]

# How long a spawned process, or a reader thread, may go unanswered before the test calls the
# run broken. Nothing that passes waits this long.
TIMEOUT = 20.0

# Captured at import, before `tests/conftest.py` redirects it. The last test of this file uses
# it to prove the gate is looking somewhere other than this machine's real log.
REAL_DEFAULT_LOG_PATH = logs.default_log_path


def rendered(record: logging.LogRecord) -> str:
    """Everything a handler could print from ``record``, as one string.

    Not just ``getMessage()``: a record also carries the unrendered template, its
    arguments and any traceback a formatter has already produced, and a credential that
    survives in any of them has survived.
    """
    parts = [record.getMessage(), str(record.msg), str(record.args)]
    if record.exc_text:
        parts.append(record.exc_text)
    return "\n".join(parts)


def run_a_full_cycle(harness: SupervisorHarness) -> None:
    """Start the child, let it die on its own, then stop the supervisor over the corpse."""
    process = harness.supervisor.start()
    process.exit_with(70)
    harness.supervisor.stop()


# --- redaction --------------------------------------------------------------------------


def test_a_full_cycle_logs_something(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    # Guards every other test here: "no record contained the key" is trivially true of a
    # module that logs nothing at all.
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()

    run_a_full_cycle(harness)

    messages = [record.getMessage() for record in caplog.records]
    assert any("starting" in message for message in messages)
    assert any("exited" in message for message in messages)
    assert any("stopping" in message for message in messages)


def test_a_full_cycle_never_logs_the_credential(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()

    run_a_full_cycle(harness)

    for record in caplog.records:
        text = rendered(record)
        assert FAKE_KEY not in text
        assert harness.config.openapi_mcp_headers() not in text


def test_the_exit_report_shows_the_launch_environment_with_the_key_removed(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    # This is the record that would leak. It has to stay useful after redaction, or the
    # next person to debug a dying child deletes the redaction instead of the log line.
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()

    run_a_full_cycle(harness)

    exits = [record.getMessage() for record in caplog.records if "exited" in record.getMessage()]
    assert len(exits) == 1
    assert "OPENAPI_MCP_HEADERS" in exits[0]
    assert logs.REDACTED in exits[0]
    assert harness.config.api_base_url in exits[0]
    assert "70" in exits[0]


def test_without_the_redactor_the_same_cycle_leaks_the_credential(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    """Prove the test above can fail. Unhook the redactor and the key comes straight out."""
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()
    supervisor_module.log.removeFilter(logs.REDACTOR)
    try:
        run_a_full_cycle(harness)
        assert any(FAKE_KEY in rendered(record) for record in caplog.records)
    finally:
        supervisor_module.log.addFilter(logs.REDACTOR)


def test_the_inherited_environment_is_never_logged(
    make_supervisor: MakeSupervisor,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The child inherits PATH and everything else the host was started with, and the
    # user's own environment is full of credentials that have nothing to do with Anytype.
    # Redaction cannot help with those, because this package has never seen them.
    monkeypatch.setenv("SOME_UNRELATED_TOKEN", "fake-unrelated-secret-value")
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()

    run_a_full_cycle(harness)

    for record in caplog.records:
        assert "SOME_UNRELATED_TOKEN" not in rendered(record)
        assert "fake-unrelated-secret-value" not in rendered(record)


def test_a_stop_we_asked_for_does_not_print_the_launch_environment(
    make_supervisor: MakeSupervisor, caplog: pytest.LogCaptureFixture
) -> None:
    # A child we terminated needs no diagnosis, so the one record carrying (redacted)
    # credential material stays out of every routine shutdown.
    caplog.set_level(logging.DEBUG)
    harness = make_supervisor()
    harness.supervisor.start()

    harness.supervisor.stop()

    messages = [record.getMessage() for record in caplog.records]
    assert any("exited with code 0" in message for message in messages)
    assert not any("OPENAPI_MCP_HEADERS" in message for message in messages)


# --- the redactor itself ------------------------------------------------------------------


def make_record(message: str, *args: object) -> logging.LogRecord:
    return logging.LogRecord(
        name="innytypes.anytype_mcp.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=args,
        exc_info=None,
    )


def test_a_config_registers_its_key_the_moment_it_is_built() -> None:
    # "By construction" means here: nothing has to remember to call protect().
    config = ServerConfig(api_key="fake-freshly-built-key-2468")

    assert logs.redact(f"key={config.api_key}") == f"key={logs.REDACTED}"


def test_the_redactor_scrubs_a_credential_hidden_in_an_argument() -> None:
    # A log argument can be any object; the credential hides in its str(), not in the
    # template. Rendering the message before scrubbing is what covers that.
    record = make_record("launched with %s", {"OPENAPI_MCP_HEADERS": f"Bearer {FAKE_KEY}"})

    logs.REDACTOR.filter(record)

    assert FAKE_KEY not in rendered(record)
    assert "OPENAPI_MCP_HEADERS" in record.getMessage()


def test_the_redactor_scrubs_an_already_formatted_traceback() -> None:
    record = make_record("the child would not start")
    record.exc_text = f"Traceback (most recent call last):\nRuntimeError: {FAKE_KEY}"

    logs.REDACTOR.filter(record)

    assert record.exc_text is not None
    assert FAKE_KEY not in record.exc_text
    assert logs.REDACTED in record.exc_text


def test_the_redactor_leaves_a_clean_record_alone() -> None:
    # A record with nothing to hide keeps its arguments, so structured handlers still see
    # fields rather than one pre-rendered string.
    record = make_record("exited with code %d", 70)

    logs.REDACTOR.filter(record)

    assert record.args == (70,)
    assert record.getMessage() == "exited with code 70"


def test_the_redactor_keeps_every_record() -> None:
    # A filter that returns False drops the record. Redaction removes credentials, never
    # evidence: a supervisor whose logs vanish is worse than one that logs too much.
    assert logs.REDACTOR.filter(make_record("anything at all")) is True


def test_an_empty_secret_is_refused() -> None:
    # str.replace("") inserts the marker between every character, so an empty secret would
    # not merely be useless — it would destroy every log line in the process.
    logs.protect("")

    assert logs.redact("untouched") == "untouched"


def test_the_redactor_is_installed_once_per_logger() -> None:
    logger = logs.get_logger("innytypes.anytype_mcp.test_idempotence")
    again = logs.get_logger("innytypes.anytype_mcp.test_idempotence")

    assert logger is again
    assert logger.filters.count(logs.REDACTOR) == 1


def test_the_redactor_does_not_print_its_secrets() -> None:
    # The one object in the process whose state is entirely credentials does not get a
    # revealing repr: a debugger, or a log of the logging configuration, would print it.
    assert FAKE_KEY not in repr(logs.REDACTOR)


# --- the log file: three processes, one destination -------------------------------------------


MANIFEST_DOCUMENT: Mapping[str, object] = {
    "id": "monty",
    "version": "1.4.0",
    "host_api": HOST_API_VERSION,
    "requires": [],
    "emits": ["monty.recorded.v1"],
    "subscribes": [],
}

RECORDED = parse_kind("monty.recorded.v1")
UNDECLARED = parse_kind("monty.undeclared.v1")

# The helper's own first act, run in a process of its own. `main` itself cannot be: it takes
# the single-instance lock, adopts Anytype and starts the host, which is why the one call being
# proved here is a named function rather than a line buried inside it.
START_THE_HELPERS_LOG = (
    "from innytypes.helper.launcher import start_helper_logging; start_helper_logging()"
)


@pytest.fixture
def attached(application_log: Path) -> Iterator[Path]:
    """This process, attached to the gate's log file at DEBUG. Yields the file."""
    logs.start_logging(role="gate", path=application_log, level="debug")
    yield application_log
    logs.stop_logging()


def written(path: Path) -> str:
    """Everything in the log right now, or nothing when there is no file yet."""
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def level_and_process(line: str) -> tuple[str, str]:
    """The level and the process id of one log line.

    :data:`~innytypes.logs.LOG_FORMAT` is date, time, level, process, logger name — and the
    date and the time are two whitespace-separated tokens, which is exactly the off-by-one a
    reader of this file should not have to work out twice.
    """
    parts = line.split()
    return parts[2], parts[3]


def wait_for_line(path: Path, needle: str) -> str:
    """The log, once it contains ``needle`` — or a failure rather than a hung test.

    A bounded poll rather than an event to wait on, because the writer is the host's own
    reader thread (:class:`~innytypes.events.channel.SocketPairChannels`) and it offers nothing
    to synchronise against; the whole point of the test is that it writes to a file. Nothing
    that passes waits more than a few milliseconds.
    """
    deadline = time.monotonic() + TIMEOUT
    while time.monotonic() < deadline:
        text = written(path)
        if needle in text:
            return text
        time.sleep(0.005)
    raise AssertionError(f"{needle!r} never reached {path}; the log holds:\n{written(path)}")


def in_its_own_process(arguments: list[str], log_file: Path) -> subprocess.CompletedProcess[str]:
    """Run one real process of this application, told where the shared log is."""
    return subprocess.run(
        [sys.executable, *arguments],
        cwd=REPO,
        env={
            **os.environ,
            logs.LOG_PATH_VARIABLE: str(log_file),
            logs.LOG_LEVEL_VARIABLE: "debug",
        },
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
        check=False,
    )


def test_the_helper_the_host_and_an_addon_all_reach_one_file(application_log: Path) -> None:
    """Three real processes, three production entry points, one file afterwards.

    The acceptance is deliberately not "a handler was installed" — that is provable of a
    process that then writes nowhere. Each of these is a separate interpreter, entering through
    the function that process actually enters through, and the assertion is made afterwards by
    reading the file.

    * **the helper** through :func:`~innytypes.helper.launcher.start_helper_logging`, which is
      the first thing `innytypes-helper` does;
    * **the host** through `innytypes up`, reached with ``--help`` so that the group callback
      attaches the log and Click then prints usage instead of taking over this machine. The
      line under test is the same line either way — there is one, in the group callback — and
      the role in the record says `host`, which is what proves it is the host's route;
    * **an addon child** through ``python -m innytypes.addons.run``, exactly the argv
      :data:`~innytypes.children.ADDON_RUNNER_MODULE` names. It exits non-zero because its
      standard input is not an event channel, which is the point: it logged anyway.
    """
    helper = in_its_own_process(["-c", START_THE_HELPERS_LOG], application_log)
    host = in_its_own_process(["-m", "innytypes", "up", "--help"], application_log)
    addon = in_its_own_process(["-m", "innytypes.addons.run", "monty"], application_log)

    assert helper.returncode == 0, helper.stderr
    assert host.returncode == 0, host.stderr
    assert addon.returncode != 0, "the addon was given a real channel by accident"

    text = written(application_log)
    assert "innytypes helper" in text
    assert "innytypes host" in text
    assert "innytypes addon monty" in text

    # Three *different* processes, not one that ran three times: the pid in each record is what
    # makes one file readable across them at all.
    pids = {level_and_process(line)[1] for line in text.splitlines() if "is logging to" in line}
    assert len(pids) == 3, text


def test_the_path_is_named_by_a_command(application_log: Path) -> None:
    """Discoverable by somebody who has not read the source, which is the acceptance."""
    result = CliRunner().invoke(cli, ["logs"])

    assert result.exit_code == 0, result.output
    assert str(application_log) in result.output


def test_the_command_shows_the_end_of_the_log(attached: Path) -> None:
    logs.get_logger("innytypes.gate").warning("a line somebody went looking for")

    result = CliRunner().invoke(cli, ["logs", "--tail", "50"])

    assert result.exit_code == 0, result.output
    assert "a line somebody went looking for" in result.output


# --- every event that fires: emitted, accepted, refused ----------------------------------------


def test_an_emitted_event_is_recorded(attached: Path) -> None:
    """The first of the three records, written in the process that emitted it."""
    registry = KindRegistry()
    emitter = registry.emitter_for(parse_manifest(MANIFEST_DOCUMENT), sink=lambda event: None)

    emitter.emit(RECORDED, {"seconds": 12, "label": "Boya"})

    text = written(attached)
    assert "event emitted: monty.recorded.v1 by monty" in text
    # The field names, never the values: a payload is the user's content, and a volume's label
    # is exactly the kind of thing that must not end up in a file for the sake of a diagnostic.
    assert "fields label, seconds" in text
    assert "Boya" not in text


def open_host_channel(channels: SocketPairChannels, addon_id: str = "monty") -> Connection:
    """Open one addon's channel on the host and hand back the *child's* end of it.

    The host side is production, untouched: the socketpair, the transport, the inbound sink
    and the reader thread are all :meth:`SocketPairChannels.open`'s. This test holds what an
    addon process would have inherited as its standard input.
    """
    descriptor = channels.open(addon_id, parse_manifest(MANIFEST_DOCUMENT))
    child = socket.socket(fileno=descriptor)
    child.settimeout(TIMEOUT)
    stream = cast(IO[bytes], child.makefile("rwb"))
    child.close()
    return StreamConnection(reader=stream, writer=stream)


def test_an_accepted_event_and_a_refused_one_do_not_look_alike(attached: Path) -> None:
    """The question this whole slice exists to answer, asked of the real host end.

    Two frames down one real socket: one kind the addon's manifest declared, one it did not.
    The host publishes the first and refuses the second, and afterwards the file has to say
    which was which to somebody scrolling — a different word *and* a different level.
    """
    channels = SocketPairChannels(bus=EventBus(), kinds=KindRegistry())
    child = open_host_channel(channels)
    try:
        child.send(frame_event(Event(kind=RECORDED, payload={"seconds": 12})))
        child.send(frame_event(Event(kind=UNDECLARED, payload={})))

        text = wait_for_line(attached, "event refused from monty")
        assert "event accepted: monty.recorded.v1 from monty" in text
    finally:
        channels.close("monty")
        child.close()

    accepted = next(line for line in text.splitlines() if "event accepted" in line)
    refused = next(line for line in text.splitlines() if "event refused" in line)

    assert "INFO" in accepted
    assert "WARNING" in refused
    # And the refusal says *why*, which is the other half of the acceptance: a refusal with no
    # reason sends the reader back to the source, which is where they started.
    assert "no manifest declared" in refused


def test_a_deliberate_level_separates_the_routine_from_the_wrong(attached: Path) -> None:
    """The levels, asserted as levels rather than as words in a sentence.

    An ordinary emit is not a warning and a refusal is not routine — that is the whole of the
    acceptance, and it is the thing a later change would most easily flatten by reaching for
    whatever level was to hand.
    """
    assert logs.resolve_level("debug") < logs.resolve_level("info")
    assert logs.resolve_level("info") < logs.resolve_level("warning")

    registry = KindRegistry()
    registry.emitter_for(parse_manifest(MANIFEST_DOCUMENT), sink=lambda event: None).emit(
        RECORDED, {"seconds": 12}
    )

    channels = SocketPairChannels(bus=EventBus(), kinds=KindRegistry())
    child = open_host_channel(channels)
    try:
        child.send(frame_event(Event(kind=RECORDED, payload={"seconds": 1})))
        child.send(frame_event(Event(kind=UNDECLARED, payload={})))
        text = wait_for_line(attached, "event refused from monty")
    finally:
        channels.close("monty")
        child.close()

    levels = {
        phrase: level_and_process(line)[0]
        for line in text.splitlines()
        for phrase in ("event emitted", "event accepted", "event refused")
        if phrase in line
    }
    assert levels == {
        # An ordinary emit is the most routine thing this application does…
        "event emitted": "DEBUG",
        # …an event that actually crossed the boundary is the fact worth keeping…
        "event accepted": "INFO",
        # …and a refusal is not routine at all.
        "event refused": "WARNING",
    }


SECOND_UNDECLARED = parse_kind("monty.unplugged.v1")


def test_a_refused_kind_is_told_once_however_often_it_is_sent_and_withdrawn_once_declared(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The volume rule and the way a refusal goes away, at the one place a refusal happens.

    Plan 0012 slice 03: a plugin sending an undeclared kind on every tick is one fact. The
    reporter hears of each kind once — the whole set for that plugin each time it grows — while
    every frame keeps its own WARNING in the log. A plugin restarted with the same manifest is
    not announced again; one reinstalled with a manifest that declares the kind has that
    refusal withdrawn, because it can no longer happen.
    """
    caplog.set_level(logging.WARNING)
    told: list[tuple[str, tuple[str, ...]]] = []
    channels = SocketPairChannels(
        bus=EventBus(),
        kinds=KindRegistry(),
        report_refusals=lambda addon_id, kinds: told.append((addon_id, kinds)),
    )
    child = open_host_channel(channels)
    try:
        for _ in range(10):
            child.send(frame_event(Event(kind=UNDECLARED, payload={})))
        child.send(frame_event(Event(kind=SECOND_UNDECLARED, payload={})))
        for _ in range(10):
            child.send(frame_event(Event(kind=UNDECLARED, payload={})))

        deadline = time.monotonic() + TIMEOUT
        while sum("event refused from monty" in r.getMessage() for r in caplog.records) < 21:
            assert time.monotonic() < deadline, "the host never refused the frames it was sent"
            time.sleep(0.01)
    finally:
        child.close()

    # Twenty-one refusals in the log, two things told.
    assert told == [
        ("monty", (str(UNDECLARED),)),
        ("monty", (str(UNDECLARED), str(SECOND_UNDECLARED))),
    ]

    # Restarted on the same manifest: nothing about the refusals changed, so nothing is said.
    channels.open("monty", parse_manifest(MANIFEST_DOCUMENT))
    assert len(told) == 2

    # Reinstalled with a manifest that declares the first kind: that one is withdrawn.
    declares_one = {**MANIFEST_DOCUMENT, "emits": ["monty.recorded.v1", str(UNDECLARED)]}
    channels.open("monty", parse_manifest(declares_one))
    assert told[-1] == ("monty", (str(SECOND_UNDECLARED),))

    # And the second: nothing is refused any more, and the empty set is what says so.
    declares_both = {**declares_one, "emits": [*declares_one["emits"], str(SECOND_UNDECLARED)]}  # type: ignore[list-item]
    channels.open("monty", parse_manifest(declares_both))
    channels.close("monty")
    assert told[-1] == ("monty", ())
    assert channels.refused("monty") == ()


# --- what a plugin is given, and what it prints -------------------------------------------------


class Stoppable:
    """An addon that does nothing but be startable and stoppable."""

    def handle(self, event: Event) -> None:
        return None

    def stop(self) -> None:
        return None


class NoHost:
    """A connection whose far end was never there: the runner starts, then shuts down.

    Enough to drive :func:`innytypes.addons.run.run` all the way through a start and a clean
    stop with no process, no socket and no thread to wait on — the host closing the channel is
    exactly how an addon is stopped.
    """

    def send(self, frame: str) -> None:
        raise PeerGoneError("the host is not there")

    def receive(self) -> str | None:
        raise PeerGoneError("the host is not there")

    def close(self) -> None:
        return None


def run_one_addon(factory: Callable[[AddonContext], Addon]) -> int:
    """Run the real addon runner against an addon defined in this file."""

    def load(group: str, name: str) -> object:
        return (lambda: MANIFEST_DOCUMENT) if group == ENTRY_POINT_GROUP else factory

    return run("monty", connection=NoHost(), load=load)


def test_a_plugin_is_handed_a_logger_and_what_it_writes_reaches_the_log(attached: Path) -> None:
    """It configures nothing. It is given one, as it is given its emitter and its settings."""
    handed: list[AddonContext] = []

    def start(context: AddonContext) -> Addon:
        handed.append(context)
        context.log.info("monty is watching %s volumes", 3)
        return Stoppable()

    assert run_one_addon(start) == 0

    context = handed[0]
    # Bound to this addon like everything else on the context: the name says who wrote the
    # line, so a plugin never has to remember to say so.
    assert context.log.name == f"{logs.PLUGIN_LOGGER_PREFIX}.monty"
    # And it installed nothing of its own — the handler is the application's, one logger up.
    assert context.log.handlers == []

    assert "monty is watching 3 volumes" in written(attached)


def test_a_plugins_emit_is_recorded_from_inside_the_plugins_own_process(attached: Path) -> None:
    """The emitter on the context is the one the emit record comes from.

    Guards the wiring rather than the emitter: an addon handed a logger but an emitter bound
    somewhere else would still log its own lines and record nothing about its events.
    """

    def start(context: AddonContext) -> Addon:
        context.emitter.emit(RECORDED, {"seconds": 1})
        return Stoppable()

    assert run_one_addon(start) == 0

    assert "event emitted: monty.recorded.v1 by monty" in written(attached)


class Printing:
    """Enough of a spawned process to have printed something and exited."""

    def __init__(self, *, out: bytes = b"", err: bytes = b"") -> None:
        self.pid = 4242
        self.stdout: IO[bytes] = BytesIO(out)
        self.stderr: IO[bytes] = BytesIO(err)

    def poll(self) -> int | None:
        return None

    def terminate(self) -> None:
        return None

    def kill(self) -> None:
        return None

    def wait(self, timeout: float | None = None) -> int:
        return 0


def test_a_child_that_prints_is_recorded_rather_than_discarded(attached: Path) -> None:
    """The pipes `default_spawn` opens are read, which until slice 04 they never were.

    `BytesIO` rather than a real pipe on purpose: it ends at once, so the drain threads finish
    and there is a deterministic moment to assert at — a real child would add a process and a
    wait without adding anything to what is being tested.
    """
    process = Printing(out=b"watching /Volumes\n\nfound 2 disks\n", err=b"cannot read /Volumes/x\n")

    for thread in record_child_output("monty", process):
        thread.join(timeout=TIMEOUT)
        assert not thread.is_alive()

    text = written(attached)
    assert "monty stdout: watching /Volumes" in text
    assert "monty stdout: found 2 disks" in text
    assert "monty stderr: cannot read /Volumes/x" in text
    # Standard error is where a process says something is wrong, so it is recorded as a
    # warning and standard output is not.
    assert CHILD_STDOUT_LEVEL == logging.INFO
    assert CHILD_STDERR_LEVEL == logging.WARNING
    stderr_line = next(line for line in text.splitlines() if "monty stderr" in line)
    assert "WARNING" in stderr_line


def test_a_child_that_prints_an_enormous_line_cannot_flood_the_log(attached: Path) -> None:
    flood = b"x" * (logs.MAX_LOG_BYTES * 2)

    for thread in record_child_output("monty", Printing(out=flood + b"\n")):
        thread.join(timeout=TIMEOUT)

    text = written(attached)
    assert "(line truncated)" in text
    assert len(text) < logs.MAX_LOG_BYTES


def installed_addon(root: Path, addon_id: str = "monty") -> InstalledAddon:
    """One installed addon, discovered the way the host discovers it."""
    directory = root / addon_id
    (directory / "env" / "bin").mkdir(parents=True)
    (directory / "manifest.json").write_text(
        json.dumps({**MANIFEST_DOCUMENT, "id": addon_id}), encoding="utf-8"
    )
    discovered = discover_addons(root)
    assert [found.id for found in discovered.installed] == [addon_id]
    return discovered.installed[0]


def test_a_spawned_addons_pipes_are_drained_by_the_supervisor(
    attached: Path, tmp_path: Path
) -> None:
    """The wiring, not the drainer: the supervisor is what has to call it.

    :func:`~innytypes.children.record_child_output` passing on its own proves nothing if the
    one place a child is created never reaches it — which is exactly the shape of the original
    defect, where the pipes were opened by ``default_spawn`` and nothing anywhere read them.
    """
    addon = installed_addon(tmp_path / "addons")
    printed = Printing(out=b"monty says hello\n")

    supervisor = ChildSupervisor(
        mcp=None,
        addons=[addon],
        run_state=RunStateFile(tmp_path / "run-state.json"),
        report_exit=lambda report: None,
        report_start_failure=lambda failure: None,
        spawn=lambda argv, env, *, channel=None: printed,
        image_of=lambda pid: None,
    )

    supervisor.start("monty")

    assert "monty stdout: monty says hello" in wait_for_line(attached, "monty says hello")


def test_the_host_tells_a_child_it_spawns_where_the_log_is() -> None:
    """The child cannot work it out, so the host answers — as it does for settings.

    The level travels with the path, so a child is as verbose as the host that started it. The
    mis-wire this catches is a variable set to some *other* per-user location: the child would
    start, write a log nobody looks in, and nothing else would be any different.
    """
    told = default_addon_locations("monty")

    assert told[logs.LOG_PATH_VARIABLE] == str(logs.default_log_path())
    assert told[logs.LOG_LEVEL_VARIABLE] == logging.getLevelName(logs.current_level())
    assert told[logs.LOG_PATH_VARIABLE] != told[SETTINGS_PATH_VARIABLE]


# --- the setting, the redaction, and the bound --------------------------------------------------


def test_the_verbosity_is_a_setting(tmp_path: Path) -> None:
    config = tmp_path / "config.toml"
    config.write_text('[logging]\nlevel = "warning"\n', encoding="utf-8")

    assert HelperSettings(path=config).logging.level == "warning"


def test_a_level_nobody_has_is_refused_by_name(tmp_path: Path) -> None:
    config = tmp_path / "config.toml"
    config.write_text('[logging]\nlevel = "chatty"\n', encoding="utf-8")

    with pytest.raises(HelperConfigError, match="logging.level"):
        _ = HelperSettings(path=config).logging


def test_the_default_shows_event_firing_and_is_a_test_mode_choice() -> None:
    """The default is DEBUG because an ordinary emit is DEBUG. That is the whole argument."""
    assert LoggingSettings().level == "debug"
    assert logs.resolve_level(LoggingSettings().level) == logs.DEFAULT_LEVEL
    assert logs.DEFAULT_LEVEL == logging.DEBUG


def test_turning_the_verbosity_down_silences_an_emit_and_not_a_refusal(
    application_log: Path,
) -> None:
    """What the setting is *for*: the routine goes quiet, the wrong does not."""
    logs.start_logging(role="gate", path=application_log, level="info")

    registry = KindRegistry()
    registry.emitter_for(parse_manifest(MANIFEST_DOCUMENT), sink=lambda event: None).emit(
        RECORDED, {"seconds": 12}
    )

    channels = SocketPairChannels(bus=EventBus(), kinds=KindRegistry())
    child = open_host_channel(channels)
    try:
        child.send(frame_event(Event(kind=UNDECLARED, payload={})))
        text = wait_for_line(application_log, "event refused from monty")
    finally:
        channels.close("monty")
        child.close()
        logs.stop_logging()

    assert "event emitted" not in text


def test_no_registered_credential_reaches_the_file(attached: Path) -> None:
    """The redactor above, applied to what is actually written rather than to a record object.

    The filter is on the handler as well as on each logger, which is what covers a record from
    a logger nothing in this package created — a plugin's, for instance.
    """
    secret = "fake-key-that-must-not-be-written-13579"
    logs.protect(secret)

    logging.getLogger("innytypes.plugin.somebody-elses").error("failed with %s", secret)

    text = written(attached)
    assert secret not in text
    assert logs.REDACTED in text


def test_the_file_does_not_grow_without_limit(
    application_log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A machine left running must not fill a disk, and the bound is the handler's own.

    The constants are turned down rather than a megabyte of records written: what is under
    test is that the handler is built with a bound and rotates at it, and a smaller bound tests
    that as well as a large one in a fraction of the time.
    """
    monkeypatch.setattr(logs, "MAX_LOG_BYTES", 4096)
    monkeypatch.setattr(logs, "BACKUP_COUNT", 2)
    logs.start_logging(role="gate", path=application_log, level="debug")
    log = logs.get_logger("innytypes.gate")
    try:
        for index in range(600):
            log.info("a line of the sort a busy machine writes all day, number %s", index)
    finally:
        logs.stop_logging()

    kept = sorted(application_log.parent.glob(f"{application_log.name}*"))
    # The live file plus at most `BACKUP_COUNT` behind it, and every one of them bounded.
    assert 1 < len(kept) <= 3, kept
    for one in kept:
        assert one.stat().st_size < 4096 * 2, one


def test_a_verbosity_spelled_wrong_does_not_silence_the_application(application_log: Path) -> None:
    """The worst possible response to a misspelled level would be to write nothing at all."""
    logs.start_logging(
        role="gate",
        path=application_log,
        environment={logs.LOG_LEVEL_VARIABLE: "chatty"},
    )
    try:
        logs.get_logger("innytypes.gate").debug("still writing")
    finally:
        logs.stop_logging()

    text = written(application_log)
    assert "'chatty' is not a logging level" in text
    assert "logging at DEBUG instead" in text
    assert "still writing" in text


def test_a_number_and_a_name_are_the_same_verbosity() -> None:
    """One value written two ways: a person writes a name, a level is a number."""
    assert logs.resolve_level("Info") == logging.INFO
    assert logs.resolve_level(logging.INFO) == logging.INFO
    assert logs.resolve_level(None) == logs.DEFAULT_LEVEL


def test_a_process_told_nothing_and_unable_to_ask_logs_nowhere(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An addon environment has no `platformdirs`, so the fallback cannot answer.

    ``None`` rather than an exception, and that is the decision: a plugin that cannot log is
    still a plugin that should run, and this is exactly where every record went before slice
    04 existed.
    """

    def no_platformdirs() -> Path:
        raise ModuleNotFoundError("No module named 'platformdirs'")

    monkeypatch.setattr(logs, "default_log_path", no_platformdirs)

    assert logs.start_logging(role="addon monty", environment={}) is None
    assert logs.log_destination() is None


def test_a_destination_that_cannot_be_opened_does_not_stop_the_application(
    tmp_path: Path,
) -> None:
    """A read-only home, a full disk, a path that is already a directory."""
    a_directory = tmp_path / "innytypes.log"
    a_directory.mkdir()

    assert logs.start_logging(role="gate", path=a_directory) is None


def test_a_rollover_by_another_process_does_not_silence_this_one(attached: Path) -> None:
    """The reason :class:`RotatingFileHandler` alone could not be used.

    Three processes share this file, so any of them may roll it over — and a plain rotating
    handler goes on writing into the renamed inode, which means the helper rotating would send
    every one of the host's records into a file nothing ever appends to again. The rename here
    is what a sibling process's rollover looks like from inside this one.
    """
    log = logs.get_logger("innytypes.gate")
    log.warning("before somebody else rolled the file")
    attached.rename(attached.with_suffix(".log.1"))

    log.warning("after somebody else rolled the file")

    assert "after somebody else rolled the file" in written(attached)
    assert "before somebody else rolled the file" not in written(attached)


def test_a_rollover_this_process_loses_is_not_an_error(
    application_log: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two processes can decide to roll one file at the same moment; one of them loses.

    The loser's rename raises, and it must not need to retry — the file *has* been rolled. All
    it owes is a stream to whatever file is live now, which is what the next record proves.
    The rotator is made to raise because that is the one part of the race a single process can
    stage; everything after it is the production path.
    """
    monkeypatch.setattr(logs, "MAX_LOG_BYTES", 2048)
    logs.start_logging(role="gate", path=application_log, level="debug")
    log = logs.get_logger("innytypes.gate")
    try:
        handler = logging.getLogger(logs.PACKAGE_LOGGER).handlers[0]

        def somebody_else_got_there_first(source: str, destination: str) -> None:
            raise OSError("the file this would have renamed is already gone")

        handler.rotator = somebody_else_got_there_first  # type: ignore[attr-defined]
        for index in range(200):
            log.info("a line long enough to push this file over its bound, number %s", index)
    finally:
        logs.stop_logging()

    assert "number 199" in written(application_log)


def test_the_gate_never_writes_to_this_machines_real_log(application_log: Path) -> None:
    """The fixture that keeps the gate out of `~/Library/Logs`, asserted rather than assumed.

    Captured at import, before the redirection, so this compares the real answer with the one
    every test actually gets. Without it the whole file would pass just as happily while
    appending to the log of a live installation.
    """
    real = REAL_DEFAULT_LOG_PATH()

    assert real.name == logs.LOG_FILENAME
    assert application_log != real
    assert logs.default_log_path() == application_log
    assert not application_log.is_relative_to(real.parent)
