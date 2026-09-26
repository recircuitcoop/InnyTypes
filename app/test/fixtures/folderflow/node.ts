// The e2e fixture for WI-0018-20: a watched-folder source and a snapshot view that records an
// Anytype object as a link. Node's standard library only, run as-is by a Node that strips
// types (Electron as Node), like the viewts reference node; it is not the SDK.
//
// - `watch` (a source): every file that appears in `folder` after start is emitted on `file`
//   as {name, body}, a new run each. Polled, so it behaves the same on every platform.
// - `link` (a snapshot view): each input, an anytype.object.created.v1 payload, is recorded as
//   a snapshot whose content is `{title, anytype: {objectId, spaceId, name}}`, then passed on.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

type Frame = Record<string, unknown> & { t?: string };

function send(frame: Frame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
let kind: string | null = null;

function watch(folder: string): void {
  const seen = new Set(fs.existsSync(folder) ? fs.readdirSync(folder) : []);
  setInterval(() => {
    const names = fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
    for (const name of names) {
      if (!seen.has(name)) {
        seen.add(name);
        const body = fs.readFileSync(path.join(folder, name), "utf8");
        send({ t: "emit", port: "file", data: { name, body } });
      }
    }
  }, 200);
}

function onFrame(frame: Frame): void {
  if (frame.t === "input" && kind === "link") {
    const id = String(frame["id"]);
    const data = (frame["event"] as { data: Record<string, unknown> }).data;
    const content = {
      title: "Created in Anytype",
      anytype: { objectId: data["object_id"], spaceId: data["space_id"], name: data["name"] },
    };
    send({ t: "snapshot", content, state: data, in: id });
    send({ t: "emit", port: "passed", data, in: id });
    send({ t: "done", in: id });
  } else if (frame.t === "close") {
    process.stdout.write(JSON.stringify({ t: "closed" }) + "\n", () => {
      process.exit(0);
    });
  }
}

lines.on("line", (line) => {
  const frame = JSON.parse(line) as Frame;
  if (kind === null) {
    const node = frame["node"] as { type: string };
    kind = node.type.slice(node.type.lastIndexOf("-") + 1);
    send({ t: "ready" });
    if (kind === "watch") {
      watch(String((frame["config"] as { folder?: unknown }).folder));
    }
    return;
  }
  onFrame(frame);
});
lines.on("close", () => {
  process.exit(0);
});
