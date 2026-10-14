// The e2e fixture for Live's run cards (WI-0022-13): a recorder and two steps whose pace the test
// sets with gate files, so every state of a card can be looked at. Node's standard library only,
// run as-is by a Node that strips types (Electron as Node); it is not the SDK.
//
// - `recorder` (a source): each `<name>.wav` that appears in `folder` after start is emitted on
//   `recording` as {title: name, file, durationSeconds: 2880}: a new run each.
// - `copy`: for each input, `status {in, phase: "copying", text: "from BOYA…"}`; once
//   `<name>.copied` exists, `status {in, phase: "copied"}` (the recorder is safe to unplug, the
//   step goes on); once `<name>.next` exists, the recording passed on, and `done`.
// - `work`: for each input, `status {in, text, progress: 1 of 3}`, then, once `<name>.worked`
//   exists, the recording passed on and `done` with a result line; once `<name>.fail` exists,
//   `error` with the step's own sentence.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

type Frame = Record<string, unknown> & { t?: string };

function send(frame: Frame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
let kind: string | null = null;
let folder = "";

const exists = (name: string): boolean => fs.existsSync(path.join(folder, name));

/** Call `then` once the first of `gates` exists, polling, with that gate's name. */
function whenGate(gates: readonly string[], then: (gate: string) => void): void {
  const timer = setInterval(() => {
    const found = gates.find(exists);
    if (found !== undefined) {
      clearInterval(timer);
      then(found);
    }
  }, 100);
}

function record(): void {
  const seen = new Set(fs.existsSync(folder) ? fs.readdirSync(folder) : []);
  setInterval(() => {
    const names = fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
    for (const file of names) {
      if (!seen.has(file) && file.endsWith(".wav")) {
        seen.add(file);
        const title = file.slice(0, -".wav".length);
        send({ t: "emit", port: "recording", data: { title, file, durationSeconds: 2880 } });
      }
    }
  }, 100);
}

function onInput(id: string, data: Record<string, unknown>): void {
  const title = String(data["title"]);
  if (kind === "copy") {
    send({ t: "status", in: id, text: "from BOYA…", phase: "copying" });
    whenGate([`${title}.copied`], () => {
      send({ t: "status", in: id, text: "copied", phase: "copied" });
      whenGate([`${title}.next`], () => {
        send({ t: "emit", port: "copied", data, in: id });
        send({ t: "done", in: id });
      });
    });
  } else if (kind === "work") {
    send({ t: "status", in: id, text: "in Renaissance", progress: { done: 1, total: 3 } });
    whenGate([`${title}.worked`, `${title}.fail`], (gate) => {
      if (gate.endsWith(".fail")) {
        send({ t: "error", in: id, message: "Mistral refused the key" });
        return;
      }
      send({ t: "emit", port: "worked", data, in: id });
      send({
        t: "done",
        in: id,
        results: [{ kind: "file", text: `Moved ${title} to *Archive*`, folder }],
      });
    });
  }
}

lines.on("line", (line) => {
  const frame = JSON.parse(line) as Frame;
  if (kind === null) {
    const node = frame["node"] as { type: string };
    kind = node.type.slice(node.type.lastIndexOf("-") + 1);
    folder = String((frame["config"] as { folder?: unknown }).folder ?? "");
    send({ t: "ready" });
    if (kind === "recorder") {
      record();
    }
    return;
  }
  if (frame.t === "input") {
    const event = frame["event"] as { data: Record<string, unknown> };
    onInput(String(frame["id"]), event.data);
  } else if (frame.t === "close") {
    process.stdout.write(JSON.stringify({ t: "closed" }) + "\n", () => {
      process.exit(0);
    });
  }
});
lines.on("close", () => {
  process.exit(0);
});
