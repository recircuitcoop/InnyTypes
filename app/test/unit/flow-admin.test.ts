// Flow administration (plan 0022 §D, D7), against an in-memory Node-RED with the real deploy
// guard and the real ajv validator: every write goes through the guard, is refused while the
// canvas is dirty, and answers a refusal as `{refused}`; duplicates and templates get new ids
// and no credentials; delete cancels, removes the tab, then the runs and the meta.
import { describe, expect, it } from "vitest";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { DeployGuard } from "../../src/application/deploy-guard";
import {
  DIRTY_SENTENCE,
  FlowAdmin,
  GONE_SENTENCE,
  LOADING_SENTENCE,
  NAME_SENTENCE,
  NO_FORM_SENTENCE,
  NO_STEP_SENTENCE,
  NO_TEMPLATE_SENTENCE,
  flowNodeTypeOf,
  isFlowOp,
  type FlowOp,
  type FlowSummary,
} from "../../src/application/flows";
import { HEALTH_RUNS, recentRuns } from "../../src/application/flow-summary";
import type { TabNode } from "../../src/domain/flows/tab";
import type { LoadedType } from "../../src/domain/packages/declaration";
import { fold, type Run, type RunEvent } from "../../src/domain/runs/run";
import type {
  FlowEngine,
  FlowMeta,
  FlowNodeType,
  FlowTab,
  FlowTemplate,
  NewFlowTab,
} from "../../src/ports/flow-admin";
import type { RunPage, RunQuery } from "../../src/ports/run-store";
import { RecordingLogger } from "../fakes/children";
import { FakeClock } from "../fakes/clock";

const TYPES: Record<string, FlowNodeType> = {
  "inny-pkg-source": { package: "pkg", kind: "source", label: "Watch", config: { type: "object" } },
  "inny-pkg-step": {
    package: "pkg",
    kind: "node",
    label: "File",
    config: {
      type: "object",
      required: ["space"],
      properties: {
        space: { type: "string", innytype: { spaces: true } },
        count: { type: "integer", minimum: 1 },
      },
    },
  },
  "inny-pkg-secretive": {
    package: "pkg",
    kind: "node",
    label: "Transcribe",
    config: {
      type: "object",
      required: ["token"],
      properties: { token: { type: "string", writeOnly: true }, label: { type: "string" } },
    },
  },
  "inny-pkg-ask": {
    package: "pkg",
    kind: "view",
    view: "action",
    label: "Approve",
    config: { type: "object" },
  },
  "inny-pkg-show": {
    package: "pkg",
    kind: "view",
    view: "snapshot",
    label: "Result",
    config: { type: "object" },
  },
};

/** Node-RED's flows in memory, as the documented flow API behaves; every call is recorded. */
class MemoryEngine implements FlowEngine {
  readonly calls: string[] = [];
  readonly tabsById = new Map<string, FlowTab>();
  readonly secrets = new Map<string, Record<string, string>>();
  #ids = 0;
  fail: Error | null = null;

  constructor(tabs: FlowTab[] = []) {
    for (const tab of tabs) {
      this.#store(tab);
    }
  }

  #store(tab: FlowTab): void {
    const strip = (node: TabNode): TabNode => {
      const { credentials, ...rest } = node as TabNode & { credentials?: Record<string, string> };
      if (credentials !== undefined) {
        this.secrets.set(node.id, { ...this.secrets.get(node.id), ...credentials });
      }
      return { ...rest, z: tab.id };
    };
    this.tabsById.set(tab.id, {
      ...tab,
      nodes: tab.nodes.map(strip),
      configs: tab.configs.map(strip),
    });
  }

  tabs() {
    return Promise.resolve(
      [...this.tabsById.values()].map(({ id, label, disabled }) => ({ id, label, disabled })),
    );
  }
  getFlow(id: string) {
    const tab = this.tabsById.get(id);
    return Promise.resolve(tab === undefined ? null : structuredClone(tab));
  }
  addFlow(flow: NewFlowTab) {
    this.calls.push(`addFlow ${flow.label}`);
    if (this.fail !== null) {
      return Promise.reject(this.fail);
    }
    const id = `tab-${String(++this.#ids)}`;
    this.#store({ id, ...flow });
    return Promise.resolve(id);
  }
  updateFlow(id: string, flow: FlowTab) {
    this.calls.push(`updateFlow ${id}`);
    this.#store({ ...flow, id });
    return Promise.resolve();
  }
  deleteFlow(id: string) {
    this.calls.push(`deleteFlow ${id}`);
    this.tabsById.delete(id);
    return Promise.resolve();
  }
  secretsSet(node: TabNode) {
    return Promise.resolve(new Set(Object.keys(this.secrets.get(node.id) ?? {})));
  }
}

/** A run of `flowId`, started at `at` (ms), done, failed or still running. */
function run(flowId: string, runId: string, at: number, end: "done" | "failed" | "running"): Run {
  const key = { flowId, runId, at: new Date(at) };
  const events: Record<string, unknown>[] = [
    { kind: "started", title: `event ${runId}` },
    { kind: "stepStarted", instanceId: "n", name: "File" },
  ];
  if (end === "done") {
    events.push({ kind: "stepDone", instanceId: "n" }, { kind: "finished" });
  } else if (end === "failed") {
    events.push({ kind: "stepFailed", instanceId: "n", text: "refused" });
  }
  return fold(events.map((event) => ({ ...key, ...event }) as unknown as RunEvent));
}

/** The runs store, a page at a time, newest first; the cursor is the next index. */
class PagedRuns {
  readonly asked: RunQuery[] = [];
  readonly deleted: string[] = [];
  constructor(public runs: Run[] = []) {}
  list(query: RunQuery): RunPage {
    this.asked.push(query);
    const all = this.runs
      .filter((r) => r.flowId === query.flowId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const from = query.cursor === undefined ? 0 : Number(query.cursor);
    const page = all.slice(from, from + query.limit);
    const next = from + query.limit < all.length ? String(from + query.limit) : null;
    return { runs: page, next };
  }
  deleteFlowRuns(flowId: string): number {
    this.deleted.push(flowId);
    const before = this.runs.length;
    this.runs = this.runs.filter((r) => r.flowId !== flowId);
    return before - this.runs.length;
  }
}

const TEMPLATES: FlowTemplate[] = [
  {
    id: "starter",
    name: "Starter",
    line: "file",
    packages: ["pkg"],
    official: true,
    starter: true,
  },
  {
    id: "foreign",
    name: "Foreign",
    line: "x",
    packages: ["other"],
    official: false,
    starter: false,
  },
  { id: "unreadable", name: "Gone", line: "x", packages: [], official: true, starter: false },
];
const TEMPLATE_NODES: Record<string, TabNode[]> = {
  starter: [
    { id: "t", type: "tab", label: "Starter", info: "how it works" },
    { id: "s1", type: "inny-pkg-step", z: "t", name: "File it", wires: [[]] },
    { id: "c1", type: "comment", z: "t", name: "Transcribe (needs innyrize)" },
  ],
  foreign: [
    { id: "t", type: "tab", label: "Foreign" },
    { id: "o1", type: "inny-other-step", z: "t" },
  ],
};

const RECORDINGS: FlowTab = {
  id: "rec",
  label: "Recordings",
  disabled: false,
  info: "about it",
  nodes: [
    { id: "w", type: "inny-pkg-source", z: "rec", wires: [["t"]], y: 10 },
    {
      id: "t",
      type: "inny-pkg-secretive",
      z: "rec",
      name: "Transcribe",
      label: "x",
      credentials: { token: "s3cret" },
      wires: [["f", "a"]],
      y: 20,
    },
    { id: "f", type: "inny-pkg-step", z: "rec", space: "sp1", wires: [["v"]], y: 30 },
    { id: "a", type: "inny-pkg-ask", z: "rec", name: "", wires: [], y: 40 },
    { id: "v", type: "inny-pkg-show", z: "rec", wires: [], y: 50 },
    { id: "d", type: "debug", z: "rec", y: 60 },
  ],
  configs: [],
};

function harness(
  options: { tabs?: FlowTab[]; runs?: Run[]; meta?: Record<string, FlowMeta> } = {},
) {
  const engine = new MemoryEngine(options.tabs ?? [structuredClone(RECORDINGS)]);
  const logger = new RecordingLogger();
  const runs = new PagedRuns(options.runs ?? []);
  const meta = new Map(Object.entries(options.meta ?? {}));
  const cancelled: string[] = [];
  let signals = 0;
  let next = 0;
  const guard = new DeployGuard({
    engine: {
      nodeSets: () =>
        Promise.resolve([
          {
            id: "node-red/common",
            module: "node-red",
            types: ["comment", "debug", "inject"],
            enabled: true,
          },
          { id: "node-red/inny-pkg", module: "node-red", types: Object.keys(TYPES), enabled: true },
          {
            id: "node-red/inny-other",
            module: "node-red",
            types: ["inny-other-step"],
            enabled: true,
          },
        ]),
    },
    store: { packages: () => ["pkg"] },
    logger,
    port: 1880,
  });
  const admin = new FlowAdmin({
    engine,
    guard,
    runs,
    cancelInputs: (flowId) => {
      cancelled.push(flowId);
      engine.calls.push(`cancelInputs ${flowId}`);
      return 2;
    },
    meta: {
      get: (id) => meta.get(id) ?? null,
      set: (id, value) => meta.set(id, value),
      remove: (id) => meta.delete(id),
    },
    templates: {
      index: () => TEMPLATES,
      nodes: (id) => TEMPLATE_NODES[id] ?? null,
    },
    nodeType: (type) => TYPES[type],
    validator: new AjvSchemaValidator(),
    clock: new FakeClock(),
    newId: () => `new-${String(++next)}`,
    logger,
    signal: () => {
      signals += 1;
    },
  });
  const call = async (op: FlowOp, args: unknown = {}) => admin.call(op, args);
  /** A write's answer, with the canvas clean unless said. */
  const write = async (op: FlowOp, args: Record<string, unknown>, canvasDirty = false) =>
    (await admin.call(op, { ...args, canvasDirty })) as { ok: true; value: unknown };
  const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    admin,
    engine,
    runs,
    meta,
    cancelled,
    logger,
    call,
    write,
    turn,
    signals: () => signals,
  };
}

async function list(h: ReturnType<typeof harness>): Promise<FlowSummary[]> {
  const answer = await h.call("flow.list");
  expect(answer.ok).toBe(true);
  return (answer as { value: FlowSummary[] }).value;
}

describe("the flow ops", () => {
  it("are known by name, and nothing else is one", () => {
    expect(isFlowOp("flow.node.configure")).toBe(true);
    expect(isFlowOp("run.list")).toBe(false);
  });
});

describe("flow.list", () => {
  it("answers each tab: its switch, steps in wire order, view nodes, health and last run", async () => {
    const h = harness({
      runs: [run("rec", "r1", 1_000, "done"), run("rec", "r2", 2_000, "running")],
    });
    const [flow] = await list(h);
    expect(flow).toEqual({
      id: "rec",
      name: "Recordings",
      on: true,
      health: { kind: "ready" },
      lastRun: expect.objectContaining({
        runId: "r2",
        state: "running",
        title: "event r2",
      }) as unknown,
      viewNodes: [
        { id: "a", name: "Approve", kind: "question" },
        { id: "v", name: "Result", kind: "result" },
      ],
      steps: [
        { id: "t", name: "Transcribe", type: "inny-pkg-secretive", setUp: true },
        { id: "f", name: "File", type: "inny-pkg-step", setUp: true },
        { id: "a", name: "Approve", type: "inny-pkg-ask", setUp: true },
        { id: "v", name: "Result", type: "inny-pkg-show", setUp: true },
      ],
    });
  });

  it("counts the steps not set up: a config that fails its schema, or a required secret unset", async () => {
    const tab = structuredClone(RECORDINGS);
    const nodes = tab.nodes.map((node) =>
      node.id === "f"
        ? { ...node, space: undefined, count: 0 }
        : node.id === "t"
          ? { ...node, credentials: undefined }
          : node,
    );
    const h = harness({ tabs: [{ ...tab, nodes }], runs: [run("rec", "r1", 1_000, "failed")] });
    const [flow] = await list(h);
    expect(flow?.health).toEqual({ kind: "steps-not-set-up", count: 2 });
    expect(flow?.steps.filter((step) => !step.setUp).map((step) => step.id)).toEqual(["t", "f"]);
  });

  it("is failing since the trailing streak of failures began, and a flow with no source is never Ready", async () => {
    const h = harness({
      tabs: [
        structuredClone(RECORDINGS),
        { ...structuredClone(RECORDINGS), id: "other", nodes: [], configs: [] },
        {
          ...structuredClone(RECORDINGS),
          id: "injected",
          nodes: [{ id: "i", type: "inject", z: "injected" }],
          configs: [],
        },
      ],
      runs: [
        run("rec", "r1", 1_000, "done"),
        run("rec", "r2", 2_000, "failed"),
        run("rec", "r3", 3_000, "failed"),
      ],
    });
    const [flow, other, injected] = await list(h);
    expect(flow?.health).toEqual({ kind: "failing-since", since: new Date(2_000) });
    // Nothing could start a run: never Ready, even never run.
    expect(other).toMatchObject({ health: { kind: "no-source" }, lastRun: null, steps: [] });
    // Node-RED's own inject starts runs, so it counts as a source; never run is Ready.
    expect(injected).toMatchObject({ health: { kind: "ready" }, lastRun: null, steps: [] });
  });

  it("reads runs a page at a time only as far back as a done run, and at most HEALTH_RUNS", () => {
    const runs = new PagedRuns([
      ...Array.from({ length: 250 }, (_, n) => run("rec", `f${String(n)}`, 10_000 + n, "failed")),
      run("rec", "ok", 1_000, "done"),
    ]);
    expect(recentRuns("rec", runs)).toHaveLength(251);
    expect(runs.asked.map((q) => q.cursor)).toEqual([undefined, "200"]);
    const endless = new PagedRuns(
      Array.from({ length: HEALTH_RUNS + 300 }, (_, n) => run("rec", `f${String(n)}`, n, "failed")),
    );
    expect(recentRuns("rec", endless)).toHaveLength(HEALTH_RUNS);
  });

  it("lists a step Node-RED filed among the config nodes, having no position", async () => {
    const tab: FlowTab = {
      id: "cfg",
      label: "C",
      disabled: false,
      nodes: [],
      configs: [{ id: "f", type: "inny-pkg-step", z: "cfg", space: "s" }],
    };
    const [flow] = await list(harness({ tabs: [tab] }));
    expect(flow?.steps).toEqual([{ id: "f", name: "File", type: "inny-pkg-step", setUp: true }]);
  });

  it("skips a tab gone between listing and reading it", async () => {
    const h = harness();
    h.engine.getFlow = () => Promise.resolve(null);
    expect(await list(h)).toEqual([]);
  });

  it("lists the templates", async () => {
    expect(await harness().call("flow.templates")).toEqual({ ok: true, value: TEMPLATES });
  });
});

describe("every write", () => {
  const WRITES: [FlowOp, Record<string, unknown>][] = [
    ["flow.setOn", { id: "rec", on: false }],
    ["flow.rename", { id: "rec", name: "New name" }],
    ["flow.duplicate", { id: "rec" }],
    ["flow.delete", { id: "rec" }],
    ["flow.fromTemplate", { templateId: "starter" }],
    ["flow.node.configure", { flowId: "rec", nodeId: "f", values: { space: "sp2" } }],
  ];

  it("is refused while the canvas has unsaved changes, with the sentence, and writes nothing", async () => {
    const h = harness();
    for (const [op, args] of WRITES) {
      expect(await h.write(op, args, true)).toEqual({
        ok: true,
        value: { refused: { reason: "dirty", sentence: DIRTY_SENTENCE } },
      });
    }
    expect(h.engine.calls).toEqual([]);
    expect(h.cancelled).toEqual([]);
    await h.turn();
    expect(h.signals()).toBe(0);
  });

  it("is refused while the canvas is still loading, with its own sentence", async () => {
    const h = harness();
    for (const [op, args] of WRITES) {
      expect(await h.call(op, { ...args, canvasDirty: true, canvasLoading: true })).toEqual({
        ok: true,
        value: { refused: { reason: "loading", sentence: LOADING_SENTENCE } },
      });
    }
    expect(h.engine.calls).toEqual([]);
  });

  it("is refused, as a failed call, when nobody said whether the canvas is dirty", async () => {
    const h = harness();
    for (const [op, args] of WRITES) {
      expect(await h.call(op, args)).toEqual({
        ok: false,
        error: "canvasDirty must say whether the canvas has unsaved changes",
      });
    }
    expect(h.engine.calls).toEqual([]);
  });

  it("asks the deploy guard, and a type it refuses refuses the write", async () => {
    const h = harness();
    expect(await h.write("flow.fromTemplate", { templateId: "foreign" })).toEqual({
      ok: true,
      value: {
        refused: {
          reason: "not-installed",
          sentence: "Not installed in InnyTypes: inny-other-step.",
        },
      },
    });
    expect(h.engine.calls).toEqual([]);
    expect(h.logger.lines).toContainEqual(expect.stringContaining("refused a deploy naming types"));
  });

  it("refuses a flow that no longer exists", async () => {
    const h = harness();
    for (const op of ["flow.setOn", "flow.rename", "flow.duplicate", "flow.delete"] as const) {
      const answer = await h.write(op, { id: "gone", on: true, name: "x" });
      expect(answer).toEqual({
        ok: true,
        value: { refused: { reason: "gone", sentence: GONE_SENTENCE } },
      });
    }
    expect(await h.call("flow.export", { id: "gone" })).toMatchObject({
      value: { refused: { reason: "gone" } },
    });
  });

  it("answers wrong arguments as a failed call, and an engine failure as one, said in the log", async () => {
    const h = harness();
    expect(await h.write("flow.setOn", { id: "rec", on: "yes" })).toEqual({
      ok: false,
      error: "on must be true or false",
    });
    expect(await h.write("flow.rename", { name: "x" })).toEqual({
      ok: false,
      error: "id is required",
    });
    expect(await h.call("flow.node.form", null)).toEqual({
      ok: false,
      error: "flowId is required",
    });
    expect(
      await h.write("flow.node.configure", { flowId: "rec", nodeId: "f", values: [] }),
    ).toEqual({ ok: false, error: "values must be an object" });
    h.engine.fail = new Error("disk full");
    expect(await h.write("flow.duplicate", { id: "rec" })).toEqual({
      ok: false,
      error: "flow.duplicate failed: disk full",
    });
    expect(h.logger.lines).toContainEqual(
      expect.stringContaining("flow.duplicate failed: Error: disk full"),
    );
  });
});

describe("flow.setOn and flow.rename", () => {
  it("switch the tab's own disabled flag off and on, and deploy only when it changes", async () => {
    const h = harness();
    expect(await h.write("flow.setOn", { id: "rec", on: false })).toEqual({
      ok: true,
      value: { id: "rec", on: false },
    });
    expect(h.engine.tabsById.get("rec")?.disabled).toBe(true);
    expect((await list(h))[0]?.on).toBe(false);
    await h.write("flow.setOn", { id: "rec", on: false });
    expect(h.engine.calls).toEqual(["updateFlow rec"]);
    await h.write("flow.setOn", { id: "rec", on: true });
    expect(h.engine.tabsById.get("rec")?.disabled).toBe(false);
    // The credentials stay: a node written without them keeps the ones it has.
    expect(h.engine.secrets.get("t")).toEqual({ token: "s3cret" });
  });

  it("renames, refusing an empty or overlong name", async () => {
    const h = harness();
    expect(await h.write("flow.rename", { id: "rec", name: "  Invoices  " })).toEqual({
      ok: true,
      value: { id: "rec", name: "Invoices" },
    });
    expect(h.engine.tabsById.get("rec")?.label).toBe("Invoices");
    for (const name of ["   ", "x".repeat(101), 7]) {
      expect(await h.write("flow.rename", { id: "rec", name })).toEqual({
        ok: true,
        value: { refused: { reason: "name", sentence: NAME_SENTENCE } },
      });
    }
  });

  it("tell the shell after each write, once per turn however often asked", async () => {
    const h = harness();
    await h.write("flow.setOn", { id: "rec", on: false });
    await h.write("flow.rename", { id: "rec", name: "A" });
    await h.turn();
    expect(h.signals()).toBe(2);
    h.admin.changed();
    h.admin.changed();
    h.admin.changed();
    await h.turn();
    expect(h.signals()).toBe(3);
  });
});

describe("flow.duplicate and flow.export", () => {
  it("copies the tab, off, with new ids, re-mapped wires and no credentials", async () => {
    const h = harness({ meta: { rec: { template: "starter", createdAt: 5 } } });
    const answer = await h.write("flow.duplicate", { id: "rec" });
    expect(answer).toEqual({ ok: true, value: { id: "tab-1", name: "Recordings (copy)" } });
    const copy = h.engine.tabsById.get("tab-1");
    expect(copy).toMatchObject({ label: "Recordings (copy)", disabled: true, info: "about it" });
    const original = new Set(RECORDINGS.nodes.map((node) => node.id));
    expect(copy?.nodes.every((node) => !original.has(node.id))).toBe(true);
    expect(copy?.nodes.find((node) => node.type === "inny-pkg-source")?.["wires"]).toEqual([
      [copy?.nodes.find((node) => node.type === "inny-pkg-secretive")?.id],
    ]);
    expect(copy?.nodes.map((node) => h.engine.secrets.get(node.id))).toEqual(
      copy?.nodes.map(() => undefined),
    );
    // The copy's secret is not set: that step reads "not set up".
    const summary = (await list(h)).find((flow) => flow.id === "tab-1");
    expect(summary?.health).toEqual({ kind: "steps-not-set-up", count: 1 });
    expect(h.meta.get("tab-1")).toEqual({ template: "starter", createdAt: 0 });
    const named = await h.write("flow.duplicate", { id: "rec", name: "Mine" });
    expect(named).toEqual({ ok: true, value: { id: "tab-2", name: "Mine" } });
    expect(h.meta.get("tab-2")).toEqual({ template: "starter", createdAt: 0 });
    // A flow no template made makes copies no template made.
    const plain = harness();
    await plain.write("flow.duplicate", { id: "rec" });
    expect(plain.meta.get("tab-1")).toEqual({ template: null, createdAt: 0 });
  });

  it("refuses a duplicate named nothing", async () => {
    const h = harness();
    expect(await h.write("flow.duplicate", { id: "rec", name: "" })).toMatchObject({
      value: { refused: { reason: "name" } },
    });
  });

  it("exports the tab and its nodes with no credentials", async () => {
    const h = harness();
    const answer = (await h.call("flow.export", { id: "rec" })) as {
      value: { name: string; nodes: TabNode[] };
    };
    expect(answer.value.name).toBe("Recordings");
    expect(answer.value.nodes[0]).toEqual({
      id: "rec",
      type: "tab",
      label: "Recordings",
      disabled: false,
      info: "about it",
    });
    expect(answer.value.nodes.map((node) => node.id)).toEqual([
      "rec",
      "w",
      "t",
      "f",
      "a",
      "v",
      "d",
    ]);
    expect(JSON.stringify(answer.value)).not.toContain("s3cret");
    expect(JSON.stringify(answer.value)).not.toContain("credentials");
  });

  it("exports a tab's env, and none when it has none", async () => {
    const h = harness({
      tabs: [{ id: "e", label: "E", disabled: true, env: [{ name: "A" }], nodes: [], configs: [] }],
    });
    const answer = (await h.call("flow.export", { id: "e" })) as { value: { nodes: TabNode[] } };
    expect(answer.value.nodes).toEqual([
      { id: "e", type: "tab", label: "E", disabled: true, env: [{ name: "A" }] },
    ]);
  });
});

describe("flow.delete", () => {
  it("cancels the inputs in hand, removes the tab, then its runs and its meta", async () => {
    const h = harness({
      runs: [run("rec", "r1", 1, "done"), run("other", "r2", 2, "done")],
      meta: { rec: { template: null, createdAt: 1 } },
    });
    expect(await h.write("flow.delete", { id: "rec" })).toEqual({
      ok: true,
      value: { id: "rec", runs: 1 },
    });
    expect(h.engine.calls).toEqual(["cancelInputs rec", "deleteFlow rec"]);
    expect(h.runs.deleted).toEqual(["rec"]);
    expect(h.runs.runs.map((r) => r.runId)).toEqual(["r2"]);
    expect(h.meta.has("rec")).toBe(false);
    expect(await list(h)).toEqual([]);
    expect(h.logger.lines).toContainEqual(
      expect.stringContaining("flow rec deleted: 2 inputs in hand cancelled, 1 runs deleted"),
    );
  });
});

describe("flow.fromTemplate", () => {
  it("adds the template's tab, off, with new ids and its info, and records the template", async () => {
    const h = harness({ tabs: [] });
    expect(await h.write("flow.fromTemplate", { templateId: "starter" })).toEqual({
      ok: true,
      value: { id: "tab-1", name: "Starter" },
    });
    const made = h.engine.tabsById.get("tab-1");
    expect(made).toMatchObject({ label: "Starter", disabled: true, info: "how it works" });
    expect(made?.nodes.map((node) => [node.id, node.type, node["z"]])).toEqual([
      ["new-1", "inny-pkg-step", "tab-1"],
      ["new-2", "comment", "tab-1"],
    ]);
    expect(h.meta.get("tab-1")).toEqual({ template: "starter", createdAt: 0 });
    const [flow] = await list(h);
    expect(flow).toMatchObject({ on: false, health: { kind: "steps-not-set-up", count: 1 } });
    expect(
      await h.write("flow.fromTemplate", { templateId: "starter", name: "Mine" }),
    ).toMatchObject({
      value: { name: "Mine" },
    });
  });

  it("refuses a template that is not offered, or whose file cannot be read", async () => {
    const h = harness({ tabs: [] });
    for (const templateId of ["nope", "unreadable"]) {
      expect(await h.write("flow.fromTemplate", { templateId })).toEqual({
        ok: true,
        value: { refused: { reason: "no-template", sentence: NO_TEMPLATE_SENTENCE } },
      });
    }
  });
});

describe("flow.node.form and flow.node.configure", () => {
  it("answers a step's schema with its innytype annotation, its values, name and set secrets", async () => {
    const h = harness();
    expect(await h.call("flow.node.form", { flowId: "rec", nodeId: "f" })).toEqual({
      ok: true,
      value: {
        flowId: "rec",
        nodeId: "f",
        type: "inny-pkg-step",
        package: "pkg",
        stepName: "File",
        schema: TYPES["inny-pkg-step"]?.config,
        values: { space: "sp1" },
        secretsSet: [],
      },
    });
    const secretive = await h.call("flow.node.form", { flowId: "rec", nodeId: "t" });
    expect(secretive).toMatchObject({ value: { values: { label: "x" }, secretsSet: ["token"] } });
  });

  it("refuses a node gone from the flow, or one of Node-RED's own", async () => {
    const h = harness();
    expect(await h.call("flow.node.form", { flowId: "rec", nodeId: "zz" })).toEqual({
      ok: true,
      value: { refused: { reason: "no-step", sentence: NO_STEP_SENTENCE } },
    });
    expect(await h.call("flow.node.form", { flowId: "rec", nodeId: "d" })).toEqual({
      ok: true,
      value: { refused: { reason: "no-form", sentence: NO_FORM_SENTENCE } },
    });
  });

  it("writes valid values, clears a value left out, and deploys that tab", async () => {
    const h = harness();
    expect(
      await h.write("flow.node.configure", {
        flowId: "rec",
        nodeId: "f",
        values: { space: "sp2", undeclared: 1 },
      }),
    ).toEqual({ ok: true, value: { flowId: "rec", nodeId: "f" } });
    const node = h.engine.tabsById.get("rec")?.nodes.find((each) => each.id === "f");
    expect(node).toMatchObject({ space: "sp2", wires: [["v"]] });
    expect(node).not.toHaveProperty("undeclared");
    expect(h.engine.calls).toEqual(["updateFlow rec"]);
  });

  it("refuses invalid values with the step's name and each problem, and writes nothing", async () => {
    const h = harness();
    const answer = await h.write("flow.node.configure", {
      flowId: "rec",
      nodeId: "f",
      values: { count: 0 },
    });
    expect(answer).toEqual({
      ok: true,
      value: {
        refused: {
          reason: "invalid",
          sentence: "File isn't set up yet: space is required; count must be >= 1.",
          problems: [
            { path: "/space", message: "is required" },
            { path: "/count", message: "must be >= 1" },
          ],
        },
      },
    });
    expect(h.engine.calls).toEqual([]);
  });

  it("sets a secret given, keeps one left empty, and refuses a required one never set", async () => {
    const h = harness();
    await h.write("flow.node.configure", {
      flowId: "rec",
      nodeId: "t",
      values: { token: "", label: "y" },
    });
    expect(h.engine.secrets.get("t")).toEqual({ token: "s3cret" });
    await h.write("flow.node.configure", { flowId: "rec", nodeId: "t", values: { token: "new" } });
    expect(h.engine.secrets.get("t")).toEqual({ token: "new" });
    const fresh = harness();
    fresh.engine.secrets.clear();
    expect(
      await fresh.write("flow.node.configure", { flowId: "rec", nodeId: "t", values: {} }),
    ).toMatchObject({
      value: {
        refused: {
          reason: "invalid",
          sentence: "Transcribe isn't set up yet: token is required.",
        },
      },
    });
  });
});

describe("flowNodeTypeOf", () => {
  it("reads a generated type's package, kind, view, label and config", () => {
    const loaded = {
      declaration: { package: "pkg" },
      type: { kind: "view", view: "action", label: "Ask", config: { type: "object" } },
    } as unknown as LoadedType;
    expect(flowNodeTypeOf(loaded)).toEqual({
      package: "pkg",
      kind: "view",
      view: "action",
      label: "Ask",
      config: { type: "object" },
    });
    const plain = {
      ...loaded,
      type: { kind: "node", label: "N", config: {} },
    } as unknown as LoadedType;
    expect(flowNodeTypeOf(plain)).not.toHaveProperty("view");
  });
});
