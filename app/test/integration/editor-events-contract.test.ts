// The contract the editor sync rests on (WI-0018-12, plan 0018 §10 risk 5), pinned to
// Node-RED 5.0.7.
//
// Palette sync uses Node-RED's own `runtime-event`s `node/added` and `node/removed`. RED.events
// is documented; those ids and their payload are Node-RED's convention, not an API for
// embedders (arch_pivot P11 §4). This file pins both halves:
// - the runtime: an event raised through the adapter reaches a connected editor's websocket as
//   `notification/node/added` or `notification/node/removed`, with the payload the editor reads;
// - the editor client: it handles those topics the way the sync relies on, and keeps a removed
//   type's definition, which is why the sync compares node sets (P11 surprise 2).
// A Node-RED upgrade fails here first; re-check the convention, then re-pin the version.
import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeclaredPackageStore } from "../../src/adapters/fs/declared-package-store";
import { EmbeddedNodeRed } from "../../src/adapters/nodered/engine";
import { nodeRedLogging } from "../../src/adapters/nodered/logging";
import { nodeRedSettings } from "../../src/adapters/nodered/settings";
import { pickFreeLoopbackPort } from "../../src/adapters/net/free-port";
import { DeployGuard } from "../../src/application/deploy-guard";
import { RecordingLogger } from "../fakes/children";

/** The Node-RED release this convention was read from. */
const PINNED = "5.0.7";

const require = createRequire(import.meta.url);
const CORE_NODES_DIR = path.dirname(require.resolve("@node-red/nodes/package.json"));
const versionOf = (name: string): string =>
  (
    JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), "utf8")) as {
      version: string;
    }
  ).version;
const EDITOR_CLIENT = fs.readFileSync(
  path.join(
    path.dirname(require.resolve("@node-red/editor-client/package.json")),
    "public",
    "red",
    "red.js",
  ),
  "utf8",
);

class LeveledRecorder extends RecordingLogger {
  debug(message: string): void {
    this.lines.push(`DEBUG ${message}`);
  }
}

interface CommsMessage {
  readonly topic: string;
  readonly data: unknown;
}

/** An editor's websocket, subscribed to every notification, collecting what arrives. */
async function editorSocket(port: number): Promise<{ received: CommsMessage[]; close(): void }> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/red/comms`);
  const received: CommsMessage[] = [];
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    received.push(...(JSON.parse(event.data) as CommsMessage[]));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error("the editor's websocket did not open"));
    });
  });
  socket.send(JSON.stringify({ subscribe: "notification/#" }));
  // The subscription is registered when the runtime has read it; a round trip settles it.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    received,
    close: () => {
      socket.close();
    },
  };
}

async function arrival(received: CommsMessage[], topic: string): Promise<CommsMessage> {
  for (let waited = 0; waited < 3_000; waited += 50) {
    const found = received.find((message) => message.topic === topic);
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no ${topic} reached the editor's websocket`);
}

describe(`Node-RED is ${PINNED}, the release the editor-sync convention was read from`, () => {
  it("pins node-red, its runtime and its editor client", () => {
    expect({
      "node-red": versionOf("node-red"),
      "@node-red/runtime": versionOf("@node-red/runtime"),
      "@node-red/editor-client": versionOf("@node-red/editor-client"),
    }).toEqual({
      "node-red": PINNED,
      "@node-red/runtime": PINNED,
      "@node-red/editor-client": PINNED,
    });
  });
});

describe("the editor client handles node/added and node/removed as the sync relies on", () => {
  it("subscribes to every node notification", () => {
    expect(EDITOR_CLIENT).toContain(
      'RED.comms.subscribe("notification/node/#",function(topic,msg) {',
    );
  });

  it("adds each set of node/added by its payload, and fetches its definitions from nodes/<id>", () => {
    const added = EDITOR_CLIENT.slice(
      EDITOR_CLIENT.indexOf('if (topic == "notification/node/added") {'),
      EDITOR_CLIENT.indexOf('} else if (topic == "notification/node/removed") {'),
    );
    expect(added).toContain("msg.forEach(function(m) {");
    expect(added).toContain("var id = m.id;");
    expect(added).toContain("RED.nodes.addNodeSet(m);");
    expect(added).toContain("url: 'nodes/'+id,");
  });

  it("removes each set of node/removed by its id, and reads its types", () => {
    const removed = EDITOR_CLIENT.slice(
      EDITOR_CLIENT.indexOf('} else if (topic == "notification/node/removed") {'),
      EDITOR_CLIENT.indexOf('} else if (topic == "notification/node/enabled") {'),
    );
    expect(removed).toContain("info = RED.nodes.removeNodeSet(m.id);");
    expect(removed).toContain("m.types.map(");
  });

  it("keeps definitions apart from node sets: the palette is the node list (P11 surprise 2)", () => {
    expect(EDITOR_CLIENT).toMatch(/getNodeList: function\(\) \{\s*return nodeList;\s*\}/);
    expect(EDITOR_CLIENT).toMatch(
      /getNodeTypes: function\(\) \{\s*return Object\.keys\(nodeDefinitions\);\s*\}/,
    );
    // removeNodeSet drops the set from nodeList and typeToId, and never touches the definitions.
    const removeNodeSet = EDITOR_CLIENT.slice(
      EDITOR_CLIENT.indexOf("removeNodeSet: function(id) {"),
      EDITOR_CLIENT.indexOf("getNodeSet: function(id) {"),
    );
    expect(removeNodeSet).toContain("delete nodeSets[id];");
    expect(removeNodeSet).toContain("nodeList.splice(i,1);");
    expect(removeNodeSet).not.toContain("nodeDefinitions");
  });

  it("answers dirty() for the quit question", () => {
    expect(EDITOR_CLIENT).toMatch(/\bdirty: function\(d\) \{/);
    expect(EDITOR_CLIENT).toContain('id="red-ui-header-button-deploy"');
  });
});

describe("the runtime raises them to a connected editor", () => {
  let scratch: string;
  let port: number;
  let engine: EmbeddedNodeRed;

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-red-events-")));
    const userDir = path.join(scratch, "node-red");
    const generatedDir = path.join(userDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    port = await pickFreeLoopbackPort();
    const logger = new RecordingLogger();
    const built: EmbeddedNodeRed = new EmbeddedNodeRed({
      port,
      settings: nodeRedSettings({
        userDir,
        generatedDir,
        credentialSecret: "a-test-credential-secret",
        coreNodesDir: CORE_NODES_DIR,
        logging: nodeRedLogging(new LeveledRecorder()),
      }),
      guard: new DeployGuard({
        engine: { nodeSets: () => built.nodeSets() },
        store: new DeclaredPackageStore([], logger),
        logger,
        port,
      }),
    });
    engine = built;
    await engine.start();
  }, 60_000);

  afterAll(async () => {
    await engine.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("node/added arrives as notification/node/added, carrying exactly what the editor's own load lists", async () => {
    const editor = await editorSocket(port);
    try {
      const raised = await engine.raiseNodeAdded(["node-red/inject", "node-red/not-there"]);
      expect(raised).toEqual(["node-red/inject"]);
      const message = await arrival(editor.received, "notification/node/added");
      // What GET /red/nodes gives the editor when it loads: the same objects, whole.
      const listed = (await (
        await fetch(`http://127.0.0.1:${String(port)}/red/nodes`, {
          headers: { accept: "application/json" },
        })
      ).json()) as { id: string }[];
      expect(message.data).toEqual(listed.filter((set) => set.id === "node-red/inject"));
      expect(message.data).toEqual([
        expect.objectContaining({ id: "node-red/inject", types: ["inject"], module: "node-red" }),
      ]);
    } finally {
      editor.close();
    }
  });

  it("node/removed arrives as notification/node/removed with each set's id and types", async () => {
    const editor = await editorSocket(port);
    try {
      engine.raiseNodeRemoved([{ id: "node-red/inny-gone", types: ["inny-gone"] }]);
      const message = await arrival(editor.received, "notification/node/removed");
      expect(message.data).toEqual([{ id: "node-red/inny-gone", types: ["inny-gone"] }]);
      // Nothing is raised for nothing: no empty notification reaches the editor.
      engine.raiseNodeRemoved([]);
      expect(await engine.raiseNodeAdded([])).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(editor.received.filter((m) => m.topic.startsWith("notification/node/"))).toHaveLength(
        1,
      );
    } finally {
      editor.close();
    }
  });
});
