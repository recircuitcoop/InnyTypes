// The first-party folder source (packages/folder, plan 0022 D18, WI-0022-25), end to end below
// the app: bundled as `npm run build:packages` bundles it, and run through the runtime's own
// node-process adapter as the runtime runs a source, against real scratch folders. What it
// emits is what the adapter hands Node-RED: one message on `created` per new file, a new run
// each (no input), typed `folder.file.created.v1`.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { minimalEnvironment } from "../../src/adapters/process/command";
import { DEFAULT_NODE_PROCESS, nodeProcessLauncher } from "../../src/adapters/process/node-process";
import { processTreeFor } from "../../src/adapters/process/process-tree";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { systemClock } from "../../src/adapters/system/clock";
import { parseDeclaration, portsOf } from "../../src/domain/packages/declaration";
import type { NodeProcess, NodeProcessSpec, NodeStatus } from "../../src/ports/node-process";
import { MemoryJournal } from "../fakes/journal";
import {
  buildFolderPackage,
  FOLDER_PACKAGE_SOURCE,
  type BuiltFolderPackage,
} from "../fixtures/folder-package";
import {
  RecordingHost,
  RecordingLogger,
  RecordingNotifier,
  RecordingSecrets,
  waitFor,
} from "../fixtures/raw-node/fixture";

const APP = path.resolve(import.meta.dirname, "..", "..");
/** Short, so a scenario waits a second, not the declared default of two. */
const SETTLE_MS = 300;

/**
 * Whether the node itself has looked at the folder: its own status, not the adapter's green
 * ring "watching" that `ready` brings before the first scan.
 */
function scannedStatus(status: NodeStatus): boolean {
  return (
    (status.text === "watching" && status.shape === "dot") ||
    status.text === "the folder is not there" ||
    status.text === CANNOT_WRITE
  );
}

/** The node's status while it cannot write down what it passed on. */
const CANNOT_WRITE = "cannot write down the files passed on";
const isWatching = (status: NodeStatus) => status.text === "watching" && status.shape === "dot";

let built: BuiltFolderPackage;
let scratch: string;

beforeAll(async () => {
  built = await buildFolderPackage();
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-folder-source-")));
}, 60_000);

afterAll(() => {
  built.remove();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const running: NodeProcess[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((node) => node.close("removed")));
});

interface Watching {
  readonly node: NodeProcess;
  readonly host: RecordingHost;
  readonly folder: string;
  readonly dataDir: string;
}

interface Created {
  name: string;
  path: string;
  size: number;
  modified: string;
  body?: string;
}

/** Start one instance of `inny-folder-watch`, as the runtime starts a source. */
async function watch(
  config: Record<string, unknown> = {},
  same?: { folder: string; dataDir: string },
): Promise<Watching> {
  const folder = same?.folder ?? fs.mkdtempSync(path.join(scratch, "watched-"));
  const dataDir = same?.dataDir ?? fs.mkdtempSync(path.join(scratch, "data-"));
  const host = new RecordingHost();
  const spec: NodeProcessSpec = {
    identity: {
      id: `f${randomUUID().slice(0, 8)}`,
      flowId: "flow-1",
      package: "folder",
      typeId: "watch",
      type: "inny-folder-watch",
      name: "",
      kind: "source",
    },
    argv: built.argv,
    cwd: built.cwd,
    env: minimalEnvironment(process.env, {}),
    config: { folder, settle_ms: SETTLE_MS, ...config },
    credentials: {},
    dataDir,
    ports: portsOf(built.type).map(({ port, event }) => ({ port, event })),
  };
  const launcher = nodeProcessLauncher({
    clock: systemClock,
    logger: new RecordingLogger(),
    secrets: new RecordingSecrets(),
    notifier: new RecordingNotifier(),
    crashes: { nodeCrashed: () => undefined },
    tree: processTreeFor(process.platform),
    newId: randomUUID,
    journal: new MemoryJournal(),
    settings: DEFAULT_NODE_PROCESS,
  });
  const node = launcher.start(spec, host);
  running.push(node);
  await waitFor("the first scan", () => host.statuses.some(scannedStatus), 10_000);
  return { node, host, folder, dataDir };
}

function created(watching: Watching): Created[] {
  return watching.host.sent.map((output) => {
    expect(output.port).toBe("created");
    return output.message.payload as Created;
  });
}

const names = (watching: Watching) => created(watching).map((file) => file.name);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("packages/folder: the declaration and how it ships", () => {
  it("declares one source, watch, on folder.file.created.v1, run from the file the build writes", () => {
    const text = fs.readFileSync(path.join(FOLDER_PACKAGE_SOURCE, "inny-package.json"), "utf8");
    const parsed = parseDeclaration(JSON.parse(text), (value) =>
      new AjvSchemaValidator().declaration(value),
    );
    if (!parsed.ok) {
      throw new Error(parsed.problems.join("; "));
    }
    expect(parsed.declaration.package).toBe("folder");
    expect(
      parsed.declaration.types.map((type) => [type.id, type.kind, type.command, type.outputs]),
    ).toEqual([
      [
        "watch",
        "source",
        ["{node}", "{package}/dist/folder.cjs"],
        [{ port: "created", event: "folder.file.created.v1" }],
      ],
    ]);
    // The folder is the one required setting: a starter made from the template is not set up
    // until Setup's Source folder step writes it.
    expect(parsed.declaration.types[0]?.config).toMatchObject({ required: ["folder"] });
    // The app's build writes that very file, beside anytype's (packages/* ships beside the app).
    const scripts = (
      JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["build:packages"]).toContain(
      "esbuild ../packages/folder/src/main.ts --bundle --platform=node --target=node22 --format=cjs --outfile=../packages/folder/dist/folder.cjs",
    );
    expect(scripts["types"]).toContain("tsc -p ../packages/folder");
  });
});

describe("packages/folder: watching one folder", { timeout: 30_000 }, () => {
  it("emits one created event per new file, a new run each, with its name, path, size, time and text", async () => {
    const watching = await watch();
    fs.writeFileSync(path.join(watching.folder, "note.md"), "# Hello\n");
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    await pause(SETTLE_MS * 3);
    const stat = fs.statSync(path.join(watching.folder, "note.md"));
    expect(created(watching)).toEqual([
      {
        name: "note.md",
        path: path.join(watching.folder, "note.md"),
        size: 8,
        modified: new Date(stat.mtimeMs).toISOString(),
        body: "# Hello\n",
      },
    ]);
    // A new run: typed as declared, with a run of its own and no input.
    const message = watching.host.sent[0]?.message;
    expect(message?.topic).toBe("folder.file.created.v1");
    expect(message?.inny).toMatchObject({ run: expect.any(String) as unknown });
  });

  it("ignores a partial write: a file still growing is passed on once, whole, after it went quiet", async () => {
    const watching = await watch();
    const file = path.join(watching.folder, "recording.m4a");
    // Six writes, each well inside the quiet period: never passed on while it grows.
    for (let chunk = 0; chunk < 6; chunk += 1) {
      fs.appendFileSync(file, Buffer.alloc(1024, chunk));
      await pause(SETTLE_MS / 2);
      expect(watching.host.sent).toEqual([]);
    }
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    await pause(SETTLE_MS * 3);
    expect(created(watching)).toEqual([
      expect.objectContaining({ name: "recording.m4a", size: 6 * 1024 }),
    ]);
    // Binary: passed by path, with no body.
    expect(created(watching)[0]).not.toHaveProperty("body");
  });

  it("never passes on a download or temporary name, a hidden file or a folder; the finished name is passed on", async () => {
    const watching = await watch();
    const partials = [
      "clip.m4a.part",
      "page.crdownload",
      "x.download",
      "y.tmp",
      ".hidden",
      "~$doc.docx",
    ];
    for (const name of partials) {
      fs.writeFileSync(path.join(watching.folder, name), "partial");
    }
    fs.mkdirSync(path.join(watching.folder, "inner"));
    fs.writeFileSync(path.join(watching.folder, "inner", "deep.txt"), "not watched");
    await pause(SETTLE_MS * 4);
    expect(watching.host.sent).toEqual([]);
    // The download finishes: renamed to its own name, it is a new file.
    fs.renameSync(
      path.join(watching.folder, "clip.m4a.part"),
      path.join(watching.folder, "clip.m4a"),
    );
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    expect(names(watching)).toEqual(["clip.m4a"]);
  });

  it("leaves the files already there the first time it starts alone, and passes on what comes after", async () => {
    const folder = fs.mkdtempSync(path.join(scratch, "existing-"));
    fs.writeFileSync(path.join(folder, "old.txt"), "old");
    const leaving = await watch({}, { folder, dataDir: fs.mkdtempSync(path.join(scratch, "d-")) });
    await pause(SETTLE_MS * 4);
    expect(leaving.host.sent).toEqual([]);
    fs.writeFileSync(path.join(folder, "new.txt"), "new");
    await waitFor("the emit", () => leaving.host.sent.length === 1, 10_000);
    await pause(SETTLE_MS * 3);
    expect(names(leaving)).toEqual(["new.txt"]);
  });

  it("remembers what it passed on across a restart: only what arrived meanwhile, and a name put back, is new", async () => {
    const first = await watch();
    fs.writeFileSync(path.join(first.folder, "one.txt"), "1");
    fs.writeFileSync(path.join(first.folder, "two.txt"), "2");
    await waitFor("two emits", () => first.host.sent.length === 2, 10_000);
    await first.node.close("redeploy");
    expect(
      JSON.parse(fs.readFileSync(path.join(first.dataDir, "seen.json"), "utf8")),
    ).toMatchObject({
      folder: first.folder,
      files: { "one.txt": { size: 1 }, "two.txt": { size: 1 } },
    });

    // While stopped, one arrives; after the restart, one is removed and put back.
    fs.writeFileSync(path.join(first.folder, "three.txt"), "3");
    const second = await watch({}, { folder: first.folder, dataDir: first.dataDir });
    await waitFor("the emit", () => second.host.sent.length === 1, 10_000);
    fs.rmSync(path.join(first.folder, "one.txt"));
    await pause(SETTLE_MS * 3);
    fs.writeFileSync(path.join(first.folder, "one.txt"), "one again");
    await waitFor("the second emit", () => second.host.sent.length === 2, 10_000);
    await pause(SETTLE_MS * 3);
    expect(names(second)).toEqual(["three.txt", "one.txt"]);
  });

  it("says a folder that is not there, and passes on its files once it is", async () => {
    const folder = path.join(scratch, `later-${randomUUID().slice(0, 8)}`);
    const watching = await watch({}, { folder, dataDir: fs.mkdtempSync(path.join(scratch, "d-")) });
    expect(watching.host.statuses.find(scannedStatus)).toEqual({
      text: "the folder is not there",
      fill: "red",
      shape: "ring",
    });
    fs.mkdirSync(folder);
    await waitFor("watching", () => watching.host.statuses.some(isWatching));
    fs.writeFileSync(path.join(folder, "first.txt"), "here now");
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    expect(names(watching)).toEqual(["first.txt"]);
  });

  // The debounce, with a quiet period well above the 500 ms scan: a file is not passed on until
  // settle_ms has passed since it LAST changed, and is passed on after. With the settle check in
  // watcher.ts removed, the file goes out on its second sighting, about 500 ms in, and this fails.
  it("waits settle_ms after the last change before passing a file on, and passes it on after", async () => {
    const watching = await watch({ settle_ms: 2000 });
    const file = path.join(watching.folder, "slow.txt");
    const firstWrite = Date.now();
    fs.writeFileSync(file, "part one");
    await pause(1200);
    // Inside the quiet period: nothing yet, though several scans have seen it unchanged.
    expect(watching.host.sent).toEqual([]);
    fs.appendFileSync(file, ", part two");
    const lastChange = Date.now();
    await pause(Math.max(0, firstWrite + 2600 - Date.now()));
    // 2.6 s after the first write but well under 2 s after the last change: still nothing.
    expect(watching.host.sent).toEqual([]);
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    expect(Date.now() - lastChange).toBeGreaterThanOrEqual(2000);
    expect(created(watching)).toEqual([
      expect.objectContaining({ name: "slow.txt", body: "part one, part two" }),
    ]);
  });

  // Never lost: with a data folder it cannot write in, the file is still passed on, once; the
  // status stays red until the record can be written, and then the record holds it.
  it("passes a file on once even while it cannot write down what it passed on, red until it can", async () => {
    const dataDir = fs.mkdtempSync(path.join(scratch, "locked-"));
    fs.chmodSync(dataDir, 0o500);
    try {
      const watching = await watch(
        {},
        { folder: fs.mkdtempSync(path.join(scratch, "w-")), dataDir },
      );
      expect(watching.host.statuses.find(scannedStatus)).toEqual({
        text: CANNOT_WRITE,
        fill: "red",
        shape: "ring",
      });
      fs.writeFileSync(path.join(watching.folder, "kept.txt"), "kept");
      await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
      await pause(SETTLE_MS * 4);
      // Still red: no "watching" since the first scan, and not written down.
      expect(watching.host.statuses.some(isWatching)).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "seen.json"))).toBe(false);

      fs.chmodSync(dataDir, 0o700);
      await waitFor("watching again", () => watching.host.statuses.some(isWatching), 10_000);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, "seen.json"), "utf8"))).toMatchObject({
        files: { "kept.txt": { size: 4 } },
      });
      await pause(SETTLE_MS * 4);
      expect(names(watching)).toEqual(["kept.txt"]);
    } finally {
      fs.chmodSync(dataDir, 0o700);
    }
  });

  // A recorder reuses names: REC001 passed on Monday, the source stopped, the file deleted and a
  // new REC001 recorded. Without comparing the remembered size and time, it is never passed on.
  it("passes on a file put back under a name it remembers while it was stopped", async () => {
    const first = await watch();
    const file = path.join(first.folder, "REC001.txt");
    fs.writeFileSync(file, "monday");
    await waitFor("the emit", () => first.host.sent.length === 1, 10_000);
    await first.node.close("redeploy");

    fs.rmSync(file);
    fs.writeFileSync(file, "tuesday, longer");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    const second = await watch({}, { folder: first.folder, dataDir: first.dataDir });
    await waitFor("the emit", () => second.host.sent.length === 1, 10_000);
    await pause(SETTLE_MS * 4);
    expect(created(second)).toEqual([
      expect.objectContaining({ name: "REC001.txt", body: "tuesday, longer" }),
    ]);
  });

  it("passes on a file replaced under the same name while it runs, once", async () => {
    const watching = await watch();
    const file = path.join(watching.folder, "REC002.txt");
    fs.writeFileSync(file, "first take");
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    // Replaced faster than a scan can see it gone.
    fs.writeFileSync(file, "second take, longer");
    await waitFor("the second emit", () => watching.host.sent.length === 2, 10_000);
    await pause(SETTLE_MS * 4);
    expect(created(watching).map((each) => each.body)).toEqual([
      "first take",
      "second take, longer",
    ]);
  });

  it("says a folder it cannot read, red, and is back to watching once it can", async () => {
    const watching = await watch();
    fs.chmodSync(watching.folder, 0o300);
    try {
      await waitFor("red", () =>
        watching.host.statuses.some((status) => status.text === "cannot read the folder"),
      );
      expect(watching.host.statuses.at(-1)).toEqual({
        text: "cannot read the folder",
        fill: "red",
        shape: "ring",
      });
      // Written while it could not be read: passed on once it can.
      fs.writeFileSync(path.join(watching.folder, "meanwhile.txt"), "meanwhile");
      await pause(SETTLE_MS * 3);
      expect(watching.host.sent).toEqual([]);
    } finally {
      fs.chmodSync(watching.folder, 0o700);
    }
    await waitFor("watching again", () => watching.host.statuses.at(-1)?.text === "watching");
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    expect(names(watching)).toEqual(["meanwhile.txt"]);
  });

  // Names listable but entries not (0o600): the old lstat swallowed every error as "gone",
  // forgot every remembered name, wrote an empty record and passed old.txt on again later.
  it("takes a folder whose entries it cannot look at for unreadable, never for empty", async () => {
    const watching = await watch();
    fs.writeFileSync(path.join(watching.folder, "old.txt"), "old");
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    const record = path.join(watching.dataDir, "seen.json");
    await waitFor("the record", () => fs.readFileSync(record, "utf8").includes("old.txt"));
    fs.chmodSync(watching.folder, 0o600);
    try {
      await waitFor("red", () => watching.host.statuses.at(-1)?.text === "cannot read the folder");
      await pause(SETTLE_MS * 4);
      expect(watching.host.statuses.at(-1)).toEqual({
        text: "cannot read the folder",
        fill: "red",
        shape: "ring",
      });
      // Nothing forgotten: the record still holds old.txt.
      expect(JSON.parse(fs.readFileSync(record, "utf8"))).toMatchObject({
        files: { "old.txt": { size: 3 } },
      });
    } finally {
      fs.chmodSync(watching.folder, 0o755);
    }
    await waitFor("watching again", () => watching.host.statuses.at(-1)?.text === "watching");
    await pause(SETTLE_MS * 4);
    expect(names(watching)).toEqual(["old.txt"]);
  });

  it("never follows a symbolic link, to a file or a folder outside the one it watches", async () => {
    const outside = fs.mkdtempSync(path.join(scratch, "outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside the folder");
    const watching = await watch();
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(watching.folder, "link.txt"));
    fs.symlinkSync(outside, path.join(watching.folder, "linked-folder"));
    await pause(SETTLE_MS * 4);
    expect(watching.host.sent).toEqual([]);
    // A plain file beside them is still passed on.
    fs.writeFileSync(path.join(watching.folder, "plain.txt"), "plain");
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    expect(names(watching)).toEqual(["plain.txt"]);
  });
});
