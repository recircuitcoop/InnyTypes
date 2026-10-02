#!/usr/bin/env python3
"""The Python SDK reference node (WI-0018-26): built on innytypes-node
(sdk/python/src/innytypes_node), not a raw hand-rolled speaker of the protocol like
app/test/fixtures/raw-node/node.py. Same purpose: give the conformance suite
(app/test/conformance/sdk-node.test.ts, sdk-views.test.ts) something to run C1-C14 against
that is built the way a real author would build it -- through the SDK, not around it.

Three types, chosen by argv[1] (the runtime always calls with this fixed, spec 2.3.1):
- kitchen (a node): the same "do"-dispatched actions as the raw fixture (rawnode), wired
  through Node.emit/done/error/status/log instead of hand-built frames, so both conformance
  suites read the same way.
- ask (an action view): present, then answer or dismiss (C10).
- record (a snapshot view): snapshot, pass through, and answer a trigger (C11).

Not installed with pip: the SDK is imported straight from its source tree, since this is a
test fixture, not a published package (examples/ has one of those).
"""

from __future__ import annotations

import json
import os
import sys
import threading
from typing import Any

_SDK_SRC = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "..", "sdk", "python", "src"
)
sys.path.insert(0, _SDK_SRC)

from innytypes_node import Node  # noqa: E402


def sized_value(input_id: str, size: int) -> str:
    """A string that makes an `emit {port: out, in: input_id}` frame exactly `size` bytes."""
    frame = {"t": "emit", "port": "out", "data": "", "in": input_id}
    overhead = len(json.dumps(frame, separators=(",", ":")).encode("utf-8"))
    return "x" * (size - overhead)


def run_kitchen() -> None:
    node = Node(ports=["out"])
    cancels: dict[str, threading.Event] = {}

    def on_input(input_id: str, event: dict[str, Any]) -> None:
        data = event.get("data")
        action = data.get("do", "echo") if isinstance(data, dict) else "echo"
        if action == "echo":
            node.emit("out", data.get("value"), input_id)
            node.done(input_id)
        elif action == "burst":
            each = data["frames"] // data["threads"]

            def burst(thread: int) -> None:
                for n in range(each):
                    node.emit("out", {"thread": thread, "n": n}, input_id)

            workers = [threading.Thread(target=burst, args=(t,)) for t in range(data["threads"])]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()
            node.done(input_id)
        elif action == "sized":
            node.emit("out", sized_value(input_id, data["bytes"]), input_id)
            node.done(input_id)
        elif action == "undeclared":
            node.emit("nope", 1, input_id)  # raises: the SDK refuses at the call site (C5)
            node.done(input_id)  # unreachable
        elif action == "new-run":
            node.emit("out", data.get("value"))  # no input id: a new run (spec 5.4.2)
            node.done(input_id)
        elif action == "twice":
            node.done(input_id)
            node.done(input_id)
        elif action == "fail":
            node.error(input_id, data.get("message", "failed"))
        elif action == "report":
            # Revision 2.1 (spec 4.2.1): notes and results on done, through the SDK.
            node.done(input_id, notes=data.get("notes"), results=data.get("results"))
        elif action == "progress":
            # Revision 2.1 (spec 4.2.2): a status naming this input, then its done.
            node.progress(input_id, data["done"], data["total"], data.get("eta_s"), data.get("text"))
            node.done(input_id)
        elif action == "slow":
            node.status("working", "blue", "dot")
            cancelled = cancels.setdefault(input_id, threading.Event())
            if cancelled.wait(timeout=10):
                node.error(input_id, "cancelled while running")
            else:
                node.done(input_id)
            cancels.pop(input_id, None)
        elif action == "credential":
            # Uses the credential without ever writing it: the SDK auto-protects it (spec
            # 11.1), so even a handler that logs it outright never leaks it (C13).
            token = node.credentials.get("token", "")
            node.emit("out", len(token), input_id)
            node.log(f"used a credential: {token}")
            node.done(input_id)
        elif action == "noise":
            # A stray print cannot reach the frame channel at all once the SDK has started
            # (C3): it lands on stderr, redacted, not on the stdout the runtime decodes.
            print("this is not a frame")  # noqa: T201 - the thing under test
            node.log("a log frame", "warn")
            node.error(None, "an error of no input")
            node.done(input_id)
        elif action == "crash":
            os._exit(data.get("code", 3))
        elif action == "done-then-crash":
            node.done(input_id)
            os._exit(4)
        else:
            node.error(input_id, f"unknown action {action!r}")

    def on_cancel(input_id: str) -> None:
        event = cancels.get(input_id)
        if event is not None:
            event.set()

    def on_fire(data: dict[str, Any]) -> None:
        node.emit("out", data)  # no input id: a new run (C12, spec 4.1 fire)

    node.run(on_input=on_input, on_cancel=on_cancel, on_fire=on_fire)


def run_ask() -> None:
    node = Node(ports=["answer"])

    def on_input(input_id: str, event: dict[str, Any]) -> None:
        node.present(
            input_id,
            {
                "title": "Answer the Python SDK view",
                "text": json.dumps(event.get("data")),
                "form": {"type": "object", "properties": {"answer": {"type": "string"}}},
            },
        )

    def on_action(input_id: str, values: dict[str, Any]) -> None:
        if values.get("__dismiss__") is True:
            node.error(input_id, "dismissed by the person")
        else:
            node.emit("answer", values, input_id)
            node.done(input_id)

    node.run(on_input=on_input, on_action=on_action)


def run_record() -> None:
    node = Node(ports=["passed", "again"])

    def on_input(input_id: str, event: dict[str, Any]) -> None:
        data = event.get("data")
        content = {"title": "Recorded by the Python SDK", "fields": {"data": json.dumps(data)}}
        node.snapshot(content, data, input_id)
        node.emit("passed", data, input_id)
        node.done(input_id)

    def on_trigger(action: str, snapshot: dict[str, Any], values: dict[str, Any]) -> None:
        node.emit(action, {"state": snapshot.get("state"), "values": values})

    node.run(on_input=on_input, on_trigger=on_trigger)


def main() -> None:
    kind = sys.argv[1] if len(sys.argv) > 1 else ""
    runners = {"kitchen": run_kitchen, "ask": run_ask, "record": run_record}
    runner = runners.get(kind)
    if runner is None:
        print(f"unknown sdk-py type {kind!r}", file=sys.stderr)  # noqa: T201
        sys.exit(2)
    runner()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
