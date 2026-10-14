// The widget kit (plan 0021): action views drawn by the package's own widgets
// (view/component.js), for the e2e test's "widget views". Node's standard library only, run
// as-is by Electron as Node, like the popoutkit fixture.
//
// - `reorder`: presents <widgetkit-reorder> with `props.items` (the input's `items`, else three
//   names); the widget answers `{order: [...]}`, which the type's `answer` schema judges.
// - `missing`: a widget that can't be drawn, so the pop-out falls back (plan 0021 §5). With
//   `show: "missing"` it names an element never defined, beside a fallback `form`; with
//   `show: "bare"` the same element and no form; with `show: "crash"` <widgetkit-crash>, which
//   is defined but throws as it is drawn, beside the form.
//
// `action` emits the values on `answer`, or errors on a dismissal. Erasable syntax only, and no
// imports but `node:`: the file runs without a build.

import * as readline from "node:readline";

type Frame = Record<string, unknown> & { t?: string };

function send(frame: Frame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

/** The fallback form of the `missing` views: one flat answer, today's default shape. */
const FALLBACK_FORM = {
  type: "object",
  properties: { choice: { type: "string", title: "Who goes first?" } },
};

function content(kind: string, show: string, data: unknown): Record<string, unknown> {
  if (kind === "reorder") {
    const items = (data as { items?: unknown } | undefined)?.items;
    return {
      title: "Put these in order",
      component: {
        element: "widgetkit-reorder",
        props: { items: Array.isArray(items) ? items : ["Ada", "Grace", "Linus"] },
      },
    };
  }
  if (show === "crash") {
    return {
      title: "A widget that breaks",
      component: { element: "widgetkit-crash" },
      form: FALLBACK_FORM,
    };
  }
  return {
    title: show === "bare" ? "A widget with no fallback" : "A widget never defined",
    component: { element: "widgetkit-missing" },
    ...(show === "bare" ? {} : { form: FALLBACK_FORM }),
  };
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
let kind: string | null = null;
let show = "missing";
/** The input ids in hand. */
const waiting = new Set<string>();

function onFrame(frame: Frame): void {
  const id = typeof frame["id"] === "string" ? frame["id"] : "";
  const inputId = typeof frame["in"] === "string" ? frame["in"] : "";
  const values = (frame["values"] ?? {}) as Record<string, unknown>;
  if (frame.t === "input") {
    waiting.add(id);
    const data = (frame["event"] as { data: unknown }).data;
    send({ t: "present", in: id, content: content(kind ?? "", show, data) });
  } else if (frame.t === "action" && waiting.has(inputId)) {
    waiting.delete(inputId);
    if (values["__dismiss__"] === true) {
      send({ t: "error", in: inputId, message: "dismissed by the person" });
    } else {
      send({ t: "emit", port: "answer", data: values, in: inputId });
      send({ t: "done", in: inputId });
    }
  } else if (frame.t === "cancel" && waiting.has(inputId)) {
    waiting.delete(inputId);
    send({ t: "error", in: inputId, message: "cancelled" });
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
    const shown = config["show"];
    show = shown === "bare" || shown === "crash" ? shown : "missing";
    send({ t: "ready" });
    return;
  }
  onFrame(frame);
});
lines.on("close", () => {
  process.exit(0);
});
