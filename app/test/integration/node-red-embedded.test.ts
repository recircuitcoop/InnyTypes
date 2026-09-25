// Node-RED 5 embedded in this process, with the runtime's settings, guard and Host check
// (WI-0018-08): the adapters under test are the real ones, and so is Node-RED. The e2e stage
// shows the same through the real app; this runs in seconds and covers the adapters.
//
// RED.init and RED.start run once per process, so one Node-RED serves the whole file.
import fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeclaredPackageStore } from "../../src/adapters/fs/declared-package-store";
import { EmbeddedNodeRed } from "../../src/adapters/nodered/engine";
import { nodeRedLogging } from "../../src/adapters/nodered/logging";
import { coreNodesOutsideCommon, nodeRedSettings } from "../../src/adapters/nodered/settings";
import { pickFreeLoopbackPort } from "../../src/adapters/net/free-port";
import { DeployGuard } from "../../src/application/deploy-guard";
import { RecordingLogger } from "../fakes/children";

const CORE_NODES_DIR = path.dirname(
  createRequire(import.meta.url).resolve("@node-red/nodes/package.json"),
);
const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

class LeveledRecorder extends RecordingLogger {
  debug(message: string): void {
    this.lines.push(`DEBUG ${message}`);
  }
}

function send(
  port: number,
  options: { method?: string; path: string; host?: string; body?: string },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: options.host ?? `127.0.0.1:${String(port)}`,
      accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const request = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, text });
        });
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

describe("coreNodesOutsideCommon", () => {
  it("lists every core node file outside core/common, from Node-RED's own folders", () => {
    const excluded = coreNodesOutsideCommon(CORE_NODES_DIR);
    expect(excluded).toEqual(
      expect.arrayContaining(["10-function.js", "90-exec.js", "80-template.js"]),
    );
    const common = fs.readdirSync(path.join(CORE_NODES_DIR, "core", "common"));
    expect(excluded.filter((file) => common.includes(file))).toEqual([]);
    expect(excluded.every((file) => file.endsWith(".js"))).toBe(true);
  });
});

describe("the embedded Node-RED", () => {
  let scratch: string;
  let port: number;
  let engine: EmbeddedNodeRed;
  const logger = new RecordingLogger();
  const nodeRedLines = new LeveledRecorder();

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-red-")));
    const userDir = path.join(scratch, "node-red");
    const generatedDir = path.join(userDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    port = await pickFreeLoopbackPort();
    const built: EmbeddedNodeRed = new EmbeddedNodeRed({
      port,
      settings: nodeRedSettings({
        userDir,
        generatedDir,
        credentialSecret: "a-test-credential-secret",
        coreNodesDir: CORE_NODES_DIR,
        logging: nodeRedLogging(nodeRedLines),
      }),
      guard: new DeployGuard({
        engine: { nodeSets: () => built.nodeSets() },
        store: new DeclaredPackageStore([FIXTURES], logger),
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

  it("registers exactly core/common, and its log reaches the logger", async () => {
    const types = (await engine.nodeSets()).flatMap((set) => set.types);
    expect(types).toContain("inject");
    expect(types).toContain("catch");
    for (const excluded of ["function", "exec", "template", "switch", "http request", "file"]) {
      expect(types).not.toContain(excluded);
    }
    // Node-RED adds "-git" when it finds a .git folder above its own; the release is 5.0.7.
    expect(engine.version()).toMatch(/^5\.0\.7(-git)?$/);
    expect(nodeRedLines.lines.some((line) => line.includes("Node-RED version: v5.0.7"))).toBe(true);
  });

  it("serves the editor on 127.0.0.1 at /red, and has no install route", async () => {
    expect((await send(port, { path: "/red/" })).status).toBe(200);
    const install = await send(port, {
      method: "POST",
      path: "/red/nodes",
      body: JSON.stringify({ module: "node-red-contrib-anything" }),
    });
    expect(install.status).toBe(404);
  });

  it("refuses a deploy naming excluded types, and accepts one of core types", async () => {
    const refused = await send(port, {
      method: "POST",
      path: "/red/flows",
      body: JSON.stringify([
        { id: "t", type: "tab" },
        { id: "e", type: "exec", z: "t" },
      ]),
    });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.text)).toEqual({
      code: "unknown_types",
      message: "Not installed in InnyTypes: exec",
    });
    const accepted = await send(port, {
      method: "POST",
      path: "/red/flows",
      body: JSON.stringify([
        { id: "t", type: "tab" },
        { id: "i", type: "inject", z: "t", wires: [] },
      ]),
    });
    expect(accepted.status).toBe(204);
    const flows = JSON.parse((await send(port, { path: "/red/flows" })).text) as { id: string }[];
    expect(flows.map((node) => node.id)).toEqual(["t", "i"]);
  });

  it("refuses a request, and a WebSocket upgrade, for any other Host", async () => {
    const refused = await send(port, {
      path: "/red/settings",
      host: `evil.example:${String(port)}`,
    });
    expect(refused.status).toBe(403);
    const status = await new Promise<number>((resolve, reject) => {
      http
        .request({
          host: "127.0.0.1",
          port,
          path: "/red/comms",
          headers: { host: "evil.example", connection: "Upgrade", upgrade: "websocket" },
        })
        .on("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        })
        .on("upgrade", () => {
          resolve(101);
        })
        .on("error", reject)
        .end();
    });
    expect(status).toBe(403);
  });

  it("never starts twice in one process", async () => {
    await expect(engine.start()).rejects.toThrow("cannot be started again in this process");
  });

  // Last in this file: once stopped, this process's Node-RED is done (arch_pivot P9 surprise 1).
  it("stops once, closes its port, and refuses a start after the stop", async () => {
    await engine.stop();
    await engine.stop();
    await expect(send(port, { path: "/red/" })).rejects.toThrow("ECONNREFUSED");
    await expect(engine.start()).rejects.toThrow("(it is stopped)");
  });
});
