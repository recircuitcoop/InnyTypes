// The pop-out kit (WI-0018-11): view nodes whose content exercises the generic renderer and a
// package's own web component, and a slow node for the Jobs page. Node's standard library
// only, run as-is by Electron as Node, like the viewts fixture.
//
// - `ask` (an action view): each input is presented, and waits. With `show: "rich"` the content
//   has every part the generic renderer draws; with `show: "component"` it names this
//   package's <popoutkit-probe> (view/component.js). `action` emits the values on `answer`, or
//   errors on a dismissal. The input's data is handed to the content as `data`.
// - `record` (a snapshot view): records its input, passes it on, and `trigger` starts a new run.
// - `slow`: holds each input until `cancel`, then answers with an error that reaches Catch.
//
// Erasable syntax only, and no imports but `node:`: the file runs without a build.

import * as readline from "node:readline";

type Frame = Record<string, unknown> & { t?: string };

function send(frame: Frame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

/** A 1×1 PNG, as a data URI: the media the generic renderer may draw. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function content(show: string, data: unknown): Record<string, unknown> {
  if (show === "component") {
    return {
      title: "Drawn by the pop-out kit's own component",
      component: { element: "popoutkit-probe" },
      data,
    };
  }
  return {
    title: "Answer the pop-out kit",
    text: JSON.stringify(data),
    fields: { asked: "by the pop-out kit" },
    table: {
      columns: ["name", "score"],
      rows: [
        ["Ada", 3],
        ["Grace", 5],
      ],
    },
    media: [{ type: "image", src: PIXEL, alt: "one pixel" }],
    anytype: { objectId: "obj-1", spaceId: "space-1", name: "The object in Anytype" },
    form: {
      type: "object",
      properties: {
        answer: { type: "string", title: "Answer" },
        count: { type: "integer", title: "Count" },
        sure: { type: "boolean", title: "Sure" },
      },
    },
  };
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
let kind: string | null = null;
let show = "rich";
/** ask and slow: the input ids in hand. */
const waiting = new Map<string, number>();

function onFrame(frame: Frame): void {
  const id = typeof frame["id"] === "string" ? frame["id"] : "";
  const inputId = typeof frame["in"] === "string" ? frame["in"] : "";
  const values = (frame["values"] ?? {}) as Record<string, unknown>;
  const data = frame.t === "input" ? (frame["event"] as { data: unknown }).data : undefined;
  if (frame.t === "input" && kind === "ask") {
    waiting.set(id, Date.now());
    send({ t: "present", in: id, content: content(show, data) });
  } else if (frame.t === "input" && kind === "record") {
    send({
      t: "snapshot",
      content: { title: "Recorded by the pop-out kit", fields: { data: JSON.stringify(data) } },
      state: data,
      in: id,
    });
    send({ t: "emit", port: "passed", data, in: id });
    send({ t: "done", in: id });
  } else if (frame.t === "input" && kind === "slow") {
    waiting.set(id, Date.now());
    send({ t: "status", text: "working", fill: "blue", shape: "dot" });
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
    const since = waiting.get(inputId) ?? Date.now();
    waiting.delete(inputId);
    // A slow job stops "as soon as practical" (spec 4.1), not at once: its error arrives well
    // after the runtime has answered the cancel, as a real job's would.
    const stop = (): void => {
      const seconds = Math.round((Date.now() - since) / 1000);
      send({ t: "error", in: inputId, message: `cancelled after ${String(seconds)}s` });
    };
    if (kind === "slow") {
      setTimeout(stop, 750);
    } else {
      stop();
    }
  } else if (frame.t === "close") {
    process.stdout.write(JSON.stringify({ t: "closed" }) + "\n", () => {
      process.exit(0);
    });
  }
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
    const config = (frame["config"] ?? {}) as Record<string, unknown>;
    show = config["show"] === "component" ? "component" : "rich";
    send({ t: "ready" });
    return;
  }
  onFrame(frame);
});
lines.on("close", () => {
  process.exit(0);
});
