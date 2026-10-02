"""A vendored copy of innytypes-node (sdk/python/src/innytypes_node/__init__.py), so this
example package has zero dependencies to lock (spec 2.3.3: no requirements.lock at all means
no dependencies). Once innytypes-node is published to an index this package's own
requirements.lock can pin by hash, a real package would depend on it instead
(docs/authors/packaging.md); until then, a small single-file SDK is vendored the way many
protocol clients are. Keep this in sync with the canonical source by hand.
"""

from __future__ import annotations

import json
import sys
import threading
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, TextIO

__all__ = [
    "MAX_FRAME_BYTES",
    "REDACTED",
    "protect",
    "redact",
    "FrameTooLargeError",
    "Node",
]

#: The largest frame, in encoded UTF-8 bytes, excluding the newline (spec 3.5).
MAX_FRAME_BYTES = 1_048_576

# ── redaction (module-global: one registry per process, like sdk/ts/src/node.ts) ───────────

REDACTED = "[redacted]"
_secrets: set[str] = set()
_secrets_lock = threading.Lock()


def protect(secret: str) -> None:
    """Register a secret: from now on it is replaced in every frame and every stderr line."""
    if secret != "":  # an empty one would put the marker between every character of every line
        with _secrets_lock:
            _secrets.add(secret)


def redact(text: str) -> str:
    """``text`` with every registered secret replaced, the longest first."""
    with _secrets_lock:
        secrets = sorted(_secrets, key=len, reverse=True)
    redacted = text
    for secret in secrets:
        redacted = redacted.replace(secret, REDACTED)
    return redacted


class _RedactedStream:
    """Stands in for stdout and stderr once a Node has started (C3): a stray ``print()``, an
    uncaught exception's traceback, or a library's own logging lands here, redacted, never on
    the real stdout (the frame channel)."""

    def __init__(self, real: TextIO) -> None:
        self._real = real

    def write(self, text: str) -> int:
        return self._real.write(redact(text))

    def flush(self) -> None:
        self._real.flush()

    def isatty(self) -> bool:
        return False

    def __getattr__(self, name: str) -> Any:
        # encoding, errors, and anything else a library pokes at.
        return getattr(self._real, name)


class FrameTooLargeError(Exception):
    """A frame this node was about to send is over 1 MiB encoded (spec 3.5). The runtime would
    only discard an oversize frame (and fail the input it belonged to), so this SDK refuses to
    write one at all: a large payload belongs in a file, passed by path (spec 3.5)."""


def _as_dict(value: object) -> dict[str, Any]:
    """``value`` if it is a JSON object, else an empty one: the start frame's fields are
    trusted to be well-formed (the runtime built them), but never trusted blindly."""
    return value if isinstance(value, dict) else {}


class Node:
    """One node process's conversation with the runtime, from the start frame on (spec 4.1)."""

    node: dict[str, str]
    config: dict[str, Any]
    credentials: dict[str, str]
    data_dir: str

    def __init__(self, *, ports: Iterable[str] | None = None) -> None:
        """Reads and checks the start frame: it MUST be the first line (spec 4.1). ``ports``,
        when given, is this type's declared output ports (spec 2.4 ``outputs``): ``emit()``
        then refuses an undeclared one at the call site (C5, SHOULD) instead of letting the
        runtime discard it later.
        """
        # Captured before stdout is redirected: this is the real frame channel (spec 3.2).
        self._out: TextIO = sys.stdout
        self._write_lock = threading.Lock()
        self._ports = None if ports is None else frozenset(ports)

        # From here on, nothing but this class's own send() reaches the real stdout (C3): a
        # library's print()/logging, and even an uncaught exception's traceback (which the
        # interpreter's default excepthook writes to sys.stderr), goes out redacted instead.
        real_stderr = sys.stderr
        sys.stdout = _RedactedStream(real_stderr)
        sys.stderr = _RedactedStream(real_stderr)

        line = sys.stdin.readline()
        frame: Any = json.loads(line) if line else None
        if not isinstance(frame, dict) or frame.get("t") != "start" or frame.get("protocol") != 2:
            print("the first frame was not a protocol 2 start", file=sys.stderr)  # noqa: T201
            sys.exit(2)

        self.node = _as_dict(frame.get("node"))
        self.config = _as_dict(frame.get("config"))
        self.credentials = _as_dict(frame.get("credentials"))
        self.data_dir = frame.get("data_dir") or ""

        # Every credential is protected the moment it is read, before any handler can run
        # (spec 11.1): a node author does not have to remember to call protect() themself.
        for value in self.credentials.values():
            if isinstance(value, str):
                protect(value)

    # ── outgoing frames ──────────────────────────────────────────────────────────────────

    def send(self, frame: dict[str, Any]) -> None:
        """One frame, one line, locked, flushed (spec 3.2): never interleaved across threads."""
        encoded = json.dumps(frame, separators=(",", ":"))
        line = redact(encoded) + "\n"
        size = len(line.encode("utf-8")) - 1  # the trailing newline is not counted (spec 3.5)
        if size > MAX_FRAME_BYTES:
            raise FrameTooLargeError(
                f"frame too large: {size} bytes, the limit is {MAX_FRAME_BYTES}"
            )
        with self._write_lock:
            self._out.write(line)
            self._out.flush()

    def ready(self) -> None:
        self.send({"t": "ready"})

    def emit(self, port: str, data: Any, input_id: str | None = None) -> None:
        if self._ports is not None and port not in self._ports:
            declared = ", ".join(sorted(self._ports)) or "(none)"
            raise ValueError(f"{port!r} is not one of this type's declared outputs: {declared}")
        frame: dict[str, Any] = {"t": "emit", "port": port, "data": data}
        if input_id is not None:
            frame["in"] = input_id
        self.send(frame)

    def done(
        self,
        input_id: str,
        notes: Sequence[Mapping[str, Any]] | None = None,
        results: Sequence[Mapping[str, Any]] | None = None,
    ) -> None:
        """Finish ``input_id``. Revision 2.1 (spec 4.2.1): ``notes`` (``{level, text}``, level
        "note" or "warning") and ``results`` (``{kind, text, anytype?, folder?, due?}``) reach
        the input's run; the runtime keeps at most 20 of each and 200 characters of a text.
        Without them this is the 2.0 frame, exactly."""
        frame: dict[str, Any] = {"t": "done", "in": input_id}
        if notes is not None:
            frame["notes"] = [dict(note) for note in notes]
        if results is not None:
            frame["results"] = [dict(result) for result in results]
        self.send(frame)

    def progress(
        self,
        input_id: str,
        done: int,
        total: int,
        eta_s: float | None = None,
        text: str | None = None,
    ) -> None:
        """How far ``input_id`` has got (spec 4.2.2): a ``status`` naming the input, so its
        run's step shows ``done`` of ``total`` and the time left (``eta_s``, seconds). ``text``
        defaults to "<done> of <total>"; the node's badge shows it as any status."""
        frame: dict[str, Any] = {
            "t": "status",
            "text": (text if text is not None else f"{done} of {total}")[:200],
            "fill": "blue",
            "shape": "dot",
            "in": input_id,
            "progress": {"done": done, "total": total},
        }
        if eta_s is not None:
            # JSON has no Infinity or NaN: json.dumps would write a bare word the runtime refuses.
            # A chained comparison is false for NaN as well as for both infinities.
            if not 0 <= eta_s < float("inf"):
                raise ValueError(f"eta_s must be a finite number of seconds >= 0, not {eta_s!r}")
            frame["eta_s"] = eta_s
        self.send(frame)

    def error(self, input_id: str | None, message: str) -> None:
        # The spec's limit is 2,000 characters (§4.5); longer would be refused as invalid.
        frame: dict[str, Any] = {"t": "error", "message": message[:2000]}
        if input_id is not None:
            frame["in"] = input_id
        self.send(frame)

    def status(self, text: str, fill: str = "blue", shape: str = "dot") -> None:
        self.send({"t": "status", "text": text[:200], "fill": fill, "shape": shape})

    def log(self, message: str, level: str = "info") -> None:
        self.send({"t": "log", "level": level, "msg": message})

    def present(self, input_id: str, content: dict[str, Any]) -> None:
        self.send({"t": "present", "in": input_id, "content": content})

    def snapshot(self, content: dict[str, Any], state: Any, input_id: str | None = None) -> None:
        frame: dict[str, Any] = {"t": "snapshot", "content": content, "state": state}
        if input_id is not None:
            frame["in"] = input_id
        self.send(frame)

    # ── the conversation ─────────────────────────────────────────────────────────────────

    def _dispatch(
        self,
        handler: Callable[..., None],
        args: tuple[Any, ...],
        *,
        input_id: str | None,
    ) -> None:
        """Run one handler on its own thread (spec 4.3.3: a node MAY process inputs
        concurrently), so a slow handler never blocks this loop from reading the next frame
        (a `cancel` or `close` in particular). An exception that escapes an input's handler
        fails that input rather than crashing the process (C4: exactly one terminal frame);
        one with no input id (trigger, fire) is logged instead, since there is nothing to fail.
        """

        def work() -> None:
            try:
                handler(*args)
            except Exception as caught:  # noqa: BLE001 - reported, never swallowed silently
                if input_id is not None:
                    self.error(input_id, str(caught))
                else:
                    self.log(str(caught), "error")

        threading.Thread(target=work, daemon=True).start()

    def run(
        self,
        on_input: Callable[[str, dict[str, Any]], None] | None = None,
        on_cancel: Callable[[str], None] | None = None,
        on_action: Callable[[str, dict[str, Any]], None] | None = None,
        on_trigger: Callable[[str, dict[str, Any], dict[str, Any]], None] | None = None,
        on_fire: Callable[[dict[str, Any]], None] | None = None,
        on_close: Callable[[], None] | None = None,
    ) -> None:
        """Sends ready, dispatches frames; on close sends closed and returns; on EOF calls
        on_close and returns (spec 6.4). Unknown frame types, and fields this SDK does not
        know, are ignored (spec 1.3). Every handler this SDK dispatches runs on its own daemon
        thread, so ``run()`` returning (close, or EOF) lets the process exit at once without
        waiting on work still in flight -- matching the close deadline (spec 4.4: 5 s).
        """
        self.ready()
        for raw in sys.stdin:
            try:
                frame: Any = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(frame, dict):
                continue
            t = frame.get("t")
            if t == "input" and on_input is not None:
                input_id = frame.get("id")
                event = frame.get("event")
                if isinstance(input_id, str) and isinstance(event, dict):
                    self._dispatch(on_input, (input_id, event), input_id=input_id)
            elif t == "cancel" and on_cancel is not None:
                cancelled = frame.get("in")
                if isinstance(cancelled, str):
                    on_cancel(cancelled)
            elif t == "action" and on_action is not None:
                acted = frame.get("in")
                if isinstance(acted, str):
                    values = frame.get("values")
                    self._dispatch(
                        on_action,
                        (acted, values if isinstance(values, dict) else {}),
                        input_id=acted,
                    )
            elif t == "trigger" and on_trigger is not None:
                action = frame.get("action")
                snapshot = frame.get("snapshot")
                values = frame.get("values")
                if isinstance(action, str) and isinstance(snapshot, dict):
                    self._dispatch(
                        on_trigger,
                        (action, snapshot, values if isinstance(values, dict) else {}),
                        input_id=None,
                    )
            elif t == "fire" and on_fire is not None:
                data = frame.get("data")
                if isinstance(data, dict):
                    self._dispatch(on_fire, (data,), input_id=None)
            elif t == "close":
                if on_close is not None:
                    on_close()
                self.send({"t": "closed"})
                return
            # Any other frame type, "future" included, is ignored (spec 1.3).
        # End of input means close (spec 6.4): stop and exit, without sending "closed" (that
        # frame answers an explicit close, and by now there is nobody left reading stdout).
        if on_close is not None:
            on_close()
