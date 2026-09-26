// The runtime's generic event-source process (spec 9.5): the command of every source in the
// synthetic `user-events` package. Bundled to dist/runtime/event-source.cjs and run by the
// runtime's own executable as Node.
//
// - `fire {data}` (the Events page; the runtime validated it): emit `data` on `event`, no `in`,
//   so a new run.
// - `input {id, event}` (a message on the source's input, which the runtime validated against
//   the payload schema before sending it): emit its data as a NEW run, then `done` the input.
// - `close`, or the end of stdin: `closed`, and exit.

import * as readline from "node:readline";

export type Frame = Readonly<Record<string, unknown>>;

/** The port every created source emits on (domain/events EVENT_PORT). */
const PORT = "event";

/** The frames to answer one frame with; `closed` is answered by the caller, then it exits. */
export function answer(frame: Frame): Frame[] {
  switch (frame["t"]) {
    case "start":
      return [{ t: "ready" }];
    case "fire":
      return [{ t: "emit", port: PORT, data: frame["data"] ?? {} }];
    case "input": {
      const id = frame["id"];
      const event = frame["event"] as { data?: unknown } | undefined;
      return typeof id === "string"
        ? [
            { t: "emit", port: PORT, data: event?.data ?? {} },
            { t: "done", in: id },
          ]
        : [];
    }
    default:
      // `cancel` finds nothing running (every input is done at once); unknown frames are
      // ignored (spec 1.3).
      return [];
  }
}

/** Speak the protocol on stdin and stdout until `close` or the end of stdin. */
export function run(): void {
  const send = (frame: Frame, then?: () => void): void => {
    process.stdout.write(JSON.stringify(frame) + "\n", then);
  };
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    let frame: Frame;
    try {
      frame = JSON.parse(line) as Frame;
    } catch {
      process.stderr.write("a line that is not a JSON frame was ignored\n");
      return;
    }
    if (frame["t"] === "close") {
      send({ t: "closed" }, () => process.exit(0));
      return;
    }
    for (const reply of answer(frame)) {
      send(reply);
    }
  });
  // End of input means close (spec 6.4).
  lines.on("close", () => process.exit(0));
}

// Run when this is the process's main module; a test imports `answer` instead.
if (typeof require !== "undefined" && require.main === module) {
  run();
}
