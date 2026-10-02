"""Unit tests for innytypes_node.Node (node protocol v2, spec Appendix A), covering the SDK
checklist of spec §12.1 and the conformance table of §12.2 (C1, C3–C5, C9–C14) at the module
level. The end-to-end run of the SAME rules against a real subprocess, C1–C14 in full, is
app/test/conformance/sdk-node.test.ts and app/test/conformance/sdk-views.test.ts, which drive
the reference node built on this SDK (app/test/fixtures/sdk-py).
"""

from __future__ import annotations

import io
import json
import time
from collections.abc import Callable

import pytest

from innytypes_node import REDACTED, FrameTooLargeError, Node, protect, redact

START = {
    "t": "start",
    "protocol": 2,
    "node": {"id": "n1", "type": "inny-pkg-kind", "name": "My node"},
    "config": {"a": 1},
    "credentials": {"token": "s3cr3t-token"},
    "data_dir": "/tmp/data",
}


def lines(*frames: dict[str, object]) -> io.StringIO:
    return io.StringIO("".join(json.dumps(frame) + "\n" for frame in frames))


def wait_until(condition: Callable[[], bool], timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting for a condition")
        time.sleep(0.005)


def frames_of(out: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in out.getvalue().splitlines()]


def patch_io(monkeypatch: pytest.MonkeyPatch) -> tuple[io.StringIO, io.StringIO]:
    """stdout (frames) and stderr (everything else), wired in before a Node reads start.

    A plain helper, called from inside each test body, NOT a pytest fixture: pytest's own
    capture manager reinstalls its own sys.stdout/sys.stderr proxies between the fixture
    "setup" phase and the test "call" phase, so a fixture-time monkeypatch of them does not
    survive into the test body. Patching from inside the body (the same phase Node() then
    runs in) does.
    """
    out, err = io.StringIO(), io.StringIO()
    monkeypatch.setattr("sys.stdout", out)
    monkeypatch.setattr("sys.stderr", err)
    return out, err


def start_node(monkeypatch: pytest.MonkeyPatch, *rest: dict[str, object], **kwargs: object) -> Node:
    monkeypatch.setattr("sys.stdin", lines(START, *rest))
    return Node(**kwargs)  # type: ignore[arg-type]


# ── start (C1) ───────────────────────────────────────────────────────────────────────────


def test_start_reads_node_config_credentials_and_data_dir(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_io(monkeypatch)
    node = start_node(monkeypatch)
    assert node.node == {"id": "n1", "type": "inny-pkg-kind", "name": "My node"}
    assert node.config == {"a": 1}
    assert node.credentials == {"token": "s3cr3t-token"}
    assert node.data_dir == "/tmp/data"


def test_start_exits_2_when_the_first_frame_is_not_a_protocol_2_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_io(monkeypatch)
    monkeypatch.setattr("sys.stdin", lines({"t": "input", "id": "x", "event": {}}))
    with pytest.raises(SystemExit) as excinfo:
        Node()
    assert excinfo.value.code == 2


def test_start_exits_2_on_empty_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_io(monkeypatch)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    with pytest.raises(SystemExit) as excinfo:
        Node()
    assert excinfo.value.code == 2


def test_start_tolerates_a_start_frame_with_no_node_config_or_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_io(monkeypatch)
    monkeypatch.setattr("sys.stdin", lines({"t": "start", "protocol": 2}))
    node = Node()
    assert node.node == {}
    assert node.config == {}
    assert node.credentials == {}
    assert node.data_dir == ""


# ── stdout hygiene (C3) ──────────────────────────────────────────────────────────────────


def test_a_stray_print_inside_a_handler_never_reaches_stdout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, err = patch_io(monkeypatch)
    node = start_node(monkeypatch)
    print("a library logged something")  # noqa: T201 - this is the thing under test
    node.ready()
    assert frames_of(out) == [{"t": "ready"}]
    assert "a library logged something" in err.getvalue()


def test_an_uncaught_exception_traceback_is_redacted_and_stays_off_stdout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, err = patch_io(monkeypatch)
    node = start_node(monkeypatch)
    try:
        raise ValueError(node.credentials["token"])
    except ValueError:
        import traceback

        traceback.print_exc()  # the default excepthook does exactly this, to sys.stderr
    assert "s3cr3t-token" not in err.getvalue()
    assert REDACTED in err.getvalue()
    assert out.getvalue() == ""


# ── outgoing frames ──────────────────────────────────────────────────────────────────────


def test_emit_done_error_status_log_present_snapshot_shapes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, _ = patch_io(monkeypatch)
    node = start_node(monkeypatch)
    node.emit("out", {"n": 1}, "i1")
    node.emit("out", {"n": 2})  # a new run: no "in"
    node.done("i1")
    node.error("i1", "boom")
    node.error(None, "no input")
    node.status("working")
    node.log("hello", "warn")
    node.present("i1", {"title": "Choose"})
    node.snapshot({"title": "Recorded"}, {"n": 1}, "i1")
    assert frames_of(out) == [
        {"t": "emit", "port": "out", "data": {"n": 1}, "in": "i1"},
        {"t": "emit", "port": "out", "data": {"n": 2}},
        {"t": "done", "in": "i1"},
        {"t": "error", "in": "i1", "message": "boom"},
        {"t": "error", "message": "no input"},
        {"t": "status", "text": "working", "fill": "blue", "shape": "dot"},
        {"t": "log", "level": "warn", "msg": "hello"},
        {"t": "present", "in": "i1", "content": {"title": "Choose"}},
        {"t": "snapshot", "content": {"title": "Recorded"}, "state": {"n": 1}, "in": "i1"},
    ]


def test_status_text_and_error_message_are_truncated_to_the_spec_limits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, _ = patch_io(monkeypatch)
    node = start_node(monkeypatch)
    node.status("x" * 300)
    node.error("i1", "y" * 3000)
    frames = frames_of(out)
    assert len(frames[0]["text"]) == 200  # type: ignore[arg-type]
    assert len(frames[1]["message"]) == 2000  # type: ignore[arg-type]


# ── revision 2.1 (spec 4.2.1, 4.2.2): done's notes and results, progress ─────────────────


def test_done_carries_notes_and_results_and_without_them_is_the_2_0_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, _ = patch_io(monkeypatch)
    node = start_node(monkeypatch)
    note = {"level": "warning", "text": "2 speakers could not be named"}
    result = {
        "kind": "anytype",
        "text": "Meeting notes",
        "anytype": {"spaceId": "s1", "objectId": "o1"},
    }
    node.done("i1", notes=[note], results=[result])
    node.done("i2", notes=[note])
    node.done("i3", results=[])
    node.done("i4")
    assert frames_of(out) == [
        {"t": "done", "in": "i1", "notes": [note], "results": [result]},
        {"t": "done", "in": "i2", "notes": [note]},
        {"t": "done", "in": "i3", "results": []},
        {"t": "done", "in": "i4"},
    ]


def test_progress_is_a_status_naming_the_input(monkeypatch: pytest.MonkeyPatch) -> None:
    out, _ = patch_io(monkeypatch)
    node = start_node(monkeypatch)
    node.progress("i1", 2, 3, eta_s=120, text="in Renaissance")
    node.progress("i2", 1, 4)
    node.progress("i3", 0, 1, text="y" * 300)
    frames = frames_of(out)
    assert frames[:2] == [
        {
            "t": "status",
            "text": "in Renaissance",
            "fill": "blue",
            "shape": "dot",
            "in": "i1",
            "progress": {"done": 2, "total": 3},
            "eta_s": 120,
        },
        {
            "t": "status",
            "text": "1 of 4",
            "fill": "blue",
            "shape": "dot",
            "in": "i2",
            "progress": {"done": 1, "total": 4},
        },
    ]
    assert len(frames[2]["text"]) == 200  # type: ignore[arg-type]


@pytest.mark.parametrize("eta_s", [float("inf"), float("-inf"), float("nan"), -1.0])
def test_progress_refuses_an_eta_s_json_cannot_carry_or_below_zero(
    monkeypatch: pytest.MonkeyPatch, eta_s: float
) -> None:
    out, _ = patch_io(monkeypatch)
    node = start_node(monkeypatch)
    with pytest.raises(ValueError, match="finite number of seconds"):
        node.progress("i1", 1, 2, eta_s=eta_s)
    assert frames_of(out) == []


def test_send_raises_frame_too_large_rather_than_writing_an_oversize_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, _ = patch_io(monkeypatch)
    node = start_node(monkeypatch)
    huge = "x" * 2_000_000
    with pytest.raises(FrameTooLargeError):
        node.emit("out", huge)
    assert out.getvalue() == ""  # nothing partial was written


def test_emit_refuses_an_undeclared_port_at_the_call_site_when_ports_were_given(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_io(monkeypatch)
    node = start_node(monkeypatch, ports=["out"])
    with pytest.raises(ValueError, match="nope"):
        node.emit("nope", 1)
    node.emit("out", 1)  # declared: no refusal


def test_emit_with_no_declared_ports_accepts_anything_the_runtime_would_still_judge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_io(monkeypatch)
    node = start_node(monkeypatch)  # ports not given: opt-in only (C5 is a SHOULD)
    node.emit("whatever", 1)  # does not raise


# ── credentials (C13) ────────────────────────────────────────────────────────────────────


def test_a_credential_never_appears_on_stdout_or_stderr(monkeypatch: pytest.MonkeyPatch) -> None:
    out, err = patch_io(monkeypatch)
    node = start_node(monkeypatch)
    node.emit("out", len(node.credentials["token"]))
    print(f"used a credential: {node.credentials['token']}")  # noqa: T201
    node.log(f"also used it here: {node.credentials['token']}")
    assert "s3cr3t-token" not in out.getvalue()
    assert "s3cr3t-token" not in err.getvalue()
    assert REDACTED in err.getvalue()
    assert REDACTED in out.getvalue()


def test_protect_and_redact_work_directly_for_secrets_that_are_not_credentials() -> None:
    protect("a-manually-protected-value")
    assert redact("holding a-manually-protected-value here") == f"holding {REDACTED} here"
    assert redact("") == ""
    protect("")  # must not turn every character into the marker


# ── run(): input / cancel / action / trigger / fire / close / EOF ───────────────────────


def test_run_dispatches_input_and_completes_it(monkeypatch: pytest.MonkeyPatch) -> None:
    out, _ = patch_io(monkeypatch)
    seen: list[tuple[str, dict[str, object]]] = []

    def on_input(input_id: str, event: dict[str, object]) -> None:
        seen.append((input_id, event))

    node = start_node(
        monkeypatch,
        {"t": "input", "id": "i1", "event": {"type": "t.v1", "data": {"n": 1}}},
        {"t": "close"},
    )
    node.run(on_input=on_input)
    wait_until(lambda: len(seen) == 1)
    assert seen == [("i1", {"type": "t.v1", "data": {"n": 1}})]
    assert frames_of(out)[0] == {"t": "ready"}
    assert frames_of(out)[-1] == {"t": "closed"}


def test_an_exception_in_on_input_fails_that_input_with_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, _ = patch_io(monkeypatch)

    def on_input(input_id: str, event: dict[str, object]) -> None:
        raise ValueError("went wrong")

    node = start_node(
        monkeypatch,
        {"t": "input", "id": "i1", "event": {"type": "t.v1", "data": {}}},
        {"t": "close"},
    )
    node.run(on_input=on_input)
    wait_until(lambda: any(f.get("t") == "error" for f in frames_of(out)))
    error = next(f for f in frames_of(out) if f.get("t") == "error")
    assert error == {"t": "error", "in": "i1", "message": "went wrong"}


def test_run_dispatches_cancel_action_trigger_and_fire(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_io(monkeypatch)
    cancelled: list[str] = []
    acted: list[tuple[str, dict[str, object]]] = []
    triggered: list[tuple[str, dict[str, object], dict[str, object]]] = []
    fired: list[dict[str, object]] = []

    node = start_node(
        monkeypatch,
        {"t": "cancel", "in": "i1"},
        {"t": "action", "in": "i2", "values": {"answer": "yes"}},
        {
            "t": "trigger",
            "action": "again",
            "snapshot": {"id": "s1", "state": {"n": 1}},
            "values": {"why": "again"},
        },
        {"t": "fire", "data": {"x": 1}},
        {"t": "close"},
    )
    node.run(
        on_cancel=cancelled.append,
        on_action=lambda i, v: acted.append((i, v)),
        on_trigger=lambda a, s, v: triggered.append((a, s, v)),
        on_fire=fired.append,
    )
    wait_until(lambda: len(fired) == 1)
    assert cancelled == ["i1"]
    assert acted == [("i2", {"answer": "yes"})]
    assert triggered == [("again", {"id": "s1", "state": {"n": 1}}, {"why": "again"})]
    assert fired == [{"x": 1}]


def test_an_exception_in_on_trigger_is_logged_not_raised_since_there_is_no_input_to_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, _ = patch_io(monkeypatch)

    def on_trigger(action: str, snapshot: dict[str, object], values: dict[str, object]) -> None:
        raise RuntimeError("trigger blew up")

    node = start_node(
        monkeypatch,
        {"t": "trigger", "action": "a", "snapshot": {"id": "s"}, "values": {}},
        {"t": "close"},
    )
    node.run(on_trigger=on_trigger)
    wait_until(lambda: any(f.get("t") == "log" for f in frames_of(out)))
    log = next(f for f in frames_of(out) if f.get("t") == "log")
    assert log == {"t": "log", "level": "error", "msg": "trigger blew up"}


def test_run_ignores_an_unknown_frame_type_and_keeps_going(monkeypatch: pytest.MonkeyPatch) -> None:
    out, _ = patch_io(monkeypatch)
    node = start_node(
        monkeypatch,
        {"t": "future", "what": 1},
        {"t": "input", "id": "after", "event": {"type": "t.v1", "data": 1}},
        {"t": "close"},
    )
    node.run(on_input=lambda i, e: node.done(i))
    wait_until(lambda: {"t": "done", "in": "after"} in frames_of(out))


def test_run_calls_on_close_and_sends_closed_on_an_explicit_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, _ = patch_io(monkeypatch)
    closed: list[bool] = []
    node = start_node(monkeypatch, {"t": "close"})
    node.run(on_close=lambda: closed.append(True))
    assert closed == [True]
    assert frames_of(out)[-1] == {"t": "closed"}


def test_run_calls_on_close_on_eof_without_sending_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    out, _ = patch_io(monkeypatch)
    closed: list[bool] = []
    node = start_node(monkeypatch)  # no frames after start: stdin ends (EOF, spec 6.4)
    node.run(on_close=lambda: closed.append(True))
    assert closed == [True]
    # "ready" always opens the conversation; "closed" answers an explicit close only, which
    # this run never received.
    assert frames_of(out) == [{"t": "ready"}]


def test_run_with_no_handlers_at_all_still_reads_to_eof_and_returns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_io(monkeypatch)
    node = start_node(monkeypatch, {"t": "input", "id": "i1", "event": {"type": "t.v1", "data": 1}})
    node.run()  # no on_input given: the input is silently unanswered, same as a raw node


def test_run_ignores_malformed_json_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    out, _ = patch_io(monkeypatch)
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO(
            json.dumps(START) + "\n" + "not json at all\n" + json.dumps({"t": "close"}) + "\n"
        ),
    )
    node = Node()
    node.run()
    assert frames_of(out)[-1] == {"t": "closed"}
