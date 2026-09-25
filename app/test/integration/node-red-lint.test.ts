// The lint rule against restarting Node-RED in one process and against the internal RED.nodes
// (arch_pivot P9 surprise 1, P9–P10 §2), run through the architecture stage's own config.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RULE = "innytypes-node-red/no-node-red-restart";

/** The messages the rule reports for `code`, linted as an adapter file. */
async function findings(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: APP, overrideConfigFile: "eslint.architecture.config.mjs" });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(APP, "src", "adapters", "nodered", "probe.ts"),
  });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

describe("the node-red embedding rule", () => {
  it("fires on RED.stop() followed by RED.start() in one function", async () => {
    const found = await findings(`
      import RED from "node-red";
      export async function restart(): Promise<void> {
        await RED.stop();
        await RED.start();
      }`);
    expect(found).toEqual([expect.stringContaining("RED.start() after RED.stop()")]);
  });

  it("fires on a start that comes after a stop anywhere in the file", async () => {
    const found = await findings(`
      const RED = require("node-red");
      export const stop = () => RED.stop();
      export const again = () => RED.start();`);
    expect(found).toEqual([expect.stringContaining("RED.start() after RED.stop()")]);
  });

  it("fires on a second start, and through an alias", async () => {
    const found = await findings(`
      import * as NodeRed from "node-red";
      const R = NodeRed;
      export const first = () => NodeRed.start();
      export const second = () => R.start();`);
    expect(found).toEqual([expect.stringContaining("at most once per process")]);
  });

  it("fires on the internal RED.nodes, however it is reached", async () => {
    const found = await findings(`
      import RED from "node-red";
      const Also = RED;
      export const a = () => RED.nodes.getType("inject");
      export const b = () => Also["nodes"];
      export const { nodes } = RED;`);
    // ESLint lists findings in source order.
    expect(found).toEqual([
      expect.stringContaining("RED.nodes is Node-RED's internal nodes module"),
      expect.stringContaining("RED.nodes is Node-RED's internal nodes module"),
      expect.stringContaining("Do not destructure the Node-RED module"),
    ]);
  });

  it("passes one start before one stop, and the documented RED.runtime.nodes", async () => {
    const found = await findings(`
      import RED from "node-red";
      export async function start(): Promise<void> { await RED.start(); }
      export async function stop(): Promise<void> { await RED.stop(); }
      export const sets = () => RED.runtime.nodes.getNodeList({});`);
    expect(found).toEqual([]);
  });

  it("leaves alone the RED a node file is handed, whose RED.nodes is the public node API", async () => {
    const found = await findings(`
      export default function (RED: { nodes: { createNode(n: unknown, c: unknown): void } }) {
        RED.nodes.createNode({}, {});
      }`);
    expect(found).toEqual([]);
  });

  it("finds nothing in the application's own sources", async () => {
    const eslint = new ESLint({ cwd: APP, overrideConfigFile: "eslint.architecture.config.mjs" });
    const results = await eslint.lintFiles(["src/**/*.ts"]);
    const ruleFindings = results.flatMap((result) =>
      result.messages
        .filter((m) => m.ruleId === RULE)
        .map((m) => `${result.filePath}:${String(m.line)} ${m.message}`),
    );
    expect(ruleFindings).toEqual([]);
    // It really looked at the file that starts and stops Node-RED.
    expect(results.map((result) => path.relative(APP, result.filePath))).toContain(
      path.join("src", "adapters", "nodered", "engine.ts"),
    );
  });
});
