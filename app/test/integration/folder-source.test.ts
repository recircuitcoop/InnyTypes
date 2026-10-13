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
    status.text === "the folder is not there"
  );
}

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

  it("passes on only the endings asked for, whatever their case", async () => {
    const watching = await watch({ extensions: ["m4a", ".WAV"] });
    for (const name of ["a.m4a", "b.txt", "c.wav", "d.M4A"]) {
      fs.writeFileSync(path.join(watching.folder, name), name);
    }
    await waitFor("three emits", () => watching.host.sent.length === 3, 10_000);
    await pause(SETTLE_MS * 3);
    expect(names(watching).sort()).toEqual(["a.m4a", "c.wav", "d.M4A"]);
  });

  it("leaves the files already there alone, unless asked to pass them on", async () => {
    const folder = fs.mkdtempSync(path.join(scratch, "existing-"));
    fs.writeFileSync(path.join(folder, "old.txt"), "old");
    const leaving = await watch({}, { folder, dataDir: fs.mkdtempSync(path.join(scratch, "d-")) });
    await pause(SETTLE_MS * 4);
    expect(leaving.host.sent).toEqual([]);

    const passing = await watch(
      { emit_existing: true },
      { folder, dataDir: fs.mkdtempSync(path.join(scratch, "d-")) },
    );
    await waitFor("the emit", () => passing.host.sent.length === 1, 10_000);
    expect(names(passing)).toEqual(["old.txt"]);
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
    await waitFor("watching", () =>
      watching.host.statuses.some((status) => status.text === "watching" && status.shape === "dot"),
    );
    fs.writeFileSync(path.join(folder, "first.txt"), "here now");
    await waitFor("the emit", () => watching.host.sent.length === 1, 10_000);
    expect(names(watching)).toEqual(["first.txt"]);
  });
});
