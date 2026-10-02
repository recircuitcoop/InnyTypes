#!/usr/bin/env python3
"""A raw protocol v2 node: the standard library only, no SDK (plan 0018 §6, conformance).

It speaks the frames of docs/specs/node-protocol-v2.md by hand, so the conformance suite tests
the runtime's side against something that shares no code with it. What it does with an input
is chosen by the input's data, ``{"do": ...}``; what it does at start, by its config.
"""

import json
import os
import queue
import subprocess
import sys
import threading

_write_lock = threading.Lock()
_out = sys.stdout.buffer


def send(frame):
    """One frame, one line, flushed, never interleaved across threads (spec 3.2)."""
    line = json.dumps(frame, separators=(",", ":")).encode("utf-8") + b"\n"
    with _write_lock:
        _out.write(line)
        _out.flush()


def sized_emit(input_id, size):
    """An emit on port ``out`` for ``input_id`` whose encoded frame is exactly ``size`` bytes."""
    frame = {"t": "emit", "port": "out", "data": "", "in": input_id}
    overhead = len(json.dumps(frame, separators=(",", ":")).encode("utf-8"))
    frame["data"] = "x" * (size - overhead)
    return frame


class Node:
    def __init__(self, start):
        self.config = start["config"]
        self.credentials = start["credentials"]
        self.data_dir = start["data_dir"]
        self.work = queue.Queue()
        self.cancelled = set()
        self.running = None
        self.running_cancelled = threading.Event()
        self.waiting = {}  # action views: input id -> True
        threading.Thread(target=self.worker, daemon=True).start()

    # -- the serial worker (spec 4.3.3: a serial node queues its inputs) -------------------

    def worker(self):
        while True:
            input_id, data = self.work.get()
            if input_id in self.cancelled:
                send({"t": "error", "in": input_id, "message": "cancelled before it started"})
                continue
            self.running = input_id
            self.running_cancelled.clear()
            try:
                self.handle(input_id, data)
            finally:
                self.running = None

    def handle(self, input_id, data):
        action = data.get("do", "echo") if isinstance(data, dict) else "echo"
        if action == "echo":
            send({"t": "emit", "port": "out", "data": data.get("value"), "in": input_id})
            send({"t": "done", "in": input_id})
        elif action == "burst":
            self.burst(input_id, data["frames"], data["threads"])
            send({"t": "done", "in": input_id})
        elif action == "sized":
            send(sized_emit(input_id, data["bytes"]))
            send({"t": "done", "in": input_id})
        elif action == "undeclared":
            send({"t": "emit", "port": "nope", "data": 1, "in": input_id})
            send({"t": "done", "in": input_id})
        elif action == "foreign":
            send({"t": "emit", "port": "out", "data": 1, "in": "not-an-input-of-mine"})
            send({"t": "done", "in": input_id})
        elif action == "new-run":
            send({"t": "emit", "port": "out", "data": data.get("value")})
            send({"t": "done", "in": input_id})
        elif action == "twice":
            send({"t": "done", "in": input_id})
            send({"t": "done", "in": input_id})
        elif action == "fail":
            send({"t": "error", "in": input_id, "message": data.get("message", "failed")})
        elif action == "report":
            # Revision 2.1 (spec 4.2.1): notes and results on done, sent as given, bounds and all.
            frame = {"t": "done", "in": input_id}
            for field in ("notes", "results"):
                if field in data:
                    frame[field] = data[field]
            send(frame)
        elif action == "slow":
            send({"t": "status", "text": "working", "fill": "blue", "shape": "dot"})
            if self.running_cancelled.wait(timeout=600):
                send({"t": "error", "in": input_id, "message": "cancelled while running"})
            else:
                send({"t": "done", "in": input_id})
        elif action == "present":
            self.waiting[input_id] = True
            send({"t": "present", "in": input_id, "content": {"title": "Choose"}})
        elif action == "grandchild":
            sleeper = subprocess.Popen(
                ["sleep", "300"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            send({"t": "emit", "port": "out", "data": sleeper.pid, "in": input_id})
            send({"t": "done", "in": input_id})
        elif action == "whoami":
            about = {
                "env": sorted(os.environ),
                "cwd": os.getcwd(),
                "pgid": os.getpgid(0),
                "data_dir": self.data_dir,
            }
            send({"t": "emit", "port": "out", "data": about, "in": input_id})
            send({"t": "done", "in": input_id})
        elif action == "crash":
            os._exit(data.get("code", 3))
        elif action == "done-then-crash":
            send({"t": "done", "in": input_id})
            os._exit(4)
        elif action == "noise":
            # Everything but frames: stray stdout, stderr, a log frame, an input-less error.
            with _write_lock:
                _out.write(b"this is not a frame\n")
                _out.flush()
            print("a line on stderr", file=sys.stderr, flush=True)
            send({"t": "log", "level": "warn", "msg": "a log frame"})
            send({"t": "error", "message": "an error of no input"})
            send({"t": "done", "in": input_id})
        elif action == "credential":
            # Uses the credential without ever writing it: only its length leaves.
            token = self.credentials.get("token", "")
            send({"t": "emit", "port": "out", "data": len(token), "in": input_id})
            print(f"used a credential of {len(token)} characters", file=sys.stderr, flush=True)
            send({"t": "done", "in": input_id})

    def burst(self, input_id, frames, threads):
        each = frames // threads

        def run(thread):
            for n in range(each):
                send({"t": "emit", "port": "out", "data": {"thread": thread, "n": n}, "in": input_id})

        workers = [threading.Thread(target=run, args=(t,)) for t in range(threads)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()

    # -- frames from the runtime -----------------------------------------------------------

    def progress(self, input_id, data):
        """Revision 2.1 (spec 4.2.2): a status naming an input, then its done. Answered on the
        reading thread, not queued, so it can report while another input holds the worker."""
        status = {"t": "status", "text": data.get("text", "working"), "in": input_id}
        if "done" in data:
            status["progress"] = {"done": data["done"], "total": data["total"]}
        for field in ("eta_s", "phase"):
            if field in data:
                status[field] = data[field]
        if data.get("infinite_eta"):
            # `1e999` is valid JSON that parses to Infinity: written by hand, json.dumps cannot.
            line = json.dumps(status, separators=(",", ":"))[:-1] + ',"eta_s":1e999}\n'
            with _write_lock:
                _out.write(line.encode("utf-8"))
                _out.flush()
        else:
            send(status)
        if data.get("stale"):
            # A status for an input that is not outstanding: the runtime updates the badge only.
            send({"t": "status", "text": "stale", "in": "not-an-input-of-mine"})
        send({"t": "done", "in": input_id})

    def on_frame(self, frame):
        kind = frame.get("t")
        if kind == "input":
            data = frame["event"]["data"]
            if isinstance(data, dict) and data.get("do") == "progress":
                self.progress(frame["id"], data)
                return
            self.work.put((frame["id"], data))
        elif kind == "cancel":
            if frame["in"] == self.running:
                self.running_cancelled.set()
            else:
                self.cancelled.add(frame["in"])
        elif kind == "action":
            input_id = frame["in"]
            if self.waiting.pop(input_id, None) is None:
                return
            if frame["values"].get("__dismiss__") is True:
                send({"t": "error", "in": input_id, "message": "dismissed by the person"})
            else:
                send({"t": "emit", "port": "out", "data": frame["values"], "in": input_id})
                send({"t": "done", "in": input_id})
        elif kind == "close":
            if self.config.get("ignore_close"):
                return
            send({"t": "closed"})
            sys.exit(0)
        # Any other frame type, "future" included, is ignored (spec 1.3).


def main():
    line = sys.stdin.buffer.readline()
    if not line:
        return
    start = json.loads(line)
    if start.get("t") != "start" or start.get("protocol") != 2:
        print("the first frame was not a protocol 2 start", file=sys.stderr, flush=True)
        sys.exit(2)
    config = start["config"]
    print(f"raw node {start['node']['id']} started", file=sys.stderr, flush=True)
    if "exit_at_start" in config:
        sys.exit(config["exit_at_start"])
    node = Node(start)
    if not config.get("no_ready"):
        send({"t": "ready"})
    for raw in sys.stdin.buffer:
        node.on_frame(json.loads(raw))
    # End of input means close (spec 6.4): stop and exit, without a traceback.


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
