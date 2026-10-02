// Conformance of protocol revision 2.1 (spec 1.3, 4.2.1, 4.2.2, 2.4.1, 12.2; plan 0022 §B):
// C20 to C23, for the three reference nodes -- the raw one (no SDK, app/test/fixtures/raw-node)
// and the ones built on each SDK (sdk-py, sdk-ts) -- each run through the runtime's real
// process adapter, as Node-RED's glue runs it. C1 to C15 stay in their own files, unchanged.
//
// "Reaches the run" is proven up to the read model: the delivery's report and step lines are
// turned into run events by domain/runs/step-report.ts and folded by domain/runs/run.ts. Who
// records those events per flow is the run records' work (WI-0022-06).
//
// C23 is the declaration and validation half only. The plan's "resolve against a fake Anytype"
// belongs to WI-0022-09, which builds the options route; no fake Anytype is needed here.

import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { formModel } from "../../src/domain/forms/form-model";
import { INNYTYPE_ANNOTATION, innytypeOptions } from "../../src/domain/forms/innytype";
import type { JsonSchema } from "../../src/domain/packages/declaration";
import { fold, type Run, type RunEvent } from "../../src/domain/runs/run";
import { stepDoneEvent, stepStatusEvent } from "../../src/domain/runs/step-report";
import {
  RAW_NODE_DIR,
  RecordingDelivery,
  startRaw,
  waitFor,
  type RawNode,
} from "../fixtures/raw-node/fixture";
import { sdkCommand, sdkPackageDir } from "../fixtures/sdk-nodes";

interface ReferenceNode {
  readonly name: string;
  readonly dir: string;
  /** The argv replacing the raw node's; none for the raw node itself. */
  readonly argv?: string[];
}

const REFERENCE_NODES: readonly ReferenceNode[] = [
  { name: "raw", dir: RAW_NODE_DIR },
  { name: "Python SDK", dir: sdkPackageDir("py"), argv: sdkCommand("py", "kitchen").argv },
  { name: "TypeScript SDK", dir: sdkPackageDir("ts"), argv: sdkCommand("ts", "kitchen").argv },
];

const FLOW = "flow-conformance";
const WAIT_MS = 10_000;

const started: RawNode[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((raw) => raw.node.close("redeploy")));
});

function start(reference: ReferenceNode, config: Record<string, unknown> = {}): RawNode {
  const raw = startRaw({
    config,
    ...(reference.argv === undefined ? {} : { argv: reference.argv }),
  });
  started.push(raw);
  return raw;
}

/** One input of run `runId` through the adapter; its delivery records what came back. */
function input(raw: RawNode, runId: string, data: object): RecordingDelivery & { id: string } {
  const delivery = new RecordingDelivery();
  const id = raw.node.input({ payload: data, topic: "t.in.v1", inny: { run: runId } }, delivery);
  if (id === null) {
    throw new Error("the adapter refused the input");
  }
  return Object.assign(delivery, { id });
}

const at = (second: number): Date => new Date(2026, 9, 2, 14, 0, second);

/** The run `runId` of FLOW, with one step of the node, folded with `more`. */
function runOf(
  raw: RawNode,
  runId: string,
  more: (key: { flowId: string; runId: string }) => RunEvent[],
): Run {
  const key = { flowId: FLOW, runId };
  return fold([
    { ...key, at: at(0), kind: "started", title: "conformance" },
    { ...key, at: at(1), kind: "stepStarted", instanceId: raw.spec.identity.id, name: "Step" },
    ...more(key),
  ]);
}

/** The reference node's one node type, as its package declares it. */
function declared(reference: ReferenceNode): { declaration: unknown; config: JsonSchema } {
  const text = fs.readFileSync(path.join(reference.dir, "inny-package.json"), "utf8");
  const declaration = JSON.parse(text) as { types: { kind: string; config: JsonSchema }[] };
  const type = declaration.types.find((candidate) => candidate.kind === "node");
  if (type === undefined) {
    throw new Error(`${reference.name} declares no node type`);
  }
  return { declaration, config: type.config };
}

describe("conformance 2.1: the runtime's side", () => {
  it("C22 an eta_s of 1e999 from the raw node is dropped and logged; the status and input stand", async () => {
    const raw = start(REFERENCE_NODES[0] as ReferenceNode);
    const moving = input(raw, "run-infinite", {
      do: "progress",
      done: 1,
      total: 2,
      text: "half",
      infinite_eta: true,
    });
    await waitFor("the progress input's done", () => moving.finished, WAIT_MS);
    expect(moving.ends).toEqual([undefined]);
    expect(moving.statuses).toEqual([{ text: "half", progress: { done: 1, total: 2 } }]);
    expect(raw.host.statuses).toContainEqual({ text: "half", fill: "blue", shape: "dot" });
    expect(raw.logger.has(/status: eta_s dropped: not a number of seconds/)).toBe(true);
    expect(raw.logger.has(/refused an invalid status/)).toBe(false);
  });

  it("C21 a status naming no outstanding input updates the badge only, and is logged", async () => {
    const raw = start(REFERENCE_NODES[0] as ReferenceNode);
    const moving = input(raw, "run-stale", { do: "progress", done: 1, total: 1, stale: true });
    await waitFor("the progress input's done", () => moving.finished, WAIT_MS);
    await waitFor(
      "the stale status",
      () => raw.host.statuses.some((s) => s.text === "stale"),
      WAIT_MS,
    );
    expect(moving.statuses).toEqual([{ text: "working", progress: { done: 1, total: 1 } }]);
    expect(
      raw.logger.has(/status for unknown or finished input not-an-input-of-mine: badge only/),
    ).toBe(true);
  });

  it("revision 2.1 keeps the wire integer 2 in the spec and both schemas", () => {
    const read = (file: string): string => fs.readFileSync(path.join(REPOSITORY, file), "utf8");
    const frames = JSON.parse(read("docs/specs/node-protocol-v2.schema.json")) as {
      $defs: { start: { properties: { protocol: unknown } } };
    };
    const declaration = JSON.parse(read("docs/specs/inny-package.v2.schema.json")) as {
      properties: { protocol: unknown };
    };
    expect(frames.$defs.start.properties.protocol).toEqual({ const: 2 });
    expect(declaration.properties.protocol).toEqual({ const: 2 });
    expect(read("docs/specs/node-protocol-v2.md")).toContain(
      "Revision **2.1** (plan 0022 §B). The wire integer is still `2`",
    );
  });

  it("no x-inny key exists in the specs, the schemas, the SDKs or the app's source", () => {
    const forbidden = ["x", "inny"].join("-");
    const roots = ["docs/specs", "sdk", "app/src"].map((root) => path.join(REPOSITORY, root));
    const offenders: string[] = [];
    for (const file of roots.flatMap((root) => filesUnder(root))) {
      if (fs.readFileSync(file, "utf8").includes(forbidden)) {
        offenders.push(path.relative(REPOSITORY, file));
      }
    }
    expect(roots.flatMap((root) => filesUnder(root)).length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every file under `dir`, dependencies and caches left out. */
function filesUnder(dir: string): string[] {
  const skipped = new Set(["node_modules", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache"]);
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return skipped.has(entry.name) ? [] : filesUnder(full);
    }
    return entry.isFile() ? [full] : [];
  });
}

describe.each(REFERENCE_NODES)("conformance 2.1: the $name reference node", (reference) => {
  it("C20 notes and results reach the run; over 20 or 200 characters are cut and logged", async () => {
    const raw = start(reference);
    const notes = [
      { level: "note", text: "used the large model" },
      { level: "warning", text: "2 speakers could not be named" },
      { level: "note", text: "x".repeat(250) },
      ...Array.from({ length: 19 }, (_, n) => ({ level: "note", text: `extra ${String(n)}` })),
    ];
    const results = [
      {
        kind: "anytype",
        text: "Meeting notes → Renaissance",
        anytype: { spaceId: "space-1", objectId: "object-1" },
      },
      { kind: "file", text: "Moved the recording", folder: "/archive" },
    ];
    const delivery = input(raw, "run-c20", { do: "report", notes, results });
    await waitFor("the report's done", () => delivery.finished, WAIT_MS);

    expect(delivery.ends).toEqual([undefined]);
    const outcome = delivery.outcomes[0];
    expect(outcome?.notes).toHaveLength(20);
    expect(outcome?.notes[2]?.text).toBe("x".repeat(200));
    expect(outcome?.results).toEqual(results);
    // One warning per frame, naming everything cut or dropped from it.
    expect(
      raw.logger.has(
        /done: notes\[2\] text cut from 250 to 200; notes: 2 over the limit of 20 dropped/,
      ),
    ).toBe(true);

    const run = runOf(raw, "run-c20", (key) => [
      stepDoneEvent(key, raw.spec.identity.id, at(2), outcome),
    ]);
    expect(run.warnings).toEqual([{ step: "Step", text: "2 speakers could not be named" }]);
    expect(run.notes[0]).toEqual({ step: "Step", text: "used the large model" });
    expect(run.notes).toHaveLength(19);
    expect(run.results.map((line) => [line.sink, line.text, line.anytype, line.folder])).toEqual([
      [
        "anytype",
        "Meeting notes → Renaissance",
        { spaceId: "space-1", objectId: "object-1" },
        null,
      ],
      ["file", "Moved the recording", null, "/archive"],
    ]);
    expect(run.state).toBe("running");
  });

  it("C21 status with in reaches only that run's step, and the badge as before", async () => {
    const raw = start(reference);
    const held = input(raw, "run-held", { do: "slow" });
    await waitFor(
      "the held input's badge",
      () => raw.host.statuses.some((s) => s.text === "working"),
      WAIT_MS,
    );
    const moving = input(raw, "run-moving", {
      do: "progress",
      done: 2,
      total: 3,
      eta_s: 120,
      text: "in Renaissance",
    });
    await waitFor("the progress input's done", () => moving.finished, WAIT_MS);

    const line = { text: "in Renaissance", progress: { done: 2, total: 3 }, etaSeconds: 120 };
    expect(moving.statuses).toEqual([line]);
    expect(held.statuses).toEqual([]);
    expect(raw.host.statuses).toContainEqual({
      text: "in Renaissance",
      fill: "blue",
      shape: "dot",
    });

    const id = raw.spec.identity.id;
    const movingRun = runOf(raw, "run-moving", (key) =>
      moving.statuses.map((status) => stepStatusEvent(key, id, at(2), status)),
    );
    const heldRun = runOf(raw, "run-held", (key) =>
      held.statuses.map((status) => stepStatusEvent(key, id, at(2), status)),
    );
    expect(movingRun.steps[0]).toMatchObject({
      statusText: "in Renaissance",
      progress: { done: 2, total: 3 },
      etaSeconds: 120,
    });
    expect(heldRun.steps[0]).toMatchObject({ statusText: null, progress: null, etaSeconds: null });

    raw.node.cancel(held.id);
    await waitFor("the held input's end", () => held.finished, WAIT_MS);
  });

  it("C22 a done with only in, and a status without in, mean what they meant in 2.0", async () => {
    const raw = start(reference);
    const echoed = input(raw, "run-c22", { do: "echo", value: 1 });
    await waitFor("the echo's done", () => echoed.finished, WAIT_MS);
    expect(echoed.ends).toEqual([undefined]);
    expect(echoed.outcomes).toEqual([undefined]);
    expect(echoed.outputs.map((output) => output.message.payload)).toEqual([1]);
    const run = runOf(raw, "run-c22", (key) => [stepDoneEvent(key, raw.spec.identity.id, at(2))]);
    expect(run).toMatchObject({ notes: [], warnings: [], results: [] });
    expect(run.steps[0]?.state).toBe("done");

    const slow = input(raw, "run-c22-slow", { do: "slow" });
    await waitFor("the badge", () => raw.host.statuses.some((s) => s.text === "working"), WAIT_MS);
    expect(raw.host.statuses).toContainEqual({ text: "working", fill: "blue", shape: "dot" });
    expect(slow.statuses).toEqual([]);
    raw.node.cancel(slow.id);
    await waitFor("the slow input's end", () => slow.finished, WAIT_MS);
    // Nothing of 2.1 was sent, so nothing of it was dropped or cut.
    expect(raw.logger.has(/dropped|cut from/)).toBe(false);
  });

  it("C23 innytype spaces and types: declared, validated as without them, read back for the form", async () => {
    const { declaration, config } = declared(reference);
    const validator = new AjvSchemaValidator();
    expect(validator.declaration(declaration)).toEqual([]);
    const values = { space: "space-1", type: "type-1" };
    expect(validator.check(config, values)).toEqual([]);
    expect(validator.check(config, { space: 5 })).not.toEqual([]);
    expect(
      new Ajv2020({ strict: true }).addKeyword(INNYTYPE_ANNOTATION).compile(config)(values),
    ).toBe(true);

    const properties = config["properties"] as Record<string, JsonSchema>;
    expect(innytypeOptions(properties["space"] as JsonSchema)).toEqual({ source: "spaces" });
    expect(innytypeOptions(properties["type"] as JsonSchema)).toEqual({
      source: "types",
      of: "space",
    });
    expect(formModel(config).fields.map((field) => [field.key, field.innytype])).toEqual([
      ["space", { source: "spaces" }],
      ["type", { source: "types", of: "space" }],
    ]);

    // The node is started with the plain strings the form stores, and works as ever.
    const raw = start(reference, values);
    const echoed = input(raw, "run-c23", { do: "echo", value: "ok" });
    await waitFor("the echo's done", () => echoed.finished, WAIT_MS);
    expect(echoed.ends).toEqual([undefined]);
  });
});
