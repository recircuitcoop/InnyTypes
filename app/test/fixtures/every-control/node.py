#!/usr/bin/env python3
"""The every-control fixture package's two types, protocol v2 by hand (WI-0018-09 e2e).

``ticker`` (a source) emits one event carrying its greeting shortly after ``ready``: a new run.
``probe`` (a node) writes the start frame it was given to ``<data_dir>/start.json``, so a test
can read the config exactly as the runtime coerced and validated it, and answers each input by
emitting on its SECOND port, so a test can see that port order reaches the right wire.
"""

import json
import sys
import threading

_lock = threading.Lock()


def send(frame):
    with _lock:
        sys.stdout.buffer.write(json.dumps(frame).encode("utf-8") + b"\n")
        sys.stdout.buffer.flush()


def main():
    kind = sys.argv[1]
    start = json.loads(sys.stdin.buffer.readline())
    config = start["config"]
    if kind == "probe":
        with open(f"{start['data_dir']}/start.json", "w", encoding="utf-8") as out:
            json.dump(start, out)
    send({"t": "ready"})
    if kind == "ticker":
        timer = threading.Timer(
            config["delay_ms"] / 1000,
            lambda: send({"t": "emit", "port": "tick", "data": {"greeting": config["greeting"]}}),
        )
        timer.daemon = True
        timer.start()
    for raw in sys.stdin.buffer:
        frame = json.loads(raw)
        if frame["t"] == "input":
            answer = {"received": frame["event"]["data"], "label": config["label"]}
            send({"t": "emit", "port": "second", "data": answer, "in": frame["id"]})
            send({"t": "done", "in": frame["id"]})
        elif frame["t"] == "close":
            send({"t": "closed"})
            return


if __name__ == "__main__":
    main()
