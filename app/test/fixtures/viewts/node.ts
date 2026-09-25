// A reference view node in TypeScript: Node's standard library only, run as-is by a Node that
// strips types (Node 22.18 and later, or Electron as Node) (WI-0018-10, conformance C10/C11).
//
// It speaks exactly the frames views need (docs/specs/node-protocol-v2.md §4, §8) by hand. It
// is not the TS SDK; that is WI-0018-26, which must pass the same C10 and C11 again.
//
// - `ask` (an action view): each input is presented, and waits. `action` answers it: with
//   `values.__dismiss__` true it errors ("dismissed by the person", which reaches Catch),
//   otherwise it emits the values on `answer` for that input, then `done`.
// - `record` (a snapshot view): each input is recorded as a snapshot of its data, passed on
//   `passed` and done. `trigger` emits on the pressed action's port with NO input id: a new
//   run, carrying the snapshot's state and the press's values.
//
// Erasable syntax only, and no imports but `node:`: the file runs without a build.

import * as readline from "node:readline";

type Frame = Record<string, unknown> & { t?: string };

/** One frame, one line (spec 3.2). Node writes each call whole, so frames never interleave. */
function send(frame: Frame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
let kind: string | null = null;
/** ask: the input ids presented and not yet answered. */
const waiting = new Set<string>();

function onFrame(frame: Frame): void {
  const id = typeof frame["id"] === "string" ? frame["id"] : "";
  const inputId = typeof frame["in"] === "string" ? frame["in"] : "";
  const values = (frame["values"] ?? {}) as Record<string, unknown>;
  if (frame.t === "input" && kind === "ask") {
    waiting.add(id);
    const event = frame["event"] as { data: unknown };
    const content = {
      title: "Answer the TypeScript view",
      text: JSON.stringify(event.data),
      form: { type: "object", properties: { answer: { type: "string" } } },
    };
    send({ t: "present", in: id, content });
  } else if (frame.t === "input" && kind === "record") {
    const data = (frame["event"] as { data: unknown }).data;
    const content = { title: "Recorded by TypeScript", fields: { data: JSON.stringify(data) } };
    send({ t: "snapshot", content, state: data, in: id });
    send({ t: "emit", port: "passed", data, in: id });
    send({ t: "done", in: id });
  } else if (frame.t === "action" && waiting.has(inputId)) {
    waiting.delete(inputId);
    if (values["__dismiss__"] === true) {
      send({ t: "error", in: inputId, message: "dismissed by the person" });
    } else {
      send({ t: "emit", port: "answer", data: values, in: inputId });
      send({ t: "done", in: inputId });
    }
  } else if (frame.t === "trigger") {
    const snapshot = frame["snapshot"] as { state?: unknown };
    send({ t: "emit", port: frame["action"], data: { state: snapshot.state, values } });
  } else if (frame.t === "cancel" && waiting.has(inputId)) {
    waiting.delete(inputId);
    send({ t: "error", in: inputId, message: "cancelled while waiting" });
  } else if (frame.t === "close") {
    // Exits once `closed` is written: a pipe's write can still be pending on return.
    process.stdout.write(JSON.stringify({ t: "closed" }) + "\n", () => {
      process.exit(0);
    });
  }
  // Any other frame, or an unknown input id, is ignored (spec 1.3).
}

lines.on("line", (line) => {
  const frame = JSON.parse(line) as Frame;
  if (kind === null) {
    const node = frame["node"] as { type?: string } | undefined;
    if (frame.t !== "start" || frame["protocol"] !== 2 || node?.type === undefined) {
      process.stderr.write("the first frame was not a protocol 2 start\n");
      process.exit(2);
    }
    kind = node.type.slice(node.type.lastIndexOf("-") + 1);
    send({ t: "ready" });
    return;
  }
  onFrame(frame);
});
// End of input means close (spec 6.4).
lines.on("close", () => {
  process.exit(0);
});
