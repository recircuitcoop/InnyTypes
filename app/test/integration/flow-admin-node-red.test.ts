// Flow administration against the embedded Node-RED 5 (plan 0022 §D, D7): the adapter uses only
// the documented `RED.runtime.flows` calls, a duplicate keeps nothing secret, an export has no
// credentials, a switch-off is the tab's own flag, and the guard in front of the admin API's
// routes is the same one the flow ops ask.
import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmbeddedNodeRed } from "../../src/adapters/nodered/engine";
import { NodeRedFlows } from "../../src/adapters/nodered/flows";
import { nodeRedLogging } from "../../src/adapters/nodered/logging";
import { nodeRedSettings } from "../../src/adapters/nodered/settings";
import { pickFreeLoopbackPort } from "../../src/adapters/net/free-port";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { DeployGuard } from "../../src/application/deploy-guard";
import { DIRTY_SENTENCE, FlowAdmin, type FlowSummary } from "../../src/application/flows";
import type { FlowNodeType } from "../../src/ports/flow-admin";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

const require = createRequire(import.meta.url);
const CORE_NODES_DIR = path.dirname(require.resolve("@node-red/nodes/package.json"));
/** A type with one password credential, planted as a generated type would be. */
const KEYED = "inny-keyed-step";
const KEYED_TYPE: FlowNodeType = {
  package: "keyed",
  kind: "node",
  label: "Keyed step",
  config: {
    type: "object",
    required: ["token"],
    properties: { token: { type: "string", writeOnly: true }, note: { type: "string" } },
  },
};

function plantKeyedType(generatedDir: string): void {
  fs.writeFileSync(
    path.join(generatedDir, "keyed.js"),
    `module.exports = function (RED) {
  function Keyed(config) { RED.nodes.createNode(this, config); }
  RED.nodes.registerType(${JSON.stringify(KEYED)}, Keyed, { credentials: { token: { type: "password" } } });
};
`,
  );
  fs.writeFileSync(
    path.join(generatedDir, "keyed.html"),
    `<script type="text/javascript">
  RED.nodes.registerType(${JSON.stringify(KEYED)}, { category: "InnyTypes", defaults: { note: { value: "" } },
    credentials: { token: { type: "password" } }, inputs: 1, outputs: 1 });
</script>
`,
  );
}

class Quiet extends RecordingLogger {
  debug(): void {}
}

describe("flow administration in the embedded Node-RED", () => {
  let scratch: string;
  let port: number;
  let engine: EmbeddedNodeRed;
  let admin: FlowAdmin;
  const flows = new NodeRedFlows();
  let ids = 0;

  beforeAll(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-flow-admin-")));
    const userDir = path.join(scratch, "node-red");
    const generatedDir = path.join(userDir, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    plantKeyedType(generatedDir);
    port = await pickFreeLoopbackPort();
    const logger = new RecordingLogger();
    const guard = new DeployGuard({
      engine: { nodeSets: () => built.nodeSets() },
      // The keyed type stands in for a verified package's.
      store: { packages: () => ["keyed"] },
      logger,
      port,
    });
    const built: EmbeddedNodeRed = new EmbeddedNodeRed({
      port,
      settings: nodeRedSettings({
        userDir,
        generatedDir,
        credentialSecret: "a-test-credential-secret",
        coreNodesDir: CORE_NODES_DIR,
        logging: nodeRedLogging(new Quiet()),
      }),
      guard,
    });
    engine = built;
    await engine.start();
    admin = new FlowAdmin({
      engine: flows,
      guard,
      runs: { list: () => ({ runs: [], next: null }), deleteFlowRuns: () => 0 },
      cancelInputs: () => 0,
      meta: { get: () => null, set: () => undefined, remove: () => undefined },
      templates: { index: () => [], nodes: () => null },
      nodeType: (type) => (type === KEYED ? KEYED_TYPE : undefined),
      validator: new AjvSchemaValidator(),
      clock: new FakeClock(),
      newId: () => `copy${String(++ids).padStart(12, "0")}`,
      logger,
      signal: () => undefined,
    });
  }, 60_000);

  afterAll(async () => {
    await engine.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function deploy(nodes: object[]): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/red/flows`, {
      method: "POST",
      headers: { "content-type": "application/json", "node-red-deployment-type": "full" },
      body: JSON.stringify(nodes),
    });
    return response.status;
  }

  const write = async (op: Parameters<FlowAdmin["call"]>[0], args: object) =>
    (await admin.call(op, { ...args, canvasDirty: false })) as { ok: boolean; value: unknown };

  it("lists, switches, renames, duplicates, exports and deletes a tab", async () => {
    expect(
      await deploy([
        { id: "rec", type: "tab", label: "Recordings" },
        { id: "inj", type: "inject", z: "rec", wires: [["key"]], x: 100, y: 40 },
        {
          id: "key",
          type: KEYED,
          z: "rec",
          note: "n",
          credentials: { token: "s3cret" },
          wires: [["dbg"]],
          x: 300,
          y: 40,
        },
        { id: "dbg", type: "debug", z: "rec", x: 500, y: 40, wires: [] },
      ]),
    ).toBe(204);

    const listed = async () =>
      ((await admin.call("flow.list", {})) as { value: FlowSummary[] }).value;
    expect(await listed()).toEqual([
      expect.objectContaining({
        id: "rec",
        name: "Recordings",
        on: true,
        health: { kind: "ready" },
        steps: [{ id: "key", name: "Keyed step", type: KEYED, setUp: true }],
      }),
    ]);

    // Off, then on: the tab's own disabled flag, nothing else.
    expect(await write("flow.setOn", { id: "rec", on: false })).toEqual({
      ok: true,
      value: { id: "rec", on: false },
    });
    expect((await flows.getFlow("rec"))?.disabled).toBe(true);
    expect((await listed())[0]?.on).toBe(false);
    await write("flow.setOn", { id: "rec", on: true });
    expect((await flows.getFlow("rec"))?.disabled).toBe(false);
    // The update kept the credential the node had.
    expect((await listed())[0]?.health).toEqual({ kind: "ready" });

    await write("flow.rename", { id: "rec", name: "Invoices" });
    expect((await flows.getFlow("rec"))?.label).toBe("Invoices");

    const copied = (await write("flow.duplicate", { id: "rec" })).value as { id: string };
    const copy = await flows.getFlow(copied.id);
    expect(copy).toMatchObject({ label: "Invoices (copy)", disabled: true });
    const copyIds = copy?.nodes.map((node) => node.id) ?? [];
    expect(copyIds.some((id) => ["inj", "key", "dbg"].includes(id))).toBe(false);
    expect(copy?.nodes.every((node) => node["z"] === copied.id)).toBe(true);
    const keyedCopy = copy?.nodes.find((node) => node.type === KEYED);
    expect(keyedCopy?.["wires"]).toEqual([[copy?.nodes.find((n) => n.type === "debug")?.id]]);
    // No credential was copied: the copy's step is not set up.
    expect(await flows.secretsSet(keyedCopy ?? { id: "", type: KEYED })).toEqual(new Set());
    expect(await flows.secretsSet({ id: "key", type: KEYED })).toEqual(new Set(["token"]));
    expect((await listed()).find((flow) => flow.id === copied.id)?.health).toEqual({
      kind: "steps-not-set-up",
      count: 1,
    });

    const exported = (await admin.call("flow.export", { id: "rec" })) as { value: unknown };
    expect(JSON.stringify(exported.value)).not.toMatch(/credentials|s3cret/);

    // Setting the copy's secret through its form sets it up.
    expect(
      await write("flow.node.configure", {
        flowId: copied.id,
        nodeId: keyedCopy?.id,
        values: { token: "other", note: "m" },
      }),
    ).toMatchObject({ ok: true, value: { flowId: copied.id } });
    expect((await listed()).find((flow) => flow.id === copied.id)?.health).toEqual({
      kind: "ready",
    });

    // Dirty: refused, and nothing deleted.
    expect(await admin.call("flow.delete", { id: "rec", canvasDirty: true })).toEqual({
      ok: true,
      value: { refused: { reason: "dirty", sentence: DIRTY_SENTENCE } },
    });
    expect(await write("flow.delete", { id: "rec" })).toEqual({
      ok: true,
      value: { id: "rec", runs: 0 },
    });
    expect(await flows.getFlow("rec")).toBeNull();
    expect((await listed()).map((flow) => flow.id)).toEqual([copied.id]);
  });

  it("answers an unknown tab as none, and a tab with no label by its id", async () => {
    expect(await flows.getFlow("no-such-tab")).toBeNull();
    const id = await flows.addFlow({ label: "", disabled: true, nodes: [], configs: [] });
    expect((await flows.tabs()).find((tab) => tab.id === id)).toEqual({
      id,
      label: id,
      disabled: true,
    });
    await flows.deleteFlow(id);
  });
});
