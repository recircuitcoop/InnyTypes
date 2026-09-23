"""The control channel between the helper and the host, as two real processes speak it.

Plan 0003 gives the helper every restart decision and the host every spawn, which only works
if the two can talk: the helper sends `start`, `stop`, `restart`, `kill`, `restart-group` and
`list`, and the host reports every child that exits. Both halves were landed as **injected
callables** — :meth:`innytypes.children.ChildSupervisor.execute` on the way in and
:data:`~innytypes.children.ExitReporter` on the way out — and every test has been passing a
fake across them. This module is the wire those two halves were waiting for, and it is the
only way the helper process and the host process talk to each other.

**The helper listens and the host connects**, exactly as the heartbeat socket already works
(:mod:`innytypes.helper.heartbeat`), for the same reason: the helper outlives every host it
starts. A socket owned by the host would have to be created, claimed and torn down again on
every restart, and would be missing at precisely the moment the helper needs to say something
about a host that has just died. One socket, in the per-user runtime directory, owned by the
helper, created ``0o600`` inside a directory created ``0o700`` — what the helper can ask the
host to do is not something another account on a shared machine gets to ask.

**The direction of connection is not the direction of commands.** The host connects, and then
commands travel helper → host and exit reports travel host → helper over that same
connection. That is the point of using one duplex stream rather than two channels: an exit the
host reports while it is carrying out a stop arrives ahead of that stop's answer, on the same
wire, in order — so the helper's restart policy hears about a crash without polling the
run-state file, and a deliberate stop is still marked ``expected`` when it gets there.

**The host says who it is, and a host this helper did not start is refused.** The first frame
on a new connection is a ``hello`` carrying the sender's process id, and the listener compares
it against the pid of the host **this helper launched** (the run-state record it wrote). A
second host started by hand in a terminal, or the previous host that has not noticed it was
replaced, is closed and counted rather than obeyed. The socket's mode is what bounds who can
connect at all; the hello is what tells this user's two hosts apart.

**Nothing hangs, and the three ways this fails are three different sentences.**

* :class:`HostNotRunningError` — no host is connected to this helper. Nothing was sent.
* :class:`ControlLinkError` — the connection dropped. The command may or may not have been
  carried out, which is exactly why it is not reported as silence.
* :class:`HostSilentError` — the command went out on a connection that is still open and no
  answer came back inside the deadline. Plan 0003 already says what that means: *the host does
  not answer a command → the helper treats the host as stale*.

Every command carries a **request number** and every answer carries it back. That is what
makes the deadline safe: an answer that arrives after the helper has given up is recognised as
the answer to a command nobody is waiting for any more, and is dropped rather than handed back
as the answer to the next one.

**The wire format is the one this application already uses**: newline-delimited JSON, as in
:mod:`innytypes.events.transport` and the heartbeat socket. A frame is a JSON object with a
``type``, and a dump of the socket is readable.

**What this module does not do.** It does not run the helper's tick, and it opens nothing by
itself. :class:`ControlListener` is what the helper's loop opens and polls
(:func:`innytypes.helper.launcher.main` and
:func:`innytypes.helper.supervision.build_supervision`), and :func:`connect_to_helper` is what
the host process calls once it is up — :class:`innytypes.cli.HelperAttachment`, from inside
`innytypes up`, which is the command the helper starts the host with. Until plan 0008 slice 03
that second caller did not exist: both ends were implemented and tested against each other and
nothing in the shipped application joined them, so every command above reached nothing there.
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from itertools import count
from pathlib import Path
from typing import Protocol

from platformdirs import user_runtime_path

from innytypes.children import (
    ChildExit,
    ChildKind,
    ChildRecord,
    ChildStartFailure,
    Command,
    CommandName,
    CommandResult,
    Degradation,
    DegradationReporter,
    ExitReporter,
    RunStateError,
    RunStateFile,
    StartFailureReporter,
)
from innytypes.helper.config import APPLICATION_NAME
from innytypes.helper.heartbeat import FRAME_TERMINATOR, RUNTIME_DIR_MODE, SOCKET_MODE
from innytypes.helper.restart import ControlChannel
from innytypes.logs import get_logger

__all__ = [
    "COMMAND_TIMEOUT",
    "CONTROL_SOCKET_NAME",
    "MAX_FRAME_BYTES",
    "CommandRefusedError",
    "ControlConnection",
    "ControlError",
    "ControlLinkError",
    "ControlListener",
    "ControlProtocolError",
    "ControlSocketError",
    "HelperLink",
    "HostLink",
    "HostNotRunningError",
    "HostSilentError",
    "MessageType",
    "SocketConnection",
    "connect_to_helper",
    "default_control_socket_path",
    "encode_command",
    "encode_degradations",
    "encode_exit",
    "encode_hello",
    "encode_refusal",
    "encode_start_failure",
    "encode_result",
    "recorded_host_pid",
]

log = get_logger(__name__)

# The socket lives beside the heartbeat socket and the run-state file, in the per-user runtime
# directory, and for the same reason: it is a channel to processes that exist right now, and
# the system is entitled to clear the lot on a reboot.
CONTROL_SOCKET_NAME = "control.sock"

# How long the helper waits for one command to be answered before it calls the host stale.
# Deliberately longer than the host's own polite stop of a whole group: a host part-way through
# stopping four plugins, five seconds each, is carrying out the command it was given, and a
# helper that declared it stale there would restart a host that was doing exactly as it was
# told. Silence here means *no progress at all*, not *slower than a keystroke*.
COMMAND_TIMEOUT = 30.0

# A whole frame, buffered before a newline arrives. The biggest frame this protocol has is the
# answer to `list` — every live child's record — and the limit is what stops a peer that never
# sends a newline from growing either process's memory without bound.
MAX_FRAME_BYTES = 256 * 1024

_RECEIVE_CHUNK = 65536
_LISTEN_BACKLOG = 4


class ControlError(RuntimeError):
    """Raised when a command cannot be carried between the helper and the host.

    One base for every way this channel fails, so a caller that only wants to know "that did
    not reach the host" catches once — and the subclasses below are there because the caller
    that *does* care must never have to tell them apart by reading a message.
    """


class ControlSocketError(ControlError):
    """Raised when the control socket cannot be opened, claimed or reached.

    The counterpart of :class:`~innytypes.helper.heartbeat.HeartbeatSocketError`, and separate
    from the errors below for the same reason: this one is a fact about the machine — no
    helper is listening, or something else already holds the path — rather than about a
    command.
    """


class HostNotRunningError(ControlError):
    """Raised when there is no host connected to this helper. **Nothing was sent.**

    The one failure a caller can act on without qualification: the command did not happen, so
    retrying it costs nothing and undoing it means nothing.
    """


class ControlLinkError(ControlError):
    """Raised when the connection to the peer dropped.

    Distinct from :class:`HostSilentError` because the two are different facts about the
    world: a dropped connection is a host that is *gone*, and a command sent on it may still
    have been carried out before it went. A caller that treated this as silence would be
    guessing about a process that no longer exists.
    """


class HostSilentError(ControlError):
    """Raised when a command went out and no answer came back inside the deadline.

    The connection is still open and the host is still there; it is simply not answering.
    Plan 0003 says what the helper does about that: **a host that does not answer a command is
    treated as stale**, which is a restart decision and therefore the policy's
    (:meth:`innytypes.helper.restart.RestartPolicy.child_stale`), never this module's.
    """


class CommandRefusedError(ControlError):
    """Raised when the host answered, and its answer was no.

    A command naming a child this host does not have is refused **by name** (plan 0003): a
    helper and a host that disagree about what is installed is a fact worth an error, and an
    error that crossed the wire is not the same thing as silence.
    """


class ControlProtocolError(ControlError):
    """Raised when a frame is not something this protocol says."""


class MessageType(StrEnum):
    """The seven things either end can put on the wire.

    ``HELLO`` is sent once per connection, by the host, before anything else; ``COMMAND`` and
    its two answers ``RESULT`` and ``REFUSED`` are the helper's round trip; ``EXIT``,
    ``START_FAILED`` and ``DEGRADED`` are the host's own, sent without being asked whenever a
    child goes, whenever one could not be started, and once the host has finished starting.

    ``START_FAILED`` is a message type of its own rather than an ``EXIT`` with no process id,
    because the helper acts on the difference: a child that died is restartable and a child
    that never started is not (:class:`~innytypes.children.ChildStartFailure`).

    ``DEGRADED`` is a third because it is not about a child at all. It carries what the host
    **came up without** — which includes parts the child supervisor does not own, such as the
    MCP HTTP endpoint — and it carries the whole set at once, so that a host which came up
    clean says so and the helper stops showing what the last one was missing.
    """

    HELLO = "hello"
    COMMAND = "command"
    RESULT = "result"
    REFUSED = "refused"
    EXIT = "exit"
    START_FAILED = "start-failed"
    DEGRADED = "degraded"


def default_control_socket_path() -> Path:
    """Where the control socket lives for this user, creating nothing."""
    return user_runtime_path(APPLICATION_NAME, appauthor=False) / CONTROL_SOCKET_NAME


# ── the frames ───────────────────────────────────────────────────────────────────────────────


def encode_hello(pid: int) -> str:
    """The host's first frame: which process it is."""
    return json.dumps({"type": MessageType.HELLO.value, "pid": pid})


def encode_command(request: int, command: Command) -> str:
    """One command, with the number its answer will carry back.

    ``endpoint`` is on every command frame and is ``null`` on all but ``set-endpoint``, in
    the same way ``child_id`` is ``null`` on ``list``: one shape per message type is what
    lets a reader refuse a malformed frame by naming the field rather than by guessing which
    fields this particular command should have had.
    """
    return json.dumps(
        {
            "type": MessageType.COMMAND.value,
            "request": request,
            "name": command.name.value,
            "child_id": command.child_id,
            "group": list(command.group),
            "endpoint": None if command.endpoint is None else list(command.endpoint),
        }
    )


def encode_result(request: int, result: CommandResult) -> str:
    """What carrying out a command produced, as the answer to that request.

    ``endpoint`` carries the address the host is serving after a ``set-endpoint``, and is
    ``null`` for every other answer. It is a URL and nothing else: no token, no key, and no
    part of the gateway's configuration beyond the address a client has to be pointed at.
    """
    return json.dumps(
        {
            "type": MessageType.RESULT.value,
            "request": request,
            "name": result.name.value,
            "children": [record.to_document() for record in result.children],
            "endpoint": result.endpoint,
            "endpoint_moved": result.endpoint_moved,
        }
    )


def encode_refusal(request: int, name: CommandName, reason: str) -> str:
    """The host's other answer: it could not, and this is why, in its own words."""
    return json.dumps(
        {
            "type": MessageType.REFUSED.value,
            "request": request,
            "name": name.value,
            "reason": reason,
        }
    )


def encode_exit(exit_report: ChildExit) -> str:
    """One child that is gone, as the host tells the helper about it."""
    return json.dumps(
        {
            "type": MessageType.EXIT.value,
            "id": exit_report.id,
            "kind": str(exit_report.kind),
            "pid": exit_report.pid,
            "exit_code": exit_report.exit_code,
            "expected": exit_report.expected,
        }
    )


def encode_start_failure(failure: ChildStartFailure) -> str:
    """One child that could not be started, as the host tells the helper about it.

    No ``pid`` and no ``exit_code``: there was never a process. A reader of a socket dump can
    tell this frame from an ``exit`` at a glance, which is the same distinction the helper
    makes when it decides what to do about it.
    """
    return json.dumps(
        {
            "type": MessageType.START_FAILED.value,
            "id": failure.id,
            "kind": str(failure.kind),
            "reason": failure.reason,
        }
    )


def encode_degradations(degradations: Sequence[Degradation]) -> str:
    """Everything the host came up without, as one frame.

    **The whole set, not one degradation per frame**, and an empty set is a frame worth
    sending. What the helper shows is *the state of the host right now*, so the message has
    to be able to say "nothing is missing" — otherwise a host that came up clean after a
    restart would leave the window and `innytypes helper status` repeating the reason the
    previous one failed, with nothing able to withdraw it.
    """
    return json.dumps(
        {
            "type": MessageType.DEGRADED.value,
            "degradations": [
                {"component": one.component, "reason": one.reason} for one in degradations
            ],
        }
    )


def _decode(frame: str) -> Mapping[str, object]:
    """One frame as the object it must be, or a refusal naming what was wrong with it."""
    try:
        decoded = json.loads(frame)
    except ValueError as error:
        raise ControlProtocolError(f"a control frame is JSON, and this one is not: {error}") from (
            error
        )

    if not isinstance(decoded, dict):
        raise ControlProtocolError(
            f"a control frame is a JSON object, got {type(decoded).__name__}: {frame!r}"
        )
    return decoded


def _message_type(document: Mapping[str, object]) -> MessageType:
    text = _text(document, "type")
    try:
        return MessageType(text)
    except ValueError as error:
        known = ", ".join(kind.value for kind in MessageType)
        raise ControlProtocolError(
            f"a control frame's type is {text!r}, which this channel does not speak; expected "
            f"one of: {known}"
        ) from error


def _command_from(document: Mapping[str, object]) -> Command:
    """One command read back, or a refusal naming the field that was wrong."""
    text = _text(document, "name")
    try:
        name = CommandName(text)
    except ValueError as error:
        known = ", ".join(command.value for command in CommandName)
        raise ControlProtocolError(
            f"{text!r} is not a command this host carries out; expected one of: {known}"
        ) from error

    child_id = document.get("child_id")
    if child_id is not None and not isinstance(child_id, str):
        raise ControlProtocolError(f"a command's child_id is the child's name, got {child_id!r}")

    group = document.get("group", [])
    if not isinstance(group, list) or not all(isinstance(member, str) for member in group):
        raise ControlProtocolError(f"a command's group is a list of child names, got {group!r}")

    return Command(
        name=name,
        child_id=child_id,
        group=tuple(group),
        endpoint=_endpoint_from(document),
    )


def _endpoint_from(document: Mapping[str, object]) -> tuple[str, int] | None:
    """The address a ``set-endpoint`` asks for, or ``None`` when the frame carries none.

    Refused by shape here and judged by nobody here: whether the address may be served is
    :func:`~innytypes.anytype_mcp.endpoint.checked_address`'s one rule, applied by the host
    when it binds. A second opinion on this wire would be a second wording of the refusal.
    """
    endpoint = document.get("endpoint")
    if endpoint is None:
        return None
    if (
        not isinstance(endpoint, list)
        or len(endpoint) != 2
        or not isinstance(endpoint[0], str)
        or isinstance(endpoint[1], bool)
        or not isinstance(endpoint[1], int)
    ):
        raise ControlProtocolError(
            f"a command's endpoint is an address and a whole-number port, got {endpoint!r}"
        )
    return endpoint[0], endpoint[1]


def _result_from(document: Mapping[str, object]) -> CommandResult:
    """One answer read back into the result the caller of ``send`` is handed."""
    text = _text(document, "name")
    try:
        name = CommandName(text)
    except ValueError as error:
        raise ControlProtocolError(f"{text!r} is not a command name: {error}") from error

    children = document.get("children", [])
    if not isinstance(children, list):
        raise ControlProtocolError(f"a result's children are a list of records, got {children!r}")

    records = []
    for child in children:
        if not isinstance(child, dict):
            raise ControlProtocolError(f"a result's children are records, and one is {child!r}")
        try:
            records.append(ChildRecord.from_document(child))
        except RunStateError as error:
            raise ControlProtocolError(
                f"a result carried something that is not a child record: {error}"
            ) from error

    endpoint = document.get("endpoint")
    if endpoint is not None and not isinstance(endpoint, str):
        raise ControlProtocolError(
            f"a result's endpoint is the URL now being served, got {endpoint!r}"
        )

    moved = document.get("endpoint_moved", False)
    if not isinstance(moved, bool):
        raise ControlProtocolError(
            f"a result says whether the listener moved, and this one says {moved!r}"
        )

    return CommandResult(
        name=name, children=tuple(records), endpoint=endpoint, endpoint_moved=moved
    )


def _exit_from(document: Mapping[str, object]) -> ChildExit:
    """One exit report read back into the thing the restart policy is handed."""
    kind_text = _text(document, "kind")
    try:
        kind = ChildKind(kind_text)
    except ValueError as error:
        known = ", ".join(kind.value for kind in ChildKind)
        raise ControlProtocolError(
            f"an exit report's kind is {kind_text!r}, which is not a kind of managed process; "
            f"expected one of: {known}"
        ) from error

    exit_code = document.get("exit_code")
    if exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)):
        raise ControlProtocolError(
            f"an exit report's exit_code is a whole number or nothing, got {exit_code!r}"
        )

    expected = document.get("expected")
    if not isinstance(expected, bool):
        raise ControlProtocolError(
            "an exit report says whether the host asked for the stop, and this one says "
            f"{expected!r}. The helper restarts what it did not ask to stop, so the field is "
            "never guessed at"
        )

    return ChildExit(
        id=_text(document, "id"),
        kind=kind,
        pid=_whole_number(document, "pid"),
        exit_code=exit_code,
        expected=expected,
    )


def _start_failure_from(document: Mapping[str, object]) -> ChildStartFailure:
    """One failed start read back into the thing the restart policy is handed."""
    kind_text = _text(document, "kind")
    try:
        kind = ChildKind(kind_text)
    except ValueError as error:
        known = ", ".join(kind.value for kind in ChildKind)
        raise ControlProtocolError(
            f"a start failure's kind is {kind_text!r}, which is not a kind of managed process; "
            f"expected one of: {known}"
        ) from error

    return ChildStartFailure(
        id=_text(document, "id"),
        kind=kind,
        reason=_text(document, "reason"),
    )


def _degradations_from(document: Mapping[str, object]) -> tuple[Degradation, ...]:
    """One ``degraded`` frame read back into the set the helper holds and shows.

    A frame whose list is not a list, or whose entries are not objects, is refused rather
    than partly read: a half-decoded set would be shown to a person as the whole truth about
    what is running.
    """
    entries = document.get("degradations")
    if not isinstance(entries, list):
        raise ControlProtocolError(
            "a degraded frame carries a `degradations` list, and this one does not"
        )

    degraded: list[Degradation] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ControlProtocolError(
                "every entry in a degraded frame is an object naming a component and a reason"
            )
        degraded.append(
            Degradation(component=_text(entry, "component"), reason=_text(entry, "reason"))
        )
    return tuple(degraded)


def _text(document: Mapping[str, object], key: str) -> str:
    if key not in document:
        raise ControlProtocolError(f"a control frame is missing {key}")
    value = document[key]
    if not isinstance(value, str):
        raise ControlProtocolError(f"a control frame's {key} must be text, got {value!r}")
    return value


def _whole_number(document: Mapping[str, object], key: str) -> int:
    if key not in document:
        raise ControlProtocolError(f"a control frame is missing {key}")
    value = document[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ControlProtocolError(f"a control frame's {key} must be a whole number, got {value!r}")
    return value


def _request_of(document: Mapping[str, object]) -> int:
    return _whole_number(document, "request")


# ── the connection under both ends ───────────────────────────────────────────────────────────


class ControlConnection(Protocol):
    """One end of a duplex, frame-at-a-time channel to exactly one peer.

    A protocol rather than a class because the deadline above it has to be provable without
    spending it: a test hands both ends a real socketpair where the timing is the real thing,
    and hands the deadline a connection that simply never answers where it is not.
    """

    def send(self, frame: str) -> None:
        """Write one frame, or raise :class:`ControlLinkError` if the peer is gone."""
        ...

    def receive(self, timeout: float | None) -> str | None:
        """The next whole frame, ``None`` if ``timeout`` passed without one.

        ``timeout`` of ``0`` is a look rather than a wait, and ``None`` waits for as long as it
        takes. A peer that has gone raises :class:`ControlLinkError`: a closed connection is a
        fact to report, never a quiet moment that looks like a deadline.
        """
        ...

    def close(self) -> None:
        """Release this end. Sending or receiving afterwards is a gone peer."""
        ...


class SocketConnection(ControlConnection):
    """Newline-delimited JSON frames over one ``AF_UNIX`` stream — the real connection.

    It inherits the protocol rather than merely satisfying it, so the connection both
    processes ship is checked against the seam the deadline is tested through.
    """

    def __init__(self, sock: socket.socket, *, max_frame_bytes: int = MAX_FRAME_BYTES) -> None:
        self._socket = sock
        self._max_frame_bytes = max_frame_bytes
        self._buffer = bytearray()

    def send(self, frame: str) -> None:
        """Write one frame whole. A short write is not a thing ``sendall`` leaves behind."""
        try:
            self._socket.sendall(frame.encode("utf-8") + FRAME_TERMINATOR)
        except (OSError, ValueError) as error:
            raise ControlLinkError(
                f"the control connection is gone: {type(error).__name__}: {error}"
            ) from error

    def receive(self, timeout: float | None) -> str | None:
        """The next frame, waiting up to ``timeout`` seconds in total for it to arrive."""
        deadline = None if timeout is None else time.monotonic() + timeout

        while True:
            frame = self._take_frame()
            if frame is not None:
                return frame

            remaining = None if deadline is None else max(deadline - time.monotonic(), 0.0)
            if not self._fill(remaining):
                return None

    def close(self) -> None:
        """Close this end, waking whatever is reading it, and tolerating a second close.

        The shutdown is not tidiness. The host's reader waits on this connection with no
        deadline (:meth:`HelperLink.serve_one`), and closing a descriptor another thread is
        blocked reading is not what wakes that thread — a half-close is, because the read
        then ends the way a peer going away ends it. Without it a host that closed its own
        end at shutdown would leave a thread parked on a descriptor number that the process
        is free to hand to something else.
        """
        with contextlib.suppress(OSError):
            self._socket.shutdown(socket.SHUT_RDWR)
        try:
            self._socket.close()
        except OSError:  # pragma: no cover - closing what is already closed
            log.debug("the control connection was already closed")

    def _fill(self, timeout: float | None) -> bool:
        """Read whatever has arrived. False when ``timeout`` passed with nothing on the wire."""
        try:
            self._socket.settimeout(timeout)
            chunk = self._socket.recv(_RECEIVE_CHUNK)
        except (TimeoutError, BlockingIOError):
            # `settimeout(0)` makes the socket non-blocking, where "nothing yet" is a
            # BlockingIOError rather than a timeout. Both mean the same thing here.
            return False
        except (OSError, ValueError) as error:
            raise ControlLinkError(
                f"the control connection is gone: {type(error).__name__}: {error}"
            ) from error

        if not chunk:
            raise ControlLinkError("the far end closed the control connection")

        self._buffer += chunk
        if len(self._buffer) > self._max_frame_bytes:
            raise ControlProtocolError(
                f"a peer sent more than {self._max_frame_bytes} bytes with no end of frame"
            )
        return True

    def _take_frame(self) -> str | None:
        """One whole frame out of the buffer, or None while the buffer holds only part of one."""
        if FRAME_TERMINATOR not in self._buffer:
            return None

        line, _, rest = self._buffer.partition(FRAME_TERMINATOR)
        self._buffer = bytearray(rest)
        try:
            return line.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ControlProtocolError(
                f"a control frame is UTF-8 JSON, and this one is not: {error}"
            ) from error


# ── the helper's end ─────────────────────────────────────────────────────────────────────────


@dataclass
class HostLink(ControlChannel):
    """The helper's half of one verified connection: commands out, exits in.

    Separate from :class:`ControlListener` because they answer different questions. This is the
    **protocol** — what a command looks like, how long an answer may take, what happens to a
    frame that arrives while the helper is waiting for a different one — and the listener is
    the **socket**: who may connect, which peer is the host, and what a dropped one means.
    Splitting them is also what makes the deadline provable: a test drives this class over a
    connection that never answers, and no test ever waits out a real one.
    """

    connection: ControlConnection
    report_exit: ExitReporter
    # Required, exactly as ``report_exit`` is, and for a reason this channel has already been
    # bitten by twice: a default here would let a caller that forgot the wire keep working,
    # decoding every report and dropping it into a log nobody reads. That is not a weaker
    # version of being told — it is the silence this direction exists to end, wearing the
    # shape of a working helper. A missing wire is a TypeError at construction instead.
    report_start_failure: StartFailureReporter
    # Required for the same reason, and it is the one this channel was missing longest: the
    # sentence naming what the host came up without existed inside the host process, fully
    # formed, and reached nobody. A default here would decode it and drop it again.
    report_degradations: DegradationReporter
    timeout: float = COMMAND_TIMEOUT
    now: Callable[[], float] = time.monotonic

    # Every unsolicited report delivered over this connection — a child that exited, a child
    # that could not be started, and the set the host came up without — counted so that a
    # caller which only wants to know "did anything arrive" does not have to be handed the
    # reports a second time.
    reported: int = field(default=0, init=False)
    _requests: count[int] = field(default_factory=lambda: count(1), init=False)

    def send(self, command: Command) -> CommandResult:
        """Carry out one command on the host and answer with what it produced.

        Exit reports that arrive while this is waiting are **delivered on the way past**,
        because they are on the same wire and in order: the exit a stop produces reaches the
        restart policy marked ``expected`` before that stop's answer reaches the caller.
        """
        request = next(self._requests)
        self.connection.send(encode_command(request, command))

        deadline = self.now() + self.timeout
        while True:
            remaining = deadline - self.now()
            frame = None if remaining <= 0 else self.connection.receive(timeout=remaining)
            if frame is None:
                raise HostSilentError(
                    f"the host did not answer {command.name} within {self.timeout:g}s. A host "
                    "that does not answer a command is treated as stale"
                )

            answer = self._dispatch(frame, request=request, name=command.name)
            if answer is not None:
                return answer

    def pump(self) -> int:
        """Deliver every report that has arrived, and wait for none. Returns how many.

        This is what makes a crash visible without polling a file: the host writes the report
        the moment a child goes — or the moment one fails to start — and the helper's tick
        picks it up here.
        """
        before = self.reported
        while (frame := self.connection.receive(timeout=0.0)) is not None:
            self._dispatch(frame, request=None, name=None)
        return self.reported - before

    def close(self) -> None:
        """Release this end of the connection."""
        self.connection.close()

    def _dispatch(
        self, frame: str, *, request: int | None, name: CommandName | None
    ) -> CommandResult | None:
        """One frame: a report to deliver, the answer being waited for, or neither.

        Returning ``None`` means "keep reading". An answer whose request number is not the one
        outstanding is an answer to a command the helper has already given up on — dropped
        here, rather than handed back as the answer to this one.
        """
        document = _decode(frame)
        message = _message_type(document)

        if message is MessageType.EXIT:
            self.report_exit(_exit_from(document))
            self.reported += 1
            return None

        if message is MessageType.START_FAILED:
            self.report_start_failure(_start_failure_from(document))
            self.reported += 1
            return None

        if message is MessageType.DEGRADED:
            self.report_degradations(_degradations_from(document))
            self.reported += 1
            return None

        if message in (MessageType.RESULT, MessageType.REFUSED):
            if _request_of(document) != request:
                log.warning(
                    "the host answered command %s, which is not the one being waited for",
                    _request_of(document),
                )
                return None

            if message is MessageType.REFUSED:
                raise CommandRefusedError(f"the host refused {name}: {_text(document, 'reason')}")
            return _result_from(document)

        raise ControlProtocolError(
            f"the host sent a {message} frame, which is not something a host says"
        )


class ControlListener(ControlChannel):
    """The helper's end of the control channel: the socket it owns, and the host on it.

    Implements :class:`~innytypes.helper.restart.ControlChannel`, so the restart policy, the
    enable switch, the plugin page and the update rollout all speak to the real host through
    the object they were already written against.

    Driven by :meth:`poll` rather than a thread of its own, exactly as the heartbeat listener
    is and for the same reason: the helper already has a tick, and a second schedule is a
    second thing to reason about when something goes wrong.

    ``host_pid`` is what makes this channel the helper's own. It answers with the process id of
    the host **this helper started** — :func:`recorded_host_pid` reads it from the run-state
    file — and a peer whose ``hello`` says anything else is closed and counted. It is a
    callable rather than a number because the helper restarts the host, and the answer changes
    when it does.
    """

    def __init__(
        self,
        path: Path | None = None,
        *,
        report_exit: ExitReporter,
        report_start_failure: StartFailureReporter,
        report_degradations: DegradationReporter,
        host_pid: Callable[[], int | None],
        timeout: float = COMMAND_TIMEOUT,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self.path = default_control_socket_path() if path is None else path
        self.refusals = 0
        self._report_exit = report_exit
        self._report_start_failure = report_start_failure
        self._report_degradations = report_degradations
        self._host_pid = host_pid
        self._timeout = timeout
        self._now = now
        self._socket: socket.socket | None = None
        self._pending: list[SocketConnection] = []
        self._host: HostLink | None = None

    def __enter__(self) -> ControlListener:
        self.open()
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @property
    def host(self) -> HostLink | None:
        """The connected host, or ``None`` while no verified host is on the socket."""
        return self._host

    def open(self) -> None:
        """Create the directory, claim the path, bind owner-only, and start listening."""
        if self._socket is not None:
            raise ControlSocketError(f"the control listener on {self.path} is already open")

        directory = self.path.parent
        directory.mkdir(parents=True, exist_ok=True)
        # `mkdir`'s mode is masked by the umask and an existing directory keeps whatever mode it
        # had, so the mode is set explicitly — the same belt and braces as the heartbeat socket.
        os.chmod(directory, RUNTIME_DIR_MODE)

        self._claim_path()

        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        previous_umask = os.umask(0o077)
        try:
            server.bind(str(self.path))
        except OSError as error:
            server.close()
            raise ControlSocketError(
                f"the control socket {self.path} could not be created: {error}"
            ) from error
        finally:
            os.umask(previous_umask)

        # The umask above closed the window in which the socket existed readable by others;
        # this makes the mode independent of whatever the umask was.
        os.chmod(self.path, SOCKET_MODE)
        server.listen(_LISTEN_BACKLOG)
        server.setblocking(False)
        self._socket = server

    def poll(self) -> int:
        """Take whoever connected, and deliver every report waiting. Never blocks."""
        self._accept_pending()
        for connection in list(self._pending):
            self._identify(connection)

        if self._host is None:
            return 0

        try:
            return self._host.pump()
        except ControlError as error:
            # Both ways this ends are the end of this connection: a host that is gone, and a
            # host talking a language this channel does not speak — after which the stream is
            # out of step and every later frame would be read against the wrong boundary.
            log.warning("the host's control connection was dropped: %s", error)
            self.refusals += 1
            self._drop_host()
            return 0

    def send(self, command: Command) -> CommandResult:
        """Ask the host to do one thing, and answer with what it did.

        Accepting first, so that a host which connected a moment ago is the host this command
        goes to rather than a :class:`HostNotRunningError` the caller has to retry past.
        """
        self.poll()

        if self._host is None:
            raise HostNotRunningError(
                f"no host is connected to this helper on {self.path}, so {command.name} reached "
                "nothing"
            )

        try:
            return self._host.send(command)
        except (ControlLinkError, ControlProtocolError):
            # A connection that dropped — or one that is out of step — is not a host any more.
            # Dropping it here is what makes the *next* command a clean "no host is running"
            # rather than a second write into a socket nobody holds.
            self._drop_host()
            raise

    def close(self) -> None:
        """Drop every peer, close the socket and remove its path."""
        for connection in self._pending:
            connection.close()
        self._pending.clear()
        self._drop_host()

        if self._socket is not None:
            self._socket.close()
            self._socket = None
            self.path.unlink(missing_ok=True)

    def _require_open(self) -> socket.socket:
        if self._socket is None:
            raise ControlSocketError(f"the control listener on {self.path} is not open")
        return self._socket

    def _claim_path(self) -> None:
        """Decide what an existing path means, and act only where the answer is unambiguous."""
        if not self.path.exists():
            return

        if not self.path.is_socket():
            raise ControlSocketError(
                f"{self.path} exists and is not a socket, so the helper will not replace it: "
                "move it aside if it is yours"
            )

        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(str(self.path))
        except OSError:
            # Nobody is listening: the socket outlived the helper that made it.
            self.path.unlink(missing_ok=True)
        else:
            raise ControlSocketError(
                f"another helper is already listening on {self.path}: only one helper owns the "
                "control socket"
            )
        finally:
            probe.close()

    def _accept_pending(self) -> None:
        server = self._require_open()
        while True:
            try:
                connection, _ = server.accept()
            except BlockingIOError:
                return
            except OSError as error:  # pragma: no cover - the socket died under us
                raise ControlSocketError(
                    f"the control socket {self.path} stopped accepting: {error}"
                ) from error

            self._pending.append(SocketConnection(connection))

    def _identify(self, connection: SocketConnection) -> None:
        """Read a peer's ``hello`` and decide whether it is the host this helper started.

        A peer that has connected and said nothing yet costs this call nothing and is asked
        again on the next poll: the frame it is part-way through sending waits in its own
        buffer.
        """
        try:
            frame = connection.receive(timeout=0.0)
        except ControlError as error:
            log.warning("a peer went away before it said which process it is: %s", error)
            self._drop_pending(connection)
            return

        if frame is None:
            return

        try:
            document = _decode(frame)
            if _message_type(document) is not MessageType.HELLO:
                raise ControlProtocolError(
                    "the first frame on a control connection is a hello saying which process "
                    f"the peer is, and this one is a {_message_type(document)}"
                )
            pid = _whole_number(document, "pid")
        except ControlError as error:
            self._refuse(connection, str(error))
            return

        expected = self._host_pid()
        if expected is None or pid != expected:
            self._refuse(
                connection,
                f"process {pid} is not the host this helper started (that is {expected})",
            )
            return

        if self._host is not None:
            # One host at a time. A newly verified host is the one this helper just launched,
            # and the connection it replaces belongs to a host that is already gone.
            log.info("a new host connected; the previous control connection is dropped")
            self._drop_host()

        self._pending.remove(connection)
        self._host = HostLink(
            connection=connection,
            report_exit=self._report_exit,
            report_start_failure=self._report_start_failure,
            report_degradations=self._report_degradations,
            timeout=self._timeout,
            now=self._now,
        )
        log.info("the host (process %s) is connected to the control socket", pid)

    def _refuse(self, connection: SocketConnection, reason: str) -> None:
        """Close a peer this helper will not talk to, and count it."""
        self.refusals += 1
        log.warning("a peer on the control socket was refused: %s", reason)
        self._drop_pending(connection)

    def _drop_pending(self, connection: SocketConnection) -> None:
        connection.close()
        if connection in self._pending:
            self._pending.remove(connection)

    def _drop_host(self) -> None:
        if self._host is not None:
            self._host.close()
            self._host = None


def recorded_host_pid(run_state: RunStateFile | None = None) -> Callable[[], int | None]:
    """The process id of the host in the run-state file — the host this helper started.

    Read on every question rather than once, because the helper restarts the host and the
    record is rewritten when it does. A file that cannot be read answers ``None``, which
    refuses every peer: a helper that has lost track of its own host must not take the word of
    whatever connects next.
    """
    records = RunStateFile() if run_state is None else run_state

    def pid() -> int | None:
        try:
            for record in records.records():
                if record.kind is ChildKind.HOST:
                    return record.pid
        except (RunStateError, OSError) as error:
            log.warning("the run-state file does not say which process the host is: %s", error)
            return None
        return None

    return pid


# ── the host's end ───────────────────────────────────────────────────────────────────────────


class HelperLink:
    """The host's half: the helper's commands carried out, and every child exit reported back.

    One object rather than two, because both directions are one connection and the writes have
    to take turns: an exit reported from the thread that noticed it and an answer written from
    the thread serving commands must not interleave half a frame each.

    ``execute`` is :meth:`innytypes.children.ChildSupervisor.execute` — the inbound half plan
    0001 slice 07 already landed. Nothing about what a command *does* lives here; this is the
    wire it arrives on.
    """

    def __init__(
        self,
        connection: ControlConnection,
        *,
        execute: Callable[[Command], CommandResult],
        pid: int | None = None,
    ) -> None:
        self._connection = connection
        self._execute = execute
        self._pid = os.getpid() if pid is None else pid
        self._writing = threading.Lock()
        self._alive = True

    @property
    def alive(self) -> bool:
        """Whether the helper is still on the other end of this connection."""
        return self._alive

    def announce(self) -> None:
        """Say which process this is, which is how the helper knows it is the host it started."""
        self._write(encode_hello(self._pid))

    def report_exit(self, exit_report: ChildExit) -> None:
        """Tell the helper a child is gone. This is the host's :data:`ExitReporter`.

        A helper that has gone away is **logged, not raised**. This is called from inside the
        child supervisor's own stop path, and an exception here would turn "nobody heard that
        the plugin stopped" into "the plugin could not be stopped". The host keeps running its
        children; what to do about a helper that is not there is
        :class:`~innytypes.helper.launcher.HelperWatch`'s decision, and it is made elsewhere.
        """
        try:
            self._write(encode_exit(exit_report))
        except ControlLinkError as error:
            log.warning(
                "the helper did not hear that %s (process %s) exited: %s",
                exit_report.id,
                exit_report.pid,
                error,
            )

    def report_start_failure(self, failure: ChildStartFailure) -> None:
        """Tell the helper a child could not be started. The host's
        :data:`~innytypes.children.StartFailureReporter`.

        A helper that has gone away is **logged, not raised**, for the same reason
        :meth:`report_exit` does it: this is called from inside the child supervisor's own
        start path, and an exception here would replace the real failure — the one the
        caller is about to see — with the unrelated fact that nobody heard about it.
        """
        try:
            self._write(encode_start_failure(failure))
        except ControlLinkError as error:
            log.warning(
                "the helper did not hear that %s could not be started (%s): %s",
                failure.id,
                failure.reason,
                error,
            )

    def report_degradations(self, degradations: Sequence[Degradation]) -> None:
        """Tell the helper what this host came up without. The host's
        :data:`~innytypes.children.DegradationReporter`.

        Sent once the host has finished starting, with the **whole** set — including an empty
        one, which is how a host that came up clean withdraws what the previous host was
        missing. Anything less than the whole set would leave the helper unable to say that a
        condition has gone away, and a window still naming yesterday's failure is worse than a
        window naming none.

        A helper that has gone away is **logged, not raised**, exactly as the other two
        reporters do it: `up` has already printed these lines for whoever is watching, and an
        exception here would take down a host that is running perfectly well without a helper
        to tell.
        """
        try:
            self._write(encode_degradations(degradations))
        except ControlLinkError as error:
            log.warning(
                "the helper did not hear what this host is running without (%s): %s",
                ", ".join(one.component for one in degradations) or "nothing",
                error,
            )

    def serve_one(self) -> bool:
        """Wait for the next command the helper sends, carry it out, and answer it.

        Returns False when there is nothing left to serve, which is the one thing that ends
        the loop: a helper that has gone, or one talking a language this channel does not
        speak — after which the stream is out of step and every later frame would be read
        against the wrong boundary.

        A command the host cannot carry out is **answered with a refusal** rather than allowed
        to end it: a host that died because the helper asked for a child it does not have
        would be worse than the disagreement it was reporting.
        """
        if not self._alive:
            return False

        try:
            frame = self._connection.receive(timeout=None)
        except ControlLinkError as error:
            log.info("the helper closed the control connection: %s", error)
            self._alive = False
            return False

        if frame is None:  # pragma: no cover - a wait with no deadline answers or raises
            return True

        try:
            request, command = self._read_command(frame)
        except ControlProtocolError as error:
            log.error("the helper sent something this channel does not speak: %s", error)
            self.close()
            return False

        try:
            result = self._execute(command)
        except Exception as error:  # noqa: BLE001 - a refusal is an answer, not a dead host
            log.warning("the host refused %s: %s", command.name, error)
            self._answer(encode_refusal(request, command.name, str(error)))
            return self._alive

        self._answer(encode_result(request, result))
        return self._alive

    def serve(self) -> None:
        """Carry out commands until the helper goes away. This is the host's reader thread."""
        while self.serve_one():
            pass

    def close(self) -> None:
        """Release this end of the connection."""
        self._alive = False
        self._connection.close()

    def _read_command(self, frame: str) -> tuple[int, Command]:
        """One frame as the command it must be, with the number its answer carries back."""
        document = _decode(frame)
        message = _message_type(document)
        if message is not MessageType.COMMAND:
            raise ControlProtocolError(f"the helper sent a {message} frame, which is not a command")
        return _request_of(document), _command_from(document)

    def _answer(self, frame: str) -> None:
        """Write one answer, treating a helper that has gone as the end of the conversation."""
        try:
            self._write(frame)
        except ControlLinkError as error:
            log.info("the helper went away before it could be answered: %s", error)

    def _write(self, frame: str) -> None:
        with self._writing:
            try:
                self._connection.send(frame)
            except ControlLinkError:
                self._alive = False
                raise


def connect_to_helper(
    *,
    execute: Callable[[Command], CommandResult],
    path: Path | None = None,
    pid: int | None = None,
) -> HelperLink:
    """Open the host's end of the control channel and say who this process is.

    Raises :class:`ControlSocketError` when no helper is listening, which is the ordinary case
    for a host somebody started by hand: there is no helper, so there is nothing to connect to,
    and the caller degrades rather than failing to start.
    """
    where = default_control_socket_path() if path is None else path

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(str(where))
    except OSError as error:
        sock.close()
        raise ControlSocketError(f"no helper is listening on {where}: {error}") from error

    link = HelperLink(SocketConnection(sock), execute=execute, pid=pid)
    link.announce()
    return link
