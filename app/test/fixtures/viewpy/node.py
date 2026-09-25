"""A reference view node in Python: the standard library only (WI-0018-10, conformance C10/C11).

It speaks exactly the frames views need (docs/specs/node-protocol-v2.md §4, §8) by hand. It is
not the Python SDK; that is WI-0018-26, which must pass the same C10 and C11 again.

- ``ask`` (an action view): each input is presented, and waits. ``action`` answers it: with
  ``values.__dismiss__`` true it errors ("dismissed by the person", which reaches Catch),
  otherwise it emits the values on ``answer`` for that input, then ``done``.
- ``record`` (a snapshot view): each input is recorded as a snapshot of its data, passed on
  ``passed`` and done. ``trigger`` emits on the pressed action's port with NO input id: a new
  run, carrying the snapshot's state and the press's values.
"""

import json
import sys


def send(frame):
    """One frame, one line, flushed (spec 3.2). This node writes from one thread only."""
    sys.stdout.write(json.dumps(frame, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    line = sys.stdin.readline()
    if not line:
        return
    start = json.loads(line)
    if start.get("t") != "start" or start.get("protocol") != 2:
        print("the first frame was not a protocol 2 start", file=sys.stderr, flush=True)
        sys.exit(2)
    kind = start["node"]["type"].rsplit("-", 1)[-1]
    waiting = set()  # ask: the input ids presented and not yet answered
    send({"t": "ready"})
    for raw in sys.stdin:
        frame = json.loads(raw)
        t = frame.get("t")
        if t == "input" and kind == "ask":
            waiting.add(frame["id"])
            content = {
                "title": "Answer the Python view",
                "text": json.dumps(frame["event"]["data"]),
                "form": {"type": "object", "properties": {"answer": {"type": "string"}}},
            }
            send({"t": "present", "in": frame["id"], "content": content})
        elif t == "input" and kind == "record":
            data = frame["event"]["data"]
            content = {"title": "Recorded by Python", "fields": {"data": json.dumps(data)}}
            send({"t": "snapshot", "content": content, "state": data, "in": frame["id"]})
            send({"t": "emit", "port": "passed", "data": data, "in": frame["id"]})
            send({"t": "done", "in": frame["id"]})
        elif t == "action" and frame["in"] in waiting:
            waiting.discard(frame["in"])
            if frame["values"].get("__dismiss__") is True:
                send({"t": "error", "in": frame["in"], "message": "dismissed by the person"})
            else:
                send({"t": "emit", "port": "answer", "data": frame["values"], "in": frame["in"]})
                send({"t": "done", "in": frame["in"]})
        elif t == "trigger":
            data = {"state": frame["snapshot"].get("state"), "values": frame["values"]}
            send({"t": "emit", "port": frame["action"], "data": data})
        elif t == "cancel" and frame["in"] in waiting:
            waiting.discard(frame["in"])
            send({"t": "error", "in": frame["in"], "message": "cancelled while waiting"})
        elif t == "close":
            send({"t": "closed"})
            return
        # Any other frame, or an unknown input id, is ignored (spec 1.3).
    # End of input means close (spec 6.4).


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
